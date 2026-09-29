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
import { bookings, stations, users, idempotencyKeys, payments } from "../shared/schema";
import { eq, sql } from "drizzle-orm";

let server: Server;
let baseUrl: string;

interface SessionClient {
  get: (path: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (path: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
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
  };
}

describe("Production Testing Strategy - CONCURRENCY Layer", () => {
  let testGameType: any;
  let testStation: any;
  let memberUser1: any;
  let memberUser2: any;
  let employeeUser: any;
  let memberClient1: SessionClient;
  let memberClient2: SessionClient;
  let employeeClient: SessionClient;

  before(async () => {
    await initDbSchema();

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

    const password = "password123";
    const hashed = await hashPassword(password);
    const rand = Math.floor(Math.random() * 100000);

    // Member 1
    const m1Name = `conc_m1_${rand}`;
    memberUser1 = await storage.createUser({
      username: m1Name,
      password: hashed,
      role: "member",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });
    const m1Res = await makeClient().post("/api/login", { username: m1Name, password });
    assert.equal(m1Res.status, 200);
    const m1Cookie = m1Res.headers.get("set-cookie")!.split(";")[0];
    memberClient1 = makeClient(m1Cookie);

    // Member 2
    const m2Name = `conc_m2_${rand}`;
    memberUser2 = await storage.createUser({
      username: m2Name,
      password: hashed,
      role: "member",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });
    const m2Res = await makeClient().post("/api/login", { username: m2Name, password });
    assert.equal(m2Res.status, 200);
    const m2Cookie = m2Res.headers.get("set-cookie")!.split(";")[0];
    memberClient2 = makeClient(m2Cookie);

    // Employee
    const empName = `conc_emp_${rand}`;
    employeeUser = await storage.createUser({
      username: empName,
      password: hashed,
      role: "employee",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });
    const empRes = await makeClient().post("/api/login", { username: empName, password });
    assert.equal(empRes.status, 200);
    const empCookie = empRes.headers.get("set-cookie")!.split(";")[0];
    employeeClient = makeClient(empCookie);

    // Seed dedicated Category & Station for concurrency testing
    testGameType = await storage.createGameType({
      name: `ConcCategory_${rand}`,
      description: "Dedicated Concurrency Category",
      hourlyPrice: 20000,
      maxPlayers: 4,
      isActive: true,
      priceModel: "flat",
    });

    testStation = await storage.createStation({
      name: `CONC-ST-01`,
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

  test("1. Simultaneous booking creation: 2 concurrent requests for single available station slot -> exactly 1 succeeds (201), other gets 409 conflict", async () => {
    const bookingPayload = {
      gameTypeId: testGameType.id,
      startTime: "2026-11-20T14:00:00Z",
      endTime: "2026-11-20T16:00:00Z",
      playerCount: 1,
      paymentMethod: "online",
    };

    // Fire both requests simultaneously
    const [res1, res2] = await Promise.all([
      memberClient1.post("/api/bookings", bookingPayload),
      memberClient2.post("/api/bookings", bookingPayload),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [201, 409], "Expected exactly one 201 Created and one 409 Conflict");

    const winner = res1.status === 201 ? res1.data : res2.data;
    const loser = res1.status === 409 ? res1.data : res2.data;

    assert.ok(winner.id, "Winner booking must have an id");
    assert.ok(
      loser.code === "STATION_ALREADY_BOOKED" ||
      loser.error === "BookingConflict" ||
      (loser.message && loser.message.includes("booked")),
      "Loser must receive booking conflict error"
    );

    // Verify DB integrity: winner booking exists in database
    const [existing] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, winner.id));

    assert.ok(existing, "Database must hold winner booking record");
    assert.equal(existing.status, "Pending");
  });

  test("2. Simultaneous session start: concurrent start timer requests return 200 idempotently without duplicate timers", async () => {
    // Create a confirmed booking to start timer for
    const booking = await storage.createBooking({
      bookingRef: `BK-CONC-${Date.now()}-1`,
      userId: memberUser1.id,
      gameTypeId: testGameType.id,
      stationId: testStation.id,
      startTime: new Date("2026-11-21T16:00:00Z"),
      endTime: new Date("2026-11-21T17:00:00Z"),
      playerCount: 1,
      totalPrice: 20000,
      currency: "INR",
      paymentMethod: "cash",
      status: "Confirmed",
    });

    // Fire two simultaneous timer start calls
    const [startRes1, startRes2] = await Promise.all([
      employeeClient.post(`/api/bookings/${booking.id}/timer/start`),
      employeeClient.post(`/api/bookings/${booking.id}/timer/start`),
    ]);

    assert.equal(startRes1.status, 200, "First start request must return 200");
    assert.equal(startRes2.status, 200, "Second simultaneous start request must return 200 idempotently");

    // Station remains operational AVAILABLE
    const updatedStation = await storage.getStation(testStation.id);
    assert.equal(updatedStation?.status, "AVAILABLE");

    // Booking must have a valid timer started
    const updatedBooking = await storage.getBooking(booking.id);
    assert.ok(updatedBooking?.timerStartedAt, "Booking must have timerStartedAt set");
    assert.equal(updatedBooking?.status, "Approved");
  });

  test("3. Duplicate payment webhook: concurrent duplicate webhook events are deduplicated with ALREADY_PROCESSED", async () => {
    const whCategory = await storage.createGameType({
      name: `WHCat_${Date.now()}`,
      description: "Dedicated Webhook Category",
      hourlyPrice: 20000,
      maxPlayers: 4,
      isActive: true,
      priceModel: "flat",
    });
    await storage.createStation({
      name: `WH-ST-${Date.now()}`,
      gameTypeId: whCategory.id,
      status: "AVAILABLE",
    });

    // Create booking and payment order via API
    const bRes = await memberClient1.post("/api/bookings", {
      gameTypeId: whCategory.id,
      startTime: "2026-11-25T14:00:00Z",
      endTime: "2026-11-25T15:00:00Z",
      playerCount: 1,
      paymentMethod: "online",
    });
    assert.equal(bRes.status, 201);
    const booking = bRes.data;

    const pRes = await memberClient1.post("/api/payments/create", {
      bookingId: booking.id,
      amount: booking.totalPrice,
    });
    assert.equal(pRes.status, 201);

    const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || "prod_webhook_secret_key_v1";
    const webhookId = `evt_conc_${Date.now()}_${Math.random()}`;
    const payload = {
      event: "payment.captured",
      bookingId: booking.id,
      paymentId: `pay_conc_${Date.now()}`,
    };
    const bodyStr = JSON.stringify(payload);
    const signature = createHmac("sha256", webhookSecret).update(bodyStr).digest("hex");

    const webhookHeaders = {
      "Content-Type": "application/json",
      "x-webhook-signature": signature,
      "x-webhook-id": webhookId,
    };

    // Fire duplicate webhook requests concurrently
    const [res1, res2] = await Promise.all([
      makeClient().post("/api/payments/webhook", payload, webhookHeaders),
      makeClient().post("/api/payments/webhook", payload, webhookHeaders),
    ]);

    assert.equal(res1.status, 200, "Webhook 1 should return 200");
    assert.equal(res2.status, 200, "Webhook 2 should return 200");

    const results = [res1.data, res2.data];
    const initialProcessed = results.find((r) => r.status === "PROCESSED");
    const deduplicated = results.find((r) => r.status === "ALREADY_PROCESSED");

    assert.ok(initialProcessed, "One response must indicate fresh processing (PROCESSED)");
    assert.ok(deduplicated, "One response must indicate duplicate deduplication (ALREADY_PROCESSED)");

    // Verify booking updated to Approved in database
    const [updatedBooking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, booking.id));
    assert.equal(updatedBooking?.status, "Approved");
  });

  test("4. Duplicate booking requests: matching Idempotency-Key returns cached response; modified payload returns 409 mismatch", async () => {
    // Add a second station so we don't hit station capacity limit
    const station2 = await storage.createStation({
      name: `CONC-ST-02`,
      gameTypeId: testGameType.id,
      status: "AVAILABLE",
    });

    const idempotencyKey = `idem_key_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const originalPayload = {
      gameTypeId: testGameType.id,
      startTime: "2026-11-23T10:00:00Z",
      endTime: "2026-11-23T11:00:00Z",
      playerCount: 1,
      paymentMethod: "online",
    };

    // 1st request: fresh creation
    const res1 = await memberClient2.post("/api/bookings", originalPayload, {
      "Idempotency-Key": idempotencyKey,
    });
    assert.equal(res1.status, 201, "First request with new idempotency key must succeed with 201");
    const createdBookingId = res1.data.id;
    assert.ok(createdBookingId);

    // 2nd request: duplicate with IDENTICAL payload
    const res2 = await memberClient2.post("/api/bookings", originalPayload, {
      "Idempotency-Key": idempotencyKey,
    });
    // Should return cached response with same booking ID
    assert.ok(res2.status === 200 || res2.status === 201, "Duplicate idempotent request must return 200/201");
    assert.equal(res2.data.id, createdBookingId, "Duplicate idempotent request must return identical booking ID");

    // 3rd request: duplicate key with DIFFERENT payload (endTime modified)
    const modifiedPayload = {
      ...originalPayload,
      endTime: "2026-11-23T12:00:00Z",
    };
    const res3 = await memberClient2.post("/api/bookings", modifiedPayload, {
      "Idempotency-Key": idempotencyKey,
    });
    assert.equal(res3.status, 409, "Mismatched payload with same idempotency key must return 409 Conflict");
    assert.ok(
      res3.data.code === "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH" ||
      (res3.data.message && res3.data.message.includes("idempotency")),
      "Must return idempotency mismatch error"
    );
  });
});
