/**
 * BACKEND-FIRST AUTHORIZATION AUDIT
 * ===================================
 * Assumption: The attacker NEVER uses the React UI.
 * They call every REST endpoint directly using curl/fetch.
 *
 * This suite verifies that every endpoint independently enforces:
 *   1. Authentication (401 when unauthenticated)
 *   2. Role/permission authorization (403 for wrong role)
 *   3. Object-level authorization (403 when accessing another user's resources)
 *   4. Field-level authorization (sensitive fields stripped, role/status escalation blocked)
 *
 * Frontend route guards are UX only and are NOT considered here.
 * Default behavior for unlisted endpoints: DENY.
 */

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { hashPassword } from "../server/auth";
import { initDbSchema } from "../server/db";
import { MemoryStore } from "express-rate-limit";
import { setRateLimitStoreFactoryForTesting } from "../server/rate-limiter";

let server: Server;
let baseUrl: string;

interface Client {
  get(path: string): Promise<{ status: number; data: any; headers: Headers }>;
  post(path: string, body?: any): Promise<{ status: number; data: any; headers: Headers }>;
  patch(path: string, body?: any): Promise<{ status: number; data: any; headers: Headers }>;
  del(path: string): Promise<{ status: number; data: any; headers: Headers }>;
}

function makeClient(cookie?: string): Client {
  const req = async (method: string, path: string, body?: any) => {
    const headers: Record<string, string> = {};
    if (cookie) headers["Cookie"] = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (path) => req("GET", path),
    post: (path, body) => req("POST", path, body),
    patch: (path, body) => req("PATCH", path, body),
    del: (path) => req("DELETE", path),
  };
}

async function login(username: string, password: string): Promise<Client> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`Login failed for ${username} (${res.status}): ${body}`);
  }
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, `Login for ${username} must set a session cookie`);
  return makeClient(cookie);
}

// Global state
let anon: Client;
let memberA: Client;
let memberB: Client;
let memberUnverified: Client;
let employeeClient: Client;
let adminClient: Client;

let memberAUser: any;
let memberBUser: any;
let memberUnverifiedUser: any;
let employeeUser: any;
let adminUser: any;

let gameType: any;
let station: any;
let bookingA: any;
let bookingB: any;

const PASS = "Audit@Pass1";

// Endpoint authorization matrix
type AuthResult = "OK" | "FAIL";
const matrix: Array<{
  method: string; path: string; role: string;
  expected: number; actual: number; result: AuthResult;
}> = [];

function record(method: string, path: string, role: string, expected: number, actual: number) {
  matrix.push({ method, path, role, expected, actual, result: expected === actual ? "OK" : "FAIL" });
}

