import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { setupAuth, sanitizeUser, hashPassword } from "../server/auth";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { initDbSchema } from "../server/db";
import { seedTestUsers } from "../server/seed";
import { config } from "../server/config";
import {
  registerMockGoogleToken,
  clearMockGoogleTokens,
  GoogleUserProfile,
} from "../server/google-auth";

interface TestClient {
  cookies: string[];
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  post: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
}

function createClient(serverAddress: string): TestClient {
  let cookieJar: string[] = [];

  const request = async (method: string, urlPath: string, body?: any, customHeaders?: Record<string, string>) => {
    const fullUrl = new URL(urlPath, serverAddress);
    const headers: Record<string, string> = { ...customHeaders };
    if (cookieJar.length > 0) {
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
      for (const sc of setCookies) {
        const cookiePart = sc.split(";")[0];
        const [cName] = cookiePart.split("=");
        cookieJar = cookieJar.filter((c) => !c.startsWith(cName + "="));
        cookieJar.push(cookiePart);
      }
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
    cookies: cookieJar,
    get: (url, headers) => request("GET", url, undefined, headers),
    post: (url, body, headers) => request("POST", url, body, headers),
  };
}

describe("Google OAuth / OpenID Connect Authentication System", () => {
  let server: http.Server;
  let serverAddress: string;

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
  });

  after(async () => {
    clearMockGoogleTokens();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("1. Public Configuration Endpoint & Secret Isolation", () => {
    test("GET /api/auth/google/config exposes only client ID and enabled flag without secrets", async () => {
      const client = createClient(serverAddress);
      const res = await client.get("/api/auth/google/config");

      assert.equal(res.status, 200);
      assert.ok(typeof res.data === "object");
      assert.ok("clientId" in res.data);
      assert.ok("enabled" in res.data);
      // Secrets must never be exposed
      assert.equal(res.data.clientSecret, undefined);
      assert.equal(res.data.sessionSecret, undefined);
    });

    test("GET /api/auth/google returns safe 503 when credentials are not configured", async () => {
      const client = createClient(serverAddress);
      const res = await client.get("/api/auth/google", { Accept: "application/json" });

      if (!config.google.clientId) {
        assert.equal(res.status, 503);
        assert.equal(res.data.code, "GOOGLE_NOT_CONFIGURED");
      }
    });
  });

  describe("2. Token Validation & Error Handling (POST /api/auth/google)", () => {
    test("Rejects request when no ID token or credential is provided (400 GOOGLE_TOKEN_REQUIRED)", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/google", {});

      assert.equal(res.status, 400);
      assert.equal(res.data.code, "GOOGLE_TOKEN_REQUIRED");
    });

    test("Rejects invalid or unverified Google tokens safely", async () => {
      const unverifiedToken = "mock_token_unverified_123";
      registerMockGoogleToken(unverifiedToken, {
        sub: "google_sub_unverified_001",
        email: "unverified_google_user@gmail.com",
        email_verified: false, // Unverified Google account
        name: "Unverified User",
      });

      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/google", {
        credential: unverifiedToken,
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.code, "GOOGLE_AUTH_FAILED");
      assert.match(res.data.message, /not verified/i);
    });

    test("Rejects non-existent token (Google validation failure)", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/google", {
        credential: "completely_bogus_token_xyz999",
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.code, "GOOGLE_AUTH_FAILED");
    });
  });

  describe("3. Automatic User Creation (Continue with Google Signup)", () => {
    const googleSub = "109876543210987654321";
    const googleEmail = `new_google_player_${Date.now()}@gmail.com`;
    const googleToken = `mock_valid_token_${Date.now()}`;

    before(() => {
      registerMockGoogleToken(googleToken, {
        sub: googleSub,
        email: googleEmail,
        email_verified: true,
        name: "Alex Vance",
        picture: "https://lh3.googleusercontent.com/a/photo123",
      });
    });

    test("Automatically creates a new member account with verified email and sets session", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/google", {
        credential: googleToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.isNew, true);
      assert.equal(res.data.user.email, googleEmail);
      assert.equal(res.data.user.fullName, "Alex Vance");
      assert.equal(res.data.user.avatarUrl, "https://lh3.googleusercontent.com/a/photo123");
      assert.equal(res.data.user.role, "member");

      // Verify user in database
      const createdUser = await storage.getUserByGoogleId(googleSub);
      assert.ok(createdUser);
      assert.equal(createdUser.googleId, googleSub);
      assert.equal(createdUser.authProvider, "google");
      assert.equal(createdUser.isEmailVerified, true, "Google users must be pre-verified");
      assert.ok(createdUser.emailVerifiedAt);
      assert.equal(createdUser.emailVerificationTokenHash, null, "No verification token needed");

      // Verify active session was established
      const meRes = await client.get("/api/user");
      assert.equal(meRes.status, 200);
      assert.equal(meRes.data.email, googleEmail);

      // Audit log was recorded
      const logs = await storage.getAuditLogs(10);
      const auditEntry = logs.find((l) => l.action === "GOOGLE_ACCOUNT_CREATED" && l.userId === createdUser.id);
      assert.ok(auditEntry, "Expected GOOGLE_ACCOUNT_CREATED audit event");
    });

    test("Subsequent login with the same Google account logs into the existing user by stable sub", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/google", {
        credential: googleToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.isNew, false);
      assert.equal(res.data.user.email, googleEmail);

      // Verify session established
      const meRes = await client.get("/api/user");
      assert.equal(meRes.status, 200);
      assert.equal(meRes.data.email, googleEmail);
    });
  });

  describe("4. Safe Account Linking (Existing Local User Links Google)", () => {
    const existingEmail = `existing_local_${Date.now()}@example.com`;
    const googleSubForExisting = `99887766554433221100`;
    const googleTokenForExisting = `mock_token_existing_${Date.now()}`;
    let localUser: any;

    before(async () => {
      localUser = await storage.createUser({
        username: `local_gamer_${Date.now()}`,
        password: await hashPassword("MyLocalPass123!"),
        email: existingEmail,
        fullName: "Original Local Gamer",
        role: "member",
        authProvider: "local",
        isEmailVerified: false, // Originally unverified local user
      });

      registerMockGoogleToken(googleTokenForExisting, {
        sub: googleSubForExisting,
        email: existingEmail, // Same verified email from Google
        email_verified: true,
        name: "Updated via Google",
        picture: "https://lh3.googleusercontent.com/avatar_linked",
      });
    });

    test("Links existing account safely by verified email, saves google_id (sub), and marks verified", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/google", {
        credential: googleTokenForExisting,
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.isNew, false);
      assert.equal(res.data.linked, true);
      assert.equal(res.data.user.id, localUser.id);

      // Check DB record
      const updatedUser = await storage.getUser(localUser.id);
      assert.ok(updatedUser);
      assert.equal(updatedUser.googleId, googleSubForExisting, "Should save Google stable sub");
      assert.equal(updatedUser.authProvider, "google");
      assert.equal(updatedUser.isEmailVerified, true, "Linking verified Google account marks email as verified");
      assert.ok(updatedUser.emailVerifiedAt);

      // Check audit log
      const logs = await storage.getAuditLogs(10);
      const linkLog = logs.find((l) => l.action === "GOOGLE_ACCOUNT_LINKED" && l.userId === localUser.id);
      assert.ok(linkLog, "Expected GOOGLE_ACCOUNT_LINKED audit event");
    });
  });

  describe("5. Member Privileges & Station Booking Feature Access for Google Users", () => {
    const bookingPlayerSub = `player_sub_${Date.now()}`;
    const bookingPlayerEmail = `google_booker_${Date.now()}@gmail.com`;
    const bookingToken = `mock_token_booker_${Date.now()}`;
    let bookingClient: TestClient;

    before(async () => {
      registerMockGoogleToken(bookingToken, {
        sub: bookingPlayerSub,
        email: bookingPlayerEmail,
        email_verified: true,
        name: "Google Booker",
      });

      bookingClient = createClient(serverAddress);
      await bookingClient.post("/api/auth/google", {
        credential: bookingToken,
      });
    });

    test("Google authenticated member can immediately create a station booking without separate email link", async () => {
      // Fetch game types and available stations
      const gtRes = await bookingClient.get("/api/game-types");
      assert.equal(gtRes.status, 200);
      assert.ok(Array.isArray(gtRes.data) && gtRes.data.length > 0);
      const gameTypeId = gtRes.data[0].id;

      const stRes = await bookingClient.get("/api/stations");
      assert.equal(stRes.status, 200);
      const station = stRes.data.find((s: any) => s.gameTypeId === gameTypeId);
      assert.ok(station, "Expected available station");

      const startMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const startTime = new Date(startMs).toISOString();
      const endTime = new Date(startMs + 60 * 60 * 1000).toISOString();

      const bookingRes = await bookingClient.post("/api/bookings", {
        gameTypeId,
        stationId: station.id,
        startTime,
        endTime,
        playerCount: 1,
        paymentMethod: "offline",
      });

      // Should succeed (201) because Google user is already verified
      assert.equal(
        bookingRes.status,
        201,
        "Google authenticated user should immediately be able to book stations"
      );
      assert.ok(bookingRes.data.id);
      assert.equal(bookingRes.data.gameTypeId, gameTypeId);
    });

    test("Google member CANNOT access administrative functionality (403 Forbidden)", async () => {
      const adminRes = await bookingClient.get("/api/admin/audit-logs");
      assert.equal(adminRes.status, 403, "Google member must still obey role-based authorization");

      const exportRes = await bookingClient.get("/api/admin/bookings/export");
      assert.equal(exportRes.status, 403);
    });
  });
});
