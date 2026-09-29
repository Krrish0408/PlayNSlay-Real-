import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { hashPassword } from "../server/auth";
import {
  USER_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  type UserRole,
  type Permission,
} from "../shared/schema";
import {
  isAdmin,
  isEmployee,
  isStaff,
  isMember,
  requirePermission,
  requireAdmin,
  requireStaff,
  BookingPolicy,
  UserPolicy,
  StationPolicy,
  CatalogPolicy,
  EmployeeDataPolicy,
} from "../server/authorization";

let server: Server;
let baseUrl: string;

interface SessionClient {
  get: (path: string) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (path: string, body?: any) => Promise<{ status: number; data: any; headers: Headers }>;
  patch: (path: string, body?: any) => Promise<{ status: number; data: any; headers: Headers }>;
  delete: (path: string) => Promise<{ status: number; data: any; headers: Headers }>;
}

function makeClient(cookie?: string): SessionClient {
  const request = async (method: string, path: string, body?: any) => {
    const headers: Record<string, string> = {};
    if (cookie) {
      headers["Cookie"] = cookie;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data: any = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return { status: res.status, data, headers: res.headers };
  };

  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    patch: (p, b) => request("PATCH", p, b),
    delete: (p) => request("DELETE", p),
  };
}

async function loginAndGetClient(username: string, password: string): Promise<SessionClient> {
  const anon = makeClient();
  const res = await anon.post("/api/login", { username, password });
  assert.equal(res.status, 200, `Login should succeed for ${username}`);
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "Login should set session cookie");
  const cookie = setCookie.split(";")[0];
  return makeClient(cookie);
}

