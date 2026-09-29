import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { generateSync } from "otplib";
import { setupAuth, sanitizeUser, hashPassword } from "../server/auth";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { initDbSchema } from "../server/db";
import { seedTestUsers } from "../server/seed";
import { decryptMfaSecret } from "../server/mfa-service";

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

describe("TOTP-based Multi-Factor Authentication (MFA) for Privileged Accounts", () => {
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
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe("1. MFA Setup, QR Flow, and Verification Before Activation", () => {
    test("Unauthenticated user cannot initiate MFA setup", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/mfa/setup");
      assert.equal(res.status, 401);
    });

    test("Privileged user receives QR code, otpauthUrl, manualEntryKey, and recovery codes", async () => {
      const timestamp = Date.now();
      const adminUser = await storage.createUser({
        username: `admin_mfa_${timestamp}`,
        password: await hashPassword("adminPass123!"),
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: adminUser.username, password: "adminPass123!" });

      const setupRes = await client.post("/api/auth/mfa/setup");
      assert.equal(setupRes.status, 200);
      assert.ok(setupRes.data.qrCode, "Must return QR code data URL");
      assert.ok(setupRes.data.qrCode.startsWith("data:image/png;base64,"), "QR code must be a base64 PNG data URL");
      assert.ok(setupRes.data.otpauthUrl, "Must return otpauth URL");
      assert.ok(setupRes.data.manualEntryKey, "Must return manual base32 secret");
      assert.ok(Array.isArray(setupRes.data.recoveryCodes), "Must return recovery codes array");
      assert.equal(setupRes.data.recoveryCodes.length, 8, "Must generate 8 recovery codes");

      // Verify MFA is NOT yet active in database before user verifies OTP
      const dbUser = await storage.getUser(adminUser.id);
      assert.equal(dbUser?.isMfaEnabled, false, "MFA must remain disabled before verification");
      assert.equal(dbUser?.mfaSecret, null, "MFA secret must not be committed before verification");
    });

    test("Activation fails with invalid OTP code", async () => {
      const timestamp = Date.now() + 1;
      const adminUser = await storage.createUser({
        username: `admin_mfa_bad_${timestamp}`,
        password: await hashPassword("adminPass123!"),
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: adminUser.username, password: "adminPass123!" });
      await client.post("/api/auth/mfa/setup");

      const activateRes = await client.post("/api/auth/mfa/activate", { token: "000000" });
      assert.equal(activateRes.status, 400);
      assert.equal(activateRes.data.code, "INVALID_MFA_TOKEN");

      const dbUser = await storage.getUser(adminUser.id);
      assert.equal(dbUser?.isMfaEnabled, false, "MFA must not be enabled when activation fails");
    });

    test("Successful activation enables MFA, encrypts secret at rest, and stores hashed recovery codes", async () => {
      const timestamp = Date.now() + 2;
      const adminUser = await storage.createUser({
        username: `admin_mfa_ok_${timestamp}`,
        password: await hashPassword("adminPass123!"),
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: adminUser.username, password: "adminPass123!" });
      const setupRes = await client.post("/api/auth/mfa/setup");
      const secret = setupRes.data.manualEntryKey;

      const validToken = generateSync({ secret });
      const activateRes = await client.post("/api/auth/mfa/activate", { token: validToken });
      assert.equal(activateRes.status, 200);
      assert.equal(activateRes.data.success, true);

      // Verify DB state
      const dbUser = await storage.getUser(adminUser.id);
      assert.equal(dbUser?.isMfaEnabled, true);
      assert.ok(dbUser?.mfaSecret, "Secret must be saved in database");
      assert.notEqual(dbUser?.mfaSecret, secret, "Secret must NOT be stored in plain text");
      assert.ok(dbUser?.mfaSecret?.includes(":"), "Secret must be stored in encrypted format <iv>:<tag>:<ciphertext>");

      // Verify decryption works
      const decrypted = decryptMfaSecret(dbUser!.mfaSecret!);
      assert.equal(decrypted, secret, "Encrypted secret must decrypt to original TOTP secret");

      // Verify recovery codes are stored as SHA-256 hashes, not plain text
      assert.ok(dbUser?.mfaRecoveryCodes, "Recovery codes must be stored");
      const hashes = JSON.parse(dbUser!.mfaRecoveryCodes!);
      assert.equal(hashes.length, 8);
      for (const h of hashes) {
        assert.equal(h.length, 64, "Stored recovery codes must be 64-char SHA-256 hex strings");
        assert.ok(!setupRes.data.recoveryCodes.includes(h), "Stored values must not be the raw recovery codes");
      }
    });
  });

  describe("2. Backend MFA State Enforcement: Login Challenge & Protected Resource Gating", () => {
    let mfaAdmin: any;
    let mfaSecret: string;
    let recoveryCodes: string[];

    before(async () => {
      const timestamp = Date.now() + 10;
      mfaAdmin = await storage.createUser({
        username: `mfa_enforced_${timestamp}`,
        password: await hashPassword("securePassword123!"),
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: mfaAdmin.username, password: "securePassword123!" });
      const setupRes = await client.post("/api/auth/mfa/setup");
      mfaSecret = setupRes.data.manualEntryKey;
      recoveryCodes = setupRes.data.recoveryCodes;
      const token = generateSync({ secret: mfaSecret });
      await client.post("/api/auth/mfa/activate", { token });
    });

    test("Password login for MFA-enabled user returns mfaRequired: true without granting access", async () => {
      const client = createClient(serverAddress);
      const loginRes = await client.post("/api/login", {
        username: mfaAdmin.username,
        password: "securePassword123!",
      });

      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.data.mfaRequired, true);

      // Verify that accessing protected endpoints is blocked with 403 MFA_REQUIRED
      const adminUsersRes = await client.get("/api/admin/users");
      assert.equal(adminUsersRes.status, 403);
      assert.equal(adminUsersRes.data.code, "MFA_REQUIRED");

      const bookingsRes = await client.get("/api/bookings");
      assert.equal(bookingsRes.status, 403);
      assert.equal(bookingsRes.data.code, "MFA_REQUIRED");
    });

    test("Invalid OTP is rejected and session remains unverified", async () => {
      const client = createClient(serverAddress);
      await client.post("/api/login", { username: mfaAdmin.username, password: "securePassword123!" });

      const verifyRes = await client.post("/api/auth/mfa/verify", { code: "111222" });
      assert.equal(verifyRes.status, 400);
      assert.equal(verifyRes.data.code, "INVALID_MFA_TOKEN");

      // Protected endpoint is still blocked
      const adminUsersRes = await client.get("/api/admin/users");
      assert.equal(adminUsersRes.status, 403);
      assert.equal(adminUsersRes.data.code, "MFA_REQUIRED");
    });

    test("Successful TOTP verification completes login and unlocks protected endpoints", async () => {
      // Clear previous timestep (from activation) so fresh verification token is accepted
      await storage.updateUser(mfaAdmin.id, { mfaLastUsedTimestep: null });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: mfaAdmin.username, password: "securePassword123!" });

      const token = generateSync({ secret: mfaSecret });
      const verifyRes = await client.post("/api/auth/mfa/verify", { code: token });
      assert.equal(verifyRes.status, 200);
      assert.equal(verifyRes.data.success, true);

      // Protected endpoint is now unlocked!
      const adminUsersRes = await client.get("/api/admin/users");
      assert.equal(adminUsersRes.status, 200);
      assert.ok(Array.isArray(adminUsersRes.data));
    });
  });

  describe("3. Replay Protection", () => {
    test("Replaying the exact same TOTP token in the same time step is strictly rejected", async () => {
      const timestamp = Date.now() + 20;
      const user = await storage.createUser({
        username: `replay_test_${timestamp}`,
        password: await hashPassword("securePassword123!"),
        role: "employee",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "securePassword123!" });
      const setupRes = await client.post("/api/auth/mfa/setup");
      const secret = setupRes.data.manualEntryKey;
      const token = generateSync({ secret });
      await client.post("/api/auth/mfa/activate", { token });

      // Second client attempts to verify with the SAME token that was just used
      const client2 = createClient(serverAddress);
      await client2.post("/api/login", { username: user.username, password: "securePassword123!" });

      const replayRes = await client2.post("/api/auth/mfa/verify", { code: token });
      assert.equal(replayRes.status, 400);
      assert.equal(replayRes.data.code, "MFA_TOKEN_REPLAY");
      assert.ok(replayRes.data.message.includes("already been used"));
    });
  });

  describe("4. Single-Use Recovery Codes", () => {
    let user: any;
    let recoveryCodes: string[];

    before(async () => {
      const timestamp = Date.now() + 30;
      user = await storage.createUser({
        username: `recovery_test_${timestamp}`,
        password: await hashPassword("securePassword123!"),
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "securePassword123!" });
      const setupRes = await client.post("/api/auth/mfa/setup");
      recoveryCodes = setupRes.data.recoveryCodes;
      const token = generateSync({ secret: setupRes.data.manualEntryKey });
      await client.post("/api/auth/mfa/activate", { token });
    });

    test("Recovery code successfully verifies MFA and grants access", async () => {
      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "securePassword123!" });

      const firstCode = recoveryCodes[0];
      const verifyRes = await client.post("/api/auth/mfa/verify", { code: firstCode });
      assert.equal(verifyRes.status, 200);
      assert.equal(verifyRes.data.usedRecoveryCode, true);

      // Verify access granted
      const adminUsersRes = await client.get("/api/admin/users");
      assert.equal(adminUsersRes.status, 200);
    });

    test("Re-using the same recovery code is strictly rejected (single-use)", async () => {
      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "securePassword123!" });

      const firstCode = recoveryCodes[0];
      const reusedRes = await client.post("/api/auth/mfa/verify", { code: firstCode });
      assert.equal(reusedRes.status, 400);
      assert.equal(reusedRes.data.code, "INVALID_RECOVERY_CODE");

      // Verify access still blocked
      const adminUsersRes = await client.get("/api/admin/users");
      assert.equal(adminUsersRes.status, 403);
    });

    test("Second unused recovery code succeeds", async () => {
      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "securePassword123!" });

      const secondCode = recoveryCodes[1];
      const verifyRes = await client.post("/api/auth/mfa/verify", { code: secondCode });
      assert.equal(verifyRes.status, 200);
      assert.equal(verifyRes.data.usedRecoveryCode, true);
    });
  });

  describe("5. Rate Limiting on MFA Verification Attempts", () => {
    test("Excessive failed verification attempts trigger rate limiting (429 or RATE_LIMITED)", async () => {
      const timestamp = Date.now() + 40;
      const user = await storage.createUser({
        username: `ratelimit_mfa_${timestamp}`,
        password: await hashPassword("securePassword123!"),
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "securePassword123!" });
      const setupRes = await client.post("/api/auth/mfa/setup");
      const token = generateSync({ secret: setupRes.data.manualEntryKey });
      await client.post("/api/auth/mfa/activate", { token });

      // Create a fresh client and attempt failed verifications
      const attackClient = createClient(serverAddress);
      await attackClient.post("/api/login", { username: user.username, password: "securePassword123!" });

      let rateLimited = false;
      // Send 25 consecutive invalid attempts to exceed test threshold (20)
      for (let i = 0; i < 25; i++) {
        const res = await attackClient.post("/api/auth/mfa/verify", { code: "999999" });
        if (res.status === 429) {
          rateLimited = true;
          break;
        }
      }

      assert.ok(rateLimited, "Rate limiter must throttle excessive MFA verification attempts with HTTP 429");
    });
  });

  describe("6. Disabling MFA and Revocation Controls", () => {
    let user: any;
    let secret: string;
    let recoveryCodes: string[];

    before(async () => {
      const timestamp = Date.now() + 50;
      user = await storage.createUser({
        username: `disable_mfa_${timestamp}`,
        password: await hashPassword("userSecretPassword!"),
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "userSecretPassword!" });
      const setupRes = await client.post("/api/auth/mfa/setup");
      secret = setupRes.data.manualEntryKey;
      recoveryCodes = setupRes.data.recoveryCodes;
      const token = generateSync({ secret });
      await client.post("/api/auth/mfa/activate", { token });
    });

    test("Admin cannot disable MFA without password reauthentication", async () => {
      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "userSecretPassword!" });
      const token = generateSync({ secret });
      await client.post("/api/auth/mfa/verify", { code: token });

      // Attempt to disable without password
      const res = await client.post("/api/auth/mfa/disable", { code: token });
      assert.equal(res.status, 401);
      assert.equal(res.data.code, "PASSWORD_REQUIRED");

      // Attempt to disable with WRONG password
      const resWrong = await client.post("/api/auth/mfa/disable", { password: "wrongPassword!", code: token });
      assert.equal(resWrong.status, 401);
      assert.equal(resWrong.data.code, "INVALID_CREDENTIALS");
    });

    test("Admin cannot disable MFA with valid password but missing/invalid MFA token", async () => {
      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "userSecretPassword!" });
      const token = generateSync({ secret });
      await client.post("/api/auth/mfa/verify", { code: token });

      // Valid password, but bad OTP code
      const res = await client.post("/api/auth/mfa/disable", {
        password: "userSecretPassword!",
        code: "000000",
      });
      assert.equal(res.status, 400);
      assert.equal(res.data.code, "INVALID_MFA_TOKEN");
    });

    test("Admin successfully disables MFA with password + valid OTP reauthentication", async () => {
      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "userSecretPassword!" });
      const token = generateSync({ secret });
      await client.post("/api/auth/mfa/verify", { code: token });

      // Valid password + valid recovery code for disable
      const disableRes = await client.post("/api/auth/mfa/disable", {
        password: "userSecretPassword!",
        code: recoveryCodes[0],
      });
      assert.equal(disableRes.status, 200);
      assert.equal(disableRes.data.success, true);

      // Verify DB reflects MFA disabled
      const dbUser = await storage.getUser(user.id);
      assert.equal(dbUser?.isMfaEnabled, false);
      assert.equal(dbUser?.mfaSecret, null);
      assert.equal(dbUser?.mfaRecoveryCodes, null);

      // User can now log in without MFA requirement
      const newClient = createClient(serverAddress);
      const loginRes = await newClient.post("/api/login", {
        username: user.username,
        password: "userSecretPassword!",
      });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.data.mfaRequired, undefined);

      // Protected endpoint works immediately
      const adminUsersRes = await newClient.get("/api/admin/users");
      assert.equal(adminUsersRes.status, 200);
    });

    test("Admin can revoke/reset MFA for another user (with admin reauthentication)", async () => {
      // 1. Create a user with MFA enabled
      const timestamp = Date.now() + 60;
      const targetUser = await storage.createUser({
        username: `target_emp_${timestamp}`,
        password: await hashPassword("empPass123!"),
        role: "employee",
      });

      const empClient = createClient(serverAddress);
      await empClient.post("/api/login", { username: targetUser.username, password: "empPass123!" });
      const setupRes = await empClient.post("/api/auth/mfa/setup");
      const token = generateSync({ secret: setupRes.data.manualEntryKey });
      await empClient.post("/api/auth/mfa/activate", { token });

      // 2. Admin logs in
      const adminClient = createClient(serverAddress);
      await adminClient.post("/api/login", { username: "admin", password: "admin123" });

      // Admin attempts reset without reauthentication password
      const noPassRes = await adminClient.post(`/api/admin/users/${targetUser.id}/mfa/reset`, {});
      assert.equal(noPassRes.status, 401);
      assert.equal(noPassRes.data.code, "PASSWORD_REQUIRED");

      // Admin resets with valid password
      const resetRes = await adminClient.post(`/api/admin/users/${targetUser.id}/mfa/reset`, {
        adminPassword: "admin123",
      });
      assert.equal(resetRes.status, 200);
      assert.equal(resetRes.data.success, true);

      // Target user in DB has MFA revoked
      const updatedTarget = await storage.getUser(targetUser.id);
      assert.equal(updatedTarget?.isMfaEnabled, false);
      assert.equal(updatedTarget?.mfaSecret, null);
    });
  });

  describe("7. Security Hygiene: Never Exposing Secrets in Normal Responses & Audit Logging", () => {
    test("MFA secret and recovery codes are NEVER exposed in API responses", async () => {
      const timestamp = Date.now() + 70;
      const user = await storage.createUser({
        username: `sanitize_check_${timestamp}`,
        password: await hashPassword("securePassword123!"),
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "securePassword123!" });
      const setupRes = await client.post("/api/auth/mfa/setup");
      const token = generateSync({ secret: setupRes.data.manualEntryKey });
      await client.post("/api/auth/mfa/activate", { token });

      // Check /api/user
      const userRes = await client.get("/api/user");
      assert.equal(userRes.status, 200);
      assert.equal(userRes.data.mfaSecret, undefined);
      assert.equal(userRes.data.mfaRecoveryCodes, undefined);
      assert.equal(userRes.data.mfaLastUsedTimestep, undefined);
      assert.equal(userRes.data.password, undefined);

      // Check /api/admin/users
      const adminUsersRes = await client.get("/api/admin/users");
      assert.equal(adminUsersRes.status, 200);
      const foundInList = adminUsersRes.data.find((u: any) => u.id === user.id);
      assert.ok(foundInList);
      assert.equal(foundInList.mfaSecret, undefined);
      assert.equal(foundInList.mfaRecoveryCodes, undefined);
      assert.equal(foundInList.mfaLastUsedTimestep, undefined);
      assert.equal(foundInList.password, undefined);
    });

    test("Security audit logs record MFA enable, disable, verify, and recovery code events", async () => {
      const logs = await storage.getAuditLogs(50);
      const actions = logs.map((l) => l.action);

      assert.ok(actions.includes("MFA_ENABLED"), "Audit logs must record MFA_ENABLED");
      assert.ok(actions.includes("MFA_VERIFIED"), "Audit logs must record MFA_VERIFIED");
      assert.ok(actions.includes("MFA_RECOVERY_CODE_USED"), "Audit logs must record MFA_RECOVERY_CODE_USED");
      assert.ok(actions.includes("MFA_DISABLED"), "Audit logs must record MFA_DISABLED");
      assert.ok(actions.includes("MFA_REVOKED_BY_ADMIN"), "Audit logs must record MFA_REVOKED_BY_ADMIN");
    });
  });
});
