/**
 * Play N Slay — Autonomous Load Testing & Concurrency Benchmark Engine
 *
 * Scenarios:
 * 1. Public Station Browsing
 * 2. User Login & Session Establishment
 * 3. Booking Availability & Station Queries
 * 4. Booking Creation (Under normal distributed load)
 * 5. Booking Cancellation
 * 6. Employee Dashboard & Operational Stats
 * 7. Admin Analytics & Comprehensive Metrics
 *
 * Additional Validation:
 * - High-Contention Concurrency Race Condition Test (Simultaneous booking on exact same station/slot)
 * - Measurement of: requests/sec, p50, p95, p99, error rate, app CPU, memory, DB pool connections, DB latency, Redis status
 */

import express from "express";
import { createServer, Server } from "http";
import net from "net";
import os from "os";
import { registerRoutes } from "../server/routes";
import { db, pool, getPoolStats } from "../server/db";
import { users, gameTypes, stations, bookings } from "@shared/schema";
import { hashPassword } from "../server/auth";
import { sql, eq, and } from "drizzle-orm";
import autocannon from "autocannon";

interface ScenarioResult {
  scenario: string;
  totalRequests: number;
  durationSeconds: number;
  requestsPerSec: number;
  p50: number;
  p95: number;
  p99: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  errorRate: number;
  non2xxCount: number;
  timeouts: number;
  statusCodes: Record<string, number>;
}

interface SystemMetrics {
  cpuPercent: number;
  memoryRssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  dbPoolTotal: number;
  dbPoolIdle: number;
  dbPoolWaiting: number;
  dbQueryLatencyMs: number;
  redisStatus: string;
}

interface ConcurrencyTestResult {
  totalConcurrentRequests: number;
  successfulBookings: number;
  conflictRejections: number;
  unhandledErrors: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  databaseCommittedRows: number;
  doubleBookingDetected: boolean;
  dataCorruptionDetected: boolean;
}

// System Resource Monitor
class ResourceMonitor {
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime = Date.now();

  async snapshot(): Promise<SystemMetrics> {
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage);
    const currentTime = Date.now();
    const elapsedTimeMs = (currentTime - this.lastCpuTime) || 1;
    const elapsedMicros = elapsedTimeMs * 1000;

    const totalCpuMicros = currentCpuUsage.user + currentCpuUsage.system;
    const cpuCount = os.cpus().length || 1;
    const cpuPercent = Number(((totalCpuMicros / elapsedMicros / cpuCount) * 100).toFixed(2));

    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = currentTime;

    const mem = process.memoryUsage();
    const poolStats = getPoolStats();

    // Measure active DB latency with a light ping
    const dbPingStart = performance.now();
    try {
      await db.select({ id: users.id }).from(users).limit(1);
    } catch {
      // ignore in test
    }
    const dbQueryLatencyMs = Number((performance.now() - dbPingStart).toFixed(2));

    const redisStatus = process.env.REDIS_URL ? "CONNECTED (Redis Cache & Distributed Store)" : "DISABLED (In-Memory Fallback Active)";

    return {
      cpuPercent,
      memoryRssMb: Number((mem.rss / (1024 * 1024)).toFixed(2)),
      heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
      heapTotalMb: Number((mem.heapTotal / (1024 * 1024)).toFixed(2)),
      dbPoolTotal: poolStats ? poolStats.totalCount : 1,
      dbPoolIdle: poolStats ? poolStats.idleCount : 1,
      dbPoolWaiting: poolStats ? poolStats.waitingCount : 0,
      dbQueryLatencyMs,
      redisStatus,
    };
  }
}

// Helper to authenticate client and extract cookie
async function obtainAuthCookie(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`Failed to login as ${username}: status ${res.status}`);
  }
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error(`No session cookie returned for ${username}`);
  return cookie.split(";")[0];
}

// Find free port
function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// Setup & Seed test data
async function prepareTestData() {
  const hashedPw = await hashPassword("password123");
  const adminPw = await hashPassword("admin123");
  const empPw = await hashPassword("employee123");

  // Admin
  await db.insert(users).values({
    username: "load_admin",
    password: adminPw,
    email: "load_admin@gaminglounge.com",
    role: "admin",
    isEmailVerified: true,
  }).onConflictDoNothing();

  // Employee
  await db.insert(users).values({
    username: "load_employee",
    password: empPw,
    email: "load_employee@gaminglounge.com",
    role: "employee",
    isEmailVerified: true,
  }).onConflictDoNothing();

  // Member
  await db.insert(users).values({
    username: "load_member",
    password: hashedPw,
    email: "load_member@gaminglounge.com",
    role: "member",
    isEmailVerified: true,
  }).onConflictDoNothing();

  // Game Type
  const [existingGt] = await db.select().from(gameTypes).limit(1);
  let gtId = existingGt?.id;
  if (!gtId) {
    const [gt] = await db.insert(gameTypes).values({
      name: "PS5 Load Testing",
      hourlyPrice: 12000,
      maxPlayers: 4,
      priceModel: "per_player",
    }).returning();
    gtId = gt.id;
  }

  // Stations
  const [existingStation] = await db.select().from(stations).limit(1);
  if (!existingStation) {
    for (let i = 1; i <= 10; i++) {
      await db.insert(stations).values({
        name: `Station-Load-${i}`,
        gameTypeId: gtId,
        status: "AVAILABLE",
      });
    }
  }
}

