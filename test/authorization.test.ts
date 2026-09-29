import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { hashPassword } from "../server/auth";

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

// Global test variables
let memberAClient: SessionClient;
let memberBClient: SessionClient;
let employee1Client: SessionClient;
let employee2Client: SessionClient;
let adminClient: SessionClient;
let anonClient: SessionClient;

let memberAUser: any;
let memberBUser: any;
let employee1User: any;
let employee2User: any;
let adminUser: any;

let testGameType: any;
let testStation: any;
let bookingA: any;
let bookingB: any;

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

  // Create test accounts
  const hashedPass = await hashPassword("pass12345");

  memberAUser = await storage.createUser({
    username: "test_member_a",
    password: hashedPass,
    role: "member",
    membershipTier: "bronze",
    isEmailVerified: true,
    emailVerifiedAt: new Date(),
  });

  memberBUser = await storage.createUser({
    username: "test_member_b",
    password: hashedPass,
    role: "member",
    membershipTier: "silver",
    isEmailVerified: true,
    emailVerifiedAt: new Date(),
  });

  employee1User = await storage.createUser({
    username: "test_employee_1",
    password: hashedPass,
    role: "employee",
    membershipTier: "bronze",
  });
  await storage.updateUser(employee1User.id, { role: "employee" });

  employee2User = await storage.createUser({
    username: "test_employee_2",
    password: hashedPass,
    role: "employee",
    membershipTier: "bronze",
  });
  await storage.updateUser(employee2User.id, { role: "employee" });

  adminUser = await storage.createUser({
    username: "test_admin",
    password: hashedPass,
    role: "admin",
    membershipTier: "platinum",
  });
  await storage.updateUser(adminUser.id, { role: "admin" });

  // Create test category and station
  testGameType = await storage.createGameType({
    name: "Auth Test Gaming",
    description: "Testing authorization",
    hourlyPrice: 10000,
    maxPlayers: 2,
    isActive: true,
    priceModel: "flat",
    imageUrl: null,
  });

  testStation = await storage.createStation({
    name: "AUTH-STAT-01",
    gameTypeId: testGameType.id,
    status: "AVAILABLE",
  });

  // Login all clients
  memberAClient = await loginUser("test_member_a", "pass12345");
  memberBClient = await loginUser("test_member_b", "pass12345");
  employee1Client = await loginUser("test_employee_1", "pass12345");
  employee2Client = await loginUser("test_employee_2", "pass12345");
  adminClient = await loginUser("test_admin", "pass12345");

  // Create sample bookings
  const now = new Date();
  const startTimeA = new Date(now.getTime() + 10 * 3600 * 1000);
  const endTimeA = new Date(now.getTime() + 11 * 3600 * 1000);

  bookingA = await storage.createBooking({
    userId: memberAUser.id,
    gameTypeId: testGameType.id,
    stationId: testStation.id,
    startTime: startTimeA,
    endTime: endTimeA,
    playerCount: 1,
    totalPrice: 10000,
    paymentMethod: "offline",
    status: "Pending",
    bookingRef: "TEST-A1",
    employeeId: null,
  });

  const startTimeB = new Date(now.getTime() + 12 * 3600 * 1000);
  const endTimeB = new Date(now.getTime() + 13 * 3600 * 1000);

  bookingB = await storage.createBooking({
    userId: memberBUser.id,
    gameTypeId: testGameType.id,
    stationId: testStation.id,
    startTime: startTimeB,
    endTime: endTimeB,
    playerCount: 1,
    totalPrice: 10000,
    paymentMethod: "offline",
    status: "Pending",
    bookingRef: "TEST-B1",
    employeeId: null,
  });
});

after(() => {
  if (server) {
    server.close();
  }
});