before(async () => {
  // Override rate-limit store to MemoryStore in tests.
  // Without this, PostgresRateLimitStore tries to write to the rate_limit_entries
  // table in PGlite which doesn't exist in the test schema, causing the store to
  // hang indefinitely on the first request that passes through a rate limiter.
  setRateLimitStoreFactoryForTesting(
    (_policy, windowMs) => new MemoryStore()
  );

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  await initDbSchema();
  server = createServer(app);
  await registerRoutes(server, app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });

  anon = makeClient();
  const hashed = await hashPassword(PASS);

  memberAUser = await storage.createUser({
    username: "audit_member_a", password: hashed, role: "member",
    membershipTier: "bronze", isEmailVerified: true, emailVerifiedAt: new Date(),
  });
  memberBUser = await storage.createUser({
    username: "audit_member_b", password: hashed, role: "member",
    membershipTier: "bronze", isEmailVerified: true, emailVerifiedAt: new Date(),
  });
  memberUnverifiedUser = await storage.createUser({
    username: "audit_member_unverified", password: hashed, role: "member",
    membershipTier: "bronze", isEmailVerified: false,
  });
  employeeUser = await storage.createUser({
    username: "audit_employee", password: hashed, role: "employee", membershipTier: "bronze",
  });
  adminUser = await storage.createUser({
    username: "audit_admin", password: hashed, role: "admin", membershipTier: "bronze",
  });

  memberA = await login("audit_member_a", PASS);
  memberB = await login("audit_member_b", PASS);
  memberUnverified = await login("audit_member_unverified", PASS);
  employeeClient = await login("audit_employee", PASS);
  adminClient = await login("audit_admin", PASS);

  gameType = await storage.createGameType({
    name: "Audit PC", description: "Audit test", hourlyPrice: 5000,
    maxPlayers: 1, isActive: true, priceModel: "flat",
  });
  station = await storage.createStation({
    name: "AUDIT-01", gameTypeId: gameType.id, status: "AVAILABLE",
  });

  bookingA = await storage.createBooking({
    userId: memberAUser.id, stationId: station.id, gameTypeId: gameType.id,
    playerCount: 1,
    startTime: new Date(Date.now() + 3_600_000),
    endTime: new Date(Date.now() + 7_200_000),
    totalPrice: 5000, basePrice: 5000, discountAmount: 0, finalPrice: 5000,
    currency: "INR", bookingRef: "AUDIT-A1", paymentMethod: "offline",
    status: "Pending", employeeId: null,
  });
  bookingB = await storage.createBooking({
    userId: memberBUser.id, stationId: station.id, gameTypeId: gameType.id,
    playerCount: 1,
    startTime: new Date(Date.now() + 9_600_000),
    endTime: new Date(Date.now() + 13_200_000),
    totalPrice: 5000, basePrice: 5000, discountAmount: 0, finalPrice: 5000,
    currency: "INR", bookingRef: "AUDIT-B1", paymentMethod: "offline",
    status: "Pending", employeeId: null,
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setRateLimitStoreFactoryForTesting(null); // Restore default store for other test files

  const failed = matrix.filter((r) => r.result === "FAIL");
  const col = (s: string, n: number) => s.length > n ? s.slice(0, n) : s.padEnd(n);

  console.log("\n=====================================================");
  console.log("       ENDPOINT AUTHORIZATION MATRIX");
  console.log("=====================================================");
  console.log(
    col("METHOD", 7),
    col("ENDPOINT", 48),
    col("ROLE", 20),
    col("EXP", 5),
    col("ACT", 5),
    "RESULT"
  );
  console.log("-".repeat(100));
  for (const r of matrix) {
    console.log(
      col(r.method, 7),
      col(r.path, 48),
      col(r.role, 20),
      col(String(r.expected), 5),
      col(String(r.actual), 5),
      r.result
    );
  }
  console.log("-".repeat(100));
  console.log(`Total: ${matrix.length}  ✔ ${matrix.filter(r => r.result === "OK").length}  ✖ ${failed.length}`);
  if (failed.length > 0) {
    console.log("\nFAILED:");
    for (const r of failed) {
      console.log(`  [FAIL] ${r.method} ${r.path} [${r.role}]: expected ${r.expected} got ${r.actual}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §1  Public endpoints — accessible without authentication
// ─────────────────────────────────────────────────────────────────────────────

describe("§1 Public endpoints — accessible without authentication", () => {
  test("GET /api/health — 200 for anon", async () => {
    const r = await anon.get("/api/health");
    record("GET", "/api/health", "anon", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("GET /api/health/db — 200 for anon", async () => {
    const r = await anon.get("/api/health/db");
    record("GET", "/api/health/db", "anon", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("GET /api/game-types — 200 for anon", async () => {
    const r = await anon.get("/api/game-types");
    record("GET", "/api/game-types", "anon", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("GET /api/stations — 200 for anon", async () => {
    const r = await anon.get("/api/stations");
    record("GET", "/api/stations", "anon", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("GET /api/stations/:id — 200 for anon", async () => {
    const r = await anon.get(`/api/stations/${station.id}`);
    record("GET", "/api/stations/:id", "anon", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("GET /api/stations/game-type/:id — 200 for anon", async () => {
    const r = await anon.get(`/api/stations/game-type/${gameType.id}`);
    record("GET", "/api/stations/game-type/:id", "anon", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("GET /api/games — 200 for anon", async () => {
    const r = await anon.get("/api/games");
    record("GET", "/api/games", "anon", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("GET /api/search — 200 for anon", async () => {
    const r = await anon.get("/api/search?q=pc");
    record("GET", "/api/search", "anon", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("POST /api/bookings/calculate-price — 200 for anon (intentional: read-only pricing preview)", async () => {
    const r = await anon.post("/api/bookings/calculate-price", {
      stationId: station.id,
      gameTypeId: gameType.id,
      startTime: new Date(Date.now() + 3_600_000).toISOString(),
      endTime: new Date(Date.now() + 7_200_000).toISOString(),
      playerCount: 1,
    });
    record("POST", "/api/bookings/calculate-price", "anon", 200, r.status);
    assert.equal(r.status, 200, "Price preview endpoint must be publicly accessible — it creates no data");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2  Authentication enforcement — every protected endpoint returns 401 for anon
// ─────────────────────────────────────────────────────────────────────────────

describe("§2 Authentication enforcement — 401 for every protected endpoint", () => {
  const PROTECTED: Array<{ m: string; p: string; b?: any }> = [
    { m: "GET",    p: "/api/user" },
    { m: "GET",    p: "/api/bookings" },
    { m: "GET",    p: "/api/bookings/1" },
    { m: "POST",   p: "/api/bookings", b: {} },
    { m: "PATCH",  p: "/api/bookings/1/status", b: { status: "Cancelled" } },
    { m: "POST",   p: "/api/bookings/1/cancel" },
    { m: "POST",   p: "/api/bookings/1/timer/start" },
    { m: "POST",   p: "/api/bookings/1/timer/stop" },
    { m: "POST",   p: "/api/bookings/offline", b: {} },
    { m: "POST",   p: "/api/payments/create", b: {} },
    { m: "POST",   p: "/api/payments/verify", b: {} },
    { m: "GET",    p: "/api/admin/bookings/export" },
    { m: "GET",    p: "/api/admin/reports/bookings" },
    { m: "GET",    p: "/api/admin/users" },
    { m: "GET",    p: "/api/users/1" },
    { m: "PATCH",  p: "/api/admin/users/1/role", b: { role: "member" } },
    { m: "POST",   p: "/api/admin/users/1/reset-password" },
    { m: "GET",    p: "/api/admin/audit-logs" },
    { m: "GET",    p: "/api/admin/stats/comprehensive" },
    { m: "GET",    p: "/api/employee/stats" },
    { m: "GET",    p: "/api/employee/stats/1" },
    { m: "PATCH",  p: "/api/user/profile", b: {} },
    { m: "POST",   p: "/api/user/change-password", b: {} },
    { m: "POST",   p: "/api/users/1/avatar" },
    { m: "POST",   p: "/api/upload" },
    { m: "GET",    p: "/api/auth/sessions" },
    { m: "DELETE", p: "/api/auth/sessions/1" },
    { m: "POST",   p: "/api/auth/sessions/revoke-all" },
    { m: "GET",    p: "/api/auth/mfa/status" },
    { m: "POST",   p: "/api/auth/mfa/setup" },
    { m: "POST",   p: "/api/auth/mfa/activate", b: {} },
    { m: "POST",   p: "/api/auth/mfa/verify", b: {} },
    { m: "POST",   p: "/api/auth/mfa/disable", b: {} },
    { m: "POST",   p: "/api/game-types", b: {} },
    { m: "PATCH",  p: "/api/game-types/1", b: {} },
    { m: "DELETE", p: "/api/game-types/1" },
    { m: "POST",   p: "/api/stations", b: {} },
    { m: "PATCH",  p: "/api/stations/1", b: {} },
    { m: "DELETE", p: "/api/stations/1" },
    { m: "POST",   p: "/api/games", b: {} },
    { m: "PATCH",  p: "/api/games/1", b: {} },
    { m: "DELETE", p: "/api/games/1" },
  ];

  for (const ep of PROTECTED) {
    test(`${ep.m} ${ep.p} → 401 for anon`, async () => {
      let r: any;
      if (ep.m === "GET")    r = await anon.get(ep.p);
      else if (ep.m === "POST")   r = await anon.post(ep.p, ep.b);
      else if (ep.m === "PATCH")  r = await anon.patch(ep.p, ep.b);
      else if (ep.m === "DELETE") r = await anon.del(ep.p);
      record(ep.m, ep.p, "anon", 401, r.status);
      assert.equal(r.status, 401, `${ep.m} ${ep.p} must return 401 for unauthenticated requests`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3  Role authorization — admin-only endpoints blocked for member and employee
// ─────────────────────────────────────────────────────────────────────────────

describe("§3 Role authorization — admin-only endpoints return 403 for non-admin", () => {
  const ADMIN_ONLY: Array<{ m: string; p: string; b?: any }> = [
    { m: "GET",    p: "/api/admin/bookings/export" },
    { m: "GET",    p: "/api/admin/reports/bookings" },
    { m: "GET",    p: "/api/admin/users" },
    { m: "PATCH",  p: "/api/admin/users/1/role", b: { role: "member" } },
    { m: "POST",   p: "/api/admin/users/1/reset-password" },
    { m: "GET",    p: "/api/admin/audit-logs" },
    { m: "GET",    p: "/api/admin/stats/comprehensive" },
    { m: "POST",   p: "/api/game-types", b: { name: "x", hourlyPrice: 100, maxPlayers: 1 } },
    { m: "PATCH",  p: "/api/game-types/1", b: { name: "y" } },
    { m: "DELETE", p: "/api/game-types/1" },
    { m: "POST",   p: "/api/stations", b: { name: "x", gameTypeId: 1, status: "AVAILABLE" } },
    { m: "DELETE", p: "/api/stations/1" },
    { m: "POST",   p: "/api/games", b: { title: "x" } },
    { m: "PATCH",  p: "/api/games/1", b: {} },
    { m: "DELETE", p: "/api/games/1" },
  ];

  for (const ep of ADMIN_ONLY) {
    test(`${ep.m} ${ep.p} → 403 for member`, async () => {
      let r: any;
      if (ep.m === "GET")    r = await memberA.get(ep.p);
      else if (ep.m === "POST")   r = await memberA.post(ep.p, ep.b);
      else if (ep.m === "PATCH")  r = await memberA.patch(ep.p, ep.b);
      else if (ep.m === "DELETE") r = await memberA.del(ep.p);
      record(ep.m, ep.p, "member", 403, r.status);
      assert.equal(r.status, 403, `${ep.m} ${ep.p} must return 403 for member`);
    });

    test(`${ep.m} ${ep.p} → 403 for employee`, async () => {
      let r: any;
      if (ep.m === "GET")    r = await employeeClient.get(ep.p);
      else if (ep.m === "POST")   r = await employeeClient.post(ep.p, ep.b);
      else if (ep.m === "PATCH")  r = await employeeClient.patch(ep.p, ep.b);
      else if (ep.m === "DELETE") r = await employeeClient.del(ep.p);
      record(ep.m, ep.p, "employee", 403, r.status);
      assert.equal(r.status, 403, `${ep.m} ${ep.p} must return 403 for employee`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §4  Staff-only endpoints blocked for member
// ─────────────────────────────────────────────────────────────────────────────

describe("§4 Staff-only endpoints — blocked for member role", () => {
  test("POST /api/bookings/offline → 403 for member", async () => {
    const r = await memberA.post("/api/bookings/offline", {
      username: "anyone", gameTypeId: gameType.id,
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 3_600_000).toISOString(),
      playerCount: 1,
    });
    record("POST", "/api/bookings/offline", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("POST /api/bookings/:id/timer/start → 403 for member", async () => {
    const r = await memberA.post(`/api/bookings/${bookingA.id}/timer/start`);
    record("POST", "/api/bookings/:id/timer/start", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("POST /api/bookings/:id/timer/stop → 403 for member", async () => {
    const r = await memberA.post(`/api/bookings/${bookingA.id}/timer/stop`);
    record("POST", "/api/bookings/:id/timer/stop", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("POST /api/upload → 403 for member (staff-only)", async () => {
    const r = await memberA.post("/api/upload");
    record("POST", "/api/upload", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("PATCH /api/stations/:id → 403 for member (requireStaff)", async () => {
    const r = await memberA.patch(`/api/stations/${station.id}`, { status: "MAINTENANCE" });
    record("PATCH", "/api/stations/:id", "member", 403, r.status);
    assert.equal(r.status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5  Object-level authorization — horizontal privilege escalation
// ─────────────────────────────────────────────────────────────────────────────

describe("§5 Object-level authorization — horizontal IDOR prevention", () => {
  test("Member A CANNOT read Member B's booking", async () => {
    const r = await memberA.get(`/api/bookings/${bookingB.id}`);
    record("GET", "/api/bookings/:id [other]", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("Member B CAN read their own booking", async () => {
    const r = await memberB.get(`/api/bookings/${bookingB.id}`);
    record("GET", "/api/bookings/:id [own]", "member", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("Member A CANNOT cancel Member B's booking via PATCH /status", async () => {
    const r = await memberA.patch(`/api/bookings/${bookingB.id}/status`, { status: "Cancelled" });
    record("PATCH", "/api/bookings/:id/status [other]", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("Member A CANNOT cancel Member B's booking via POST /cancel", async () => {
    const r = await memberA.post(`/api/bookings/${bookingB.id}/cancel`);
    record("POST", "/api/bookings/:id/cancel [other]", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("Member B CAN cancel their own Pending booking", async () => {
    const freshB = await storage.createBooking({
      userId: memberBUser.id, stationId: station.id, gameTypeId: gameType.id,
      playerCount: 1,
      startTime: new Date(Date.now() + 80_000_000), endTime: new Date(Date.now() + 84_000_000),
      totalPrice: 5000, basePrice: 5000, discountAmount: 0, finalPrice: 5000,
      currency: "INR", bookingRef: "AUDIT-CNCL-B", paymentMethod: "offline",
      status: "Pending", employeeId: null,
    });
    const r = await memberB.post(`/api/bookings/${freshB.id}/cancel`);
    record("POST", "/api/bookings/:id/cancel [own Pending]", "member", 200, r.status);
    assert.equal(r.status, 200);
    assert.equal(r.data.status, "Cancelled");
  });

  test("Employee CAN read any booking (BOOKING_READ_ALL)", async () => {
    const r = await employeeClient.get(`/api/bookings/${bookingA.id}`);
    record("GET", "/api/bookings/:id [any]", "employee", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("Admin CAN read any booking (BOOKING_READ_ALL)", async () => {
    const r = await adminClient.get(`/api/bookings/${bookingB.id}`);
    record("GET", "/api/bookings/:id [any]", "admin", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("Member A CANNOT view Member B's profile", async () => {
    const r = await memberA.get(`/api/users/${memberBUser.id}`);
    record("GET", "/api/users/:id [other]", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("Member A CAN view own profile", async () => {
    const r = await memberA.get(`/api/users/${memberAUser.id}`);
    record("GET", "/api/users/:id [own]", "member", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("Admin CAN view any user profile", async () => {
    const r = await adminClient.get(`/api/users/${memberAUser.id}`);
    record("GET", "/api/users/:id [any]", "admin", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("Member A CANNOT update Member B's avatar", async () => {
    const r = await memberA.post(`/api/users/${memberBUser.id}/avatar`);
    record("POST", "/api/users/:id/avatar [other]", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("POST /api/payments/create — member CANNOT pay for another member's booking", async () => {
    const r = await memberA.post("/api/payments/create", {
      bookingId: bookingB.id, amount: 5000, currency: "INR",
    });
    record("POST", "/api/payments/create [other booking]", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("POST /api/payments/create — member CAN create payment for own booking", async () => {
    const r = await memberA.post("/api/payments/create", {
      bookingId: bookingA.id, amount: 5000, currency: "INR",
    });
    record("POST", "/api/payments/create [own booking]", "member", 201, r.status);
    assert.equal(r.status, 201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6  Vertical privilege escalation — status escalation blocked for member
// ─────────────────────────────────────────────────────────────────────────────

describe("§6 Vertical privilege escalation — booking status escalation blocked for member", () => {
  test("Member CANNOT set booking status to Approved", async () => {
    const r = await memberA.patch(`/api/bookings/${bookingA.id}/status`, { status: "Approved" });
    record("PATCH", "/api/bookings/:id/status [→Approved by member]", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("Member CANNOT set booking status to Completed", async () => {
    const r = await memberA.patch(`/api/bookings/${bookingA.id}/status`, { status: "Completed" });
    record("PATCH", "/api/bookings/:id/status [→Completed by member]", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("Member CAN cancel (→Cancelled) own Pending booking via PATCH /status", async () => {
    const fresh = await storage.createBooking({
      userId: memberAUser.id, stationId: station.id, gameTypeId: gameType.id,
      playerCount: 1,
      startTime: new Date(Date.now() + 90_000_000), endTime: new Date(Date.now() + 94_000_000),
      totalPrice: 5000, basePrice: 5000, discountAmount: 0, finalPrice: 5000,
      currency: "INR", bookingRef: "AUDIT-STATUS-A", paymentMethod: "offline",
      status: "Pending", employeeId: null,
    });
    const r = await memberA.patch(`/api/bookings/${fresh.id}/status`, { status: "Cancelled" });
    record("PATCH", "/api/bookings/:id/status [→Cancelled by member, own Pending]", "member", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("Employee CAN approve a booking", async () => {
    const fresh = await storage.createBooking({
      userId: memberAUser.id, stationId: station.id, gameTypeId: gameType.id,
      playerCount: 1,
      startTime: new Date(Date.now() + 100_000_000), endTime: new Date(Date.now() + 104_000_000),
      totalPrice: 5000, basePrice: 5000, discountAmount: 0, finalPrice: 5000,
      currency: "INR", bookingRef: "AUDIT-APPR-EMP", paymentMethod: "offline",
      status: "Pending", employeeId: null,
    });
    const r = await employeeClient.patch(`/api/bookings/${fresh.id}/status`, { status: "Approved" });
    record("PATCH", "/api/bookings/:id/status [→Approved by employee]", "employee", 200, r.status);
    assert.equal(r.status, 200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7  Employee data object-level scoping
// ─────────────────────────────────────────────────────────────────────────────

describe("§7 Employee data object-level authorization", () => {
  test("Employee CANNOT access another employee's stats via /api/employee/stats/:id", async () => {
    const r = await employeeClient.get(`/api/employee/stats/${adminUser.id}`);
    record("GET", "/api/employee/stats/:id [other]", "employee", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("Employee CAN access own stats via /api/employee/stats/:id", async () => {
    const r = await employeeClient.get(`/api/employee/stats/${employeeUser.id}`);
    record("GET", "/api/employee/stats/:id [own]", "employee", 200, r.status);
    assert.notEqual(r.status, 401);
    assert.notEqual(r.status, 403);
  });

  test("Member CANNOT access employee stats at /api/employee/stats/:id", async () => {
    const r = await memberA.get(`/api/employee/stats/${employeeUser.id}`);
    record("GET", "/api/employee/stats/:id [member]", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("Member CANNOT access /api/employee/stats (query endpoint)", async () => {
    const r = await memberA.get("/api/employee/stats");
    record("GET", "/api/employee/stats [member]", "member", 403, r.status);
    assert.equal(r.status, 403);
  });

  test("Admin CAN access any employee stats via /api/employee/stats/:id", async () => {
    const r = await adminClient.get(`/api/employee/stats/${employeeUser.id}`);
    record("GET", "/api/employee/stats/:id [admin]", "admin", 200, r.status);
    assert.notEqual(r.status, 401);
    assert.notEqual(r.status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8  Field-level authorization — sensitive fields must not leak
// ─────────────────────────────────────────────────────────────────────────────

describe("§8 Field-level authorization — sensitive fields must not appear in any response", () => {
  const SENSITIVE = [
    "password", "emailVerificationTokenHash", "emailVerificationTokenExpiresAt",
    "passwordResetTokenHash", "passwordResetTokenExpiresAt",
    "mfaSecret", "mfaRecoveryCodes", "mfaLastUsedTimestep",
  ];

  function checkNoSensitiveFields(obj: any, context: string) {
    for (const field of SENSITIVE) {
      assert.equal(
        (obj as any)[field], undefined,
        `'${field}' must not be exposed in ${context}`
      );
    }
  }

  test("GET /api/user must not expose sensitive fields", async () => {
    const r = await memberA.get("/api/user");
    assert.equal(r.status, 200);
    checkNoSensitiveFields(r.data, "GET /api/user");
    record("GET", "/api/user [field-level]", "member", 200, r.status);
  });

  test("GET /api/users/:id (own) must not expose sensitive fields", async () => {
    const r = await memberA.get(`/api/users/${memberAUser.id}`);
    assert.equal(r.status, 200);
    checkNoSensitiveFields(r.data, "GET /api/users/:id");
    record("GET", "/api/users/:id [field-level]", "member", 200, r.status);
  });

  test("GET /api/admin/users must not expose sensitive fields in user list", async () => {
    const r = await adminClient.get("/api/admin/users");
    assert.equal(r.status, 200);
    const users: any[] = Array.isArray(r.data) ? r.data : (r.data?.items ?? r.data?.data ?? []);
    for (const u of users.slice(0, 5)) {
      checkNoSensitiveFields(u, `GET /api/admin/users [user id=${u?.id}]`);
    }
    record("GET", "/api/admin/users [field-level]", "admin", 200, r.status);
  });

  test("GET /api/bookings/:id — nested user object must not expose sensitive fields", async () => {
    const r = await employeeClient.get(`/api/bookings/${bookingA.id}`);
    assert.equal(r.status, 200);
    if (r.data?.user) {
      checkNoSensitiveFields(r.data.user, "GET /api/bookings/:id user object");
    }
    record("GET", "/api/bookings/:id [field-level]", "employee", 200, r.status);
  });

  test("GET /api/admin/reports/bookings — customer sub-object must not expose sensitive fields", async () => {
    const r = await adminClient.get("/api/admin/reports/bookings");
    assert.equal(r.status, 200);
    const items: any[] = r.data?.data ?? [];
    for (const item of items.slice(0, 3)) {
      if (item?.customer) {
        checkNoSensitiveFields(item.customer, `report customer id=${item.customer?.id}`);
      }
    }
    record("GET", "/api/admin/reports/bookings [field-level]", "admin", 200, r.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §9  Field injection — clients cannot inject privileged fields
// ─────────────────────────────────────────────────────────────────────────────

describe("§9 Field injection prevention", () => {
  test("POST /api/register — injected role=admin must be ignored; user created as member", async () => {
    const r = await anon.post("/api/register", {
      username: "audit_inject_role",
      password: "P@ssw0rd123!",
      role: "admin",
    });
    if (r.status === 201 || r.status === 200) {
      assert.equal(r.data.role, "member", "Injected role must be overridden to member");
    }
    record("POST", "/api/register [role injection]", "anon", 201, r.status);
  });

  test("PATCH /api/user/profile — injected role field must be ignored", async () => {
    const r = await memberA.patch("/api/user/profile", {
      fullName: "Audit Injector",
      role: "admin",
    });
    if (r.status === 200) {
      assert.equal(r.data.role, "member", "Profile update must not accept role injection");
    }
    record("PATCH", "/api/user/profile [role injection]", "member", 200, r.status);
  });

  test("POST /api/bookings — injected status/employeeId/totalPrice must be overridden server-side", async () => {
    const r = await memberA.post("/api/bookings", {
      gameTypeId: gameType.id,
      stationId: station.id,
      startTime: new Date(Date.now() + 50_000_000).toISOString(),
      endTime: new Date(Date.now() + 54_000_000).toISOString(),
      playerCount: 1,
      totalPrice: 1,
      status: "Approved",
      employeeId: adminUser.id,
    });
    if (r.status === 201) {
      assert.equal(r.data.status, "Pending",
        "Server must override injected status → Pending");
      assert.equal(r.data.employeeId, null,
        "Server must override injected employeeId → null");
      assert.notEqual(r.data.totalPrice, 1,
        "Server must override injected totalPrice with server-authoritative value");
    }
    record("POST", "/api/bookings [status/employeeId/price injection]", "member", 201, r.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 Email verification gate
// ─────────────────────────────────────────────────────────────────────────────

describe("§10 Email verification gate", () => {
  test("Unverified member CANNOT create an online booking (403 EMAIL_VERIFICATION_REQUIRED)", async () => {
    const r = await memberUnverified.post("/api/bookings", {
      gameTypeId: gameType.id,
      stationId: station.id,
      startTime: new Date(Date.now() + 200_000_000).toISOString(),
      endTime: new Date(Date.now() + 204_000_000).toISOString(),
      playerCount: 1,
    });
    record("POST", "/api/bookings [unverified member]", "member-unverified", 403, r.status);
    assert.equal(r.status, 403);
    assert.equal(r.data?.code, "EMAIL_VERIFICATION_REQUIRED");
  });

  test("Staff are exempt from email verification gate for offline bookings", async () => {
    const r = await employeeClient.post("/api/bookings/offline", {
      username: memberAUser.username,
      gameTypeId: gameType.id,
      stationId: null,
      startTime: new Date(Date.now() + 210_000_000).toISOString(),
      endTime: new Date(Date.now() + 214_000_000).toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    });
    record("POST", "/api/bookings/offline [employee, email gate exempt]", "employee", 201, r.status);
    assert.notEqual(r.status, 403, "Staff must not hit the email verification gate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §11 Admin privilege management
// ─────────────────────────────────────────────────────────────────────────────

describe("§11 Admin privilege management", () => {
  test("Admin CAN list users (GET /api/admin/users)", async () => {
    const r = await adminClient.get("/api/admin/users");
    record("GET", "/api/admin/users [admin]", "admin", 200, r.status);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data) || Array.isArray(r.data?.items) || Array.isArray(r.data?.data), "Must return users list");
  });

  test("Admin role update rejects invalid roles", async () => {
    const r = await adminClient.patch(`/api/admin/users/${memberBUser.id}/role`, { role: "superadmin" });
    record("PATCH", "/api/admin/users/:id/role [invalid role]", "admin", 400, r.status);
    assert.equal(r.status, 400);
  });

  test("Admin CAN update a user's role and response contains new role", async () => {
    const r = await adminClient.patch(`/api/admin/users/${memberBUser.id}/role`, { role: "employee" });
    record("PATCH", "/api/admin/users/:id/role [admin→employee]", "admin", 200, r.status);
    assert.equal(r.status, 200);
    assert.equal(r.data?.user?.role, "employee");
    // Restore
    await adminClient.patch(`/api/admin/users/${memberBUser.id}/role`, { role: "member" });
    memberB = await login("audit_member_b", PASS);
  });

  test("Admin CAN read audit logs", async () => {
    const r = await adminClient.get("/api/admin/audit-logs");
    record("GET", "/api/admin/audit-logs [admin]", "admin", 200, r.status);
    assert.equal(r.status, 200);
  });

  test("Employee CANNOT read audit logs (403)", async () => {
    const r = await employeeClient.get("/api/admin/audit-logs");
    record("GET", "/api/admin/audit-logs [employee]", "employee", 403, r.status);
    assert.equal(r.status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §12 Booking list data scoping
// ─────────────────────────────────────────────────────────────────────────────

describe("§12 Booking list data scoping", () => {
  test("Member's GET /api/bookings only returns own bookings (userId matches session user)", async () => {
    const r = await memberB.get("/api/bookings");
    assert.equal(r.status, 200);
    const items: any[] = r.data?.data ?? [];
    for (const b of items) {
      assert.equal(b.userId, memberBUser.id,
        `Member must not see booking userId=${b.userId} (expected ${memberBUser.id})`);
    }
    record("GET", "/api/bookings [member — own only scoping]", "member", 200, r.status);
  });

  test("Employee's GET /api/bookings is accessible (BOOKING_READ_ALL)", async () => {
    const r = await employeeClient.get("/api/bookings");
    assert.equal(r.status, 200);
    record("GET", "/api/bookings [employee — all]", "employee", 200, r.status);
  });

  test("Admin's GET /api/bookings is accessible (BOOKING_READ_ALL)", async () => {
    const r = await adminClient.get("/api/bookings");
    assert.equal(r.status, 200);
    record("GET", "/api/bookings [admin — all]", "admin", 200, r.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §13 Session management object-level authorization
// ─────────────────────────────────────────────────────────────────────────────

describe("§13 Session management authorization", () => {
  test("GET /api/auth/sessions returns structured session list with no raw session hash", async () => {
    const r = await memberA.get("/api/auth/sessions");
    record("GET", "/api/auth/sessions [member]", "member", 200, r.status);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data));
    for (const s of r.data as any[]) {
      assert.ok("id" in s, "Session must have id");
      assert.ok("isCurrent" in s, "Session must indicate current");
      assert.equal("sessionIdHash" in s, false, "Raw sessionIdHash must not be returned");
    }
  });

  test("DELETE /api/auth/sessions/:id with non-existent or other-user session returns 404", async () => {
    const r = await memberA.del("/api/auth/sessions/999999");
    record("DELETE", "/api/auth/sessions/:id [other user]", "member", 404, r.status);
    assert.equal(r.status, 404,
      "Attempting to revoke a session not owned by the caller must return 404 (not leak data or error 500)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §14 Input validation — malformed IDs must return 400 not 500
// ─────────────────────────────────────────────────────────────────────────────

describe("§14 Input validation — invalid resource IDs return 400", () => {
  const INVALID_ID_TESTS: Array<{ m: string; p: string; client: "member" | "admin"; b?: any }> = [
    { m: "GET",   p: "/api/bookings/notanumber",                client: "member" },
    { m: "PATCH", p: "/api/bookings/notanumber/status",         client: "admin",  b: { status: "Cancelled" } },
    { m: "POST",  p: "/api/bookings/notanumber/cancel",         client: "member", b: {} },
    { m: "GET",   p: "/api/users/notanumber",                   client: "member" },
    { m: "GET",   p: "/api/stations/notanumber",                client: "admin" },
    { m: "GET",   p: "/api/stations/game-type/notanumber",      client: "admin" },
    { m: "PATCH", p: "/api/admin/users/notanumber/role",        client: "admin",  b: { role: "member" } },
    { m: "POST",  p: "/api/admin/users/notanumber/reset-password", client: "admin", b: {} },
    { m: "GET",   p: "/api/employee/stats/notanumber",          client: "admin" },
  ];

  for (const ep of INVALID_ID_TESTS) {
    test(`${ep.m} ${ep.p} returns 400 for invalid ID`, async () => {
      const c = ep.client === "admin" ? adminClient : memberA;
      let r: any;
      if (ep.m === "GET")   r = await c.get(ep.p);
      else if (ep.m === "POST")  r = await c.post(ep.p, ep.b ?? {});
      else if (ep.m === "PATCH") r = await c.patch(ep.p, ep.b ?? {});
      record(ep.m, ep.p, ep.client, 400, r.status);
      assert.equal(r.status, 400, `${ep.m} ${ep.p} with 'notanumber' ID must return 400`);
    });
  }
});
