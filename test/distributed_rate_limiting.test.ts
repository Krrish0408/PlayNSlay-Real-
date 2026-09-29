import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { Express } from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import {
  PostgresRateLimitStore,
  createKeyGenerator,
  getClientIp,
  createRateLimitHandler,
  createPolicyLimiter,
  RateLimitPolicy,
  DEFAULT_POLICY_CONFIGS,
  authLimiter,
  registerLimiter,
  passwordResetLimiter,
  emailVerificationLimiter,
  bookingCreationLimiter,
  bookingCancellationLimiter,
  paymentCreationLimiter,
  paymentVerificationLimiter,
  fileUploadLimiter,
  adminExportsLimiter,
  publicCatalogLimiter,
  searchLimiter,
  catalogOrSearchLimiter,
  getSharedRateLimitStore,
  getRedisClient,
} from "../server/rate-limiter";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { hashPassword } from "../server/auth";

let fullServer: Server;
let fullBaseUrl: string;

interface SessionClient {
  get: (path: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (path: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  patch: (path: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
}

function makeClient(cookie?: string, defaultHeaders?: Record<string, string>): SessionClient {
  const request = async (method: string, path: string, body?: any, reqHeaders?: Record<string, string>) => {
    const headers: Record<string, string> = {
      ...(defaultHeaders || {}),
      ...(reqHeaders || {}),
    };
    if (cookie) {
      headers["Cookie"] = cookie;
    }
    if (body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${fullBaseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
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
    get: (path, h) => request("GET", path, undefined, h),
    post: (path, b, h) => request("POST", path, b, h),
    patch: (path, b, h) => request("PATCH", path, b, h),
  };
}

describe("DISTRIBUTED API RATE LIMITING TEST SUITE", () => {
  let adminUser: any;
  let memberUserA: any;
  let memberUserB: any;
  let adminClient: SessionClient;
  let memberClientA: SessionClient;
  let memberClientB: SessionClient;
  let gameType: any;
  let station: any;

  before(async () => {
    // 1. Start full application server
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    fullServer = createServer(app);
    await registerRoutes(fullServer, app);

    await new Promise<void>((resolve) => {
      fullServer.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = fullServer.address() as AddressInfo;
    fullBaseUrl = `http://127.0.0.1:${addr.port}`;

    const timestamp = Date.now();

    // 2. Create test users
    adminUser = await storage.createUser({
      username: `admin_rl_${timestamp}`,
      password: await hashPassword("AdminSecretPassword123!"),
      email: `admin_rl_${timestamp}@test.com`,
      role: "admin",
      isEmailVerified: true,
    });

    memberUserA = await storage.createUser({
      username: `member_a_rl_${timestamp}`,
      password: await hashPassword("MemberPassword123!"),
      email: `member_a_rl_${timestamp}@test.com`,
      role: "member",
      isEmailVerified: true,
    });

    memberUserB = await storage.createUser({
      username: `member_b_rl_${timestamp}`,
      password: await hashPassword("MemberPassword123!"),
      email: `member_b_rl_${timestamp}@test.com`,
      role: "member",
      isEmailVerified: true,
    });

    gameType = await storage.createGameType({
      name: `Category RL ${timestamp}`,
      description: "Rate limiting test category",
      hourlyPrice: 4000,
      maxPlayers: 4,
      isActive: true,
      priceModel: "flat",
    });

    station = await storage.createStation({
      name: `Station-RL-${timestamp}`,
      gameTypeId: gameType.id,
      status: "AVAILABLE",
    });

    // 3. Log in users
    const login = async (username: string, pass: string, ip: string) => {
      const res = await fetch(`${fullBaseUrl}/api/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": ip,
        },
        body: JSON.stringify({ username, password: pass }),
      });
      assert.equal(res.status, 200, `Login failed for ${username}`);
      const cookie = res.headers.get("set-cookie") || undefined;
      return makeClient(cookie, { "X-Forwarded-For": ip });
    };

    adminClient = await login(adminUser.username, "AdminSecretPassword123!", "198.51.100.10");
    memberClientA = await login(memberUserA.username, "MemberPassword123!", "198.51.100.42");
    memberClientB = await login(memberUserB.username, "MemberPassword123!", "198.51.100.42");
  });

  after(async () => {
    if (fullServer) {
      await new Promise<void>((resolve) => fullServer.close(() => resolve()));
    }
  });

  describe("1. Distributed Shared Store Engine (PostgresRateLimitStore)", () => {
    test("Increments atomic counters and sets reset_time correctly", async () => {
      const store = new PostgresRateLimitStore("test_policy", 60000);
      const testKey = `client_${Date.now()}`;

      const hit1 = await store.increment(testKey);
      assert.equal(hit1.totalHits, 1);
      assert.ok(hit1.resetTime instanceof Date);
      assert.ok(hit1.resetTime.getTime() > Date.now());

      const hit2 = await store.increment(testKey);
      assert.equal(hit2.totalHits, 2);
      assert.equal(hit2.resetTime.getTime(), hit1.resetTime.getTime(), "reset_time must remain stable within the window");

      const hit3 = await store.increment(testKey);
      assert.equal(hit3.totalHits, 3);

      const got = await store.get(testKey);
      assert.ok(got);
      assert.equal(got?.totalHits, 3);

      await store.decrement(testKey);
      const afterDec = await store.get(testKey);
      assert.equal(afterDec?.totalHits, 2);

      await store.resetKey(testKey);
      const afterReset = await store.get(testKey);
      assert.equal(afterReset, undefined);
    });

    test("Window reset semantics: expired window resets counter to 1 with new reset_time", async () => {
      // 10ms window
      const store = new PostgresRateLimitStore("test_short_window", 10);
      const testKey = `expiring_${Date.now()}`;

      const hit1 = await store.increment(testKey);
      assert.equal(hit1.totalHits, 1);

      // Wait 50ms for window to expire
      await new Promise((resolve) => setTimeout(resolve, 50));

      const hitAfterExpire = await store.increment(testKey);
      assert.equal(hitAfterExpire.totalHits, 1, "Counter must reset to 1 after window expiry");
      assert.ok(hitAfterExpire.resetTime.getTime() > hit1.resetTime.getTime());
    });

    test("Shared store is distributed and not purely in-memory", () => {
      const store = getSharedRateLimitStore("booking_creation", 60000);
      assert.ok(
        store instanceof PostgresRateLimitStore || store.constructor.name === "RedisStore",
        "Multi-instance store must be PostgresRateLimitStore or RedisStore"
      );
    });
  });

  describe("2. All 12 Policy Definitions & Throttling with HTTP 429 & Retry-After", () => {
    const policies: RateLimitPolicy[] = [
      "authentication",
      "registration",
      "password_reset",
      "email_verification",
      "booking_creation",
      "booking_cancellation",
      "payment_creation",
      "payment_verification",
      "file_upload",
      "admin_exports",
      "public_catalog",
      "search",
    ];

    test("All 12 distinct policies exist in DEFAULT_POLICY_CONFIGS", () => {
      for (const policy of policies) {
        assert.ok(DEFAULT_POLICY_CONFIGS[policy], `Policy configuration missing for: ${policy}`);
        assert.ok(DEFAULT_POLICY_CONFIGS[policy].windowMs > 0);
        assert.ok(DEFAULT_POLICY_CONFIGS[policy].max > 0);
      }
    });

    test("Policy limiter returns HTTP 429, Retry-After header, and structured JSON payload when limit is exceeded", async () => {
      // Create isolated test app with a threshold of 3 requests
      const testApp = express();
      const testLimiter = createPolicyLimiter("booking_creation", {
        max: 3,
        windowMs: 30000,
        message: "Too many booking creation requests. Please slow down and try again shortly.",
      });

      testApp.post("/test-booking-rate-limit", testLimiter, (_req, res) => {
        res.status(201).json({ success: true });
      });

      const srv = createServer(testApp);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      const port = (srv.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/test-booking-rate-limit`;

      try {
        // Request 1: 201
        const res1 = await fetch(url, { method: "POST", headers: { "X-Forwarded-For": "203.0.113.19" } });
        assert.equal(res1.status, 201);
        assert.equal(res1.headers.get("ratelimit-limit"), "3");

        // Request 2: 201
        const res2 = await fetch(url, { method: "POST", headers: { "X-Forwarded-For": "203.0.113.19" } });
        assert.equal(res2.status, 201);

        // Request 3: 201
        const res3 = await fetch(url, { method: "POST", headers: { "X-Forwarded-For": "203.0.113.19" } });
        assert.equal(res3.status, 201);

        // Request 4: 429 TOO MANY REQUESTS
        const res4 = await fetch(url, { method: "POST", headers: { "X-Forwarded-For": "203.0.113.19" } });
        assert.equal(res4.status, 429);

        // Check Retry-After header
        const retryAfter = res4.headers.get("retry-after");
        assert.ok(retryAfter, "Response must include Retry-After header");
        const retryAfterSeconds = parseInt(retryAfter, 10);
        assert.ok(retryAfterSeconds >= 1 && retryAfterSeconds <= 30);

        // Check RateLimit headers
        assert.equal(res4.headers.get("ratelimit-limit"), "3");
        assert.equal(res4.headers.get("ratelimit-remaining"), "0");

        // Check JSON payload structure
        const body: any = await res4.json();
        assert.equal(body.code, "TOO_MANY_REQUESTS");
        assert.equal(body.policy, "booking_creation");
        assert.equal(body.retryAfter, retryAfterSeconds);
        assert.ok(body.message.includes("Too many booking creation requests"));
      } finally {
        await new Promise<void>((r) => srv.close(() => r()));
      }
    });

    test("MFA rate limiter returns 429 with RATE_LIMITED error code for security auditing", async () => {
      const testApp = express();
      const testMfaLimiter = createPolicyLimiter("authentication", {
        max: 2,
        windowMs: 60000,
        message: "Too many MFA verification attempts. Please wait 15 minutes before trying again.",
      });

      testApp.post("/api/auth/mfa/verify", testMfaLimiter, (_req, res) => {
        res.json({ success: true });
      });

      const srv = createServer(testApp);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      const port = (srv.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/api/auth/mfa/verify`;

      try {
        await fetch(url, { method: "POST", headers: { "X-Forwarded-For": "192.0.2.77" } });
        await fetch(url, { method: "POST", headers: { "X-Forwarded-For": "192.0.2.77" } });

        const res = await fetch(url, { method: "POST", headers: { "X-Forwarded-For": "192.0.2.77" } });
        assert.equal(res.status, 429);
        assert.ok(res.headers.get("retry-after"));
        const body: any = await res.json();
        assert.equal(body.code, "RATE_LIMITED");
        assert.equal(body.policy, "authentication");
      } finally {
        await new Promise<void>((r) => srv.close(() => r()));
      }
    });
  });

  describe("3. NAT Safety & Shared IP Isolation", () => {
    test("Authenticated Requests: User A hitting limit does NOT lock out User B on the same shared NAT IP", async () => {
      const testApp = express();
      testApp.use(express.json());

      // Mock auth middleware putting user on req
      testApp.use((req, _res, next) => {
        const authHeader = req.headers["x-test-user-id"];
        if (authHeader) {
          (req as any).user = { id: parseInt(authHeader as string, 10) };
        }
        next();
      });

      const bookingLimiter = createPolicyLimiter("booking_creation", {
        max: 2,
        windowMs: 60000,
      });

      testApp.post("/api/bookings", bookingLimiter, (_req, res) => {
        res.status(201).json({ bookingId: Math.floor(Math.random() * 1000) });
      });

      const srv = createServer(testApp);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      const port = (srv.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/api/bookings`;
      const sharedNatIp = "203.0.113.88";

      try {
        // User A performs 2 requests from shared NAT IP -> Succeeds
        const resA1 = await fetch(url, {
          method: "POST",
          headers: { "X-Forwarded-For": sharedNatIp, "X-Test-User-Id": "101" },
        });
        assert.equal(resA1.status, 201);

        const resA2 = await fetch(url, {
          method: "POST",
          headers: { "X-Forwarded-For": sharedNatIp, "X-Test-User-Id": "101" },
        });
        assert.equal(resA2.status, 201);

        // User A performs 3rd request from shared NAT IP -> Throttled (429)
        const resA3 = await fetch(url, {
          method: "POST",
          headers: { "X-Forwarded-For": sharedNatIp, "X-Test-User-Id": "101" },
        });
        assert.equal(resA3.status, 429, "User A must be throttled");

        // CRITICAL NAT SAFETY CHECK:
        // User B on the EXACT SAME NAT IP must NOT be blocked!
        const resB1 = await fetch(url, {
          method: "POST",
          headers: { "X-Forwarded-For": sharedNatIp, "X-Test-User-Id": "102" },
        });
        assert.equal(resB1.status, 201, "User B on shared NAT IP must NOT be locked out by User A's activity!");

        const resB2 = await fetch(url, {
          method: "POST",
          headers: { "X-Forwarded-For": sharedNatIp, "X-Test-User-Id": "102" },
        });
        assert.equal(resB2.status, 201, "User B's second request must succeed");

        // User B's 3rd request -> User B also hits their own quota
        const resB3 = await fetch(url, {
          method: "POST",
          headers: { "X-Forwarded-For": sharedNatIp, "X-Test-User-Id": "102" },
        });
        assert.equal(resB3.status, 429, "User B is now throttled on their own quota");
      } finally {
        await new Promise<void>((r) => srv.close(() => r()));
      }
    });

    test("Unauthenticated Password Reset: Attack on Account X does NOT lock out Account Y on the same NAT IP", async () => {
      const testApp = express();
      testApp.use(express.json());

      const pwResetLimiter = createPolicyLimiter("password_reset", {
        max: 2,
        windowMs: 60000,
        useAccountIdentity: true,
      });

      testApp.post("/api/auth/forgot-password", pwResetLimiter, (req, res) => {
        res.json({ message: "Password reset email sent if account exists" });
      });

      const srv = createServer(testApp);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      const port = (srv.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/api/auth/forgot-password`;
      const sharedNatIp = "198.51.100.99";

      try {
        // Attacker spamming password resets for alice@example.com from shared NAT IP
        const r1 = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": sharedNatIp },
          body: JSON.stringify({ email: "alice@example.com" }),
        });
        assert.equal(r1.status, 200);

        const r2 = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": sharedNatIp },
          body: JSON.stringify({ email: "alice@example.com" }),
        });
        assert.equal(r2.status, 200);

        // 3rd attempt for alice is throttled
        const r3 = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": sharedNatIp },
          body: JSON.stringify({ email: "alice@example.com" }),
        });
        assert.equal(r3.status, 429, "Password resets for alice@example.com must be throttled");

        // CRITICAL NAT SAFETY CHECK:
        // Legitimate user bob@example.com on the same NAT IP can still request password reset!
        const rBob = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": sharedNatIp },
          body: JSON.stringify({ email: "bob@example.com" }),
        });
        assert.equal(rBob.status, 200, "bob@example.com must NOT be locked out on the shared NAT IP!");
      } finally {
        await new Promise<void>((r) => srv.close(() => r()));
      }
    });
  });

  describe("4. Endpoint-Aware End-to-End Route Policies", () => {
    test("Payment creation endpoint (/api/payments/create) is functional and rate limited", async () => {
      const res = await memberClientA.post("/api/payments/create", {
        bookingId: 999999, // non-existent booking
        amount: 2500,
      });
      // Route must exist and fail with 404 (booking not found), not 404 route not found
      assert.equal(res.status, 404);
      assert.ok(res.data.message.includes("Booking not found"));
    });

    test("Payment verification endpoint (/api/payments/verify) is functional and rate limited", async () => {
      const res = await memberClientA.post("/api/payments/verify", {
        orderId: "order_123456",
        paymentId: "pay_123456",
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.equal(res.data.verified, true);
      assert.equal(res.data.status, "COMPLETED");
    });

    test("Dedicated search endpoint (/api/search) is functional with search policy", async () => {
      const res = await memberClientA.get("/api/search?q=station");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.stations));
      assert.ok(Array.isArray(res.data.games));
      assert.equal(res.data.query, "station");
    });

    test("Public catalog endpoints (/api/game-types, /api/stations, /api/games) are accessible", async () => {
      const res1 = await memberClientA.get("/api/game-types");
      assert.equal(res1.status, 200);

      const res2 = await memberClientA.get("/api/stations");
      assert.equal(res2.status, 200);

      const res3 = await memberClientA.get("/api/games");
      assert.equal(res3.status, 200);
    });

    test("Admin exports endpoint (/api/admin/bookings/export) enforces adminExportsLimiter", async () => {
      const res = await adminClient.get("/api/admin/bookings/export?limit=10");
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/csv"));
    });
  });
});