describe("1. Horizontal Privilege Escalation: Member A → Booking B", () => {
  test("Member A CANNOT view Member B's booking (GET /api/bookings/:id returns 403)", async () => {
    const res = await memberAClient.get(`/api/bookings/${bookingB.id}`);
    assert.equal(res.status, 403);
    assert.match(res.data.message, /forbidden|not authorized/i);
  });

  test("Member B CAN view their own booking (GET /api/bookings/:id returns 200)", async () => {
    const res = await memberBClient.get(`/api/bookings/${bookingB.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.id, bookingB.id);
  });

  test("Member A CANNOT modify status on Member B's booking (PATCH /api/bookings/:id/status returns 403)", async () => {
    const res = await memberAClient.patch(`/api/bookings/${bookingB.id}/status`, {
      status: "Cancelled",
    });
    assert.equal(res.status, 403);
  });

  test("Member A CANNOT cancel Member B's booking via cancel endpoint (POST /api/bookings/:id/cancel returns 403)", async () => {
    const res = await memberAClient.post(`/api/bookings/${bookingB.id}/cancel`);
    assert.equal(res.status, 403);
  });

  test("Member A CANNOT approve their own booking (status escalation returns 403)", async () => {
    const res = await memberAClient.patch(`/api/bookings/${bookingA.id}/status`, {
      status: "Approved",
    });
    assert.equal(res.status, 403);
    assert.match(res.data.message, /only permitted to cancel/i);
  });

  test("Member A CAN cancel their own eligible booking (POST /api/bookings/:id/cancel returns 200)", async () => {
    const res = await memberAClient.post(`/api/bookings/${bookingA.id}/cancel`);
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "Cancelled");
  });

  test("Member A CANNOT re-cancel an already cancelled booking (returns 400)", async () => {
    const res = await memberAClient.post(`/api/bookings/${bookingA.id}/cancel`);
    assert.equal(res.status, 400);
    assert.match(res.data.message, /cannot be cancelled|already cancelled/i);
  });

  test("Bookings list for Member A returns ONLY Member A's bookings", async () => {
    const res = await memberAClient.get("/api/bookings");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    for (const b of res.data) {
      assert.equal(b.userId, memberAUser.id);
      assert.notEqual(b.userId, memberBUser.id);
    }
  });

  test("Server never trusts userId, employeeId, or totalPrice from request body on booking creation", async () => {
    const baseTime = Date.now();
    const start = new Date(baseTime + 20 * 3600 * 1000).toISOString();
    const end = new Date(baseTime + 21 * 3600 * 1000).toISOString();

    const res = await memberAClient.post("/api/bookings", {
      gameTypeId: testGameType.id,
      startTime: start,
      endTime: end,
      playerCount: 1,
      // Attempting to inject spoofed values:
      userId: memberBUser.id,
      employeeId: employee1User.id,
      totalPrice: 1, // Attempt to get free/cheap booking
      status: "Approved",
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.userId, memberAUser.id, "userId must be derived from session");
    assert.equal(res.data.employeeId, null, "employeeId must not be accepted from member");
    assert.equal(res.data.status, "Pending", "Initial status must be Pending");
    assert.equal(res.data.totalPrice, 10000, "Price must be calculated by server");
  });
});

describe("2. Vertical Privilege Escalation: Employee → Admin Endpoint", () => {
  test("Employee CANNOT list users (GET /api/admin/users returns 403)", async () => {
    const res = await employee1Client.get("/api/admin/users");
    assert.equal(res.status, 403);
  });

  test("Employee CANNOT access comprehensive stats (GET /api/admin/stats/comprehensive returns 403)", async () => {
    const res = await employee1Client.get("/api/admin/stats/comprehensive");
    assert.equal(res.status, 403);
  });

  test("Employee CANNOT export bookings (GET /api/admin/bookings/export returns 403)", async () => {
    const res = await employee1Client.get("/api/admin/bookings/export");
    assert.equal(res.status, 403);
  });

  test("Employee CANNOT reset another user's password (POST /api/admin/users/:id/reset-password returns 403)", async () => {
    const res = await employee1Client.post(`/api/admin/users/${memberAUser.id}/reset-password`, {
      newPassword: "newsecretpassword123",
    });
    assert.equal(res.status, 403);
  });

  test("Employee CANNOT create game types (POST /api/game-types returns 403)", async () => {
    const res = await employee1Client.post("/api/game-types", {
      name: "Hacked Category",
      description: "Exploit attempt",
      hourlyPrice: 5000,
      maxPlayers: 1,
      isActive: true,
      priceModel: "flat",
    });
    assert.equal(res.status, 403);
  });

  test("Employee CANNOT delete game types (DELETE /api/game-types/:id returns 403)", async () => {
    const res = await employee1Client.delete(`/api/game-types/${testGameType.id}`);
    assert.equal(res.status, 403);
  });

  test("Employee CANNOT create physical stations (POST /api/stations returns 403)", async () => {
    const res = await employee1Client.post("/api/stations", {
      name: "ROGUE-01",
      gameTypeId: testGameType.id,
      status: "AVAILABLE",
    });
    assert.equal(res.status, 403);
  });

  test("Employee CANNOT delete physical stations (DELETE /api/stations/:id returns 403)", async () => {
    const res = await employee1Client.delete(`/api/stations/${testStation.id}`);
    assert.equal(res.status, 403);
  });

  test("Employee CANNOT create catalog games (POST /api/games returns 403)", async () => {
    const res = await employee1Client.post("/api/games", {
      title: "Rogue Game",
      platforms: "PC",
    });
    assert.equal(res.status, 403);
  });
});

describe("3. Vertical Privilege Escalation: Member → Employee Endpoint", () => {
  test("Member CANNOT view employee stats (GET /api/employee/stats returns 403)", async () => {
    const res = await memberAClient.get("/api/employee/stats");
    assert.equal(res.status, 403);
    assert.match(res.data.message, /forbidden|cannot access employee data/i);
  });

  test("Member CANNOT view specific employee stats (GET /api/employee/stats/:id returns 403)", async () => {
    const res = await memberAClient.get(`/api/employee/stats/${employee1User.id}`);
    assert.equal(res.status, 403);
  });

  test("Member CANNOT create offline bookings (POST /api/bookings/offline returns 403)", async () => {
    const res = await memberAClient.post("/api/bookings/offline", {
      username: "walkin_customer",
      gameTypeId: testGameType.id,
      playerCount: 1,
    });
    assert.equal(res.status, 403);
  });

  test("Member CANNOT start station booking timers (POST /api/bookings/:id/timer/start returns 403)", async () => {
    const res = await memberAClient.post(`/api/bookings/${bookingB.id}/timer/start`);
    assert.equal(res.status, 403);
  });

  test("Member CANNOT stop station booking timers (POST /api/bookings/:id/timer/stop returns 403)", async () => {
    const res = await memberAClient.post(`/api/bookings/${bookingB.id}/timer/stop`);
    assert.equal(res.status, 403);
  });

  test("Member CANNOT update physical station status (PATCH /api/stations/:id returns 403)", async () => {
    const res = await memberAClient.patch(`/api/stations/${testStation.id}`, {
      status: "MAINTENANCE",
    });
    assert.equal(res.status, 403);
  });

  test("Member CANNOT upload files (POST /api/upload returns 403)", async () => {
    const res = await memberAClient.post("/api/upload");
    assert.equal(res.status, 403);
  });
});

describe("4. Horizontal Privilege Escalation: Employee 1 → Employee 2 Restricted Data", () => {
  test("Employee 1 CANNOT view Employee 2's specific stats (GET /api/employee/stats/:id returns 403)", async () => {
    const res = await employee1Client.get(`/api/employee/stats/${employee2User.id}`);
    assert.equal(res.status, 403);
    assert.match(res.data.message, /forbidden|another employee/i);
  });

  test("Employee 1 CANNOT view Employee 2's stats via query param (GET /api/employee/stats?employeeId=... returns 403)", async () => {
    const res = await employee1Client.get(`/api/employee/stats?employeeId=${employee2User.id}`);
    assert.equal(res.status, 403);
    assert.match(res.data.message, /forbidden|another employee/i);
  });

  test("Employee 1 CAN view their OWN employee stats (GET /api/employee/stats returns 200)", async () => {
    const res = await employee1Client.get("/api/employee/stats");
    assert.equal(res.status, 200);
    assert.ok("totalEntries" in res.data);
  });

  test("Employee 1 CAN view their OWN stats by ID (GET /api/employee/stats/:id returns 200)", async () => {
    const res = await employee1Client.get(`/api/employee/stats/${employee1User.id}`);
    assert.equal(res.status, 200);
    assert.ok("totalEntries" in res.data);
  });

  test("Admin CAN view any employee's statistics (GET /api/employee/stats/:id returns 200)", async () => {
    const res = await adminClient.get(`/api/employee/stats/${employee2User.id}`);
    assert.equal(res.status, 200);
    assert.ok("totalEntries" in res.data);
  });
});

describe("5. Profile and Identity Isolation", () => {
  test("Member A CANNOT view Member B's profile by ID (GET /api/users/:id returns 403)", async () => {
    const res = await memberAClient.get(`/api/users/${memberBUser.id}`);
    assert.equal(res.status, 403);
    assert.match(res.data.message, /forbidden|own profile/i);
  });

  test("Member A CAN view their own profile by ID (GET /api/users/:id returns 200)", async () => {
    const res = await memberAClient.get(`/api/users/${memberAUser.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.id, memberAUser.id);
    assert.equal(res.data.username, memberAUser.username);
  });

  test("Registration strictly assigns role=member and ignores role/isAdmin from body", async () => {
    const res = await anonClient.post("/api/register", {
      username: "attacker_attempt",
      password: "password12345",
      role: "admin",
      isAdmin: true,
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.role, "member");
    assert.equal(res.data.isAdmin, undefined);
  });

  test("Profile update ignores role/isAdmin injection", async () => {
    const res = await memberAClient.patch("/api/user/profile", {
      fullName: "Updated Name",
      role: "admin",
      isAdmin: true,
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.fullName, "Updated Name");
    assert.equal(res.data.role, "member");
    assert.equal(res.data.isAdmin, undefined);
  });
});

describe("6. Operational Booking Functionality for Employees and Admins", () => {
  test("Employee CAN update booking status (Approved)", async () => {
    const res = await employee1Client.patch(`/api/bookings/${bookingB.id}/status`, {
      status: "Approved",
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "Approved");
  });

  test("Employee CAN operate timer on booking", async () => {
    const resStart = await employee1Client.post(`/api/bookings/${bookingB.id}/timer/start`);
    assert.equal(resStart.status, 200);
    assert.ok(resStart.data.timerStartedAt);

    const resStop = await employee1Client.post(`/api/bookings/${bookingB.id}/timer/stop`);
    assert.equal(resStop.status, 200);
    assert.ok(resStop.data.timerEndTime);
  });

  test("Employee CAN create offline booking with employeeId strictly derived from session", async () => {
    const start = new Date(Date.now() + 50 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 51 * 3600 * 1000).toISOString();

    const res = await employee1Client.post("/api/bookings/offline", {
      username: "walkin_vip",
      gameTypeId: testGameType.id,
      playerCount: 1,
      startTime: start,
      endTime: end,
      // Attempting to spoof employeeId
      employeeId: 99999,
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.employeeId, employee1User.id, "employeeId must come from session");
    assert.equal(res.data.totalPrice, 10000, "Price must be calculated server-side");
  });

  test("Unauthenticated requests return 401", async () => {
    const resBookings = await anonClient.get("/api/bookings");
    assert.equal(resBookings.status, 401);

    const resUser = await anonClient.get("/api/user");
    assert.equal(resUser.status, 401);

    const resEmployeeStats = await anonClient.get("/api/employee/stats");
    assert.equal(resEmployeeStats.status, 401);

    const resAdminUsers = await anonClient.get("/api/admin/users");
    assert.equal(resAdminUsers.status, 401);
  });
});
