import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { hashPassword } from "../server/auth";
import { calculateBookingPrice } from "../server/pricing-service";

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

let memberClient: SessionClient;
let adminClient: SessionClient;
let testMember: any;
let otherMember: any;
let pcCategory: any;
let ps5Category: any;
let pcStation: any;
let ps5Station: any;

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

  const hashedPass = await hashPassword("pricingpass123");

  testMember = await storage.createUser({
    username: "pricing_member",
    password: hashedPass,
    role: "member",
    membershipTier: "bronze",
    isEmailVerified: true,
    emailVerifiedAt: new Date(),
  });

  otherMember = await storage.createUser({
    username: "other_victim_member",
    password: hashedPass,
    role: "member",
    membershipTier: "gold",
    isEmailVerified: true,
    emailVerifiedAt: new Date(),
  });

  const testAdmin = await storage.createUser({
    username: "pricing_admin",
    password: hashedPass,
    role: "admin",
    membershipTier: "platinum",
  });
  await storage.updateUser(testAdmin.id, { role: "admin" });

  // Create trusted categories in DB
  pcCategory = await storage.createGameType({
    name: "PC Gaming",
    description: "High performance PC stations",
    hourlyPrice: 8000, // ₹80.00 / hr
    maxPlayers: 1,
    isActive: true,
    priceModel: "flat",
    imageUrl: null,
  });

  ps5Category = await storage.createGameType({
    name: "PS5",
    description: "4K console gaming",
    hourlyPrice: 12000, // ₹120.00 / hr
    maxPlayers: 4,
    isActive: true,
    priceModel: "per_player",
    imageUrl: null,
  });

  pcStation = await storage.createStation({
    name: "PC-TEST-01",
    gameTypeId: pcCategory.id,
    status: "AVAILABLE",
  });

  ps5Station = await storage.createStation({
    name: "PS5-TEST-01",
    gameTypeId: ps5Category.id,
    status: "AVAILABLE",
  });

  memberClient = await loginUser("pricing_member", "pricingpass123");
  adminClient = await loginUser("pricing_admin", "pricingpass123");
});

after(() => {
  if (server) {
    server.close();
  }
});

