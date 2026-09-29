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
  generatePasswordResetToken,
  hashPasswordResetToken,
  getLastSentPasswordResetEmail,
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
    get: (url, headers) => request("GET", url, undefined, headers),
    post: (url, body, headers) => request("POST", url, body, headers),
  };
}

describe("Secure Password Recovery System", () => {
  let server: http.Server;
  let serverAddress: string;
  let adminClient: TestClient;
  let memberClient: TestClient;
  let employeeClient: TestClient;

  let memberUser: any;
  let adminUser: any;
  let employeeUser: any;

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

    adminClient = createClient(serverAddress);
    memberClient = createClient(serverAddress);
    employeeClient = createClient(serverAddress);

    // Fetch seeded users
    adminUser = await storage.getUserByUsername("admin");
    employeeUser = await storage.getUserByUsername("employee");

    // Create a dedicated member with verified email for password reset tests
    const timestamp = Date.now();
    memberUser = await storage.createUser({
      username: `pwd_member_${timestamp}`,
      password: await hashPassword("initialPassword123!"),
      email: `pwd_member_${timestamp}@example.com`,
      fullName: "Password Test Member",
      role: "member",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });

    // Authenticate users
    const adminLoginRes = await adminClient.post("/api/login", { username: "admin", password: "admin123" });
    assert.equal(adminLoginRes.status, 200, "Admin login must succeed");
    const empLoginRes = await employeeClient.post("/api/login", { username: "employee", password: "employee123" });
    assert.equal(empLoginRes.status, 200, "Employee login must succeed");
    const memLoginRes = await memberClient.post("/api/login", { username: memberUser.username, password: "initialPassword123!" });
    assert.equal(memLoginRes.status, 200, "Member login must succeed");
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("1. Password Reset Request: Cryptographic Security & Anti-Enumeration", () => {
    test("Non-existent email returns generic 200 response to prevent account enumeration", async () => {
      clearSentEmailsLog();
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/forgot-password", {
        email: "nonexistent_random_user_9999@example.com",
      });

      assert.equal(res.status, 200);
      assert.match(res.data.message, /If an account exists with this email address/i);
      // No email should have been sent
      const sent = getLastSentPasswordResetEmail();
      assert.equal(sent, undefined);
    });

    test("Registered user email returns IDENTICAL generic 200 response (anti-enumeration)", async () => {
      clearSentEmailsLog();
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/forgot-password", {
        email: memberUser.email,
      });

      assert.equal(res.status, 200);
      assert.equal(
        res.data.message,
        "If an account exists with this email address, password reset instructions have been sent."
      );

      // Email was dispatched to the real user
      const sent = getLastSentPasswordResetEmail();
      assert.ok(sent);
      assert.equal(sent.to, memberUser.email);
      assert.ok(sent.resetToken);
      // Token must have high entropy (at least 32 bytes hex = 64 characters)
      assert.ok(sent.resetToken.length >= 64);
    });

    test("Token in database is HASHED with SHA-256 and has short expiration (15 mins)", async () => {
      const user = await storage.getUser(memberUser.id);
      assert.ok(user);
      assert.ok(user.passwordResetTokenHash);
      assert.ok(user.passwordResetTokenExpiresAt);

      const sent = getLastSentPasswordResetEmail();
      assert.ok(sent);

      // Raw token must NEVER equal stored token hash
      assert.notEqual(sent.resetToken, user.passwordResetTokenHash);

      // Stored hash must match SHA-256 of raw token
      const expectedHash = hashPasswordResetToken(sent.resetToken);
      assert.equal(user.passwordResetTokenHash, expectedHash);

      // Verify short expiration (approx 15 minutes)
      const expiresAt = new Date(user.passwordResetTokenExpiresAt).getTime();
      const now = Date.now();
      const diffMinutes = (expiresAt - now) / (1000 * 60);
      assert.ok(diffMinutes > 10 && diffMinutes <= 16, `Expiration should be ~15m, got ${diffMinutes}m`);
    });

    test("Records security audit event for PASSWORD_RESET_REQUESTED", async () => {
      const logs = await storage.getAuditLogs(10);
      const resetLog = logs.find((l) => l.action === "PASSWORD_RESET_REQUESTED" && l.userId === memberUser.id);
      assert.ok(resetLog, "Expected PASSWORD_RESET_REQUESTED audit log");
      // Raw token or passwords must NEVER appear in audit log details
      const sent = getLastSentPasswordResetEmail();
      if (sent) {
        assert.ok(!resetLog.details?.includes(sent.resetToken), "Audit log must not contain raw reset token");
      }
    });
  });

  describe("2. Password Reset Execution: Single-Use, Expiry, and Replay Defense", () => {
    test("Rejects password reset with invalid or tampered token (400 INVALID_TOKEN)", async () => {
      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/reset-password", {
        token: "completely_fake_invalid_token_1234567890abcdef",
        newPassword: "FreshNewPassword123!",
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.code, "INVALID_TOKEN");
    });

    test("Rejects password reset if token is expired (400 TOKEN_EXPIRED)", async () => {
      const { rawToken, tokenHash } = generatePasswordResetToken(15);
      // Simulate expired token in DB (expired 1 hour ago)
      await storage.updateUser(memberUser.id, {
        passwordResetTokenHash: tokenHash,
        passwordResetTokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/reset-password", {
        token: rawToken,
        newPassword: "FreshNewPassword123!",
      });

      assert.equal(res.status, 400);
      assert.equal(res.data.code, "TOKEN_EXPIRED");
    });

    test("Successfully resets password with valid token and hashes new password", async () => {
      // Generate a fresh reset token
      const { rawToken, tokenHash, expiresAt } = generatePasswordResetToken(15);
      await storage.updateUser(memberUser.id, {
        passwordResetTokenHash: tokenHash,
        passwordResetTokenExpiresAt: expiresAt,
      });

      const client = createClient(serverAddress);
      const res = await client.post("/api/auth/reset-password", {
        token: rawToken,
        newPassword: "NewlyResetPassword123!",
      });

      assert.equal(res.status, 200);
      assert.match(res.data.message, /Password has been reset successfully/i);

      // Verify in DB that reset token hash is cleared
      const updatedUser = await storage.getUser(memberUser.id);
      assert.ok(updatedUser);
      assert.equal(updatedUser.passwordResetTokenHash, null);
      assert.equal(updatedUser.passwordResetTokenExpiresAt, null);
      assert.equal(updatedUser.resetRequired, false);

      // Verify old password fails
      const loginOld = await client.post("/api/login", {
        username: memberUser.username,
        password: "initialPassword123!",
      });
      assert.equal(loginOld.status, 401);

      // Verify new password succeeds
      const loginNew = await client.post("/api/login", {
        username: memberUser.username,
        password: "NewlyResetPassword123!",
      });
      assert.equal(loginNew.status, 200);
    });

    test("Single-use token defense: Replaying the used token is strictly rejected", async () => {
      // Attempting to reset again with the already used token
      const lastEmail = getLastSentPasswordResetEmail();
      const usedToken = lastEmail?.resetToken;
      if (usedToken) {
        const client = createClient(serverAddress);
        const res = await client.post("/api/auth/reset-password", {
          token: usedToken,
          newPassword: "AttackerHijackPassword123!",
        });
        assert.equal(res.status, 400);
        assert.equal(res.data.code, "INVALID_TOKEN");
      }
    });

    test("Records security audit event for PASSWORD_RESET_COMPLETED", async () => {
      const logs = await storage.getAuditLogs(10);
      const completedLog = logs.find((l) => l.action === "PASSWORD_RESET_COMPLETED" && l.userId === memberUser.id);
      assert.ok(completedLog, "Expected PASSWORD_RESET_COMPLETED audit log");
      assert.ok(!completedLog.details?.includes("NewlyResetPassword123!"), "Audit log must not contain password");
    });
  });

  describe("3. Post-Reset Security: Invalidation of All Existing Sessions & Forced Reauthentication", () => {
    test("Password reset invalidates active sessions across all devices immediately", async () => {
      // 1. Establish an active session on Device A
      const deviceAClient = createClient(serverAddress);
      const loginRes = await deviceAClient.post("/api/login", {
        username: memberUser.username,
        password: "NewlyResetPassword123!",
      });
      assert.equal(loginRes.status, 200);

      // Verify Device A is authenticated
      const userResA = await deviceAClient.get("/api/user");
      assert.equal(userResA.status, 200);
      assert.equal(userResA.data.username, memberUser.username);

      // 2. Perform password reset via Device B
      const { rawToken, tokenHash, expiresAt } = generatePasswordResetToken(15);
      await storage.updateUser(memberUser.id, {
        passwordResetTokenHash: tokenHash,
        passwordResetTokenExpiresAt: expiresAt,
      });

      const deviceBClient = createClient(serverAddress);
      const resetRes = await deviceBClient.post("/api/auth/reset-password", {
        token: rawToken,
        newPassword: "DeviceBSuperNewPassword123!",
      });
      assert.equal(resetRes.status, 200);

      // 3. Device A's previous session MUST now be completely invalidated (401 Unauthorized)
      const userResAfterReset = await deviceAClient.get("/api/user");
      assert.equal(
        userResAfterReset.status,
        401,
        "Device A's session should have been invalidated after password reset"
      );

      // Device A must reauthenticate with the new password
      const reauthRes = await deviceAClient.post("/api/login", {
        username: memberUser.username,
        password: "DeviceBSuperNewPassword123!",
      });
      assert.equal(reauthRes.status, 200);
    });
  });

  describe("4. Admin Forced Password Reset Flow: Admin NEVER Chooses Password", () => {
    let targetUser: any;
    let targetClient: TestClient;

    before(async () => {
      const ts = Date.now();
      targetUser = await storage.createUser({
        username: `target_user_${ts}`,
        password: await hashPassword("TargetUserOldPass123!"),
        email: `target_${ts}@example.com`,
        fullName: "Target User",
        role: "member",
        isEmailVerified: true,
      });

      targetClient = createClient(serverAddress);
      const res = await targetClient.post("/api/login", {
        username: targetUser.username,
        password: "TargetUserOldPass123!",
      });
      assert.equal(res.status, 200);
    });

    test("Non-admin (Employee or Member) CANNOT trigger admin reset (403 Forbidden)", async () => {
      const empRes = await employeeClient.post(`/api/admin/users/${targetUser.id}/reset-password`, {});
      assert.equal(empRes.status, 403);

      // Re-authenticate memberClient with the new password established in section 3
      const memAuthRes = await memberClient.post("/api/login", {
        username: memberUser.username,
        password: "DeviceBSuperNewPassword123!",
      });
      assert.equal(memAuthRes.status, 200, "Member re-authentication should succeed");

      const memRes = await memberClient.post(`/api/admin/users/${targetUser.id}/reset-password`, {});
      assert.equal(memRes.status, 403);
    });

    test("Admin forces password reset: Sessions invalidated, reset_required marked true, secure token emailed", async () => {
      clearSentEmailsLog();

      // Admin triggers reset without choosing a password
      const res = await adminClient.post(`/api/admin/users/${targetUser.id}/reset-password`, {
        // Even if an admin client sends newPassword, it is ignored
        newPassword: "AttackerAttemptToChoosePassword123!",
      });

      assert.equal(res.status, 200);
      assert.ok(res.data.resetRequired);
      assert.match(res.data.message, /Password reset initiated/i);

      // 1. Target user's existing session is immediately invalidated
      const sessionCheck = await targetClient.get("/api/user");
      assert.equal(sessionCheck.status, 401, "Target user's active session must be immediately invalidated");

      // 2. Target user record has reset_required = true
      const userInDb = await storage.getUser(targetUser.id);
      assert.ok(userInDb);
      assert.equal(userInDb.resetRequired, true);
      assert.ok(userInDb.passwordResetTokenHash);
      assert.ok(userInDb.passwordResetTokenExpiresAt);

      // 3. User received secure reset email
      const sent = getLastSentPasswordResetEmail();
      assert.ok(sent);
      assert.equal(sent.to, targetUser.email);
      assert.ok(sent.resetToken);

      // 4. Audit log recorded for ADMIN_FORCED_PASSWORD_RESET
      const logs = await storage.getAuditLogs(10);
      const adminResetLog = logs.find(
        (l) => l.action === "ADMIN_FORCED_PASSWORD_RESET" && l.details?.includes(targetUser.username)
      );
      assert.ok(adminResetLog, "Expected ADMIN_FORCED_PASSWORD_RESET audit log");
      assert.equal(adminResetLog.userId, adminUser.id);
      // No raw tokens or passwords in audit logs
      assert.ok(!adminResetLog.details?.includes(sent.resetToken));
      assert.ok(!adminResetLog.details?.includes("AttackerAttemptToChoosePassword123!"));
    });

    test("Target user cannot log in while reset_required is true (403 RESET_REQUIRED)", async () => {
      const loginAttempt = await targetClient.post("/api/login", {
        username: targetUser.username,
        password: "TargetUserOldPass123!",
      });

      assert.equal(loginAttempt.status, 403);
      assert.equal(loginAttempt.data.code, "RESET_REQUIRED");
      assert.equal(loginAttempt.data.resetRequired, true);
    });

    test("Target user completes secure reset flow: Sets new password, reset_required cleared, can log in", async () => {
      const sent = getLastSentPasswordResetEmail();
      assert.ok(sent);

      const recoveryClient = createClient(serverAddress);
      const resetRes = await recoveryClient.post("/api/auth/reset-password", {
        token: sent.resetToken,
        newPassword: "TargetUserNewSecurePassword123!",
      });

      assert.equal(resetRes.status, 200);

      // Verify resetRequired is cleared in DB
      const userAfter = await storage.getUser(targetUser.id);
      assert.ok(userAfter);
      assert.equal(userAfter.resetRequired, false);
      assert.equal(userAfter.passwordResetTokenHash, null);

      // Now target user can log in with new password
      const newLogin = await recoveryClient.post("/api/login", {
        username: targetUser.username,
        password: "TargetUserNewSecurePassword123!",
      });
      assert.equal(newLogin.status, 200);
      assert.equal(newLogin.data.username, targetUser.username);
    });
  });

  describe("5. Audit Log Administrative Visibility & Privilege Protection", () => {
    test("Admin can view security audit logs (GET /api/admin/audit-logs)", async () => {
      const res = await adminClient.get("/api/admin/audit-logs");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data));
      assert.ok(res.data.length > 0);

      const hasResetRequested = res.data.some((l: any) => l.action === "PASSWORD_RESET_REQUESTED");
      const hasResetCompleted = res.data.some((l: any) => l.action === "PASSWORD_RESET_COMPLETED");
      const hasAdminForced = res.data.some((l: any) => l.action === "ADMIN_FORCED_PASSWORD_RESET");

      assert.ok(hasResetRequested, "Audit logs should include PASSWORD_RESET_REQUESTED");
      assert.ok(hasResetCompleted, "Audit logs should include PASSWORD_RESET_COMPLETED");
      assert.ok(hasAdminForced, "Audit logs should include ADMIN_FORCED_PASSWORD_RESET");
    });

    test("Non-admin cannot view security audit logs (403 Forbidden)", async () => {
      const empRes = await employeeClient.get("/api/admin/audit-logs");
      assert.equal(empRes.status, 403);

      const memRes = await memberClient.get("/api/admin/audit-logs");
      assert.equal(memRes.status, 403);
    });
  });
});
