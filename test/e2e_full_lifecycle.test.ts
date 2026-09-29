import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { createHmac } from "crypto";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { hashPassword } from "../server/auth";
import { db, initDbSchema } from "../server/db";
import { bookings, stations, users, payments } from "../shared/schema";
import { eq } from "drizzle-orm";
import { getLastSentVerificationEmail, clearSentEmailsLog } from "../server/email-service";

let server: Server;
let baseUrl: string;

interface SessionClient {
  get: (path: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (path: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  patch: (path: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
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
    get: (path: string, headers?: Record<string, string>) => request("GET", path, undefined, headers),
    post: (path: string, body?: any, headers?: Record<string, string>) => request("POST", path, body, headers),
    patch: (path: string, body?: any, headers?: Record<string, string>) => request("PATCH", path, body, headers),
  };
}

describe("Production Testing Strategy - E2E Full User & Staff Lifecycle", () => {
  let adminUser: any;
  let employeeUser: any;
  let testGameType: any;
  let testStation: any;

  let adminClient: SessionClient;
  let employeeClient: SessionClient;
  let memberClient: SessionClient;

  const rand = Math.floor(Math.random() * 100000);
  const memberUsername = `e2e_user_${rand}`;
  const memberEmail = `e2e_user_${rand}@testgaminglounge.com`;
  const memberPassword = "SecureMemberPass123!";

  let registeredUserId: number;
  let createdBookingId: number;
  let paymentOrderId: string;
  let offlineBookingId: number;

  before(async () => {
    await initDbSchema();
    clearSentEmailsLog();

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

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

    const hashedStaffPass = await hashPassword("StaffPass123!");

    // Seed Admin
    const adminName = `e2e_admin_${rand}`;
    adminUser = await storage.createUser({
      username: adminName,
      password: hashedStaffPass,
      role: "admin",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });
    const aRes = await makeClient().post("/api/login", { username: adminName, password: "StaffPass123!" });
    assert.equal(aRes.status, 200);
    adminClient = makeClient(aRes.headers.get("set-cookie")!.split(";")[0]);

    // Seed Employee
    const empName = `e2e_employee_${rand}`;
    employeeUser = await storage.createUser({
      username: empName,
      password: hashedStaffPass,
      role: "employee",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });
    const eRes = await makeClient().post("/api/login", { username: empName, password: "StaffPass123!" });
    assert.equal(eRes.status, 200);
    employeeClient = makeClient(eRes.headers.get("set-cookie")!.split(";")[0]);

    // Seed Game Category & Physical Stations
    testGameType = await storage.createGameType({
      name: `E2E PS5 Arena ${rand}`,
      description: "PlayStation 5 Pro Lounge",
      hourlyPrice: 25000, // ₹250.00
      maxPlayers: 4,
      isActive: true,
      priceModel: "flat",
    });

    testStation = await storage.createStation({
      name: `E2E-ST-01`,
      gameTypeId: testGameType.id,
      status: "AVAILABLE",
    });

    await storage.createStation({
      name: `E2E-ST-02`,
      gameTypeId: testGameType.id,
      status: "AVAILABLE",
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  // ============================================================
  // Step 1: Member Registration
  // ============================================================
  test("E2E Step 1: Member Registration dispatches secure email token", async () => {
    const regRes = await makeClient().post("/api/register", {
      username: memberUsername,
      email: memberEmail,
      password: memberPassword,
      fullName: "E2E Test Player",
    });

    assert.equal(regRes.status, 201, "Registration should succeed with 201 Created");
    assert.equal(regRes.data.isEmailVerified, false, "Initial user must be unverified");
    registeredUserId = regRes.data.id;
    assert.ok(registeredUserId, "Must return registered user ID");
  });

  // ============================================================
  // Step 2: Email Verification
  // ============================================================
  test("E2E Step 2: Email Verification validates token and activates account", async () => {
    const sentEmail = getLastSentVerificationEmail();
    assert.ok(sentEmail, "Verification email must be intercepted in test environment");
    assert.equal(sentEmail.to, memberEmail);

    const verifyRes = await makeClient().post("/api/auth/verify-email", {
      token: sentEmail.verificationToken,
    });

    assert.equal(verifyRes.status, 200, "Email verification must return 200 OK");
    assert.equal(verifyRes.data.user.isEmailVerified, true, "User must now be verified");
  });

  // ============================================================
  // Step 3: Member Login
  // ============================================================
  test("E2E Step 3: Member Login establishes authenticated session", async () => {
    const loginRes = await makeClient().post("/api/login", {
      username: memberUsername,
      password: memberPassword,
    });

    assert.equal(loginRes.status, 200, "Login must succeed with 200 OK");
    assert.equal(loginRes.data.id, registeredUserId);
    assert.equal(loginRes.data.role, "member");

    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];
    memberClient = makeClient(cookie);

    // Verify session
    const meRes = await memberClient.get("/api/user");
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.username, memberUsername);
  });

  // ============================================================
  // Step 4: Booking Creation
  // ============================================================
  test("E2E Step 4: Member creates online booking with auto-assigned station", async () => {
    const bookingRes = await memberClient.post("/api/bookings", {
      gameTypeId: testGameType.id,
      startTime: "2026-12-01T15:00:00Z",
      endTime: "2026-12-01T17:00:00Z",
      playerCount: 2,
      paymentMethod: "online",
    });

    assert.equal(bookingRes.status, 201, "Booking creation must return 201 Created");
    assert.ok(bookingRes.data.id, "Must return created booking ID");
    assert.equal(bookingRes.data.status, "Pending");
    assert.equal(bookingRes.data.totalPrice, 50000); // 2 hours at ₹250.00/hr = 50000 paise
    createdBookingId = bookingRes.data.id;
  });

  // ============================================================
  // Step 5: Payment Creation & Completion
  // ============================================================
  test("E2E Step 5: Payment lifecycle: order creation, client verification, and captured webhook", async () => {
    // 5a. Create payment order
    const orderRes = await memberClient.post("/api/payments/create", {
      bookingId: createdBookingId,
      amount: 50000,
    });
    assert.equal(orderRes.status, 201);
    paymentOrderId = orderRes.data.orderId;
    assert.ok(paymentOrderId);

    // 5b. Client payment verification
    const verifyPayRes = await memberClient.post("/api/payments/verify", {
      orderId: paymentOrderId,
      paymentId: `pay_e2e_${Date.now()}`,
      bookingId: createdBookingId,
    });
    assert.equal(verifyPayRes.status, 200);
    assert.equal(verifyPayRes.data.success, true);

    // 5c. Webhook confirms capture with HMAC signature
    const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || "prod_webhook_secret_key_v1";
    const webhookId = `evt_e2e_${Date.now()}`;
    const payload = {
      event: "payment.captured",
      bookingId: createdBookingId,
      paymentId: `pay_e2e_wh_${Date.now()}`,
    };
    const bodyStr = JSON.stringify(payload);
    const signature = createHmac("sha256", webhookSecret).update(bodyStr).digest("hex");

    const whRes = await makeClient().post("/api/payments/webhook", payload, {
      "Content-Type": "application/json",
      "x-webhook-signature": signature,
      "x-webhook-id": webhookId,
    });
    assert.equal(whRes.status, 200);
    assert.equal(whRes.data.status, "PROCESSED");

    // Verify booking state in DB is now Approved
    const [dbBooking] = await db.select().from(bookings).where(eq(bookings.id, createdBookingId));
    assert.equal(dbBooking.status, "Approved");
  });

  // ============================================================
  // Step 6: Booking Cancellation
  // ============================================================
  test("E2E Step 6: Member cancels booking within allowed policy", async () => {
    // Member creates an advance booking to test cancellation
    const bRes = await memberClient.post("/api/bookings", {
      gameTypeId: testGameType.id,
      startTime: "2026-12-10T10:00:00Z",
      endTime: "2026-12-10T11:00:00Z",
      playerCount: 1,
      paymentMethod: "online",
    });
    assert.equal(bRes.status, 201);
    const cancelTargetId = bRes.data.id;

    // Member cancels it
    const cancelRes = await memberClient.patch(`/api/bookings/${cancelTargetId}/status`, {
      status: "Cancelled",
    });

    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.status, "Cancelled");

    // Verify DB
    const [cancelledRecord] = await db.select().from(bookings).where(eq(bookings.id, cancelTargetId));
    assert.equal(cancelledRecord.status, "Cancelled");
  });

  // ============================================================
  // Step 7: Employee Walk-In Check-In
  // ============================================================
  test("E2E Step 7: Employee performs walk-in offline booking check-in", async () => {
    const offlineRes = await employeeClient.post("/api/bookings/offline", {
      username: `walkin_${Date.now()}`,
      stationId: testStation.id,
      gameTypeId: testGameType.id,
      startTime: "2026-12-05T12:00:00Z",
      endTime: "2026-12-05T13:00:00Z",
      playerCount: 1,
      paymentMethod: "cash",
    });

    assert.equal(offlineRes.status, 201, "Offline walk-in check-in must succeed with 201");
    assert.ok(offlineRes.data.id);
    offlineBookingId = offlineRes.data.id;
  });

  // ============================================================
  // Step 8: Session Start and Stop
  // ============================================================
  test("E2E Step 8: Employee starts session timer and stops on session completion", async () => {
    // Start session timer
    const startRes = await employeeClient.post(`/api/bookings/${offlineBookingId}/timer/start`);
    assert.equal(startRes.status, 200, "Timer start must return 200 OK");
    assert.ok(startRes.data.timerStartedAt);
    assert.equal(startRes.data.status, "Approved");

    // Verify booking is active and station is operational
    const currentStation = await storage.getStation(testStation.id);
    assert.equal(currentStation?.status, "AVAILABLE");

    // Stop session timer
    const stopRes = await employeeClient.post(`/api/bookings/${offlineBookingId}/timer/stop`);
    assert.equal(stopRes.status, 200, "Timer stop must return 200 OK");
    assert.ok(stopRes.data.timerEndTime);
    assert.equal(stopRes.data.status, "Completed");

    // Station remains operational AVAILABLE
    const releasedStation = await storage.getStation(testStation.id);
    assert.equal(releasedStation?.status, "AVAILABLE");
  });

  // ============================================================
  // Step 9: Admin Operations
  // ============================================================
  test("E2E Step 9: Admin performs privileged stats inspection and user role updates", async () => {
    // 9a. Comprehensive stats inspection
    const statsRes = await adminClient.get("/api/admin/stats/comprehensive");
    assert.equal(statsRes.status, 200);
    assert.ok(statsRes.data);

    // 9b. Audit logs inspection
    const auditRes = await adminClient.get("/api/admin/audit-logs");
    assert.equal(auditRes.status, 200);
    assert.ok(Array.isArray(auditRes.data));

    // 9c. Update user role
    const roleRes = await adminClient.patch(`/api/admin/users/${registeredUserId}/role`, {
      role: "employee",
    });
    assert.equal(roleRes.status, 200);
    assert.equal(roleRes.data.user.role, "employee");

    // Verify DB
    const [updatedUser] = await db.select().from(users).where(eq(users.id, registeredUserId));
    assert.equal(updatedUser.role, "employee");
  });


});
