import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { setupAuth, sanitizeUser } from "../server/auth";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { initDbSchema } from "../server/db";
import { seedTestUsers } from "../server/seed";
import {
  generateVerificationToken,
  hashVerificationToken,
  getLastSentVerificationEmail,
  clearSentEmailsLog,
  getSentEmailsFor,
} from "../server/email-service";

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
    get: (url: string, headers?: Record<string, string>) => request("GET", url, undefined, headers),
    post: (url: string, body?: any, headers?: Record<string, string>) => request("POST", url, body, headers),
  };
}

describe("Secure Email Verification System", () => {
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
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("1. Cryptographic Token Generation & Hashing Security", () => {
    test("Generates 256-bit cryptographically secure raw token and sha256 hash", () => {
      const { rawToken, tokenHash, expiresAt } = generateVerificationToken(24);

      assert.equal(rawToken.length, 64, "Raw token must be 32 bytes hex (64 chars)");
      assert.equal(tokenHash.length, 64, "SHA-256 hash must be 64 chars hex");
      assert.notEqual(rawToken, tokenHash, "Raw token must never equal its hash");

      // Verify that hashing rawToken reproduces tokenHash
      const computedHash = hashVerificationToken(rawToken);
      assert.equal(computedHash, tokenHash);

      // Verify expiry is approximately 24 hours in the future
      const expectedExpiry = Date.now() + 24 * 3600 * 1000;
      assert(Math.abs(expiresAt.getTime() - expectedExpiry) < 5000);
    });
  });

  describe("2. User Registration in Unverified State & Token Dispatch", () => {
    test("Registration creates user with isEmailVerified=false and stores ONLY hashed token", async () => {
      clearSentEmailsLog();
      const client = createClient(serverAddress);
      const testEmail = `gamer_${Date.now()}@example.com`;
      const testUsername = `gamer_${Date.now()}`;

      const res = await client.post("/api/register", {
        username: testUsername,
        password: "securePassword123",
        email: testEmail,
        fullName: "Test Gamer",
      });

      assert.equal(res.status, 201);
      assert.equal(res.data.isEmailVerified, false);
      assert.equal(res.data.emailVerifiedAt, null);

      // Verify database record directly
      const dbUser = await storage.getUserByUsername(testUsername);
      assert(dbUser, "User must exist in database");
      assert.equal(dbUser.isEmailVerified, false);
      assert.equal(dbUser.emailVerifiedAt, null);
      assert(dbUser.emailVerificationTokenHash, "Hashed token must be stored");
      assert(dbUser.emailVerificationTokenExpiresAt, "Token expiry must be stored");

      // Verify that the sent email contains the RAW token and database contains ONLY the HASH
      const sentEmail = getLastSentVerificationEmail();
      assert(sentEmail, "Verification email must have been sent");
      assert.equal(sentEmail.to, testEmail);
      assert.notEqual(sentEmail.verificationToken, dbUser.emailVerificationTokenHash, "Raw token must NEVER be stored in database");
      assert.equal(hashVerificationToken(sentEmail.verificationToken), dbUser.emailVerificationTokenHash);

      // Verify sanitizeUser does not leak token hash or token expiry to client
      assert.equal((res.data as any).emailVerificationTokenHash, undefined);
      assert.equal((res.data as any).emailVerificationTokenExpiresAt, undefined);
    });

    test("Non-disclosure: Registration with existing email does not disclose user existence", async () => {
      const client1 = createClient(serverAddress);
      const client2 = createClient(serverAddress);
      const existingEmail = `existing_${Date.now()}@example.com`;

      // Register first user
      const res1 = await client1.post("/api/register", {
        username: `first_${Date.now()}`,
        password: "password123",
        email: existingEmail,
      });
      assert.equal(res1.status, 201);

      // Try registering with the same email under another username
      const res2 = await client2.post("/api/register", {
        username: `second_${Date.now()}`,
        password: "password123",
        email: existingEmail,
      });

      // Must return generic 201 without revealing that the email is already in use
      assert.equal(res2.status, 201);
      assert.doesNotMatch(JSON.stringify(res2.data), /already exists|already registered|duplicate/i);
    });
  });

  describe("3. Verification Flow & Token Single-Use (Replay Defense)", () => {
    test("Valid raw token successfully verifies email and sets email_verified_at", async () => {
      clearSentEmailsLog();
      const client = createClient(serverAddress);
      const testEmail = `verify_me_${Date.now()}@example.com`;
      const testUsername = `verify_me_${Date.now()}`;

      await client.post("/api/register", {
        username: testUsername,
        password: "password123",
        email: testEmail,
      });

      const sentEmail = getLastSentVerificationEmail();
      assert(sentEmail, "Sent email record must exist");

      // Verify using raw token
      const verifyRes = await client.post("/api/auth/verify-email", {
        token: sentEmail.verificationToken,
      });

      assert.equal(verifyRes.status, 200);
      assert.equal(verifyRes.data.user.isEmailVerified, true);
      assert(verifyRes.data.user.emailVerifiedAt, "email_verified_at must be populated");

      // Verify database state: token hash must be wiped (single-use)
      const dbUser = await storage.getUserByUsername(testUsername);
      assert(dbUser);
      assert.equal(dbUser.isEmailVerified, true);
      assert.notEqual(dbUser.emailVerifiedAt, null);
      assert.equal(dbUser.emailVerificationTokenHash, null, "Token hash must be invalidated upon use");
      assert.equal(dbUser.emailVerificationTokenExpiresAt, null, "Token expiry must be cleared");
    });

    test("Prevent token reuse: Replay of used token is rejected", async () => {
      clearSentEmailsLog();
      const client = createClient(serverAddress);
      const testEmail = `replay_${Date.now()}@example.com`;
      const testUsername = `replay_${Date.now()}`;

      await client.post("/api/register", {
        username: testUsername,
        password: "password123",
        email: testEmail,
      });

      const sentEmail = getLastSentVerificationEmail();
      assert(sentEmail);

      // First verification: success
      const firstRes = await client.post("/api/auth/verify-email", {
        token: sentEmail.verificationToken,
      });
      assert.equal(firstRes.status, 200);

      // Replay attempt with same token: rejected
      const replayRes = await client.post("/api/auth/verify-email", {
        token: sentEmail.verificationToken,
      });
      assert.equal(replayRes.status, 400);
      assert.match(replayRes.data.message, /invalid or expired/i);
    });

    test("Tampered / Invalid token is rejected", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/verify-email", {
        token: "completely_fake_invalid_token_1234567890abcdef",
      });

      assert.equal(res.status, 400);
      assert.match(res.data.message, /invalid or expired/i);
    });

    test("Expired token is rejected", async () => {
      const client = createClient(serverAddress);
      const testUsername = `expired_${Date.now()}`;
      const { rawToken, tokenHash } = generateVerificationToken(24);

      // Create user with already-expired token (1 hour ago)
      const user = await storage.createUser({
        username: testUsername,
        password: "hashedPassword123",
        email: `expired_${Date.now()}@example.com`,
        isEmailVerified: false,
        emailVerificationTokenHash: tokenHash,
        emailVerificationTokenExpiresAt: new Date(Date.now() - 3600 * 1000), // Expired
      });

      const res = await client.post("/api/auth/verify-email", {
        token: rawToken,
      });

      assert.equal(res.status, 400);
      assert.match(res.data.message, /expired/i);
    });

    test("GET /api/auth/verify-email?token=... supports browser link verification", async () => {
      clearSentEmailsLog();
      const client = createClient(serverAddress);
      const testEmail = `get_verify_${Date.now()}@example.com`;
      const testUsername = `get_verify_${Date.now()}`;

      await client.post("/api/register", {
        username: testUsername,
        password: "password123",
        email: testEmail,
      });

      const sentEmail = getLastSentVerificationEmail();
      assert(sentEmail);

      const res = await client.get(`/api/auth/verify-email?token=${sentEmail.verificationToken}`, {
        Accept: "application/json",
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.user.isEmailVerified, true);
    });
  });

  describe("4. Verification Resend & Rate Limiting", () => {
    test("Resend verification dispatches new token and invalidates previous token", async () => {
      clearSentEmailsLog();
      const client = createClient(serverAddress);
      const testEmail = `resend_${Date.now()}@example.com`;
      const testUsername = `resend_${Date.now()}`;

      await client.post("/api/register", {
        username: testUsername,
        password: "password123",
        email: testEmail,
      });

      const firstSent = getLastSentVerificationEmail();
      assert(firstSent);
      const firstToken = firstSent.verificationToken;

      // Resend verification
      const resendRes = await client.post("/api/auth/resend-verification", {
        email: testEmail,
      });
      assert.equal(resendRes.status, 200);

      const secondSent = getLastSentVerificationEmail();
      assert(secondSent);
      const secondToken = secondSent.verificationToken;

      assert.notEqual(firstToken, secondToken, "Resend must generate a new unique token");

      // Old token should now be invalid
      const oldVerifyRes = await client.post("/api/auth/verify-email", {
        token: firstToken,
      });
      assert.equal(oldVerifyRes.status, 400);

      // New token should succeed
      const newVerifyRes = await client.post("/api/auth/verify-email", {
        token: secondToken,
      });
      assert.equal(newVerifyRes.status, 200);
      assert.equal(newVerifyRes.data.user.isEmailVerified, true);
    });

    test("Resend with unknown email returns generic response without leaking user existence", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/resend-verification", {
        email: "nonexistent_email_12345@domain.com",
      });

      assert.equal(res.status, 200);
      assert.match(res.data.message, /if an unverified account exists/i);
    });
  });

  describe("5. Member Account Feature Gating: Verified Email Required", () => {
    test("Unverified member CANNOT create an online station booking (403 EMAIL_VERIFICATION_REQUIRED)", async () => {
      const client = createClient(serverAddress);
      const testUsername = `unverified_booker_${Date.now()}`;

      await client.post("/api/register", {
        username: testUsername,
        password: "password123",
        email: `unverified_${Date.now()}@example.com`,
      });

      // Fetch game types
      const typesRes = await client.get("/api/game-types");
      const gameType = typesRes.data[0];

      const start = new Date(Date.now() + 200 * 3600 * 1000).toISOString();
      const end = new Date(Date.now() + 201 * 3600 * 1000).toISOString();

      // Attempt to book without verified email
      const bookingRes = await client.post("/api/bookings", {
        gameTypeId: gameType.id,
        startTime: start,
        endTime: end,
        playerCount: 1,
      });

      assert.equal(bookingRes.status, 403);
      assert.equal(bookingRes.data.code, "EMAIL_VERIFICATION_REQUIRED");
      assert.match(bookingRes.data.message, /Email verification required/i);
    });

    test("Verified member CAN create an online station booking", async () => {
      clearSentEmailsLog();
      const client = createClient(serverAddress);
      const testEmail = `verified_booker_${Date.now()}@example.com`;
      const testUsername = `verified_booker_${Date.now()}`;

      await client.post("/api/register", {
        username: testUsername,
        password: "password123",
        email: testEmail,
      });

      const sentEmail = getLastSentVerificationEmail();
      assert(sentEmail);

      // Complete verification
      const verifyRes = await client.post("/api/auth/verify-email", {
        token: sentEmail.verificationToken,
      });
      assert.equal(verifyRes.status, 200);

      // Re-fetch current user session
      const userRes = await client.get("/api/user");
      assert.equal(userRes.data.isEmailVerified, true);

      // Fetch game types
      const typesRes = await client.get("/api/game-types");
      const gameType = typesRes.data[0];

      const start = new Date(Date.now() + 202 * 3600 * 1000).toISOString();
      const end = new Date(Date.now() + 203 * 3600 * 1000).toISOString();

      // Booking must now succeed
      const bookingRes = await client.post("/api/bookings", {
        gameTypeId: gameType.id,
        startTime: start,
        endTime: end,
        playerCount: 1,
      });

      assert.equal(bookingRes.status, 201);
      assert(bookingRes.data.id);
      assert.equal(bookingRes.data.status, "Pending");
    });
  });
});
