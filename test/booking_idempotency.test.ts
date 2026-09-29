import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { initDbSchema, db } from "../server/db";
import { hashPassword } from "../server/auth";
import { bookings, idempotencyKeys, stations } from "../shared/schema";
import { eq, and } from "drizzle-orm";
import { CSRF_COOKIE_NAME } from "../server/csrf";

interface TestClient {
  cookieJar: string[];
  csrfToken?: string;
  get: (urlPath: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (urlPath: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
}

function createClient(serverAddress: string): TestClient {
  let cookieJar: string[] = [];
  let csrfToken: string | undefined;

  const updateCookies = (setCookies: string[]) => {
    for (const sc of setCookies) {
      const cookiePart = sc.split(";")[0];
      const [cName] = cookiePart.split("=");
      cookieJar = cookieJar.filter((c) => !c.startsWith(cName + "="));
      if (!sc.includes("Expires=Thu, 01 Jan 1970") && !sc.includes("Max-Age=0")) {
        cookieJar.push(cookiePart);
      }
    }
  };

  const request = async (
    method: string,
    urlPath: string,
    body?: any,
    customHeaders?: Record<string, string>
  ) => {
    const fullUrl = new URL(urlPath, serverAddress);
    const headers: Record<string, string> = { ...customHeaders };
    if (cookieJar.length > 0 && !headers["Cookie"]) {
      headers["Cookie"] = cookieJar.join("; ");
    }
    if (body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    if (!headers["Origin"]) {
      headers["Origin"] = serverAddress;
    }
    if (client && client.csrfToken && !headers["X-CSRF-Token"]) {
      headers["X-CSRF-Token"] = client.csrfToken;
    }

    const res = await fetch(fullUrl.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      updateCookies(setCookies);
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

  const client: TestClient = {
    cookieJar,
    csrfToken,
    get: (urlPath, headers) => request("GET", urlPath, undefined, headers),
    post: (urlPath, body, headers) => request("POST", urlPath, body, headers),
  };

  return client;
}

async function loginUser(client: TestClient, username: string, pass = "SecurePass123!"): Promise<void> {
  const csrfRes = await client.get("/api/csrf-token");
  client.csrfToken = csrfRes.data.csrfToken;

  const loginRes = await client.post("/api/login", {
    username,
    password: pass,
  });
  assert.equal(loginRes.status, 200, `Login failed for user ${username}`);

  // Fetch updated post-login csrf token
  const postLoginCsrf = await client.get("/api/csrf-token");
  client.csrfToken = postLoginCsrf.data.csrfToken;
}

describe("Server-Side Booking Creation Idempotency Suite", () => {
  let server: http.Server;
  let serverAddress: string;

  let testCategory: any;
  let testStation: any;
  let memberUser1: any;
  let memberUser2: any;
  let staffUser: any;

  let client1: TestClient;
  let client2: TestClient;
  let staffClient: TestClient;

  before(async () => {
    await initDbSchema();

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

    const hashedPass = await hashPassword("SecurePass123!");

    const ts = Date.now();
    memberUser1 = await storage.createUser({
      username: `idem_member_1_${ts}`,
      password: hashedPass,
      email: `idem_member_1_${ts}@test.com`,
      role: "member",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });

    memberUser2 = await storage.createUser({
      username: `idem_member_2_${ts}`,
      password: hashedPass,
      email: `idem_member_2_${ts}@test.com`,
      role: "member",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });

    staffUser = await storage.createUser({
      username: `idem_staff_${ts}`,
      password: hashedPass,
      email: `idem_staff_${ts}@test.com`,
      role: "employee",
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });

    testCategory = await storage.createGameType({
      name: `Idempotency Arena ${ts}`,
      description: "Testing idempotency semantics",
      hourlyPrice: 1200,
      maxPlayers: 2,
      priceModel: "flat",
      isActive: true,
    });

    testStation = await storage.createStation({
      name: `IDEM-STATION-${ts}`,
      gameTypeId: testCategory.id,
      status: "AVAILABLE",
    });

    client1 = createClient(serverAddress);
    await loginUser(client1, memberUser1.username);

    client2 = createClient(serverAddress);
    await loginUser(client2, memberUser2.username);

    staffClient = createClient(serverAddress);
    await loginUser(staffClient, staffUser.username);
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  test("1. Same request twice → exactly ONE booking created, second returns cached original result with Idempotent-Replayed header", async () => {
    const key = `idem-key-twice-${Date.now()}`;
    const startTime = new Date("2027-03-01T10:00:00.000Z");
    const endTime = new Date("2027-03-01T12:00:00.000Z");

    const payload = {
      gameTypeId: testCategory.id,
      stationId: testStation.id,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    };

    // First request
    const res1 = await client1.post("/api/bookings", payload, {
      "Idempotency-Key": key,
    });
    assert.equal(res1.status, 201, `First request failed: ${JSON.stringify(res1.data)}`);
    assert.ok(res1.data.id, "First request must return created booking with id");
    assert.equal(res1.headers.get("Idempotent-Replayed"), null, "First request must not be marked replayed");
    const firstBookingId = res1.data.id;

    // Second identical request with same key
    const res2 = await client1.post("/api/bookings", payload, {
      "Idempotency-Key": key,
    });
    assert.equal(res2.status, 201, `Second request failed: ${JSON.stringify(res2.data)}`);
    assert.equal(res2.headers.get("Idempotent-Replayed"), "true", "Second request must contain Idempotent-Replayed: true header");
    assert.equal(res2.data.id, firstBookingId, "Second request must return identical booking ID");
    assert.equal(res2.data.bookingRef, res1.data.bookingRef, "Second request must return identical booking reference");

    // Verify in database: exactly one booking exists for this booking ID
    const [dbBooking] = await db.select().from(bookings).where(eq(bookings.id, firstBookingId));
    assert.ok(dbBooking, "Booking must exist in database");

    // Verify exactly one idempotency record exists with status COMPLETED
    const keyRecord = await storage.getIdempotencyKey(memberUser1.id, key);
    assert.ok(keyRecord, "Idempotency key record must exist");
    assert.equal(keyRecord.status, "COMPLETED");
    assert.equal(keyRecord.bookingId, firstBookingId);
  });

  test("2. Concurrent identical requests → exactly ONE booking created, all callers receive original result", async () => {
    const key = `idem-key-concurrent-${Date.now()}`;
    const startTime = new Date("2027-03-02T14:00:00.000Z");
    const endTime = new Date("2027-03-02T16:00:00.000Z");

    const payload = {
      gameTypeId: testCategory.id,
      stationId: testStation.id,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    };

    // Send 4 concurrent identical requests with the same key and same user session
    const requests = Array.from({ length: 4 }).map(() =>
      client1.post("/api/bookings", payload, {
        "Idempotency-Key": key,
      })
    );

    const responses = await Promise.all(requests);

    // All requests should succeed with status 201 and return the exact same booking ID
    for (const res of responses) {
      assert.equal(res.status, 201, `Concurrent request returned non-201 status: ${res.status} ${JSON.stringify(res.data)}`);
    }

    const bookingIds = responses.map((r) => r.data.id);
    const uniqueIds = Array.from(new Set(bookingIds));
    assert.equal(uniqueIds.length, 1, `Expected exactly 1 unique booking ID across all concurrent calls, got: ${uniqueIds}`);

    // Verify in database that only ONE booking was created in total for this time range
    const userBookings = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.userId, memberUser1.id), eq(bookings.startTime, startTime)));
    assert.equal(userBookings.length, 1, `Expected exactly 1 booking in database, found ${userBookings.length}`);
  });

  test("3. Same key with different payload → rejected with 409 Conflict (IDEMPOTENCY_KEY_PAYLOAD_MISMATCH)", async () => {
    const key = `idem-key-mismatch-${Date.now()}`;
    const startTime = new Date("2027-03-03T09:00:00.000Z");
    const endTime = new Date("2027-03-03T11:00:00.000Z");

    const payload1 = {
      gameTypeId: testCategory.id,
      stationId: testStation.id,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    };

    // Initial valid request
    const res1 = await client1.post("/api/bookings", payload1, {
      "Idempotency-Key": key,
    });
    assert.equal(res1.status, 201);
    const originalBookingId = res1.data.id;

    // Conflicting request with the SAME key but DIFFERENT payload (playerCount: 2)
    const payload2 = {
      ...payload1,
      playerCount: 2,
    };

    const res2 = await client1.post("/api/bookings", payload2, {
      "Idempotency-Key": key,
    });
    assert.equal(res2.status, 409, `Expected 409 Conflict on payload mismatch, got ${res2.status}: ${JSON.stringify(res2.data)}`);
    assert.equal(res2.data.code, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
    assert.ok(
      res2.data.message.toLowerCase().includes("idempotency key"),
      "Error message should explain idempotency key conflict"
    );

    // Verify original booking in database is unaltered
    const [dbBooking] = await db.select().from(bookings).where(eq(bookings.id, originalBookingId));
    assert.ok(dbBooking);
    assert.equal(dbBooking.playerCount, 1, "Original booking payload must remain intact");
  });

  test("4. Failed transaction → key can safely be retried according to defined semantics", async () => {
    const key = `idem-key-fail-retry-${Date.now()}`;
    const startTime = new Date("2027-03-04T12:00:00.000Z");
    const endTime = new Date("2027-03-04T14:00:00.000Z");

    // First attempt: station is deliberately set to MAINTENANCE so transaction fails
    await storage.updateStation(testStation.id, { status: "MAINTENANCE" });

    const payload = {
      gameTypeId: testCategory.id,
      stationId: testStation.id,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    };

    const res1 = await client1.post("/api/bookings", payload, {
      "Idempotency-Key": key,
    });
    // Should fail with 400 or 409 because station is unavailable
    assert.ok(res1.status === 400 || res1.status === 409, `Expected failure status, got ${res1.status}`);

    // Verify idempotency record exists with status FAILED
    const failedKeyRecord = await storage.getIdempotencyKey(memberUser1.id, key);
    assert.ok(failedKeyRecord, "Key record must exist");
    assert.equal(failedKeyRecord.status, "FAILED", "Key must be marked FAILED after transaction failure");

    // Restore station to AVAILABLE so retry can succeed
    await storage.updateStation(testStation.id, { status: "AVAILABLE" });

    // Second attempt: retry the exact same request with the same idempotency key
    const res2 = await client1.post("/api/bookings", payload, {
      "Idempotency-Key": key,
    });
    assert.equal(res2.status, 201, `Retry after failure must succeed with 201, got ${res2.status}: ${JSON.stringify(res2.data)}`);
    assert.ok(res2.data.id, "Successful retry must return created booking id");
    const createdBookingId = res2.data.id;

    // Verify record transitioned to COMPLETED
    const completedKeyRecord = await storage.getIdempotencyKey(memberUser1.id, key);
    assert.ok(completedKeyRecord);
    assert.equal(completedKeyRecord.status, "COMPLETED", "Key must now be marked COMPLETED");
    assert.equal(completedKeyRecord.bookingId, createdBookingId);

    // Third attempt: repeated call now safely returns the cached result from the successful retry
    const res3 = await client1.post("/api/bookings", payload, {
      "Idempotency-Key": key,
    });
    assert.equal(res3.status, 201);
    assert.equal(res3.headers.get("Idempotent-Replayed"), "true");
    assert.equal(res3.data.id, createdBookingId);
  });

  test("5. Key scoping: Two different users using the same key string do not collide", async () => {
    const sharedKey = `shared-client-key-${Date.now()}`;
    const startTime1 = new Date("2027-03-05T10:00:00.000Z");
    const endTime1 = new Date("2027-03-05T11:00:00.000Z");

    const payloadUser1 = {
      gameTypeId: testCategory.id,
      stationId: testStation.id,
      startTime: startTime1.toISOString(),
      endTime: endTime1.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    };

    // User 1 uses key
    const res1 = await client1.post("/api/bookings", payloadUser1, {
      "Idempotency-Key": sharedKey,
    });
    assert.equal(res1.status, 201);

    const startTime2 = new Date("2027-03-05T11:00:00.000Z");
    const endTime2 = new Date("2027-03-05T12:00:00.000Z");

    const payloadUser2 = {
      gameTypeId: testCategory.id,
      stationId: testStation.id,
      startTime: startTime2.toISOString(),
      endTime: endTime2.toISOString(),
      playerCount: 1,
      paymentMethod: "offline",
    };

    // User 2 uses identical key string - should NOT be rejected as a conflict
    // because idempotency keys are strictly scoped per user
    const res2 = await client2.post("/api/bookings", payloadUser2, {
      "Idempotency-Key": sharedKey,
    });
    assert.equal(res2.status, 201, `User 2 should succeed with same key string, got ${res2.status}: ${JSON.stringify(res2.data)}`);
    assert.notEqual(res1.data.id, res2.data.id, "Bookings must be distinct");
  });

  test("6. Offline booking creation: supports Idempotency-Key header with safe replay and payload mismatch rejection", async () => {
    const key = `idem-key-offline-${Date.now()}`;
    const startTime = new Date("2027-03-06T15:00:00.000Z");
    const endTime = new Date("2027-03-06T16:00:00.000Z");

    const offlinePayload = {
      username: `offline_customer_${Date.now()}`,
      gameTypeId: testCategory.id,
      stationId: testStation.id,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      playerCount: 1,
      paymentMethod: "cash",
    };

    // 1. Staff creates offline booking
    const res1 = await staffClient.post("/api/bookings/offline", offlinePayload, {
      "Idempotency-Key": key,
    });
    assert.equal(res1.status, 201, `Offline booking creation failed: ${JSON.stringify(res1.data)}`);
    const offlineBookingId = res1.data.id;

    // 2. Staff retries with identical key
    const res2 = await staffClient.post("/api/bookings/offline", offlinePayload, {
      "Idempotency-Key": key,
    });
    assert.equal(res2.status, 201);
    assert.equal(res2.headers.get("Idempotent-Replayed"), "true");
    assert.equal(res2.data.id, offlineBookingId);

    // 3. Staff sends different payload with same key
    const conflictingOfflinePayload = {
      ...offlinePayload,
      playerCount: 2,
    };
    const res3 = await staffClient.post("/api/bookings/offline", conflictingOfflinePayload, {
      "Idempotency-Key": key,
    });
    assert.equal(res3.status, 409);
    assert.equal(res3.data.code, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
  });
});