describe("Authoritative Role Authorization & Centralized Permissions", () => {
  let memberUser: any;
  let employeeUser: any;
  let adminUser: any;

  let anonClient: SessionClient;
  let memberClient: SessionClient;
  let employeeClient: SessionClient;
  let adminClient: SessionClient;

  let dummyBooking: any;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    server = createServer(app);
    await registerRoutes(server, app);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    anonClient = makeClient();

    const timestamp = Date.now();
    const password = "Password123!";
    const hashedPass = await hashPassword(password);

    // 1. Create member
    memberUser = await storage.createUser({
      username: `test_member_${timestamp}`,
      password: hashedPass,
      email: `member_${timestamp}@test.com`,
      role: "member",
      isEmailVerified: true,
    });

    // 2. Create employee
    employeeUser = await storage.createUser({
      username: `test_employee_${timestamp}`,
      password: hashedPass,
      email: `employee_${timestamp}@test.com`,
      role: "employee",
      isEmailVerified: true,
    });

    // 3. Create admin
    adminUser = await storage.createUser({
      username: `test_admin_${timestamp}`,
      password: hashedPass,
      email: `admin_${timestamp}@test.com`,
      role: "admin",
      isEmailVerified: true,
    });

    memberClient = await loginAndGetClient(memberUser.username, password);
    employeeClient = await loginAndGetClient(employeeUser.username, password);
    adminClient = await loginAndGetClient(adminUser.username, password);

    dummyBooking = {
      id: 9999,
      userId: memberUser.id,
      gameTypeId: 1,
      stationId: 1,
      gameTitle: "Test Game",
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      playerCount: 1,
      totalPrice: 1000,
      paymentMethod: "offline",
      status: "Approved",
      bookingRef: "REF-9999",
      employeeId: null,
      timerStartedAt: null,
      timerEndTime: null,
      idempotencyKey: null,
      createdAt: new Date(),
    };
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("1. Centralized Permission Matrix & Deny-by-Default", () => {
    test("USER_ROLES contains exactly member, employee, admin", () => {
      assert.deepEqual([...USER_ROLES], ["member", "employee", "admin"]);
    });

    test("Deny-by-default for unauthenticated or undefined users", () => {
      for (const perm of PERMISSIONS) {
        assert.equal(hasPermission(null, perm), false, `null user must be denied permission ${perm}`);
        assert.equal(hasPermission(undefined, perm), false, `undefined user must be denied permission ${perm}`);
        assert.equal(hasPermission({ role: undefined }, perm), false, `undefined role must be denied permission ${perm}`);
        assert.equal(hasPermission({ role: "invalid_role" }, perm), false, `invalid role must be denied permission ${perm}`);
      }
    });

    test("Member has strictly defined member permissions only", () => {
      const allowed: Permission[] = [
        "BOOKING_READ_OWN",
        "BOOKING_CREATE",
        "BOOKING_CANCEL_OWN",
        "USER_READ_OWN",
        "USER_UPDATE_OWN",
        "STATION_VIEW",
        "CATALOG_VIEW",
        "FILE_UPLOAD",
      ];

      for (const perm of PERMISSIONS) {
        const expected = allowed.includes(perm);
        assert.equal(
          hasPermission(memberUser, perm),
          expected,
          `Member permission ${perm} should be ${expected}`
        );
      }
    });

    test("Employee has member permissions plus staff booking management & own stats", () => {
      const allowed: Permission[] = [
        "BOOKING_READ_OWN",
        "BOOKING_READ_ALL",
        "BOOKING_CREATE",
        "BOOKING_CANCEL_OWN",
        "BOOKING_MANAGE",
        "USER_READ_OWN",
        "USER_UPDATE_OWN",
        "STATION_VIEW",
        "CATALOG_VIEW",
        "EMPLOYEE_STATS_VIEW_OWN",
        "FILE_UPLOAD",
      ];

      for (const perm of PERMISSIONS) {
        const expected = allowed.includes(perm);
        assert.equal(
          hasPermission(employeeUser, perm),
          expected,
          `Employee permission ${perm} should be ${expected}`
        );
      }

      // Explicitly verify employee cannot manage users, pricing, stations, or view audits
      assert.equal(hasPermission(employeeUser, "USER_MANAGE"), false);
      assert.equal(hasPermission(employeeUser, "PRICING_MANAGE"), false);
      assert.equal(hasPermission(employeeUser, "STATION_MANAGE"), false);
      assert.equal(hasPermission(employeeUser, "AUDIT_VIEW"), false);
      assert.equal(hasPermission(employeeUser, "ANALYTICS_VIEW"), false);
    });

    test("Admin has full administrative permissions", () => {
      for (const perm of PERMISSIONS) {
        assert.equal(
          hasPermission(adminUser, perm),
          true,
          `Admin must have permission ${perm}`
        );
      }
    });
  });

  describe("2. Predicates derive strictly from authoritative role (no conflicting fields)", () => {
    test("Role predicates evaluate strictly against role column", () => {
      assert.equal(isMember(memberUser), true);
      assert.equal(isEmployee(memberUser), false);
      assert.equal(isAdmin(memberUser), false);
      assert.equal(isStaff(memberUser), false);

      assert.equal(isMember(employeeUser), false);
      assert.equal(isEmployee(employeeUser), true);
      assert.equal(isAdmin(employeeUser), false);
      assert.equal(isStaff(employeeUser), true);

      assert.equal(isMember(adminUser), false);
      assert.equal(isEmployee(adminUser), false);
      assert.equal(isAdmin(adminUser), true);
      assert.equal(isStaff(adminUser), true);
    });

    test("Conflicting injected fields (isAdmin: true on member) are completely ignored by predicates", () => {
      const spoofedMember = { ...memberUser, isAdmin: true };
      assert.equal(isAdmin(spoofedMember as any), false, "Injected isAdmin: true on member must not grant admin status");
      assert.equal(isStaff(spoofedMember as any), false, "Injected isAdmin: true on member must not grant staff status");
      assert.equal(isMember(spoofedMember as any), true, "Authoritative role remains member");

      const spoofedEmployee = { ...employeeUser, isAdmin: true };
      assert.equal(isAdmin(spoofedEmployee as any), false, "Injected isAdmin: true on employee must not grant admin status");
      assert.equal(isEmployee(spoofedEmployee as any), true);
    });
  });

  describe("3. Resource Policies enforce permissions with deny-by-default", () => {
    test("BookingPolicy.canRead: member can read own, staff can read all, others denied", () => {
      assert.equal(BookingPolicy.canRead(memberUser, dummyBooking), true);
      assert.equal(BookingPolicy.canRead({ ...memberUser, id: 8888 }, dummyBooking), false);
      assert.equal(BookingPolicy.canRead(employeeUser, dummyBooking), true);
      assert.equal(BookingPolicy.canRead(adminUser, dummyBooking), true);
    });

    test("UserPolicy.canModifyRole: only admin permitted", () => {
      assert.equal(UserPolicy.canModifyRole(memberUser), false);
      assert.equal(UserPolicy.canModifyRole(employeeUser), false);
      assert.equal(UserPolicy.canModifyRole(adminUser), true);
    });

    test("StationPolicy.canCreate: only admin permitted", () => {
      assert.equal(StationPolicy.canCreate(memberUser), false);
      assert.equal(StationPolicy.canCreate(employeeUser), false);
      assert.equal(StationPolicy.canCreate(adminUser), true);
    });

    test("CatalogPolicy.canManage: only admin permitted", () => {
      assert.equal(CatalogPolicy.canManage(memberUser), false);
      assert.equal(CatalogPolicy.canManage(employeeUser), false);
      assert.equal(CatalogPolicy.canManage(adminUser), true);
    });

    test("EmployeeDataPolicy.canAccessStats: employee can access own, admin can access any, member denied", () => {
      assert.equal(EmployeeDataPolicy.canAccessStats(memberUser, employeeUser.id), false);
      assert.equal(EmployeeDataPolicy.canAccessStats(employeeUser, employeeUser.id), true);
      assert.equal(EmployeeDataPolicy.canAccessStats(employeeUser, 99999), false);
      assert.equal(EmployeeDataPolicy.canAccessStats(adminUser, 99999), true);
    });
  });

  describe("4. Direct API Route Protection (Server-side security, not relying on hidden frontend)", () => {
    test("Admin endpoint GET /api/admin/users blocks anon (401), member (403), employee (403), allows admin (200)", async () => {
      const anonRes = await anonClient.get("/api/admin/users");
      assert.equal(anonRes.status, 401);

      const memberRes = await memberClient.get("/api/admin/users");
      assert.equal(memberRes.status, 403);

      const employeeRes = await employeeClient.get("/api/admin/users");
      assert.equal(employeeRes.status, 403);

      const adminRes = await adminClient.get("/api/admin/users");
      assert.equal(adminRes.status, 200);
      assert.ok(Array.isArray(adminRes.data));
    });

    test("Admin endpoint GET /api/admin/audit-logs blocks non-admin", async () => {
      const memberRes = await memberClient.get("/api/admin/audit-logs");
      assert.equal(memberRes.status, 403);

      const employeeRes = await employeeClient.get("/api/admin/audit-logs");
      assert.equal(employeeRes.status, 403);

      const adminRes = await adminClient.get("/api/admin/audit-logs");
      assert.equal(adminRes.status, 200);
    });

    test("Admin endpoint PATCH /api/admin/users/:id/role blocks employee and member", async () => {
      const memberRes = await memberClient.patch(`/api/admin/users/${memberUser.id}/role`, {
        role: "admin",
      });
      assert.equal(memberRes.status, 403);

      const employeeRes = await employeeClient.patch(`/api/admin/users/${memberUser.id}/role`, {
        role: "admin",
      });
      assert.equal(employeeRes.status, 403);
    });

    test("GET /api/user returns authoritative role and permissions list", async () => {
      const res = await memberClient.get("/api/user");
      assert.equal(res.status, 200);
      assert.equal(res.data.role, "member");
      assert.ok(Array.isArray(res.data.permissions));
      assert.ok(res.data.permissions.includes("BOOKING_READ_OWN"));
      assert.ok(!res.data.permissions.includes("USER_MANAGE"));

      const adminRes = await adminClient.get("/api/user");
      assert.equal(adminRes.status, 200);
      assert.equal(adminRes.data.role, "admin");
      assert.ok(adminRes.data.permissions.includes("USER_MANAGE"));
      assert.ok(adminRes.data.permissions.includes("AUDIT_VIEW"));
    });
  });
});

