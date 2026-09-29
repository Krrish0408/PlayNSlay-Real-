import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { setupAuth, hashPassword } from "../server/auth";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { initDbSchema } from "../server/db";
import { seedTestUsers } from "../server/seed";
import { MemoryStore } from "express-rate-limit";
import { setRateLimitStoreFactoryForTesting } from "../server/rate-limiter";
import {
  validateStartupConfig,
  ConfigurationError,
  DEFAULT_DEV_ORIGINS,
  DEFAULT_STAGING_ORIGINS,
  DEFAULT_PROD_ORIGINS,
  REQUIRED_CORS_METHODS,
  REQUIRED_CORS_HEADERS,
} from "../server/config";
import {
  validateOrigin,
  isOriginAllowed,
  corsMiddleware,
  setCorsEnvironmentForTesting,
  setCustomAllowedOriginsForTesting,
  resetCorsTestingOverrides,
} from "../server/cors";

interface TestClient {
  cookieJar: string[];
  setCookie: (cookie: string) => void;
  getCookieValue: (name: string) => string | undefined;
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  patch: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  delete: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  options: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
}

function createClient(serverAddress: string): TestClient {
  let cookieJar: string[] = [];

  const updateCookies = (setCookies: string[]) => {
    for (const sc of setCookies) {
      const cookiePart = sc.split(";")[0];
      const [cName] = cookiePart.split("=");
      cookieJar = cookieJar.filter((c) => !c.startsWith(cName + "="));
      if (!sc.includes("Expires=Thu, 01 Jan 1970") && !sc.includes("Max-Age=0")) {
        cookieJar.push(cookiePart);
      }
    }
  };

  const request = async (
    method: string,
    urlPath: string,
    body?: any,
    customHeaders?: Record<string, string>
  ) => {
    const fullUrl = new URL(urlPath, serverAddress);
    const headers: Record<string, string> = { ...customHeaders };
    if (cookieJar.length > 0 && !headers["Cookie"]) {
      headers["Cookie"] = cookieJar.join("; ");
    }
    if (body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(fullUrl.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      updateCookies(setCookies);
    }

    let data: any = null;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    return { status: res.status, data, headers: res.headers };
  };

  return {
    cookieJar,
    setCookie: (cookie: string) => {
      cookieJar.push(cookie);
    },
    getCookieValue: (name: string) => {
      const match = cookieJar.find((c) => c.startsWith(`${name}=`));
      if (!match) return undefined;
      return decodeURIComponent(match.split("=")[1]);
    },
    get: (url, headers) => request("GET", url, undefined, headers),
    post: (url, body, headers) => request("POST", url, body, headers),
    patch: (url, body, headers) => request("PATCH", url, body, headers),
    delete: (url, headers) => request("DELETE", url, undefined, headers),
    options: (url, headers) => request("OPTIONS", url, undefined, headers),
  };
}

describe("Hardened CORS Configuration & Cross-Origin Security Suite", () => {
  let server: http.Server;
  let serverAddress: string;
  let serverOrigin: string;

  before(async () => {
    // Avoid PGlite table locking in tests
    setRateLimitStoreFactoryForTesting(() => new MemoryStore());

    await initDbSchema();
    await seedTestUsers();

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    server = http.createServer(app);
    await registerRoutes(server, app);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address() as any;
    serverAddress = `http://127.0.0.1:${addr.port}`;
    serverOrigin = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    setRateLimitStoreFactoryForTesting(null);
    resetCorsTestingOverrides();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    resetCorsTestingOverrides();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Explicit Production & Staging Allowlist Configuration (Fail-Closed)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("1. Explicit Allowlist Configuration & Fail-Closed Validation", () => {
    test("Production mode requires HTTPS origins and fails closed on wildcard '*'", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "production",
            databaseUrl: "postgresql://user:pass@localhost:5432/db",
            sessionSecret: "valid_secret_key_1234567890",
            prodOrigins: ["*"],
          });
        },
        (err: any) => {
          assert(err instanceof ConfigurationError);
          assert.equal(err.code, "CORS_ORIGIN_WILDCARD_FORBIDDEN");
          assert.match(err.message, /Wildcard CORS origin '\*' is strictly prohibited/i);
          return true;
        }
      );
    });

    test("Production mode fails closed on insecure HTTP origin", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "production",
            databaseUrl: "postgresql://user:pass@localhost:5432/db",
            sessionSecret: "valid_secret_key_1234567890",
            prodOrigins: ["http://insecure-site.com"],
          });
        },
        (err: any) => {
          assert(err instanceof ConfigurationError);
          assert.equal(err.code, "CORS_ORIGIN_INSECURE");
          assert.match(err.message, /must use HTTPS/i);
          return true;
        }
      );
    });

    test("Staging mode fails closed on insecure HTTP origin or wildcard '*'", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "staging",
            databaseUrl: "postgresql://user:pass@localhost:5432/db",
            sessionSecret: "valid_secret_key_1234567890",
            stagingOrigins: ["*"],
          });
        },
        (err: any) => {
          assert(err instanceof ConfigurationError);
          assert.equal(err.code, "CORS_ORIGIN_WILDCARD_FORBIDDEN");
          return true;
        }
      );

      assert.throws(
        () => {
          validateStartupConfig({
            env: "staging",
            databaseUrl: "postgresql://user:pass@localhost:5432/db",
            sessionSecret: "valid_secret_key_1234567890",
            stagingOrigins: ["http://staging.gaminglounge.com"],
          });
        },
        (err: any) => {
          assert(err instanceof ConfigurationError);
          assert.equal(err.code, "CORS_ORIGIN_INSECURE");
          return true;
        }
      );
    });

    test("Production mode succeeds with valid explicit HTTPS origins", () => {
      const config = validateStartupConfig({
        env: "production",
        databaseUrl: "postgresql://user:pass@localhost:5432/db",
        sessionSecret: "valid_secret_key_1234567890",
        prodOrigins: ["https://gaminglounge.com", "https://app.gaminglounge.com"],
      });
      assert.equal(config.cors.productionOrigins.length, 2);
      assert.ok(config.cors.productionOrigins.includes("https://gaminglounge.com"));
      assert.ok(config.cors.productionOrigins.includes("https://app.gaminglounge.com"));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Never Wildcard '*' with Credentials
  // ─────────────────────────────────────────────────────────────────────────────
  describe("2. Never Wildcard '*' with Credentials", () => {
    test("Preflight from authorized origin returns exact mirrored origin, never '*'", async () => {
      const client = createClient(serverAddress);
      const res = await client.options("/api/bookings", {
        Origin: serverOrigin,
      });

      assert.equal(res.status, 204);
      const allowOrigin = res.headers.get("access-control-allow-origin");
      const allowCredentials = res.headers.get("access-control-allow-credentials");

      assert.equal(allowOrigin, serverOrigin, "Must mirror exact authorized origin");
      assert.notEqual(allowOrigin, "*", "Must NEVER return wildcard '*'");
      assert.equal(allowCredentials, "true", "Credentials must be enabled for authorized origin");
    });

    test("Unauthorized origin preflight is rejected (403) and never returns Access-Control-Allow-Origin", async () => {
      const client = createClient(serverAddress);
      const res = await client.options("/api/bookings", {
        Origin: "https://evil-unauthorized.com",
      });

      assert.equal(res.status, 403);
      assert.equal(res.headers.get("access-control-allow-origin"), null, "Must NOT emit Allow-Origin for unauthorized origin");
      assert.equal(res.headers.get("access-control-allow-credentials"), null, "Must NOT emit Allow-Credentials for unauthorized origin");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Strict Environment Separation
  // ─────────────────────────────────────────────────────────────────────────────
  describe("3. Strict Environment Separation (Dev vs Staging vs Production)", () => {
    test("Development environment allows localhost and 127.0.0.1", () => {
      setCorsEnvironmentForTesting("development");
      assert.ok(isOriginAllowed("http://localhost:3000"));
      assert.ok(isOriginAllowed("http://localhost:5173"));
      assert.ok(isOriginAllowed("http://127.0.0.1:5001"));
    });

    test("Staging environment strictly REJECTS localhost and development origins", () => {
      setCorsEnvironmentForTesting("staging");
      assert.equal(isOriginAllowed("http://localhost:3000"), false, "localhost must be rejected in staging");
      assert.equal(isOriginAllowed("http://127.0.0.1:5001"), false, "127.0.0.1 must be rejected in staging");
      assert.ok(isOriginAllowed("https://staging.gaminglounge.com"), "staging origin must be allowed");
    });

    test("Production environment strictly REJECTS localhost and development origins", () => {
      setCorsEnvironmentForTesting("production");
      assert.equal(isOriginAllowed("http://localhost:3000"), false, "localhost must be rejected in production");
      assert.equal(isOriginAllowed("http://localhost:5173"), false, "localhost:5173 must be rejected in production");
      assert.equal(isOriginAllowed("http://127.0.0.1:5000"), false, "127.0.0.1 must be rejected in production");
    });

    test("Production environment strictly REJECTS staging origins", () => {
      setCorsEnvironmentForTesting("production");
      assert.equal(
        isOriginAllowed("https://staging.gaminglounge.com"),
        false,
        "staging origin must NOT be allowed in production"
      );
      assert.ok(
        isOriginAllowed("https://gaminglounge.com"),
        "production origin must be allowed in production"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. HTTP Methods and Headers Whitelisting
  // ─────────────────────────────────────────────────────────────────────────────
  describe("4. Only Allow Required HTTP Methods and Headers", () => {
    test("Allowed methods only include standard API methods", () => {
      assert.deepEqual(REQUIRED_CORS_METHODS, [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
        "HEAD",
      ]);
    });

    test("Preflight with disallowed HTTP method (e.g. TRACE) is rejected with 405", async () => {
      const client = createClient(serverAddress);
      const res = await client.options("/api/bookings", {
        Origin: serverOrigin,
        "Access-Control-Request-Method": "TRACE",
      });

      assert.equal(res.status, 405, "Disallowed method TRACE must be rejected");
      assert.equal(res.data.code, "CORS_METHOD_NOT_ALLOWED");
    });

    test("Preflight with disallowed HTTP method (e.g. CONNECT) is rejected with 405", async () => {
      const client = createClient(serverAddress);
      const res = await client.options("/api/bookings", {
        Origin: serverOrigin,
        "Access-Control-Request-Method": "CONNECT",
      });

      assert.equal(res.status, 405, "Disallowed method CONNECT must be rejected");
    });

    test("Preflight with disallowed custom header is rejected with 403", async () => {
      const client = createClient(serverAddress);
      const res = await client.options("/api/bookings", {
        Origin: serverOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, X-Exploit-Header",
      });

      assert.equal(res.status, 403, "Disallowed header must be rejected");
      assert.equal(res.data.code, "CORS_HEADER_NOT_ALLOWED");
    });

    test("Preflight with allowed headers returns 204 with complete CORS headers", async () => {
      const client = createClient(serverAddress);
      const res = await client.options("/api/bookings", {
        Origin: serverOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, X-CSRF-Token, Authorization, Idempotency-Key",
      });

      assert.equal(res.status, 204);
      assert.equal(res.headers.get("access-control-allow-origin"), serverOrigin);
      assert.ok(res.headers.get("access-control-allow-methods")?.includes("POST"));
      assert.ok(res.headers.get("access-control-allow-headers")?.includes("X-CSRF-Token"));
      assert.ok(res.headers.get("access-control-allow-headers")?.includes("Idempotency-Key"));
      assert.equal(res.headers.get("access-control-max-age"), "86400");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Allow Credentials Only Where Required
  // ─────────────────────────────────────────────────────────────────────────────
  describe("5. Allow Credentials Only Where Required", () => {
    test("Public non-credentialed health check does not require credentials header", async () => {
      const client = createClient(serverAddress);
      const res = await client.get("/api/health", {
        Origin: serverOrigin,
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), serverOrigin);
      // Public health check without cookies doesn't emit credentials header
      assert.equal(res.headers.get("access-control-allow-credentials"), null);
    });

    test("Authenticated endpoint sets credentials header for authorized origin", async () => {
      const client = createClient(serverAddress);
      const res = await client.get("/api/user", {
        Origin: serverOrigin,
      });

      assert.equal(res.status, 401); // Unauthenticated, but CORS evaluated
      assert.equal(res.headers.get("access-control-allow-origin"), serverOrigin);
      assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    });

    test("Unauthorized origin NEVER receives Access-Control-Allow-Credentials", async () => {
      const client = createClient(serverAddress);
      const res = await client.get("/api/user", {
        Origin: "https://unauthorized-origin.com",
      });

      assert.equal(res.status, 403);
      assert.equal(res.headers.get("access-control-allow-credentials"), null);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Server-Side Origin Validation & Attack Resistance
  // ─────────────────────────────────────────────────────────────────────────────
  describe("6. Server-Side Origin Validation & Attack Resistance", () => {
    test("Rejects Origin: 'null' (sandboxed iframes / data URIs)", () => {
      const v = validateOrigin("null");
      assert.equal(v.valid, false);
      assert.match(v.reason || "", /null/i);
    });

    test("Rejects malformed and non-URL origin strings", () => {
      assert.equal(validateOrigin("not-a-valid-url").valid, false);
      assert.equal(validateOrigin("javascript:alert(1)").valid, false);
      assert.equal(validateOrigin("").valid, false);
    });

    test("Rejects origins with embedded userinfo (credentials)", () => {
      const v = validateOrigin("https://user:pass@gaminglounge.com");
      assert.equal(v.valid, false);
      assert.match(v.reason || "", /credentials/i);
    });

    test("Rejects origins with path components", () => {
      const v = validateOrigin("https://gaminglounge.com/malicious/path");
      assert.equal(v.valid, false);
      assert.match(v.reason || "", /path/i);
    });

    test("Rejects origins with query parameters or hash", () => {
      assert.equal(validateOrigin("https://gaminglounge.com?attack=1").valid, false);
      assert.equal(validateOrigin("https://gaminglounge.com#anchor").valid, false);
    });

    test("Rejects subdomain / suffix hijacking attacks", () => {
      setCorsEnvironmentForTesting("production");
      assert.equal(
        isOriginAllowed("https://gaminglounge.com.attacker.com"),
        false,
        "Suffix spoofing must be rejected"
      );
      assert.equal(
        isOriginAllowed("https://attacker-gaminglounge.com"),
        false,
        "Prefix spoofing must be rejected"
      );
      assert.equal(
        isOriginAllowed("https://evilgaminglounge.com"),
        false,
        "Lookalike domain must be rejected"
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Proving Unauthorized Origin CANNOT Perform Authenticated API Operations
  // ─────────────────────────────────────────────────────────────────────────────
  describe("7. Unauthorized Origin Cannot Perform Authenticated API Operations", () => {
    const PASS = "StrongPass123!";
    let memberCookie: string;
    let adminCookie: string;

    before(async () => {
      const timestamp = Date.now();
      const memberUser = await storage.createUser({
        username: `cors_victim_${timestamp}`,
        password: await hashPassword(PASS),
        role: "member",
      });
      const adminUser = await storage.createUser({
        username: `cors_admin_${timestamp}`,
        password: await hashPassword(PASS),
        role: "admin",
      });

      // Login member
      const memberClient = createClient(serverAddress);
      const csrf1 = (await memberClient.get("/api/csrf-token")).data.csrfToken;
      await memberClient.post(
        "/api/login",
        { username: memberUser.username, password: PASS },
        { Origin: serverOrigin, "X-CSRF-Token": csrf1 }
      );
      memberCookie = memberClient.cookieJar.join("; ");

      // Login admin
      const adminClient = createClient(serverAddress);
      const csrf2 = (await adminClient.get("/api/csrf-token")).data.csrfToken;
      await adminClient.post(
        "/api/login",
        { username: adminUser.username, password: PASS },
        { Origin: serverOrigin, "X-CSRF-Token": csrf2 }
      );
      adminCookie = adminClient.cookieJar.join("; ");
    });

    test("Unauthorized origin CANNOT read authenticated user profile (GET /api/user)", async () => {
      const attacker = createClient(serverAddress);
      const res = await attacker.get("/api/user", {
        Origin: "https://evil-phishing.org",
        Cookie: memberCookie,
      });

      assert.equal(res.status, 403, "Must be rejected with 403 Forbidden");
      assert.equal(res.data.code, "CORS_ORIGIN_NOT_ALLOWED");
      assert.equal(res.headers.get("access-control-allow-origin"), null);
      assert.equal(res.headers.get("access-control-allow-credentials"), null);
    });

    test("Unauthorized origin CANNOT read victim's bookings (GET /api/bookings)", async () => {
      const attacker = createClient(serverAddress);
      const res = await attacker.get("/api/bookings", {
        Origin: "https://evil-phishing.org",
        Cookie: memberCookie,
      });

      assert.equal(res.status, 403, "Must be rejected with 403 Forbidden");
      assert.equal(res.data.code, "CORS_ORIGIN_NOT_ALLOWED");
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    });

    test("Unauthorized origin CANNOT create bookings with victim's session (POST /api/bookings)", async () => {
      const attacker = createClient(serverAddress);
      const res = await attacker.post(
        "/api/bookings",
        {
          stationId: 1,
          startTime: new Date(Date.now() + 3600000).toISOString(),
          endTime: new Date(Date.now() + 7200000).toISOString(),
          playerCount: 1,
        },
        {
          Origin: "https://attacker-controlled.site",
          Cookie: memberCookie,
        }
      );

      assert.equal(res.status, 403, "State-changing request from untrusted origin must be forbidden");
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    });

    test("Unauthorized origin CANNOT cancel bookings with victim's session (POST /api/bookings/:id/cancel)", async () => {
      const attacker = createClient(serverAddress);
      const res = await attacker.post(
        "/api/bookings/1/cancel",
        {},
        {
          Origin: "https://malicious-forum.com",
          Cookie: memberCookie,
        }
      );

      assert.equal(res.status, 403);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    });

    test("Unauthorized origin CANNOT escalate roles with admin session (PATCH /api/admin/users/:id/role)", async () => {
      const attacker = createClient(serverAddress);
      const res = await attacker.patch(
        "/api/admin/users/1/role",
        { role: "admin" },
        {
          Origin: "https://evil-exploit.xyz",
          Cookie: adminCookie,
        }
      );

      assert.equal(res.status, 403, "Admin privilege modification from untrusted origin must be forbidden");
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    });

    test("Unauthorized origin CANNOT upload files with staff session (POST /api/upload)", async () => {
      const attacker = createClient(serverAddress);
      const res = await attacker.post(
        "/api/upload",
        { file: "malicious.exe" },
        {
          Origin: "https://malicious-uploader.net",
          Cookie: adminCookie,
        }
      );

      assert.equal(res.status, 403);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    });

    test("Unauthorized origin CANNOT trigger MFA setup with victim's session (POST /api/auth/mfa/setup)", async () => {
      const attacker = createClient(serverAddress);
      const res = await attacker.post(
        "/api/auth/mfa/setup",
        {},
        {
          Origin: "https://credential-stealer.com",
          Cookie: memberCookie,
        }
      );

      assert.equal(res.status, 403);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    });
  });
});