describe("1. Server Authoritative Pricing Service (Unit/Integration)", () => {
  test("Calculates standard flat rate correctly (1h PC Gaming = ₹80.00)", async () => {
    const start = new Date("2026-10-01T10:00:00Z");
    const end = new Date("2026-10-01T11:00:00Z");

    const snapshot = await calculateBookingPrice({
      gameTypeId: pcCategory.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
    });

    assert.equal(snapshot.durationHours, 1);
    assert.equal(snapshot.basePrice, 8000);
    assert.equal(snapshot.discountAmount, 0);
    assert.equal(snapshot.finalPrice, 8000);
    assert.equal(snapshot.currency, "INR");
    assert.equal(snapshot.pricingRule, "standard_v1");
  });

  test("Applies multi-hour discount rule for PC Gaming (2h = ₹140.00 instead of ₹160.00)", async () => {
    const start = new Date("2026-10-01T10:00:00Z");
    const end = new Date("2026-10-01T12:00:00Z");

    const snapshot = await calculateBookingPrice({
      gameTypeId: pcCategory.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
    });

    assert.equal(snapshot.durationHours, 2);
    assert.equal(snapshot.basePrice, 16000); // 8000 * 2 = 16000
    assert.equal(snapshot.discountAmount, 2000); // 16000 - 14000 = 2000
    assert.equal(snapshot.finalPrice, 14000); // ₹140.00
    assert.equal(snapshot.currency, "INR");
    assert.equal(snapshot.pricingRule, "v1_duration_discount");
  });

  test("Applies tiered per-player rate for PS5 (1h, 2 players = ₹180.00 instead of ₹240.00)", async () => {
    const start = new Date("2026-10-01T10:00:00Z");
    const end = new Date("2026-10-01T11:00:00Z");

    const snapshot = await calculateBookingPrice({
      gameTypeId: ps5Category.id,
      startTime: start,
      endTime: end,
      playerCount: 2,
    });

    assert.equal(snapshot.durationHours, 1);
    assert.equal(snapshot.basePrice, 24000); // 12000 * 2 = 24000
    assert.equal(snapshot.discountAmount, 6000); // 24000 - 18000 = 6000
    assert.equal(snapshot.finalPrice, 18000); // ₹180.00
    assert.equal(snapshot.currency, "INR");
    assert.equal(snapshot.pricingRule, "v1_tiered_player");
  });

  test("Preview endpoint POST /api/bookings/calculate-price returns authoritative snapshot", async () => {
    const res = await memberClient.post("/api/bookings/calculate-price", {
      gameTypeId: ps5Category.id,
      startTime: "2026-10-01T14:00:00Z",
      endTime: "2026-10-01T16:00:00Z",
      playerCount: 4,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.currency, "INR");
    assert.equal(res.data.finalPrice, 50000); // 4P PS5 rate: ₹250/hr * 2h = ₹500 (50000 cents)
    assert.equal(res.data.pricingRule, "v1_tiered_player");
  });
});

describe("2. Request Payload Manipulation Defense: Client is NEVER Trusted", () => {
  test("Client cannot manipulate total_price (server calculates authoritative price)", async () => {
    const start = new Date(Date.now() + 100 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 101 * 3600 * 1000).toISOString();

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: ps5Category.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
      // MALICIOUS ATTEMPT: Try to book 1h PS5 (₹120) for 1 cent
      total_price: 1,
      totalPrice: 1,
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.totalPrice, 12000, "totalPrice must be strictly 12000 cents");
    assert.equal(res.data.finalPrice, 12000, "finalPrice snapshot must be strictly 12000 cents");
    assert.equal(res.data.basePrice, 12000);
  });

  test("Client cannot manipulate hourly_rate / hourlyPrice", async () => {
    const start = new Date(Date.now() + 102 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 103 * 3600 * 1000).toISOString();

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: ps5Category.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
      // MALICIOUS ATTEMPT: Fake hourly rate
      hourly_rate: 10,
      hourlyPrice: 10,
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.totalPrice, 12000, "Price must be calculated from database hourlyPrice");
  });

  test("Client cannot inject artificial discounts", async () => {
    const start = new Date(Date.now() + 104 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 105 * 3600 * 1000).toISOString();

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: ps5Category.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
      // MALICIOUS ATTEMPT: Inject massive fake discount
      discount: 11999,
      discountAmount: 11999,
      discount_amount: 11999,
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.discountAmount, 0, "No discount for 1h 1P PS5");
    assert.equal(res.data.finalPrice, 12000);
    assert.equal(res.data.totalPrice, 12000);
  });

  test("Client cannot tamper with currency or pricing rule identifier", async () => {
    const start = new Date(Date.now() + 106 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 107 * 3600 * 1000).toISOString();

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: pcCategory.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
      // MALICIOUS ATTEMPT: Spoof currency and pricing rule
      currency: "USD",
      pricingRule: "unlimited_free_promo_2026",
      pricing_rule: "unlimited_free_promo_2026",
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.currency, "INR", "Currency must be forced to INR");
    assert.equal(res.data.pricingRule, "standard_v1", "Pricing rule must be generated server-side");
  });

  test("Client cannot forge status, paymentMethod, employeeId, or userId", async () => {
    const start = new Date(Date.now() + 108 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 109 * 3600 * 1000).toISOString();

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: pcCategory.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
      // MALICIOUS ATTEMPT: Steal another user identity, pre-approve, fake employee
      userId: otherMember.id,
      user_id: otherMember.id,
      employeeId: 9999,
      employee_id: 9999,
      status: "Approved",
      booking_status: "Completed",
      payment_status: "paid",
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.userId, testMember.id, "userId must be locked to authenticated session");
    assert.equal(res.data.employeeId, null, "employeeId must remain null");
    assert.equal(res.data.status, "Pending", "status must be forced to Pending");
  });

  test("Client cannot bypass station ownership (booking PC station with PS5 category is rejected)", async () => {
    const start = new Date(Date.now() + 110 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 111 * 3600 * 1000).toISOString();

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: ps5Category.id,
      stationId: pcStation.id, // Station belongs to PC, not PS5!
      startTime: start,
      endTime: end,
      playerCount: 1,
    });

    assert.equal(res.status, 400);
    assert.match(res.data.message, /does not belong to the selected gaming category/i);
  });
});

