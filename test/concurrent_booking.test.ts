import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { hashPassword } from "../server/auth";
import { db, initDbSchema } from "../server/db";
import { bookings } from "../shared/schema";
import { eq, sql } from "drizzle-orm";

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
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path),
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

// Test users and entities
let clients: SessionClient[] = [];
let testCategory: any;
let testStationSingle: any;
let multiCategory: any;
let stationMultiA: any;
let stationMultiB: any;

before(async () => {
  await initDbSchema();

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

  const hashedPass = await hashPassword("concurPass123");

  // Create 6 concurrent test users
  for (let i = 1; i <= 6; i++) {
    const user = await storage.createUser({
      username: `concurrent_user_${i}`,
      password: hashedPass,
      email: `concurrent_${i}@testlounge.com`,
      role: "member",
      membershipTier: "silver",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });
    const client = await loginUser(`concurrent_user_${i}`, "concurPass123");
    clients.push(client);
  }

  // Create dedicated category with exactly 1 station for single-station race testing
  testCategory = await storage.createGameType({
    name: "Concurrent Test Arena",
    description: "High concurrency race testing category",
    hourlyPrice: 1500,
    maxPlayers: 1,
    priceModel: "flat",
    isActive: true,
  });

  testStationSingle = await storage.createStation({
    name: "RACE-STATION-01",
    gameTypeId: testCategory.id,
    status: "AVAILABLE",
  });

  // Create category with 2 stations for multi-station auto-assignment testing
  multiCategory = await storage.createGameType({
    name: "Multi-Station Race Arena",
    description: "Multi station auto allocation testing",
    hourlyPrice: 2000,
    maxPlayers: 1,
    priceModel: "flat",
    isActive: true,
  });

  stationMultiA = await storage.createStation({
    name: "MULTI-STATION-A",
    gameTypeId: multiCategory.id,
    status: "AVAILABLE",
  });

  stationMultiB = await storage.createStation({
    name: "MULTI-STATION-B",
    gameTypeId: multiCategory.id,
    status: "AVAILABLE",
  });
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("Concurrent Race-Condition Safe Booking Creation", () => {

  test("1. Concurrent Booking Requests: Exactly ONE wins, others receive safe 409", async () => {
    const startTime = new Date("2027-01-15T14:00:00.000Z");
    const endTime = new Date("2027-01-15T16:00:00.000Z");

    const payload = {
      gameTypeId: testCategory.id,
      stationId: testStationSingle.id,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    };

    // Fire 5 concurrent booking requests simultaneously for the exact same station and time interval
    const concurrentRequests = clients.slice(0, 5).map((client) =>
      client.post("/api/bookings", payload)
    );

    const responses = await Promise.all(concurrentRequests);

    const winners = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    assert.equal(winners.length, 1, `Expected exactly 1 winning booking, got ${winners.length}`);
    assert.equal(conflicts.length, 4, `Expected exactly 4 conflicts (HTTP 409), got ${conflicts.length}`);

    // Verify safe structured error for all losing requests
    for (const conflict of conflicts) {
      assert.equal(conflict.data.error, "BookingConflict", "Must have structured error field 'BookingConflict'");
      assert.equal(conflict.data.code, "STATION_ALREADY_BOOKED", "Must have code 'STATION_ALREADY_BOOKED'");
      assert.ok(
        conflict.data.message.toLowerCase().includes("booked") ||
        conflict.data.message.toLowerCase().includes("available"),
        "Message must be a friendly explanation without leaking internals"
      );

      // Verify no database internals are exposed
      const jsonString = JSON.stringify(conflict.data);
      assert.ok(!jsonString.includes("no_overlapping_station_bookings"), "Must NOT expose constraint name");
      assert.ok(!jsonString.includes("tstzrange"), "Must NOT expose SQL range function name");
      assert.ok(!jsonString.includes("pg_"), "Must NOT expose postgres internals");
      assert.ok(!jsonString.includes("SELECT"), "Must NOT expose SQL queries");
    }

    // Verify in database: exactly 1 booking exists for testStationSingle in this time slot
    const dbBookings = await db
      .select()
      .from(bookings)
      .where(
        sql`${bookings.stationId} = ${testStationSingle.id} AND ${bookings.status} NOT IN ('Cancelled', 'Rejected')`
      );

    assert.equal(dbBookings.length, 1, "Database must strictly contain exactly 1 non-cancelled booking");
    assert.equal(dbBookings[0].id, winners[0].data.id, "Database record must match the winner's booking ID");
  });

  test("2. PostgreSQL Database-Level Enforcement: Direct concurrent transactions fail with 23P01", async () => {
    const slotStart = new Date("2027-02-10T10:00:00.000Z");
    const slotEnd = new Date("2027-02-10T12:00:00.000Z");

    let winnerId: number | null = null;
    let caughtExclusionViolation = false;

    // Fire 2 concurrent database transactions directly at the PostgreSQL level
    const insertDirect = async (bookingRef: string) => {
      return await db.transaction(async (tx: any) => {
        const [inserted] = await tx.insert(bookings).values({
          userId: 1,
          gameTypeId: testCategory.id,
          stationId: testStationSingle.id,
          startTime: slotStart,
          endTime: slotEnd,
          playerCount: 1,
          totalPrice: 3000,
          paymentMethod: "offline",
          status: "Approved",
          bookingRef,
        }).returning();
        return inserted;
      });
    };

    const results = await Promise.allSettled([
      insertDirect("DIRECT-RACE-A"),
      insertDirect("DIRECT-RACE-B"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    assert.equal(fulfilled.length, 1, "Only one direct transaction can succeed");
    assert.equal(rejected.length, 1, "The competing direct transaction must be rejected by PostgreSQL");

    const err = rejected[0].reason;
    const innerErr = err?.cause || err;
    if (
      innerErr?.code === "23P01" ||
      err?.code === "23P01" ||
      String(err?.message).includes("no_overlapping_station_bookings") ||
      String(innerErr?.message).includes("no_overlapping_station_bookings") ||
      String(err?.message).includes("exclusion") ||
      String(innerErr?.message).includes("exclusion")
    ) {
      caughtExclusionViolation = true;
    }
    assert.ok(caughtExclusionViolation, `Expected 23P01 exclusion violation, got code: ${innerErr?.code || err?.code}, message: ${err?.message}`);
  });

  test("3. Cancelled and Rejected bookings do NOT block new bookings", async () => {
    const cancelSlotStart = new Date("2027-03-01T10:00:00.000Z");
    const cancelSlotEnd = new Date("2027-03-01T12:00:00.000Z");

    // Insert a cancelled booking for this slot
    await db.insert(bookings).values({
      userId: 1,
      gameTypeId: testCategory.id,
      stationId: testStationSingle.id,
      startTime: cancelSlotStart,
      endTime: cancelSlotEnd,
      playerCount: 1,
      totalPrice: 3000,
      paymentMethod: "offline",
      status: "Cancelled",
      bookingRef: "CANCELLED-REF",
    });

    // A new booking request for the exact same slot must succeed
    const res = await clients[0].post("/api/bookings", {
      gameTypeId: testCategory.id,
      stationId: testStationSingle.id,
      startTime: cancelSlotStart.toISOString(),
      endTime: cancelSlotEnd.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    });

    assert.equal(res.status, 201, "New booking must succeed over a cancelled booking");
    assert.equal(res.data.status, "Pending");

    // Insert a rejected booking for another slot
    const rejectSlotStart = new Date("2027-03-02T10:00:00.000Z");
    const rejectSlotEnd = new Date("2027-03-02T12:00:00.000Z");

    await db.insert(bookings).values({
      userId: 1,
      gameTypeId: testCategory.id,
      stationId: testStationSingle.id,
      startTime: rejectSlotStart,
      endTime: rejectSlotEnd,
      playerCount: 1,
      totalPrice: 3000,
      paymentMethod: "offline",
      status: "Rejected",
      bookingRef: "REJECTED-REF",
    });

    // A new booking request for the rejected slot must succeed
    const res2 = await clients[1].post("/api/bookings", {
      gameTypeId: testCategory.id,
      stationId: testStationSingle.id,
      startTime: rejectSlotStart.toISOString(),
      endTime: rejectSlotEnd.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    });

    assert.equal(res2.status, 201, "New booking must succeed over a rejected booking");
  });

  test("4. Half-Open Interval Boundary: Back-to-back bookings (adjacent hours) both succeed", async () => {
    // 10:00 to 11:00 and 11:00 to 12:00 for the same physical station
    const slot1Start = new Date("2027-04-10T10:00:00.000Z");
    const slot1End = new Date("2027-04-10T11:00:00.000Z");
    const slot2Start = new Date("2027-04-10T11:00:00.000Z");
    const slot2End = new Date("2027-04-10T12:00:00.000Z");

    const res1 = await clients[0].post("/api/bookings", {
      gameTypeId: testCategory.id,
      stationId: testStationSingle.id,
      startTime: slot1Start.toISOString(),
      endTime: slot1End.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    });
    assert.equal(res1.status, 201, "First interval (10:00-11:00) must succeed");

    const res2 = await clients[1].post("/api/bookings", {
      gameTypeId: testCategory.id,
      stationId: testStationSingle.id,
      startTime: slot2Start.toISOString(),
      endTime: slot2End.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    });
    assert.equal(res2.status, 201, "Adjacent back-to-back interval (11:00-12:00) must succeed under half-open [) exclusion");

    // Partial overlap (10:30 to 11:30) must be rejected with 409
    const resOverlap = await clients[2].post("/api/bookings", {
      gameTypeId: testCategory.id,
      stationId: testStationSingle.id,
      startTime: new Date("2027-04-10T10:30:00.000Z").toISOString(),
      endTime: new Date("2027-04-10T11:30:00.000Z").toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    });
    assert.equal(resOverlap.status, 409, "Overlapping interval (10:30-11:30) must be rejected with 409");
    assert.equal(resOverlap.data.error, "BookingConflict");
  });

  test("5. Multi-Station Auto-Allocation: 2 concurrent requests win separate stations, 3rd gets 409", async () => {
    const multiSlotStart = new Date("2027-05-20T16:00:00.000Z");
    const multiSlotEnd = new Date("2027-05-20T18:00:00.000Z");

    const payload = {
      gameTypeId: multiCategory.id,
      // stationId omitted to test auto-allocation concurrency
      startTime: multiSlotStart.toISOString(),
      endTime: multiSlotEnd.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    };

    // 3 clients concurrently request booking in a category with only 2 stations
    const [resA, resB, resC] = await Promise.all([
      clients[0].post("/api/bookings", payload),
      clients[1].post("/api/bookings", payload),
      clients[2].post("/api/bookings", payload),
    ]);

    const results = [resA, resB, resC];
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    assert.equal(successes.length, 2, "Exactly 2 bookings must succeed for 2 available stations");
    assert.equal(conflicts.length, 1, "The 3rd concurrent request must be rejected with 409");

    // Ensure the two winners got DIFFERENT stations
    const stationId1 = successes[0].data.stationId;
    const stationId2 = successes[1].data.stationId;
    assert.notEqual(stationId1, stationId2, "Auto-allocation must give two different physical stations");
    assert.ok(
      [stationMultiA.id, stationMultiB.id].includes(stationId1) &&
      [stationMultiA.id, stationMultiB.id].includes(stationId2),
      "Allocated stations must belong to the requested category"
    );

    // Verify structured error on the conflict
    assert.equal(conflicts[0].data.error, "BookingConflict");
    assert.equal(conflicts[0].data.code, "STATION_ALREADY_BOOKED");
  });

  test("6. Different Stations Concurrent Bookings for the same time interval both succeed", async () => {
    const diffSlotStart = new Date("2027-06-01T20:00:00.000Z");
    const diffSlotEnd = new Date("2027-06-01T22:00:00.000Z");

    const [resA, resB] = await Promise.all([
      clients[0].post("/api/bookings", {
        gameTypeId: multiCategory.id,
        stationId: stationMultiA.id,
        startTime: diffSlotStart.toISOString(),
        endTime: diffSlotEnd.toISOString(),
        playerCount: 1,
        paymentMethod: "offline",
      }),
      clients[1].post("/api/bookings", {
        gameTypeId: multiCategory.id,
        stationId: stationMultiB.id,
        startTime: diffSlotStart.toISOString(),
        endTime: diffSlotEnd.toISOString(),
        playerCount: 1,
        paymentMethod: "offline",
      }),
    ]);

    assert.equal(resA.status, 201, "Booking for Station A must succeed");
    assert.equal(resB.status, 201, "Booking for Station B must succeed");
    assert.equal(resA.data.stationId, stationMultiA.id);
    assert.equal(resB.data.stationId, stationMultiB.id);
  });
});