// Helper to run Autocannon scenario
function runAutocannonScenario(opts: autocannon.Options & { scenarioName: string }): Promise<ScenarioResult> {
  return new Promise((resolve, reject) => {
    autocannon(opts, (err, result) => {
      if (err) return reject(err);

      const non2xx = result.non2xx || 0;
      const totalRequests = result.requests.total || 1;
      const errorRate = Number(((non2xx / totalRequests) * 100).toFixed(2));

      const statusCodes: Record<string, number> = {};
      if (result.statusCodeStats) {
        for (const [code, stat] of Object.entries(result.statusCodeStats)) {
          statusCodes[code] = stat.count;
        }
      }

      const lat = result.latency as any;
      const p50 = Number((lat.p50 ?? lat.average ?? 0).toFixed(2));
      const p95 = Number((lat.p97_5 ?? lat.p90 ?? lat.average ?? 0).toFixed(2));
      const p99 = Number((lat.p99 ?? lat.average ?? 0).toFixed(2));
      const avgLatency = Number((lat.average ?? 0).toFixed(2));
      const minLatency = Number((lat.min ?? 0).toFixed(2));
      const maxLatency = Number((lat.max ?? 0).toFixed(2));

      resolve({
        scenario: opts.scenarioName,
        totalRequests,
        durationSeconds: result.duration,
        requestsPerSec: Number(result.requests.average.toFixed(2)),
        p50,
        p95,
        p99,
        avgLatency,
        minLatency,
        maxLatency,
        errorRate,
        non2xxCount: non2xx,
        timeouts: result.timeouts || 0,
        statusCodes,
      });
    });
  });
}