describe("3. Strict Server-Side Numeric Range & Timestamp Validation", () => {
  test("Rejects reversed timestamps (startTime >= endTime)", async () => {
    const start = new Date("2026-10-01T15:00:00Z").toISOString();
    const end = new Date("2026-10-01T14:00:00Z").toISOString(); // Earlier than start!

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: pcCategory.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
    });

    assert.equal(res.status, 400);
    assert.match(res.data.message, /endTime must be strictly after startTime|Invalid duration/i);
  });

  test("Rejects zero duration (startTime == endTime)", async () => {
    const time = new Date("2026-10-01T15:00:00Z").toISOString();

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: pcCategory.id,
      startTime: time,
      endTime: time,
      playerCount: 1,
    });

    assert.equal(res.status, 400);
    assert.match(res.data.message, /endTime must be strictly after startTime|Invalid duration/i);
  });

  test("Rejects durations shorter than minimum allowed (e.g. 5 minutes)", async () => {
    const start = new Date("2026-10-01T15:00:00Z").toISOString();
    const end = new Date("2026-10-01T15:05:00Z").toISOString(); // 5 minutes

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: pcCategory.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
    });

    assert.equal(res.status, 400);
    assert.match(res.data.message, /Minimum booking duration is 15 minutes/i);
  });

  test("Rejects durations exceeding maximum allowed (e.g. 30 hours)", async () => {
    const start = new Date("2026-10-01T10:00:00Z").toISOString();
    const end = new Date("2026-10-02T16:00:00Z").toISOString(); // 30 hours

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: pcCategory.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
    });

    assert.equal(res.status, 400);
    assert.match(res.data.message, /Maximum booking duration is 24 hours/i);
  });

  test("Rejects invalid playerCount < 1", async () => {
    const start = new Date(Date.now() + 112 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 113 * 3600 * 1000).toISOString();

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: pcCategory.id,
      startTime: start,
      endTime: end,
      playerCount: 0,
    });

    assert.equal(res.status, 400);
    assert.match(res.data.message, /player count|at least 1|greater than or equal to 1/i);
  });

  test("Rejects playerCount exceeding category maximum capacity", async () => {
    const start = new Date(Date.now() + 114 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 115 * 3600 * 1000).toISOString();

    const res = await memberClient.post("/api/bookings", {
      gameTypeId: pcCategory.id, // maxPlayers is 1
      startTime: start,
      endTime: end,
      playerCount: 3, // Exceeds 1
    });

    assert.equal(res.status, 400);
    assert.match(res.data.message, /exceeds maximum allowed/i);
  });
});

describe("4. Price Snapshot Immutability Across Category Rate Changes", () => {
  test("Historical booking price snapshot does not change when future rates are modified", async () => {
    const start = new Date(Date.now() + 120 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 121 * 3600 * 1000).toISOString();

    // 1. Create booking at current rate (PS5 1h = ₹120.00 / 12000 cents)
    const createRes = await memberClient.post("/api/bookings", {
      gameTypeId: ps5Category.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
    });

    assert.equal(createRes.status, 201);
    const bookingId = createRes.data.id;
    assert.equal(createRes.data.finalPrice, 12000);
    assert.equal(createRes.data.totalPrice, 12000);

    // 2. Admin alters the game category price in the database from ₹120 to ₹350
    const updateRes = await adminClient.patch(`/api/game-types/${ps5Category.id}`, {
      hourlyPrice: 35000,
    });
    assert.equal(updateRes.status, 200);

    // 3. Retrieve the past booking by ID
    const fetchRes = await memberClient.get(`/api/bookings/${bookingId}`);
    assert.equal(fetchRes.status, 200);

    // 4. Verify historical price snapshot remained completely intact!
    assert.equal(fetchRes.data.basePrice, 12000, "Historical base_price must remain 12000");
    assert.equal(fetchRes.data.finalPrice, 12000, "Historical final_price must remain 12000");
    assert.equal(fetchRes.data.totalPrice, 12000, "Historical total_price must remain 12000");
    assert.equal(fetchRes.data.currency, "INR");
    assert.equal(fetchRes.data.pricingRule, "v1_tiered_player");
  });
});
