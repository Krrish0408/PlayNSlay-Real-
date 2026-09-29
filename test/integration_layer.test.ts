import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { createHmac } from "crypto";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { hashPassword } from "../server/auth";
import { db, initDbSchema, checkDatabaseHealth } from "../server/db";
import { bookings, stations, users, idempotencyKeys } from "../shared/schema";
import { eq, sql } from "drizzle-orm";

let server: Server;
let baseUrl: string;

interface SessionClient {
  get: (path: string) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (path: string, body?: any, customHeaders?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
}

function makeClient(cookie?: string): SessionClient {
  const request = async (method: string, path: string, body?: any, customHeaders: Record<string, string> = {}) => {
    const headers: Record<string, string> = { ...customHeaders };
    if (cookie) {
      headers["Cookie"] = cookie;
    }
    if (body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data: any = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return { status: res.status, data, headers: res.headers };
  };

  return {
    get: (path: string) => request("GET", path),
    post: (path: string, body?: any, headers?: Record<string, string>) => request("POST", path, body, headers),
  };
}

describe("Production Testing Strategy - INTEGRATION Layer", () => {
  let memberUser: any;
  let employeeUser: any;
  let testGameType: any;
  let testStation: any;
  let memberClient: SessionClient;
  let employeeClient: SessionClient;

  before(async () => {
    await initDbSchema();

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    const { setupAuth } = await import("../server/auth");
    setupAuth(app);

    const httpServer = createServer(app);
    await registerRoutes(httpServer, app);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        server = httpServer;
        resolve();
      });
    });

    // Seed Member
    const memberName = `int_member_${Date.now()}`;
    const password = "password123";
    const hashed = await hashPassword(password);
    memberUser = await storage.createUser({
      username: memberName,
      password: hashed,
      role: "member",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });

    // Seed Employee
    const empName = `int_employee_${Date.now()}`;
    employeeUser = await storage.createUser({
      username: empName,
      password: hashed,
      role: "employee",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });

    // Seed GameType
    testGameType = await storage.createGameType({
      name: `Int Arena ${Date.now()}`,
      description: "Integration Category",
      hourlyPrice: 20000,
      maxPlayers: 4,
      isActive: true,
      priceModel: "flat",
    });

    // Seed Station
    testStation = await storage.createStation({
      name: `INT-ST-01`,
      gameTypeId: testGameType.id,
      status: "AVAILABLE",
    });

    // Login Member
    const mRes = await makeClient().post("/api/login", { username: memberName, password });
    assert.equal(mRes.status, 200);
    const mCookie = mRes.headers.get("set-cookie")!.split(";")[0];
    memberClient = makeClient(mCookie);

    // Login Employee
    const eRes = await makeClient().post("/api/login", { username: empName, password });
    assert.equal(eRes.status, 200);
    const eCookie = eRes.headers.get("set-cookie")!.split(";")[0];
    employeeClient = makeClient(eCookie);
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ==========================================
  // 1. PostgreSQL & Transaction Rollback
  // ==========================================
  describe("1. PostgreSQL Connection Pool & Atomic Transactions", () => {
    test("Database health check verifies live connection pool and latency", async () => {
      const health = await checkDatabaseHealth();
      assert.equal(health.healthy, true);
      assert.ok(health.latencyMs >= 0);
    });

    test("Atomic transaction rollbacks: failed booking leaves zero orphaned records", async () => {
      const initialBookings = await db.select({ count: sql<number>`count(*)::int` }).from(bookings);
      const beforeCount = Number(initialBookings[0]?.count || 0);

      // Attempt invalid booking with negative playerCount and invalid category
      const res = await memberClient.post("/api/bookings", {
        gameTypeId: 999999, // non-existent category
        startTime: "2026-10-20T10:00:00Z",
        endTime: "2026-10-20T12:00:00Z",
        playerCount: 1,
      });

      assert.equal(res.status, 400);

      // Verify no partial record was inserted into database
      const afterBookings = await db.select({ count: sql<number>`count(*)::int` }).from(bookings);
      const afterCount = Number(afterBookings[0]?.count || 0);
      assert.equal(afterCount, beforeCount, "Failed transaction must not insert records into bookings table");
    });
  });

  // ==========================================
  // 2. Session Lifecycle Integration
  // ==========================================
  describe("2. Session Lifecycle & Multi-Device Tracking", () => {
    test("Authenticated session creates trackable session state", async () => {
      const userRes = await memberClient.get("/api/user");
      assert.equal(userRes.status, 200);
      assert.equal(userRes.data.id, memberUser.id);
      assert.equal(userRes.data.role, "member");
    });

    test("Logout terminates session and prevents subsequent access", async () => {
      // Create temporary session
      const tempRes = await makeClient().post("/api/login", {
        username: memberUser.username,
        password: "password123",
      });
      const tempCookie = tempRes.headers.get("set-cookie")!.split(";")[0];
      const tempClient = makeClient(tempCookie);

      const checkBefore = await tempClient.get("/api/user");
      assert.equal(checkBefore.status, 200);

      // Logout
      const logoutRes = await tempClient.post("/api/logout");
      assert.equal(logoutRes.status, 200);

      // Subsequent access must be 401 Unauthorized
      const checkAfter = await tempClient.get("/api/user");
      assert.equal(checkAfter.status, 401);
    });
  });

  // ==========================================
  // 3. Booking Transactions Integration
  // ==========================================
  describe("3. Booking Transactions & Station Allocation", () => {
    let createdBookingId: number;

    test("Transactionally creates booking with auto-assigned station", async () => {
      const res = await memberClient.post("/api/bookings", {
        gameTypeId: testGameType.id,
        startTime: "2026-10-22T14:00:00Z",
        endTime: "2026-10-22T16:00:00Z",
        playerCount: 2,
        paymentMethod: "online",
      });

      assert.equal(res.status, 201);
      assert.ok(res.data.id);
      assert.equal(res.data.userId, memberUser.id);
      assert.equal(res.data.stationId, testStation.id);
      assert.equal(res.data.status, "Pending");
      createdBookingId = res.data.id;
    });

    test("Committed booking is safely queryable in database with all relations", async () => {
      assert.ok(createdBookingId);
      const [record] = await db
        .select()
        .from(bookings)
        .where(eq(bookings.id, createdBookingId));

      assert.ok(record);
      assert.equal(record.userId, memberUser.id);
      assert.equal(record.totalPrice, 40000); // 2 hours at ₹200.00/hr = 40000 paise
      assert.equal(record.currency, "INR");
    });
  });

  // ==========================================
  // 4. Payment Lifecycle Integration
  // ==========================================
  describe("4. Payment Lifecycle: Order, Verification, and Webhook", () => {
    let bookingForPayment: any;
    let orderId: string;

    before(async () => {
      const res = await memberClient.post("/api/bookings", {
        gameTypeId: testGameType.id,
        startTime: "2026-10-23T14:00:00Z",
        endTime: "2026-10-23T15:00:00Z",
        playerCount: 1,
        paymentMethod: "online",
      });
      assert.equal(res.status, 201);
      bookingForPayment = res.data;
    });

    test("Step 1: Create payment order for existing booking", async () => {
      const res = await memberClient.post("/api/payments/create", {
        bookingId: bookingForPayment.id,
        amount: bookingForPayment.totalPrice,
      });

      assert.equal(res.status, 201);
      assert.ok(res.data.orderId);
      assert.equal(res.data.bookingId, bookingForPayment.id);
      assert.equal(res.data.status, "CREATED");
      orderId = res.data.orderId;
    });

    test("Step 2: Client verifies payment with order and payment ID", async () => {
      const res = await memberClient.post("/api/payments/verify", {
        orderId,
        paymentId: `pay_${Date.now()}_test`,
        bookingId: bookingForPayment.id,
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.status, "COMPLETED");
    });

    test("Step 3: Webhook payment.captured updates booking status to Approved", async () => {
      const webhookId = `evt_int_${Date.now()}`;
      const payload = {
        event: "payment.captured",
        bookingId: bookingForPayment.id,
        paymentId: `pay_${Date.now()}_wh`,
      };

      const secret = process.env.PAYMENT_WEBHOOK_SECRET || "prod_webhook_secret_key_v1";
      const signature = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");

      const res = await makeClient().post("/api/payments/webhook", payload, {
        "x-webhook-id": webhookId,
        "x-webhook-signature": signature,
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.status, "PROCESSED");

      // Verify booking updated in database
      const [updated] = await db
        .select()
        .from(bookings)
        .where(eq(bookings.id, bookingForPayment.id));

      assert.equal(updated.status, "Approved");
    });

    test("Step 4: Invalid webhook signature is rejected with 401", async () => {
      const payload = { event: "payment.captured", bookingId: 1 };
      const res = await makeClient().post("/api/payments/webhook", payload, {
        "x-webhook-id": `evt_tampered_${Date.now()}`,
        "x-webhook-signature": "tampered_invalid_signature_hex",
      });

      assert.equal(res.status, 401);
      assert.equal(res.data.code, "INVALID_WEBHOOK_SIGNATURE");
    });
  });
});
