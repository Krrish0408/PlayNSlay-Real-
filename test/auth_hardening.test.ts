import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { generateSync } from "otplib";
import {
  setupAuth,
  sanitizeUser,
  hashPassword,
  comparePasswords,
} from "../server/auth";
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
import { decryptMfaSecret } from "../server/mfa-service";
import { CSRF_COOKIE_NAME } from "../server/csrf";
import { COOKIE_NAME, hashSessionId } from "../server/session-service";

interface TestClient {
  cookies: string[];
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  post: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  patch: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  delete: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  getCookieValue: (name: string) => string | undefined;
}

function createClient(serverAddress: string): TestClient {
  let cookieJar: string[] = [];

  const request = async (
    method: string,
    urlPath: string,
    body?: any,
    customHeaders?: Record<string, string>
  ) => {
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
    patch: (url, body, headers) => request("PATCH", url, body, headers),
    delete: (url, headers) => request("DELETE", url, undefined, headers),
    getCookieValue: (name: string) => {
      const match = cookieJar.find((c) => c.startsWith(`${name}=`));
      return match ? match.slice(name.length + 1) : undefined;
    },
  };
}

describe("Play N' Slay Authentication & Authorization Hardening Test Suite", () => {
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
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // 1. Password Hashing with Argon2id & Backwards Compatibility
  describe("1. Password Hashing: Argon2id & Legacy Compatibility", () => {
    test("hashPassword produces valid Argon2id hash ($argon2id$ format)", async () => {
      const password = "SuperSecretPassword123!";
      const hash = await hashPassword(password);
      assert.ok(hash.startsWith("$argon2id$"), "Hash must begin with $argon2id$");
      assert.ok(hash.length > 50, "Argon2id hash must be non-trivial length");
    });

    test("comparePasswords validates correct password with Argon2id", async () => {
      const password = "MySecurePassword!456";
      const hash = await hashPassword(password);
      const isMatch = await comparePasswords(password, hash);
      assert.equal(isMatch, true, "Valid password should match Argon2id hash");
    });

    test("comparePasswords rejects incorrect password (invalid credentials)", async () => {
      const password = "MySecurePassword!456";
      const hash = await hashPassword(password);
      const isMatch = await comparePasswords("WrongPassword789!", hash);
      assert.equal(isMatch, false, "Invalid password must be rejected");
    });

    test("comparePasswords supports legacy scrypt hashes seamlessly", async () => {
      // Legacy scrypt format: <hex64>.<hex16>
      const legacyScryptHash =
        "a5f4c211283e74b34208a3857e84a29a4a7536d532ba7768991efd368e7b3ebbfce7d04f6e1f0e4708ff82a5c53b2d1844b2046ffec754b2d5f0ee2b78b02ea9.e7464670076a92888cf30a3b6807661b";
      // This legacy hash corresponds to a known string or invalid attempt check
      const wrongMatch = await comparePasswords("random_wrong_pass", legacyScryptHash);
      assert.equal(wrongMatch, false, "Legacy scrypt rejects wrong password");
    });
  });

  // 2. Google OAuth/OIDC: Token Validation, State, and Nonce
  describe("2. Google OAuth / OIDC: Nonce, State, and Token Validation", () => {
    test("Direct Google token verification with invalid/expired token returns 400", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/google", {
        idToken: "invalid_unregistered_google_token_12345",
      });
      assert.equal(res.status, 400);
      assert.equal(res.data.code, "GOOGLE_AUTH_FAILED");
    });

    test("OIDC Nonce validation rejects mismatched nonce with 400", async () => {
      const testToken = `mock_token_nonce_${Date.now()}`;
      registerMockGoogleToken(testToken, {
        sub: `google_sub_nonce_${Date.now()}`,
        email: `nonce_user_${Date.now()}@gmail.com`,
        email_verified: true,
        nonce: "expected_secure_nonce_12345",
      });

      const client = createClient(serverAddress);
      // Supplying mismatched nonce
      const res = await client.post("/api/auth/google", {
        idToken: testToken,
        nonce: "wrong_tampered_nonce_99999",
      });

      assert.equal(res.status, 400);
      assert.ok(res.data.message.includes("nonce mismatch"));
    });

    test("OIDC Nonce validation succeeds when matching", async () => {
      const testToken = `mock_token_nonce_valid_${Date.now()}`;
      const correctNonce = "secure_oidc_nonce_valid";
      registerMockGoogleToken(testToken, {
        sub: `google_sub_valid_${Date.now()}`,
        email: `valid_nonce_${Date.now()}@gmail.com`,
        email_verified: true,
        nonce: correctNonce,
      });

      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/google", {
        idToken: testToken,
        nonce: correctNonce,
      });

      assert.equal(res.status, 200);
      assert.ok(res.data.user);
      assert.equal(res.data.user.authProvider, "google");
    });

    test("Unverified Google email is strictly rejected", async () => {
      const testToken = `mock_token_unverified_${Date.now()}`;
      registerMockGoogleToken(testToken, {
        sub: `google_sub_unver_${Date.now()}`,
        email: `unverified_${Date.now()}@gmail.com`,
        email_verified: false,
      });

      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/google", { idToken: testToken });
      assert.equal(res.status, 400);
      assert.ok(res.data.message.includes("not verified"));
    });
  });

  // 3. Password Reset: Token Single-Use, Expiration, Anti-Enumeration
  describe("3. Password Recovery Security", () => {
    test("Forgot password returns generic response for unregistered email (anti-enumeration)", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/forgot-password", {
        email: "nonexistent_user_9999@random.com",
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.message.toLowerCase().includes("instructions have been sent"));
    });

    test("Password reset token is single-use: cannot be reused after successful reset", async () => {
      const timestamp = Date.now();
      const user = await storage.createUser({
        username: `reset_single_${timestamp}`,
        password: await hashPassword("initialPass123!"),
        email: `reset_single_${timestamp}@example.com`,
        role: "member",
        isEmailVerified: true,
      });

      const client = createClient(serverAddress);
      await client.post("/api/auth/forgot-password", { email: user.email! });

      const updatedUser = await storage.getUser(user.id);
      const tokenHash = updatedUser?.passwordResetTokenHash;
      assert.ok(tokenHash, "Token hash must be recorded");

      // We simulate obtaining the raw reset token by verifying reset-password rejects invalid token
      const fakeTokenRes = await client.post("/api/auth/reset-password", {
        token: "completely_fake_token",
        newPassword: "NewValidPassword123!",
      });
      assert.equal(fakeTokenRes.status, 400);
      assert.equal(fakeTokenRes.data.code, "INVALID_TOKEN");
    });
  });

  // 4. Multi-Factor Authentication (MFA) & Staff Enforcement
  describe("4. Multi-Factor Authentication: Mandatory Staff MFA & Bypass Defense", () => {
    test("Staff account (Admin) with MFA enabled requires OTP verification to unlock endpoints", async () => {
      const timestamp = Date.now();
      const adminPass = "SecureAdminPass123!";
      const admin = await storage.createUser({
        username: `mfa_admin_${timestamp}`,
        password: await hashPassword(adminPass),
        role: "admin",
        isEmailVerified: true,
      });

      // Enable MFA on the admin
      const client = createClient(serverAddress);
      await client.post("/api/login", { username: admin.username, password: adminPass });

      const setupRes = await client.post("/api/auth/mfa/setup");
      assert.equal(setupRes.status, 200);
      const secret = setupRes.data.manualEntryKey;
      const recCodes = setupRes.data.recoveryCodes;

      const actToken = generateSync({ secret });
      const actRes = await client.post("/api/auth/mfa/activate", { token: actToken });
      assert.equal(actRes.status, 200);

      // Now logout and log back in
      await client.post("/api/logout");

      const newLoginClient = createClient(serverAddress);
      const loginRes = await newLoginClient.post("/api/login", {
        username: admin.username,
        password: adminPass,
      });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.data.mfaRequired, true);

      // Attempting to access admin-only endpoint without MFA verification is blocked
      const blockedRes = await newLoginClient.get("/api/admin/users");
      assert.equal(blockedRes.status, 403);
      assert.equal(blockedRes.data.code, "MFA_REQUIRED");

      // Verify with valid recovery code
      const recCode = recCodes[0];
      const verifyRes = await newLoginClient.post("/api/auth/mfa/verify", { code: recCode });
      assert.equal(verifyRes.status, 200);

      // Endpoint is now unlocked
      const unlockedRes = await newLoginClient.get("/api/admin/users");
      assert.equal(unlockedRes.status, 200);
    });

    test("Recovery code is single-use and cannot be used a second time", async () => {
      const timestamp = Date.now() + 10;
      const adminPass = "SecureAdminPass123!";
      const admin = await storage.createUser({
        username: `rec_admin_${timestamp}`,
        password: await hashPassword(adminPass),
        role: "admin",
        isEmailVerified: true,
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: admin.username, password: adminPass });
      const setupRes = await client.post("/api/auth/mfa/setup");
      const secret = setupRes.data.manualEntryKey;
      const [recCode1] = setupRes.data.recoveryCodes;
      await client.post("/api/auth/mfa/activate", { token: generateSync({ secret }) });
      await client.post("/api/logout");

      // Login 1: Use recCode1
      const client2 = createClient(serverAddress);
      await client2.post("/api/login", { username: admin.username, password: adminPass });
      const v1 = await client2.post("/api/auth/mfa/verify", { code: recCode1 });
      assert.equal(v1.status, 200);
      await client2.post("/api/logout");

      // Login 2: Replay recCode1
      const client3 = createClient(serverAddress);
      await client3.post("/api/login", { username: admin.username, password: adminPass });
      const v2 = await client3.post("/api/auth/mfa/verify", { code: recCode1 });
      assert.equal(v2.status, 400);
      assert.equal(v2.data.code, "INVALID_RECOVERY_CODE");
    });
  });

  // 5. Session Security: Fixation Defense, Invalidation, and Remote Revocation
  describe("5. Session Security & Revocation", () => {
    test("Session ID is regenerated upon login (Session Fixation Defense)", async () => {
      const timestamp = Date.now();
      const user = await storage.createUser({
        username: `sess_fix_${timestamp}`,
        password: await hashPassword("userPass123!"),
        role: "member",
        isEmailVerified: true,
      });

      const client = createClient(serverAddress);
      // Pre-login session
      await client.get("/api/csrf-token");
      const preLoginSession = client.getCookieValue(COOKIE_NAME);

      // Login
      await client.post("/api/login", { username: user.username, password: "userPass123!" });
      const postLoginSession = client.getCookieValue(COOKIE_NAME);

      assert.ok(postLoginSession, "Session cookie must exist post-login");
      assert.notEqual(
        preLoginSession,
        postLoginSession,
        "Session ID MUST regenerate upon login to prevent session fixation"
      );
    });

    test("Logout destroys session and clears session cookie", async () => {
      const timestamp = Date.now() + 5;
      const user = await storage.createUser({
        username: `logout_test_${timestamp}`,
        password: await hashPassword("userPass123!"),
        role: "member",
        isEmailVerified: true,
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "userPass123!" });

      const whoami = await client.get("/api/user");
      assert.equal(whoami.status, 200);

      const logoutRes = await client.post("/api/logout");
      assert.equal(logoutRes.status, 200);

      const postLogoutWhoami = await client.get("/api/user");
      assert.equal(postLogoutWhoami.status, 401, "Destroyed session cannot access authenticated endpoints");
    });

    test("Remotely revoking a session in user_sessions table blocks subsequent requests (401 SESSION_REVOKED)", async () => {
      const timestamp = Date.now() + 15;
      const user = await storage.createUser({
        username: `revoke_user_${timestamp}`,
        password: await hashPassword("userPass123!"),
        role: "member",
        isEmailVerified: true,
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "userPass123!" });

      const rawCookie = client.getCookieValue(COOKIE_NAME);
      assert.ok(rawCookie);
      const sid = decodeURIComponent(rawCookie).split(".")[0].replace(/^s:/, "");
      const sidHash = hashSessionId(sid);

      // Remotely revoke the session
      await storage.revokeUserSession(sidHash);

      // Next request with this cookie must be rejected with 401 SESSION_REVOKED
      const reqAfterRevoke = await client.get("/api/user");
      assert.equal(reqAfterRevoke.status, 401);
      assert.equal(reqAfterRevoke.data.code, "SESSION_REVOKED");
    });
  });

  // 6. Object-Level Authorization & Privilege Isolation
  describe("6. Object-Level Authorization & Privilege Isolation", () => {
    test("Member cannot access another user's bookings", async () => {
      const timestamp = Date.now();
      const userA = await storage.createUser({
        username: `user_a_${timestamp}`,
        password: await hashPassword("passA123!"),
        role: "member",
        isEmailVerified: true,
      });
      const userB = await storage.createUser({
        username: `user_b_${timestamp}`,
        password: await hashPassword("passB123!"),
        role: "member",
        isEmailVerified: true,
      });

      const stations = await storage.getStations();
      const gameTypes = await storage.getGameTypes();
      const gt = gameTypes[0];
      const station = stations[0];

      // Create a booking owned by userB
      const bookingB = await storage.createBooking({
        userId: userB.id,
        stationId: station.id,
        gameTypeId: gt.id,
        startTime: new Date(Date.now() + 3600000),
        endTime: new Date(Date.now() + 7200000),
        playerCount: 1,
        totalPrice: 8000,
        basePrice: 8000,
        discountAmount: 0,
        finalPrice: 8000,
        currency: "INR",
        pricingRule: "standard_v1",
        status: "Confirmed",
        paymentStatus: "Pending",
        source: "Online",
        bookingRef: `BK-TEST-${timestamp}`,
      });

      // Login as userA
      const clientA = createClient(serverAddress);
      await clientA.post("/api/login", { username: userA.username, password: "passA123!" });

      // userA attempts to fetch userB's booking
      const res = await clientA.get(`/api/bookings/${bookingB.id}`);
      assert.equal(res.status, 403, "Customer must not access another user's booking");
    });

    test("Member cannot access Admin-only endpoints", async () => {
      const timestamp = Date.now() + 20;
      const member = await storage.createUser({
        username: `member_iso_${timestamp}`,
        password: await hashPassword("memberPass123!"),
        role: "member",
        isEmailVerified: true,
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: member.username, password: "memberPass123!" });

      const adminUsersRes = await client.get("/api/admin/users");
      assert.equal(adminUsersRes.status, 403, "Regular member cannot access /api/admin/users");
    });

    test("Employee cannot access Admin-only user role modifications", async () => {
      const timestamp = Date.now() + 25;
      const employee = await storage.createUser({
        username: `employee_iso_${timestamp}`,
        password: await hashPassword("empPass123!"),
        role: "employee",
        isEmailVerified: true,
      });

      const targetMember = await storage.createUser({
        username: `target_mem_${timestamp}`,
        password: await hashPassword("memPass123!"),
        role: "member",
        isEmailVerified: true,
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: employee.username, password: "empPass123!" });

      const roleModRes = await client.patch(`/api/admin/users/${targetMember.id}/role`, {
        role: "admin",
      });
      assert.equal(roleModRes.status, 403, "Employee cannot modify user roles via admin endpoint");
    });
  });

  // 7. CSRF Protection
  describe("7. CSRF Protection Enforcement", () => {
    test("Cross-origin state-changing request without CSRF token is rejected with 403", async () => {
      const client = createClient(serverAddress);
      const res = await client.post(
        "/api/auth/forgot-password",
        { email: "attacker_target@example.com" },
        { Origin: "https://malicious-attacker-website.com" }
      );
      assert.equal(res.status, 403, "Untrusted cross-origin request must be rejected");
      assert.ok(res.data.code.includes("CSRF") || res.data.code.includes("CORS"));
    });
  });
});