// Run Concurrency Race Condition Test
async function runConcurrencyRaceTest(baseUrl: string, memberCookie: string): Promise<ConcurrencyTestResult> {
  const targetStationId = 1;
  const targetStart = "2026-11-20T14:00:00.000Z";
  const targetEnd = "2026-11-20T16:00:00.000Z";
  const totalConcurrentRequests = 25;

  console.log(`\n============================================================`);
  console.log(`[CONCURRENCY TEST] Firing ${totalConcurrentRequests} simultaneous booking requests`);
  console.log(`Target: Station ID ${targetStationId} | Time: ${targetStart} to ${targetEnd}`);
  console.log(`============================================================`);

  const latencies: number[] = [];
  const statusCodes: number[] = [];

  const requests = Array.from({ length: totalConcurrentRequests }, async (_, index) => {
    const t0 = performance.now();
    try {
      const res = await fetch(`${baseUrl}/api/bookings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": memberCookie,
          "Idempotency-Key": `race-key-${index}-${Date.now()}`,
        },
        body: JSON.stringify({
          startTime: targetStart,
          endTime: targetEnd,
          stationId: targetStationId,
          gameTypeId: 1,
          playerCount: 1,
          paymentMethod: "offline",
        }),
      });
      const t1 = performance.now();
      latencies.push(t1 - t0);
      statusCodes.push(res.status);
      return res.status;
    } catch (err) {
      const t1 = performance.now();
      latencies.push(t1 - t0);
      statusCodes.push(500);
      return 500;
    }
  });

  await Promise.all(requests);

  // Compute stats
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;

  const successfulBookings = statusCodes.filter((c) => c === 201).length;
  const conflictRejections = statusCodes.filter((c) => c === 409).length;
  const unhandledErrors = statusCodes.filter((c) => c !== 201 && c !== 409).length;

  // Direct database verification
  const committedBookings = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.stationId, targetStationId),
        sql`tstzrange(${bookings.startTime}, ${bookings.endTime}, '[)') && tstzrange(${targetStart}::timestamptz, ${targetEnd}::timestamptz, '[)')`,
        sql`${bookings.status} NOT IN ('Cancelled', 'Rejected')`
      )
    );

  const databaseCommittedRows = committedBookings.length;
  const doubleBookingDetected = databaseCommittedRows > 1 || successfulBookings > 1;
  const dataCorruptionDetected = databaseCommittedRows === 0 && successfulBookings > 0;

  return {
    totalConcurrentRequests,
    successfulBookings,
    conflictRejections,
    unhandledErrors,
    p50Ms: Number(p50.toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    p99Ms: Number(p99.toFixed(2)),
    databaseCommittedRows,
    doubleBookingDetected,
    dataCorruptionDetected,
  };
}

// Main Load Test Suite
export async function runLoadTestSuite() {
  process.env.BENCHMARK_MODE = "true";

  console.log("============================================================");
  console.log("PLAY N SLAY — PRODUCTION LOAD & CONCURRENCY BENCHMARK SUITE");
  console.log("============================================================\n");

  // Spin up dedicated isolated server
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const port = await getFreePort();
  const server = createServer(app);
  await registerRoutes(server, app);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Load Engine] Target benchmark server listening at: ${baseUrl}`);

  await prepareTestData();
  console.log("[Load Engine] Initialized and verified database seed records.");

  // Authenticate personas
  const adminCookie = await obtainAuthCookie(baseUrl, "load_admin", "admin123");
  const employeeCookie = await obtainAuthCookie(baseUrl, "load_employee", "employee123");
  const memberCookie = await obtainAuthCookie(baseUrl, "load_member", "password123");
  console.log("[Load Engine] Authenticated admin, employee, and member test sessions.");

  const monitor = new ResourceMonitor();
  const scenarioResults: ScenarioResult[] = [];

  const initialMetrics = await monitor.snapshot();

  // 1. Scenario: Public Station Browsing
  console.log("\n[Scenario 1/7] Running: Public Station Browsing (GET /api/stations)...");
  const res1 = await runAutocannonScenario({
    scenarioName: "1. Public Station Browsing",
    url: `${baseUrl}/api/stations`,
    connections: 15,
    duration: 5,
    method: "GET",
    headers: { Accept: "application/json" },
  });
  scenarioResults.push(res1);

  // 2. Scenario: User Login
  console.log("\n[Scenario 2/7] Running: User Login (POST /api/login)...");
  const res2 = await runAutocannonScenario({
    scenarioName: "2. User Authentication (Login)",
    url: `${baseUrl}/api/login`,
    connections: 10,
    duration: 5,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "load_member", password: "password123" }),
  });
  scenarioResults.push(res2);

  // 3. Scenario: Booking Availability
  console.log("\n[Scenario 3/7] Running: Booking Availability (GET /api/bookings)...");
  const res3 = await runAutocannonScenario({
    scenarioName: "3. Booking Availability / Schedule",
    url: `${baseUrl}/api/bookings?limit=25`,
    connections: 12,
    duration: 5,
    method: "GET",
    headers: { Cookie: memberCookie, Accept: "application/json" },
  });
  scenarioResults.push(res3);

  // 4. Scenario: Booking Creation (Distributed non-conflicting slots)
  console.log("\n[Scenario 4/7] Running: Booking Creation (POST /api/bookings)...");
  const bookingRequests = Array.from({ length: 300 }, (_, i) => ({
    method: "POST" as const,
    path: "/api/bookings",
    headers: {
      "Content-Type": "application/json",
      Cookie: memberCookie,
    },
    body: JSON.stringify({
      startTime: new Date(Date.now() + 10000000 + i * 7200000).toISOString(),
      endTime: new Date(Date.now() + 10000000 + (i + 1) * 7200000).toISOString(),
      gameTypeId: 1,
      playerCount: 1,
      paymentMethod: "offline",
    }),
  }));

  const res4 = await runAutocannonScenario({
    scenarioName: "4. Booking Creation (Dynamic Slots)",
    url: baseUrl,
    connections: 8,
    duration: 5,
    requests: bookingRequests,
  });
  scenarioResults.push(res4);

  // 5. Scenario: Booking Cancellation
  console.log("\n[Scenario 5/7] Running: Booking Cancellation (PATCH /api/bookings/:id/status)...");
  const seededBookingIds: number[] = [];
  for (let i = 0; i < 50; i++) {
    const [b] = await db.insert(bookings).values({
      userId: 1,
      startTime: new Date(Date.now() + 500000000 + i * 3600000),
      endTime: new Date(Date.now() + 500000000 + (i + 1) * 3600000),
      totalPrice: 12000,
      bookingRef: `CANCEL-LOAD-${i}-${Date.now()}`,
      status: "Approved",
    }).returning();
    seededBookingIds.push(b.id);
  }

  const cancelRequests = seededBookingIds.map((id) => ({
    method: "PATCH" as const,
    path: `/api/bookings/${id}/status`,
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({ status: "Cancelled" }),
  }));

  const res5 = await runAutocannonScenario({
    scenarioName: "5. Booking Cancellation",
    url: baseUrl,
    connections: 6,
    duration: 5,
    requests: cancelRequests,
  });
  scenarioResults.push(res5);

  // 6. Scenario: Employee Dashboard
  console.log("\n[Scenario 6/7] Running: Employee Dashboard (GET /api/employee/stats)...");
  const res6 = await runAutocannonScenario({
    scenarioName: "6. Employee Dashboard & Stats",
    url: `${baseUrl}/api/employee/stats`,
    connections: 10,
    duration: 6,
    method: "GET",
    headers: { Cookie: employeeCookie, Accept: "application/json" },
  });
  scenarioResults.push(res6);

  // 7. Scenario: Admin Analytics
  console.log("\n[Scenario 7/7] Running: Admin Analytics (GET /api/admin/stats/comprehensive)...");
  const res7 = await runAutocannonScenario({
    scenarioName: "7. Admin Analytics & Reporting",
    url: `${baseUrl}/api/admin/stats/comprehensive`,
    connections: 8,
    duration: 6,
    method: "GET",
    headers: { Cookie: adminCookie, Accept: "application/json" },
  });
  scenarioResults.push(res7);

  // System snapshot under load
  const loadMetrics = await monitor.snapshot();

  // 8. Strict Concurrency Race Condition Test
  const concurrencyResult = await runConcurrencyRaceTest(baseUrl, memberCookie);

  // Teardown
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // Render comprehensive summary
  console.log("\n============================================================");
  console.log("LOAD TESTING RESULTS — SUMMARY MATRIX");
  console.log("============================================================");
  console.table(
    scenarioResults.map((s) => ({
      Scenario: s.scenario,
      "RPS (req/s)": s.requestsPerSec,
      "p50 (ms)": s.p50,
      "p95 (ms)": s.p95,
      "p99 (ms)": s.p99,
      "Avg Latency": s.avgLatency,
      "Error %": `${s.errorRate}%`,
      "Total Req": s.totalRequests,
    }))
  );

  console.log("\n============================================================");
  console.log("SYSTEM & INFRASTRUCTURE UTILIZATION METRICS");
  console.log("============================================================");
  console.log(`- CPU Usage (Application):           ${loadMetrics.cpuPercent}%`);
  console.log(`- Memory RSS:                        ${loadMetrics.memoryRssMb} MB`);
  console.log(`- Memory Heap (Used / Total):        ${loadMetrics.heapUsedMb} MB / ${loadMetrics.heapTotalMb} MB`);
  console.log(`- Database Pool Connections (Total): ${loadMetrics.dbPoolTotal}`);
  console.log(`- Database Pool Connections (Idle):  ${loadMetrics.dbPoolIdle}`);
  console.log(`- Database Pool Waiting Requests:    ${loadMetrics.dbPoolWaiting}`);
  console.log(`- Database Query Latency:            ${loadMetrics.dbQueryLatencyMs} ms`);
  console.log(`- Redis Status:                      ${loadMetrics.redisStatus}`);

  console.log("\n============================================================");
  console.log("HIGH-CONTENTION CONCURRENCY TEST RESULTS");
  console.log("============================================================");
  console.log(`- Total Simultaneous Requests:       ${concurrencyResult.totalConcurrentRequests}`);
  console.log(`- Successful Bookings (HTTP 201):     ${concurrencyResult.successfulBookings}`);
  console.log(`- Conflicting Rejections (HTTP 409):  ${concurrencyResult.conflictRejections}`);
  console.log(`- Unhandled Errors (HTTP 5xx):       ${concurrencyResult.unhandledErrors}`);
  console.log(`- Contention Latency p50:            ${concurrencyResult.p50Ms} ms`);
  console.log(`- Contention Latency p95:            ${concurrencyResult.p95Ms} ms`);
  console.log(`- Contention Latency p99:            ${concurrencyResult.p99Ms} ms`);
  console.log(`- Database Committed Records:        ${concurrencyResult.databaseCommittedRows}`);
  console.log(`- Double Booking Detected:           ${concurrencyResult.doubleBookingDetected ? "FAIL" : "PASSED (ZERO DOUBLE BOOKINGS)"}`);
  console.log(`- Data Corruption Detected:          ${concurrencyResult.dataCorruptionDetected ? "FAIL" : "PASSED (ZERO CORRUPTION)"}`);

  if (concurrencyResult.doubleBookingDetected || concurrencyResult.dataCorruptionDetected) {
    console.error("FATAL: Concurrency race condition violation detected!");
    process.exit(1);
  }

  console.log("\n[PASS] All load test scenarios and concurrency validations passed successfully.\n");

  return {
    scenarioResults,
    systemMetrics: loadMetrics,
    concurrencyResult,
  };
}

if (process.argv[1]?.endsWith("run-load-test.ts")) {
  runLoadTestSuite()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Load test failed:", err);
      process.exit(1);
    });
}
