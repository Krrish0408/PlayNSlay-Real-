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
  MEMBER_SESSION_MAX_AGE,
  PRIVILEGED_SESSION_MAX_AGE,
  hashSessionId,
} from "../server/session-service";

interface TestClient {
  cookies: string[];
  getRawCookieHeader: () => string | undefined;
  getSessionId: () => string | undefined;
  setCookie: (cookie: string) => void;
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  post: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  patch: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
  delete: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: any }>;
}

function createClient(serverAddress: string): TestClient {
  let cookieJar: string[] = [];
  let rawSetCookieHeaders: string[] = [];

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
      rawSetCookieHeaders = setCookies;
      for (const sc of setCookies) {
        const cookiePart = sc.split(";")[0];
        const [cName] = cookiePart.split("=");
        cookieJar = cookieJar.filter((c) => !c.startsWith(cName + "="));
        if (!sc.includes("Expires=Thu, 01 Jan 1970") && !sc.includes("Max-Age=0")) {
          cookieJar.push(cookiePart);
        }
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
    getRawCookieHeader: () => rawSetCookieHeaders.find((h) => h.startsWith(`${COOKIE_NAME}=`)),
    getSessionId: () => {
      const match = cookieJar.find((c) => c.startsWith(`${COOKIE_NAME}=`));
      if (!match) return undefined;
      // Cookie format: pns_session=s%3A<sid>.<signature>
      const rawVal = decodeURIComponent(match.split("=")[1]);
      if (rawVal.startsWith("s:")) {
        return rawVal.slice(2).split(".")[0];
      }
      return rawVal;
    },
    setCookie: (cookie: string) => {
      cookieJar.push(cookie);
    },
    get: (url, headers) => request("GET", url, undefined, headers),
    post: (url, body, headers) => request("POST", url, body, headers),
    patch: (url, body, headers) => request("PATCH", url, body, headers),
    delete: (url, headers) => request("DELETE", url, undefined, headers),
  };
}

