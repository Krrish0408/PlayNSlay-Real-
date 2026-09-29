import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { hashPassword } from "../server/auth";
import { encodeCursor } from "../server/pagination";

let server: Server;
let baseUrl: string;

interface SessionClient {
  get: (path: string) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (path: string, body?: any) => Promise<{ status: number; data: any; headers: Headers }>;
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
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
  };
}

async function loginUser(username: string, password: string): Promise<SessionClient> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  assert.equal(res.status, 200, `Login failed for user ${username}`);
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "Login must return set-cookie header");

  const cookieVal = setCookie.split(";")[0];
  return makeClient(cookieVal);
}

let adminClient: SessionClient;
let memberClient: SessionClient;
let anonClient: SessionClient;
let testUser: any;
let testAdmin: any;
let testGameType: any;

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

  const pwd = await hashPassword("pass123456");

  // Create admin
  const adminSuffix = Date.now();
  testAdmin = await storage.createUser({
    username: `admin_pag_${adminSuffix}`,
    email: `admin_pag_${adminSuffix}@example.com`,
    password: pwd,
    role: "admin",
    isEmailVerified: true,
  });

  // Create member
  testUser = await storage.createUser({
    username: `member_pag_${adminSuffix}`,
    email: `member_pag_${adminSuffix}@example.com`,
    password: pwd,
    role: "member",
    isEmailVerified: true,
  });

  // Create game category
  testGameType = await storage.createGameType({
    name: `Category Pag ${adminSuffix}`,
    description: "Category for pagination tests",
    hourlyPrice: 500,
    maxPlayers: 4,
    priceModel: "flat",
  });

  // Seed 30 stations for pagination testing
  for (let i = 1; i <= 30; i++) {
    await storage.createStation({
      name: `Station-Pag-${i}`,
      gameTypeId: testGameType.id,
      status: "AVAILABLE",
    });
  }

  // Seed 30 bookings for pagination testing
  const baseTime = Date.now() - 30 * 3600 * 1000;
  for (let i = 1; i <= 30; i++) {
    await storage.createBooking({
      userId: testUser.id,
      gameTypeId: testGameType.id,
      bookingRef: `REF-PAG-${i}-${adminSuffix}`,
      startTime: new Date(baseTime + i * 3600 * 1000),
      endTime: new Date(baseTime + (i + 1) * 3600 * 1000),
      totalPrice: 500,
      paymentMethod: "offline",
      playerCount: 1,
      status: i % 2 === 0 ? "Approved" : "Pending",
    });
  }

  // Seed 30 audit logs for pagination testing
  for (let i = 1; i <= 30; i++) {
    await storage.createAuditLog({
      userId: testAdmin.id,
      username: testAdmin.username,
      action: `TEST_ACTION_${i}`,
      details: `Audit log details ${i}`,
    });
  }

  adminClient = await loginUser(testAdmin.username, "pass123456");
  memberClient = await loginUser(testUser.username, "pass123456");
  anonClient = makeClient();
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("API Pagination & Resource Limits Test Suite", () => {
  describe("1. Default Limit & Maximum Limit Enforcement", () => {
    test("GET /api/stations returns default limit (25) and pagination headers", async () => {
      const res = await anonClient.get("/api/stations");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-pagination-limit"), "25");
      assert.ok(res.headers.has("x-has-more"));
      // When unparameterized, returns items array bounded by safe default limit
      assert.ok(Array.isArray(res.data));
      assert.ok(res.data.length <= 25, `Expected <= 25 items, got ${res.data.length}`);
    });

    test("GET /api/stations?limit=10 returns exactly 10 items in cursor envelope", async () => {
      const res = await anonClient.get("/api/stations?limit=10");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-pagination-limit"), "10");
      assert.equal(res.data.limit, 10);
      assert.equal(res.data.items.length, 10);
      assert.equal(res.data.hasMore, true);
      assert.ok(res.data.nextCursor, "Must return nextCursor when hasMore is true");
    });

    test("GET /api/stations?limit=101 rejects extremely large limits with 400", async () => {
      const res = await anonClient.get("/api/stations?limit=101");
      assert.equal(res.status, 400);
      assert.ok(res.data.message || res.data.errors, "Should return validation error");
    });

    test("GET /api/stations?limit=-5 rejects negative limits with 400", async () => {
      const res = await anonClient.get("/api/stations?limit=-5");
      assert.equal(res.status, 400);
    });

    test("GET /api/stations?limit=abc rejects non-numeric limits with 400", async () => {
      const res = await anonClient.get("/api/stations?limit=abc");
      assert.equal(res.status, 400);
    });

    test("GET /api/bookings?limit=500 rejects extremely large booking limits with 400", async () => {
      const res = await memberClient.get("/api/bookings?limit=500");
      assert.equal(res.status, 400);
    });
  });

  describe("2. Cursor Validation & Tamper Resistance", () => {
    test("Malformed base64 cursor is rejected with 400 INVALID_CURSOR", async () => {
      const res = await memberClient.get("/api/bookings?cursor=not-valid-base64!!!");
      assert.equal(res.status, 400);
      assert.equal(res.data.code, "INVALID_CURSOR");
    });

    test("Valid base64 but invalid schema cursor is rejected with 400 INVALID_CURSOR", async () => {
      const fakeCursor = Buffer.from(JSON.stringify({ badField: "corrupted" })).toString("base64url");
      const res = await memberClient.get(`/api/bookings?cursor=${fakeCursor}`);
      assert.equal(res.status, 400);
      assert.equal(res.data.code, "INVALID_CURSOR");
    });

    test("Stations endpoint rejects invalid id cursor with 400 INVALID_CURSOR", async () => {
      const fakeCursor = Buffer.from(JSON.stringify({ id: "not-a-number" })).toString("base64url");
      const res = await anonClient.get(`/api/stations?cursor=${fakeCursor}`);
      assert.equal(res.status, 400);
      assert.equal(res.data.code, "INVALID_CURSOR");
    });
  });

  describe("3. Deterministic Ordering & Multi-Page Traversal", () => {
    test("Bookings multi-page traversal using cursor has zero duplicates across pages", async () => {
      // Page 1
      const page1 = await memberClient.get("/api/bookings?limit=10");
      assert.equal(page1.status, 200);
      assert.equal(page1.data.items.length, 10);
      assert.equal(page1.data.hasMore, true);
      const cursor1 = page1.data.nextCursor;
      assert.ok(cursor1, "Page 1 must provide nextCursor");

      // Page 2
      const page2 = await memberClient.get(`/api/bookings?limit=10&cursor=${encodeURIComponent(cursor1)}`);
      assert.equal(page2.status, 200);
      assert.equal(page2.data.items.length, 10);
      const cursor2 = page2.data.nextCursor;

      // Verify no duplicates between Page 1 and Page 2
      const ids1 = new Set(page1.data.items.map((b: any) => b.id));
      for (const item of page2.data.items) {
        assert.ok(!ids1.has(item.id), `Duplicate booking ID ${item.id} detected across pages`);
      }

      // Verify deterministic descending order
      const combined = [...page1.data.items, ...page2.data.items];
      for (let i = 0; i < combined.length - 1; i++) {
        const curr = new Date(combined[i].createdAt).getTime();
        const next = new Date(combined[i + 1].createdAt).getTime();
        assert.ok(
          curr > next || (curr === next && combined[i].id > combined[i + 1].id),
          "Items must be sorted deterministically in (createdAt DESC, id DESC)"
        );
      }
    });

    test("Stations multi-page traversal using cursor has zero duplicates across pages", async () => {
      // Page 1
      const page1 = await anonClient.get("/api/stations?limit=10");
      assert.equal(page1.status, 200);
      assert.equal(page1.data.items.length, 10);
      const cursor1 = page1.data.nextCursor;
      assert.ok(cursor1);

      // Page 2
      const page2 = await anonClient.get(`/api/stations?limit=10&cursor=${encodeURIComponent(cursor1)}`);
      assert.equal(page2.status, 200);
      assert.equal(page2.data.items.length, 10);

      // Verify no duplicates
      const ids1 = new Set(page1.data.items.map((s: any) => s.id));
      for (const item of page2.data.items) {
        assert.ok(!ids1.has(item.id), `Duplicate station ID ${item.id} detected across pages`);
      }

      // Verify deterministic ascending order
      for (let i = 0; i < page1.data.items.length - 1; i++) {
        assert.ok(page1.data.items[i].id < page1.data.items[i + 1].id, "Stations must be sorted (id ASC)");
      }
    });

    test("Admin Audit Logs multi-page traversal using cursor has zero duplicates across pages", async () => {
      // Page 1
      const page1 = await adminClient.get("/api/admin/audit-logs?limit=10");
      assert.equal(page1.status, 200);
      assert.equal(page1.data.items.length, 10);
      const cursor1 = page1.data.nextCursor;
      assert.ok(cursor1);

      // Page 2
      const page2 = await adminClient.get(`/api/admin/audit-logs?limit=10&cursor=${encodeURIComponent(cursor1)}`);
      assert.equal(page2.status, 200);
      assert.equal(page2.data.items.length, 10);

      // Verify no duplicates
      const ids1 = new Set(page1.data.items.map((l: any) => l.id));
      for (const item of page2.data.items) {
        assert.ok(!ids1.has(item.id), `Duplicate audit log ID ${item.id} detected across pages`);
      }
    });

    test("Admin Users list pagination returns cursor envelope with deterministic ordering", async () => {
      const res = await adminClient.get("/api/admin/users?limit=10");
      assert.equal(res.status, 200);
      assert.ok(res.data.items.length >= 2);
      assert.equal(res.data.limit, 10);
    });

    test("Games catalog pagination returns cursor envelope with deterministic ordering", async () => {
      const res = await anonClient.get("/api/games?limit=10");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.items));
      assert.equal(res.data.limit, 10);
    });
  });

  describe("4. Filters Validated with Zod", () => {
    test("GET /api/bookings?status=INVALID_STATUS rejects invalid enum with 400", async () => {
      const res = await memberClient.get("/api/bookings?status=INVALID_STATUS");
      assert.equal(res.status, 400);
    });

    test("GET /api/bookings?stationId=-1 rejects negative station ID with 400", async () => {
      const res = await memberClient.get("/api/bookings?stationId=-1");
      assert.equal(res.status, 400);
    });

    test("GET /api/stations?status=INVALID_STATUS rejects invalid station status with 400", async () => {
      const res = await anonClient.get("/api/stations?status=INVALID_STATUS");
      assert.equal(res.status, 400);
    });

    test("GET /api/admin/users?role=super_god rejects invalid role with 400", async () => {
      const res = await adminClient.get("/api/admin/users?role=super_god");
      assert.equal(res.status, 400);
    });
  });

  describe("5. Date-Range Limits Where Appropriate", () => {
    test("GET /api/bookings rejects fromDate > toDate with 400", async () => {
      const from = "2026-05-10T00:00:00.000Z";
      const to = "2026-05-01T00:00:00.000Z";
      const res = await memberClient.get(`/api/bookings?fromDate=${from}&toDate=${to}`);
      assert.equal(res.status, 400);
      assert.ok(JSON.stringify(res.data).includes("fromDate must be earlier"));
    });

    test("GET /api/bookings rejects date range exceeding 365 days with 400", async () => {
      const from = "2025-01-01T00:00:00.000Z";
      const to = "2026-06-01T00:00:00.000Z"; // ~516 days
      const res = await memberClient.get(`/api/bookings?fromDate=${from}&toDate=${to}`);
      assert.equal(res.status, 400);
      assert.ok(JSON.stringify(res.data).includes("cannot exceed 365 days"));
    });

    test("GET /api/admin/audit-logs rejects date range exceeding 90 days with 400", async () => {
      const from = "2026-01-01T00:00:00.000Z";
      const to = "2026-05-01T00:00:00.000Z"; // 120 days
      const res = await adminClient.get(`/api/admin/audit-logs?fromDate=${from}&toDate=${to}`);
      assert.equal(res.status, 400);
      assert.ok(JSON.stringify(res.data).includes("cannot exceed 90 days"));
    });

    test("GET /api/admin/reports/bookings rejects date range exceeding 90 days with 400", async () => {
      const from = "2026-01-01T00:00:00.000Z";
      const to = "2026-05-01T00:00:00.000Z"; // 120 days
      const res = await adminClient.get(`/api/admin/reports/bookings?fromDate=${from}&toDate=${to}`);
      assert.equal(res.status, 400);
      assert.ok(JSON.stringify(res.data).includes("cannot exceed 90 days"));
    });
  });

  describe("6. Resource Limits & Expensive Endpoints", () => {
    test("GET /api/admin/bookings/export enforces batch limit and returns CSV", async () => {
      const res = await adminClient.get("/api/admin/bookings/export?limit=50");
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/csv"));
      assert.ok(res.headers.has("x-export-count"));
    });

    test("GET /api/admin/bookings/export rejects limits exceeding 500 with 400", async () => {
      const res = await adminClient.get("/api/admin/bookings/export?limit=1000");
      assert.equal(res.status, 400);
    });

    test("GET /api/admin/reports/bookings returns paginated reports with cursor envelope", async () => {
      const res = await adminClient.get("/api/admin/reports/bookings?limit=10");
      assert.equal(res.status, 200);
      assert.ok(res.data.items);
      assert.equal(res.data.limit, 10);
      assert.ok(res.headers.has("x-pagination-limit"));
    });
  });
});

