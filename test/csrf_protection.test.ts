import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { setupAuth, sanitizeUser, hashPassword } from "../server/auth";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { initDbSchema } from "../server/db";
import { seedTestUsers } from "../server/seed";
import {
  COOKIE_NAME,
  hashSessionId,
} from "../server/session-service";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  generateCsrfToken,
} from "../server/csrf";

interface TestClient {
  cookieJar: string[];
  setCookie: (cookie: string) => void;
  getCookieValue: (name: string) => string | undefined;
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  post: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  patch: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  delete: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  options: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
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

describe("CSRF Protection & Cross-Origin Security Suite", () => {
  let server: http.Server;
  let serverAddress: string;
  let serverOrigin: string;

  before(async () => {
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
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe("1. Authoritative CSRF Token Issuance & Cookie Priming", () => {
    test("GET /api/csrf-token returns valid CSRF token and sets pns_csrf cookie", async () => {
      const client = createClient(serverAddress);
      const res = await client.get("/api/csrf-token");

      assert.equal(res.status, 200);
      assert.ok(res.data.csrfToken, "Response must include csrfToken");
      assert.equal(typeof res.data.csrfToken, "string");
      assert.equal(res.data.csrfToken.length, 64, "CSRF token must be 256-bit hex (64 chars)");

      const cookieVal = client.getCookieValue(CSRF_COOKIE_NAME);
      assert.ok(cookieVal, "pns_csrf cookie must be set");
      assert.equal(cookieVal, res.data.csrfToken, "Cookie must match the issued CSRF token");
    });

    test("CSRF token rotates when logging in with a new session", async () => {
      const timestamp = Date.now();
      const user = await storage.createUser({
        username: `csrf_user_${timestamp}`,
        password: await hashPassword("securePassword123!"),
        role: "member",
        isEmailVerified: true,
      });

      const client = createClient(serverAddress);

      // 1. Unauthenticated client fetches CSRF token
      const tokenRes1 = await client.get("/api/csrf-token");
      const preLoginToken = tokenRes1.data.csrfToken;
      assert.ok(preLoginToken);

      // 2. Client logs in
      const loginRes = await client.post(
        "/api/login",
        { username: user.username, password: "securePassword123!" },
        {
          Origin: serverOrigin,
          "X-CSRF-Token": preLoginToken,
        }
      );
      assert.equal(loginRes.status, 200);

      // 3. Post-login CSRF token fetched for the new session must be rotated
      const tokenRes2 = await client.get("/api/csrf-token");
      const postLoginToken = tokenRes2.data.csrfToken;
      assert.ok(postLoginToken, "Post-login CSRF token must exist");
      assert.notEqual(
        preLoginToken,
        postLoginToken,
        "CSRF token must be rotated upon login session regeneration"
      );
    });
  });

  describe("2. Defense in Depth: Origin & Referer Validation", () => {
    test("Malicious external website cannot perform authenticated booking (Origin mismatch)", async () => {
      const timestamp = Date.now() + 1;
      const user = await storage.createUser({
        username: `victim_booking_${timestamp}`,
        password: await hashPassword("pass123!"),
        role: "member",
        isEmailVerified: true,
      });

      // Legitimate user logs in and establishes authenticated browser session
      const victim = createClient(serverAddress);
      const preToken = (await victim.get("/api/csrf-token")).data.csrfToken;
      await victim.post(
        "/api/login",
        { username: user.username, password: "pass123!" },
        { Origin: serverOrigin, "X-CSRF-Token": preToken }
      );

      // Malicious site (e.g. evil-phishing.com) attempts to forge booking with victim's cookies
      const attackRes = await victim.post(
        "/api/bookings",
        {
          stationId: 1,
          startTime: new Date(Date.now() + 3600000).toISOString(),
          endTime: new Date(Date.now() + 7200000).toISOString(),
          playerCount: 1,
        },
        {
          Origin: "https://evil-phishing.com",
        }
      );

      assert.equal(attackRes.status, 403, "Cross-origin booking attempt must be forbidden");
      assert.ok(
        attackRes.data.code === "CSRF_ORIGIN_MISMATCH" || attackRes.data.message.includes("Origin"),
        "Must specify origin mismatch"
      );
    });

    test("Malicious external website cannot perform authenticated account actions (Referer mismatch)", async () => {
      const timestamp = Date.now() + 2;
      const user = await storage.createUser({
        username: `victim_account_${timestamp}`,
        password: await hashPassword("currentPass123!"),
        role: "member",
      });

      const victim = createClient(serverAddress);
      const preToken = (await victim.get("/api/csrf-token")).data.csrfToken;
      await victim.post(
        "/api/login",
        { username: user.username, password: "currentPass123!" },
        { Origin: serverOrigin, "X-CSRF-Token": preToken }
      );

      // Malicious site attempts password change via malicious referer
      const attackRes = await victim.post(
        "/api/user/change-password",
        {
          currentPassword: "currentPass123!",
          newPassword: "hackedPassword999!",
        },
        {
          Referer: "https://attacker.site/exploit-frame.html",
        }
      );

      assert.equal(attackRes.status, 403, "Cross-origin password change must be rejected");
      assert.ok(
        attackRes.data.code === "CSRF_ORIGIN_MISMATCH" || attackRes.data.message.includes("Referer"),
        "Must specify referer mismatch"
      );
    });

    test("Malicious website cannot forge admin privilege escalation actions (Origin: https://evil.org)", async () => {
      const adminClient = createClient(serverAddress);
      const preToken = (await adminClient.get("/api/csrf-token")).data.csrfToken;
      await adminClient.post(
        "/api/login",
        { username: "admin", password: "admin123" },
        { Origin: serverOrigin, "X-CSRF-Token": preToken }
      );

      const targetUser = await storage.createUser({
        username: `target_demote_${Date.now()}`,
        password: await hashPassword("pass123!"),
        role: "member",
      });

      // Attacker attempts to change roles using admin's ambient session
      const attackRes = await adminClient.patch(
        `/api/admin/users/${targetUser.id}/role`,
        { role: "admin" },
        {
          Origin: "https://evil.org",
        }
      );

      assert.equal(attackRes.status, 403, "Cross-origin role modification must be rejected");
    });

    test("Requests with Origin: 'null' (sandboxed iframes / data URIs) are strictly rejected", async () => {
      const client = createClient(serverAddress);
      const res = await client.post(
        "/api/auth/verify-email",
        { token: "dummyToken" },
        { Origin: "null" }
      );

      assert.equal(res.status, 403);
      assert.ok(res.data.message.toLowerCase().includes("null"));
    });
  });

  describe("3. Synchronizer Token & Double-Submit Protection", () => {
    test("State-changing browser request without CSRF token is rejected with 403", async () => {
      const client = createClient(serverAddress);

      // Browser request sending Origin but omitting X-CSRF-Token
      const res = await client.post(
        "/api/auth/verify-email",
        { token: "someToken" },
        {
          Origin: serverOrigin,
        }
      );

      assert.equal(res.status, 403);
      assert.equal(res.data.code, "CSRF_TOKEN_MISSING");
    });

    test("State-changing browser request with invalid/forged CSRF token is rejected with 403", async () => {
      const client = createClient(serverAddress);
      await client.get("/api/csrf-token");

      const res = await client.post(
        "/api/auth/verify-email",
        { token: "someToken" },
        {
          Origin: serverOrigin,
          "X-CSRF-Token": "forged_invalid_csrf_token_99999999999999999999999999999999",
        }
      );

      assert.equal(res.status, 403);
      assert.equal(res.data.code, "CSRF_TOKEN_INVALID");
    });

    test("Legitimate same-origin request with matching Origin and valid CSRF token succeeds", async () => {
      const timestamp = Date.now() + 10;
      const user = await storage.createUser({
        username: `legit_user_${timestamp}`,
        password: await hashPassword("userPass123!"),
        role: "member",
        isEmailVerified: true,
      });

      const client = createClient(serverAddress);

      // 1. Get initial token
      const tokenRes = await client.get("/api/csrf-token");
      const initToken = tokenRes.data.csrfToken;

      // 2. Login with valid token & matching Origin
      const loginRes = await client.post(
        "/api/login",
        { username: user.username, password: "userPass123!" },
        {
          Origin: serverOrigin,
          "X-CSRF-Token": initToken,
        }
      );
      assert.equal(loginRes.status, 200);

      // 3. User makes booking with post-login CSRF token
      const activeCsrf = client.getCookieValue(CSRF_COOKIE_NAME)!;
      assert.ok(activeCsrf, "Active CSRF cookie must be present");

      const gameTypes = await storage.getGameTypes();
      const stations = await storage.getStations();
      const station = stations[0];
      const gt = gameTypes.find((g) => g.id === station.gameTypeId) || gameTypes[0];

      const start = new Date(Date.now() + 7200000);
      const end = new Date(Date.now() + 10800000);

      const bookingRes = await client.post(
        "/api/bookings",
        {
          gameTypeId: gt.id,
          stationId: station.id,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          playerCount: 1,
        },
        {
          Origin: serverOrigin,
          "X-CSRF-Token": activeCsrf,
        }
      );

      assert.equal(bookingRes.status, 201, "Legitimate same-origin booking must succeed");
      assert.equal(bookingRes.data.userId, user.id);
    });

    test("CSRF token supplied via body parameter (_csrf) is also accepted", async () => {
      const client = createClient(serverAddress);
      const tokenRes = await client.get("/api/csrf-token");
      const csrf = tokenRes.data.csrfToken;

      const res = await client.post(
        "/api/auth/verify-email",
        {
          token: "dummyVerificationToken",
          _csrf: csrf,
        },
        {
          Origin: serverOrigin,
        }
      );

      // Should pass CSRF check and proceed to token validation (not rejected by 403 CSRF)
      assert.notEqual(res.status, 403, "Body _csrf token should be accepted by CSRF middleware");
    });
  });

  describe("4. Safe Methods (GET, HEAD, OPTIONS) Exemption", () => {
    test("GET requests succeed without CSRF token", async () => {
      const client = createClient(serverAddress);
      const res = await client.get("/api/stations", {
        Origin: serverOrigin,
      });

      assert.equal(res.status, 200, "Safe GET requests must not require CSRF token");
      assert.ok(Array.isArray(res.data));
    });

    test("OPTIONS requests succeed without CSRF token", async () => {
      const client = createClient(serverAddress);
      const res = await client.options("/api/bookings", {
        Origin: serverOrigin,
      });

      assert.equal(res.status, 204, "OPTIONS preflight must not require CSRF token");
    });
  });

  describe("5. Explicit CORS Policy: Never Wildcard with Credentials", () => {
    test("Preflight OPTIONS from untrusted origin is rejected (403)", async () => {
      const client = createClient(serverAddress);
      const res = await client.options("/api/bookings", {
        Origin: "https://untrusted-hacker.com",
      });

      assert.equal(res.status, 403, "CORS preflight from untrusted origin must be rejected");
      const allowOrigin = res.headers.get("access-control-allow-origin");
      assert.ok(
        !allowOrigin || allowOrigin !== "*",
        "Must NEVER allow wildcard origin on CORS preflight"
      );
    });

    test("Authorized origin preflight returns explicit mirror, credentials: true, and never '*'", async () => {
      const client = createClient(serverAddress);
      const res = await client.options("/api/bookings", {
        Origin: serverOrigin,
      });

      assert.equal(res.status, 204);
      const allowOrigin = res.headers.get("access-control-allow-origin");
      const allowCredentials = res.headers.get("access-control-allow-credentials");

      assert.equal(allowOrigin, serverOrigin, "Must explicitly mirror authorized origin, not '*'");
      assert.notEqual(allowOrigin, "*", "Access-Control-Allow-Origin must NEVER be wildcard '*'");
      assert.equal(allowCredentials, "true", "Credentials must be enabled for authorized origin");
    });
  });
});