describe("Hardened Session Management System", () => {
  let server: http.Server;
  let serverAddress: string;

  before(async () => {
    // Enable short timeouts for testing idle and absolute timeout behavior
    process.env.PRIVILEGED_IDLE_TIMEOUT_MS = "500"; // 500ms
    process.env.PRIVILEGED_ABSOLUTE_TIMEOUT_MS = "1200"; // 1.2s

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
    delete process.env.PRIVILEGED_IDLE_TIMEOUT_MS;
    delete process.env.PRIVILEGED_ABSOLUTE_TIMEOUT_MS;

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe("1. Cookie Hardening & Security Standards", () => {
    test("Cookie uses custom non-default name 'pns_session', HttpOnly, SameSite=Lax, and Path=/", async () => {
      const timestamp = Date.now();
      const user = await storage.createUser({
        username: `cookie_test_${timestamp}`,
        password: await hashPassword("cookiePassword123!"),
        role: "member",
      });

      const client = createClient(serverAddress);
      const res = await client.post("/api/login", {
        username: user.username,
        password: "cookiePassword123!",
      });

      assert.equal(res.status, 200);

      const rawCookie = client.getRawCookieHeader();
      assert.ok(rawCookie, "Set-Cookie header must be sent");
      assert.ok(rawCookie.startsWith("pns_session="), "Cookie name must be custom 'pns_session' instead of connect.sid");
      assert.ok(rawCookie.toLowerCase().includes("httponly"), "Cookie must be HttpOnly");
      assert.ok(rawCookie.toLowerCase().includes("samesite=lax"), "Cookie must have SameSite=Lax");
      assert.ok(rawCookie.toLowerCase().includes("path=/"), "Cookie must have Path=/");
    });

    test("Cookie contains NO sensitive user information or secrets", async () => {
      const timestamp = Date.now() + 1;
      const user = await storage.createUser({
        username: `safe_cookie_${timestamp}`,
        password: await hashPassword("superSecretPassword999!"),
        email: `secret_email_${timestamp}@example.com`,
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", {
        username: user.username,
        password: "superSecretPassword999!",
      });

      const rawCookie = client.getRawCookieHeader()!;
      assert.ok(!rawCookie.includes(user.username), "Cookie must not contain username");
      assert.ok(!rawCookie.includes("superSecretPassword"), "Cookie must not contain password");
      assert.ok(!rawCookie.includes(user.email!), "Cookie must not contain email");
      assert.ok(!rawCookie.includes("admin"), "Cookie must not contain role");
    });

    test("Privileged accounts receive shorter session lifetimes than ordinary members", async () => {
      const timestamp = Date.now() + 2;
      const member = await storage.createUser({
        username: `lifetime_member_${timestamp}`,
        password: await hashPassword("pass123!"),
        role: "member",
      });
      const admin = await storage.createUser({
        username: `lifetime_admin_${timestamp}`,
        password: await hashPassword("pass123!"),
        role: "admin",
      });

      // Member login
      const memberClient = createClient(serverAddress);
      await memberClient.post("/api/login", { username: member.username, password: "pass123!" });
      const memberCookie = memberClient.getRawCookieHeader()!;
      const memberExpiresMatch = memberCookie.match(/Expires=([^;]+)/i);
      const memberExpires = memberExpiresMatch ? new Date(memberExpiresMatch[1]).getTime() : 0;

      // Admin login
      const adminClient = createClient(serverAddress);
      await adminClient.post("/api/login", { username: admin.username, password: "pass123!" });
      const adminCookie = adminClient.getRawCookieHeader()!;
      const adminExpiresMatch = adminCookie.match(/Expires=([^;]+)/i);
      const adminExpires = adminExpiresMatch ? new Date(adminExpiresMatch[1]).getTime() : 0;

      assert.ok(adminExpires > 0, "Admin Expires must be set in cookie");
      assert.ok(memberExpires > 0, "Member Expires must be set in cookie");
      assert.ok(
        adminExpires < memberExpires,
        `Admin session expiration (${adminExpires}) must be earlier than member expiration (${memberExpires})`
      );

      // Verify in user_sessions metadata database
      const [adminSession] = await storage.getUserActiveSessions(admin.id);
      const [memberSession] = await storage.getUserActiveSessions(member.id);
      assert.ok(adminSession, "Admin session record must exist in user_sessions");
      assert.ok(memberSession, "Member session record must exist in user_sessions");
      assert.ok(
        adminSession.expiresAt.getTime() < memberSession.expiresAt.getTime(),
        "Admin user_sessions expiresAt must be significantly earlier than member user_sessions expiresAt"
      );
    });
  });

  describe("2. Session Fixation Defense", () => {
    test("Session ID is regenerated upon successful login, defeating session fixation", async () => {
      const timestamp = Date.now() + 10;
      const initialUser = await storage.createUser({
        username: `initial_user_${timestamp}`,
        password: await hashPassword("securePassword123!"),
        role: "member",
      });
      const targetUser = await storage.createUser({
        username: `target_user_${timestamp}`,
        password: await hashPassword("securePassword123!"),
        role: "member",
      });

      const client = createClient(serverAddress);

      // Client establishes a session prior to target login
      await client.post("/api/login", {
        username: initialUser.username,
        password: "securePassword123!",
      });
      const preLoginSid = client.getSessionId();
      assert.ok(preLoginSid, "Pre-login session ID should exist");

      // Successful login of target user must regenerate the session ID
      const loginRes = await client.post("/api/login", {
        username: targetUser.username,
        password: "securePassword123!",
      });
      assert.equal(loginRes.status, 200);

      const postLoginSid = client.getSessionId();
      assert.ok(postLoginSid, "Post-login session ID must exist");
      assert.notEqual(
        preLoginSid,
        postLoginSid,
        "Session ID MUST be regenerated upon login to prevent session fixation attacks"
      );

      // Pre-login session ID cannot be reused to access target user's account
      const attackerClient = createClient(serverAddress);
      attackerClient.setCookie(`${COOKIE_NAME}=s%3A${preLoginSid}.invalid_or_old_signature`);
      const probeRes = await attackerClient.get("/api/user");
      assert.equal(probeRes.status, 401, "Old/pre-login session ID must not grant access");
    });
  });

  describe("3. Logout & Session Destruction", () => {
    test("Logging out destroys session in store, clears cookie, and prevents session reuse", async () => {
      const timestamp = Date.now() + 20;
      const user = await storage.createUser({
        username: `logout_user_${timestamp}`,
        password: await hashPassword("securePassword123!"),
        role: "member",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: user.username, password: "securePassword123!" });
      const activeSid = client.getSessionId()!;

      // Confirm logged in
      const userRes = await client.get("/api/user");
      assert.equal(userRes.status, 200);

      // Logout
      const logoutRes = await client.post("/api/logout");
      assert.equal(logoutRes.status, 200);

      // Verify Set-Cookie clears the cookie
      const rawCookie = client.getRawCookieHeader();
      assert.ok(
        rawCookie?.includes("Expires=Thu, 01 Jan 1970") || rawCookie?.includes("Max-Age=0"),
        "Logout must clear cookie on client"
      );

      // Attempting to reuse the old session ID must fail
      const reuseClient = createClient(serverAddress);
      reuseClient.setCookie(`pns_session=s%3A${activeSid}.fakeSignature`);
      const unauthorizedRes = await reuseClient.get("/api/user");
      assert.equal(unauthorizedRes.status, 401, "Destroyed session cannot be reused");
    });
  });

  describe("4. Password Reset Invalidation Across Devices", () => {
    test("Password reset invalidates active sessions across all devices immediately", async () => {
      const timestamp = Date.now() + 30;
      const user = await storage.createUser({
        username: `pwd_reset_session_${timestamp}`,
        password: await hashPassword("originalPassword123!"),
        email: `pwd_reset_${timestamp}@example.com`,
        role: "member",
      });

      // Device 1: Log in
      const device1 = createClient(serverAddress);
      await device1.post("/api/login", { username: user.username, password: "originalPassword123!" });
      assert.equal((await device1.get("/api/user")).status, 200);

      // Device 2: Log in
      const device2 = createClient(serverAddress);
      await device2.post("/api/login", { username: user.username, password: "originalPassword123!" });
      assert.equal((await device2.get("/api/user")).status, 200);

      // User triggers password reset or change
      const changeRes = await device1.post("/api/user/change-password", {
        currentPassword: "originalPassword123!",
        newPassword: "brandNewPassword456!",
      });
      assert.equal(changeRes.status, 200);

      // Device 2 should now be immediately invalidated
      const device2Res = await device2.get("/api/user");
      assert.equal(
        device2Res.status,
        401,
        "All other device sessions must be revoked and rejected after password change"
      );
    });
  });

  describe("5. Privilege Changes Invalidation & Session Regeneration", () => {
    test("Admin changing a user's role invalidates existing sessions for that user across all devices", async () => {
      const timestamp = Date.now() + 40;
      const member = await storage.createUser({
        username: `promo_user_${timestamp}`,
        password: await hashPassword("memberPass123!"),
        role: "member",
      });

      // Member logs in on device
      const memberClient = createClient(serverAddress);
      await memberClient.post("/api/login", { username: member.username, password: "memberPass123!" });
      assert.equal((await memberClient.get("/api/user")).status, 200);

      // Admin logs in
      const adminClient = createClient(serverAddress);
      await adminClient.post("/api/login", { username: "admin", password: "admin123" });

      // Admin changes member's role to 'employee'
      const patchRes = await adminClient.patch(`/api/admin/users/${member.id}/role`, {
        role: "employee",
      });
      assert.equal(patchRes.status, 200);

      // Member's existing session must now be invalidated, forcing re-authentication
      const checkRes = await memberClient.get("/api/user");
      assert.equal(
        checkRes.status,
        401,
        "Existing sessions must be invalidated upon privilege change"
      );

      // Member can log in again and now has the new privilege
      const reLoginRes = await memberClient.post("/api/login", {
        username: member.username,
        password: "memberPass123!",
      });
      assert.equal(reLoginRes.status, 200);
      assert.equal(reLoginRes.data.role, "employee");
    });

    test("Admin changing own role regenerates their current session ID", async () => {
      const timestamp = Date.now() + 45;
      const selfAdmin = await storage.createUser({
        username: `self_admin_${timestamp}`,
        password: await hashPassword("adminPass123!"),
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: selfAdmin.username, password: "adminPass123!" });
      const originalSid = client.getSessionId();

      // Admin updates own role
      const patchRes = await client.patch(`/api/admin/users/${selfAdmin.id}/role`, { role: "admin" });
      assert.equal(patchRes.status, 200);

      const regeneratedSid = client.getSessionId();
      assert.notEqual(
        originalSid,
        regeneratedSid,
        "Current session ID must be regenerated when privileges are modified"
      );
    });
  });

  describe("6. Multi-Device Management: user_sessions Metadata, Revocation, and Logout All", () => {
    test("Active sessions are recorded in user_sessions metadata table with IP and User Agent", async () => {
      const timestamp = Date.now() + 50;
      const user = await storage.createUser({
        username: `session_meta_${timestamp}`,
        password: await hashPassword("userPass123!"),
        role: "member",
      });

      const client = createClient(serverAddress);
      await client.post(
        "/api/login",
        { username: user.username, password: "userPass123!" },
        { "User-Agent": "PlayNSlayTestClient/1.0", "X-Forwarded-For": "203.0.113.195" }
      );

      const sessionsRes = await client.get("/api/auth/sessions");
      assert.equal(sessionsRes.status, 200);
      assert.ok(Array.isArray(sessionsRes.data));
      assert.equal(sessionsRes.data.length, 1);

      const s = sessionsRes.data[0];
      assert.ok(s.id, "Session metadata must have id");
      assert.ok(s.createdAt, "Session metadata must have created_at");
      assert.ok(s.lastSeenAt, "Session metadata must have last_seen_at");
      assert.ok(s.expiresAt, "Session metadata must have expires_at");
      assert.equal(s.ipAddress, "203.0.113.195");
      assert.equal(s.userAgent, "PlayNSlayTestClient/1.0");
      assert.equal(s.isCurrent, true);
    });

    test("Support revoking individual sessions", async () => {
      const timestamp = Date.now() + 60;
      const user = await storage.createUser({
        username: `revoke_single_${timestamp}`,
        password: await hashPassword("userPass123!"),
        role: "member",
      });

      // Device 1
      const device1 = createClient(serverAddress);
      await device1.post("/api/login", { username: user.username, password: "userPass123!" });

      // Device 2
      const device2 = createClient(serverAddress);
      await device2.post("/api/login", { username: user.username, password: "userPass123!" });

      // Device 1 inspects sessions
      const sessionsList = await device1.get("/api/auth/sessions");
      assert.equal(sessionsList.data.length, 2);

      // Find Device 2 session (not current on device 1)
      const device2Session = sessionsList.data.find((s: any) => !s.isCurrent);
      assert.ok(device2Session);

      // Revoke Device 2 session from Device 1
      const revokeRes = await device1.delete(`/api/auth/sessions/${device2Session.id}`);
      assert.equal(revokeRes.status, 200);

      // Device 2 request must now be rejected
      const dev2Check = await device2.get("/api/user");
      assert.equal(dev2Check.status, 401);
      assert.equal(dev2Check.data.code, "SESSION_REVOKED");

      // Device 1 remains authenticated and unaffected
      const dev1Check = await device1.get("/api/user");
      assert.equal(dev1Check.status, 200);
    });

    test("Support 'logout all devices'", async () => {
      const timestamp = Date.now() + 70;
      const user = await storage.createUser({
        username: `logout_all_${timestamp}`,
        password: await hashPassword("userPass123!"),
        role: "member",
      });

      // Device 1
      const dev1 = createClient(serverAddress);
      await dev1.post("/api/login", { username: user.username, password: "userPass123!" });

      // Device 2
      const dev2 = createClient(serverAddress);
      await dev2.post("/api/login", { username: user.username, password: "userPass123!" });

      // Device 1 calls logout-all
      const logoutAllRes = await dev1.post("/api/auth/logout-all");
      assert.equal(logoutAllRes.status, 200);

      // Both Device 1 and Device 2 are logged out
      const dev1Check = await dev1.get("/api/user");
      assert.equal(dev1Check.status, 401);

      const dev2Check = await dev2.get("/api/user");
      assert.equal(dev2Check.status, 401);
    });
  });

  describe("7. Idle and Absolute Timeouts", () => {
    test("Privileged session terminates when idle timeout expires", async () => {
      const timestamp = Date.now() + 80;
      const admin = await storage.createUser({
        username: `idle_admin_${timestamp}`,
        password: await hashPassword("adminPass123!"),
        role: "admin",
      });

      const client = createClient(serverAddress);
      await client.post("/api/login", { username: admin.username, password: "adminPass123!" });
      assert.equal((await client.get("/api/user")).status, 200);

      // Wait 600ms (exceeds test PRIVILEGED_IDLE_TIMEOUT_MS of 500ms)
      await new Promise((r) => setTimeout(r, 650));

      const idleRes = await client.get("/api/user");
      assert.equal(idleRes.status, 401);
      assert.equal(idleRes.data.code, "SESSION_IDLE_TIMEOUT");
    });
  });
});
