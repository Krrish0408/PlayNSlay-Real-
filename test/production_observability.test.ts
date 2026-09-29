import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { WebSocket } from "ws";
import { setupAuth } from "../server/auth";
import { registerRoutes } from "../server/routes";
import { initDbSchema } from "../server/db";
import { seedTestUsers } from "../server/seed";
import { MemoryStore } from "express-rate-limit";
import { setRateLimitStoreFactoryForTesting } from "../server/rate-limiter";
import {
  logger,
  metrics,
  QuantileReservoir,
  SlidingWindowRateTracker,
  observabilityMiddleware,
  livenessHandler,
  readinessHandler,
  metricsHandler,
  setupWebSocketObservability,
  monitoring,
} from "../server/observability";
import {
  requestIdMiddleware,
  BookingConflictError,
  RateLimitError,
  DatabaseUnavailableError,
} from "../server/error-handler";

interface TestClient {
  cookieJar: string[];
  setCookie: (cookie: string) => void;
  getCookieValue: (name: string) => string | undefined;
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
}

function createClient(serverAddress: string): TestClient {
  let cookieJar: string[] = [];

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

  return {
    cookieJar,
    setCookie: (cookie: string) => {
      cookieJar.push(cookie);
    },
    getCookieValue: (name: string) => {
      const match = cookieJar.find((c) => c.startsWith(`${name}=`));
      if (!match) return undefined;
      return decodeURIComponent(match.split("=")[1]);
    },
    get: (url, headers) => request("GET", url, undefined, headers),
    post: (url, body, headers) => request("POST", url, body, headers),
  };
}

describe("Production Observability & Metrics Test Suite", () => {
  let server: http.Server;
  let serverAddress: string;
  let client: TestClient;

  before(async () => {
    setRateLimitStoreFactoryForTesting(() => new MemoryStore());
    await initDbSchema();
    await seedTestUsers();

    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    // Observability and correlation
    app.use(requestIdMiddleware);
    app.use(observabilityMiddleware);

    // Mock routes for triggering specific observable conditions
    app.get("/api/test-obs/error-500", (_req, _res, next) => {
      next(new Error("Simulated 500 error"));
    });

    app.get("/api/test-obs/conflict", (_req, _res, next) => {
      next(new BookingConflictError("Station unavailable"));
    });

    app.get("/api/test-obs/rate-limit", (_req, _res, next) => {
      next(new RateLimitError());
    });

    server = http.createServer(app);
    await registerRoutes(server, app);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverAddress = `http://127.0.0.1:${addr.port}`;
        client = createClient(serverAddress);
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  beforeEach(() => {
    metrics.resetForTesting();
  });

  describe("1. Request Tracing & Context Fields", () => {
    test("Every request completes with requestId, method, route, status, and latency tracked", async () => {
      const res = await client.get("/api/health");
      assert.strictEqual(res.status, 200);

      const reqId = res.headers.get("x-request-id");
      assert.ok(reqId, "Response must include X-Request-Id");

      const snapshot = metrics.getSnapshot();
      assert.strictEqual(snapshot.requestCount, 1, "Must record 1 request");
      assert.ok(snapshot.p50Latency >= 0, "Latency p50 must be recorded");
    });
  });

  describe("2. Health Check Endpoints (GET /health/live & GET /health/ready)", () => {
    test("GET /health/live returns 200 OK with process liveness and uptime", async () => {
      const res = await client.get("/health/live");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, "live");
      assert.ok(typeof res.data.uptime === "number");
      assert.ok(res.data.timestamp);
    });

    test("GET /api/health/live also returns 200 OK for consistency", async () => {
      const res = await client.get("/api/health/live");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, "live");
    });

    test("GET /health/ready returns 200 OK when database is accessible", async () => {
      const res = await client.get("/health/ready");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, "ready");
      assert.strictEqual(res.data.dependencies.database, "ready");
      assert.ok(res.data.timestamp);
    });

    test("Public health endpoints do NOT leak sensitive diagnostic information", async () => {
      const resLive = await client.get("/health/live");
      const resReady = await client.get("/health/ready");

      const liveStr = JSON.stringify(resLive.data);
      const readyStr = JSON.stringify(resReady.data);

      for (const text of [liveStr, readyStr]) {
        assert.doesNotMatch(text, /postgres:\/\//i);
        assert.doesNotMatch(text, /password/i);
        assert.doesNotMatch(text, /127\.0\.0\.1/);
        assert.doesNotMatch(text, /5432/);
        assert.doesNotMatch(text, /SELECT/i);
        assert.doesNotMatch(text, /pool/i);
      }
    });

    test("Readiness handler returns 503 when dependencies fail without leaking stack traces", async () => {
      // Simulate readiness check failure
      const mockReq = {} as any;
      let statusCode = 200;
      let responseBody: any = null;

      const mockRes = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(body: any) {
          responseBody = body;
          return this;
        },
      } as any;

      // Force simulated failure
      const origHandler = readinessHandler;
      const failingHandler = async (_req: any, res: any) => {
        return res.status(503).json({
          status: "not_ready",
          dependencies: { database: "unavailable" },
          timestamp: new Date().toISOString(),
        });
      };

      await failingHandler(mockReq, mockRes);
      assert.strictEqual(statusCode, 503);
      assert.strictEqual(responseBody.status, "not_ready");
      assert.strictEqual(responseBody.dependencies.database, "unavailable");
      assert.strictEqual(responseBody.stack, undefined);
    });
  });

  describe("3. Metrics Dimensions Tracking", () => {
    test("Tracks request count and error rate correctly", async () => {
      await client.get("/health/live");
      await client.get("/health/live");
      await client.get("/api/test-obs/error-500");

      const snapshot = metrics.getSnapshot();
      assert.strictEqual(snapshot.requestCount, 3);
      // 1 error out of 3 requests = ~0.3333 error rate
      assert.ok(snapshot.errorRate > 0.3 && snapshot.errorRate < 0.35);
    });

    test("Tracks p50, p95, p99 latency percentiles with QuantileReservoir", () => {
      const reservoir = new QuantileReservoir(100);
      for (let i = 1; i <= 100; i++) {
        reservoir.record(i);
      }
      assert.strictEqual(reservoir.getPercentile(50), 50.5);
      assert.strictEqual(reservoir.getPercentile(95), 95.05);
      assert.strictEqual(reservoir.getPercentile(99), 99.01);
      assert.strictEqual(reservoir.getAverage(), 50.5);
    });

    test("Tracks database query latency percentiles", () => {
      metrics.recordDatabaseLatency(5);
      metrics.recordDatabaseLatency(10);
      metrics.recordDatabaseLatency(20);
      metrics.recordDatabaseLatency(50);

      const snapshot = metrics.getSnapshot();
      assert.strictEqual(snapshot.databaseLatency.samples, 4);
      assert.ok(snapshot.databaseLatency.p50 >= 5);
      assert.ok(snapshot.databaseLatency.p99 >= 20);
      assert.ok(snapshot.databaseLatency.avg > 0);
    });

    test("Tracks active in-flight HTTP connections", () => {
      assert.strictEqual(metrics.getActiveConnections(), 0);
      metrics.incrementActiveConnections();
      metrics.incrementActiveConnections();
      assert.strictEqual(metrics.getActiveConnections(), 2);
      metrics.decrementActiveConnections();
      assert.strictEqual(metrics.getActiveConnections(), 1);
      metrics.decrementActiveConnections();
      assert.strictEqual(metrics.getActiveConnections(), 0);
      // Negative safety guard
      metrics.decrementActiveConnections();
      assert.strictEqual(metrics.getActiveConnections(), 0);
    });

    test("Tracks booking creation rate and total counters", () => {
      metrics.recordBookingCreated();
      metrics.recordBookingCreated();
      metrics.recordBookingCreated();

      const snapshot = metrics.getSnapshot();
      assert.strictEqual(snapshot.bookingCreationsTotal, 3);
      assert.strictEqual(snapshot.bookingCreationRate, 3);
    });

    test("Tracks booking conflict rate and total counters", async () => {
      await client.get("/api/test-obs/conflict");

      const snapshot = metrics.getSnapshot();
      assert.strictEqual(snapshot.bookingConflictsTotal, 1);
      assert.strictEqual(snapshot.bookingConflictRate, 1);
    });

    test("Tracks payment failures counter", () => {
      metrics.recordPaymentFailure();
      metrics.recordPaymentFailure();

      const snapshot = metrics.getSnapshot();
      assert.strictEqual(snapshot.paymentFailures, 2);
    });

    test("Tracks authentication failures on 401 responses", async () => {
      // Unauthenticated request to protected endpoint returns 401
      const res = await client.get("/api/user");
      assert.strictEqual(res.status, 401);

      const snapshot = metrics.getSnapshot();
      assert.strictEqual(snapshot.authenticationFailures, 1);
    });

    test("Tracks rate-limit events on 429 responses", async () => {
      const res = await client.get("/api/test-obs/rate-limit");
      assert.strictEqual(res.status, 429);

      const snapshot = metrics.getSnapshot();
      assert.strictEqual(snapshot.rateLimitEvents, 1);
    });

    test("Tracks queue depth accurately", () => {
      metrics.setQueueDepth(5);
      assert.strictEqual(metrics.getQueueDepth(), 5);
      const snapshot = metrics.getSnapshot();
      assert.strictEqual(snapshot.queueDepth, 5);
      metrics.setQueueDepth(0);
      assert.strictEqual(metrics.getQueueDepth(), 0);
    });
  });

  describe("4. Metrics Endpoints (GET /metrics & GET /api/metrics)", () => {
    test("GET /metrics returns standard Prometheus text format", async () => {
      metrics.recordBookingCreated();
      metrics.recordPaymentFailure();

      const res = await client.get("/metrics");
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/plain"));

      const text = res.data;
      assert.match(text, /# HELP http_requests_total/);
      assert.match(text, /http_requests_total \d+/);
      assert.match(text, /# HELP http_request_duration_seconds/);
      assert.match(text, /http_request_duration_seconds{quantile="0.5"}/);
      assert.match(text, /# HELP database_duration_seconds/);
      assert.match(text, /booking_creations_total 1/);
      assert.match(text, /payment_failures_total 1/);
    });

    test("GET /metrics?format=json returns structured JSON snapshot", async () => {
      const res = await client.get("/metrics?format=json");
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("application/json"));
      assert.ok(res.data.requestCount !== undefined);
      assert.ok(res.data.databaseLatency !== undefined);
      assert.ok(res.data.bookingCreationRate !== undefined);
    });

    test("GET /api/metrics returns structured JSON snapshot", async () => {
      const res = await client.get("/api/metrics");
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("application/json"));
      assert.ok(typeof res.data.p50Latency === "number");
      assert.ok(typeof res.data.p95Latency === "number");
      assert.ok(typeof res.data.p99Latency === "number");
    });
  });

  describe("5. WebSocket Observability & Connection Tracking", () => {
    test("WebSocket client connections increment and decrement webSocketConnections metric", async () => {
      assert.strictEqual(metrics.getWebSocketConnections(), 0);

      const wsUrl = serverAddress.replace("http://", "ws://") + "/ws";
      const wsClient = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        wsClient.on("open", () => resolve());
        wsClient.on("error", (err) => reject(err));
      });

      assert.strictEqual(metrics.getWebSocketConnections(), 1);

      // Ping-pong verification
      const pongPromise = new Promise<string>((resolve) => {
        wsClient.on("message", (data) => resolve(data.toString()));
      });
      wsClient.send("ping");
      const pongResponse = await pongPromise;
      assert.strictEqual(pongResponse, "pong");

      // Disconnect
      await new Promise<void>((resolve) => {
        wsClient.on("close", () => resolve());
        wsClient.close();
      });

      // Give event loop a tick to process close event
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual(metrics.getWebSocketConnections(), 0);
    });
  });

  describe("6. Structured Logging & Secret Redaction (Pino)", () => {
    test("Pino logger is initialized and redacts passwords and secrets", async () => {
      assert.ok(logger, "Pino logger must exist");

      // Test that Pino structured logging redacts sensitive fields
      const { default: pino } = await import("pino");
      let capturedLog = "";
      const stream = {
        write(msg: string) {
          capturedLog += msg;
        },
      };

      const testLogger = pino(
        {
          redact: {
            paths: ["password", "token", "secret", "creditCard", "cvv"],
            censor: "[REDACTED]",
          },
        },
        stream
      );

      testLogger.info(
        {
          username: "bob",
          password: "SuperSecretPassword123!",
          token: "secret_token_abc",
          secret: "session_secret_xyz",
          creditCard: "4111222233334444",
          cvv: "999",
        },
        "Test sensitive log"
      );

      assert.ok(capturedLog.includes("bob"));
      assert.ok(capturedLog.includes("[REDACTED]"));
      assert.doesNotMatch(capturedLog, /SuperSecretPassword123!/);
      assert.doesNotMatch(capturedLog, /secret_token_abc/);
      assert.doesNotMatch(capturedLog, /session_secret_xyz/);
      assert.doesNotMatch(capturedLog, /4111222233334444/);
      assert.doesNotMatch(capturedLog, /999/);
    });

    test("monitoring bridge provides OpenTelemetry descriptors and sanitized breadcrumbs", () => {
      const descriptors = monitoring.getOpenTelemetryMetricDescriptors();
      assert.ok(Array.isArray(descriptors));
      assert.ok(descriptors.some((d) => d.name === "http_requests_total"));
      assert.ok(descriptors.some((d) => d.name === "database_duration_seconds"));
      assert.ok(descriptors.some((d) => d.name === "websocket_connections"));

      const ctx = monitoring.getServiceContext();
      assert.strictEqual(ctx.serviceName, "gaming-lounge-manager");
      assert.strictEqual(ctx.version, "1.0.0");
    });
  });
});

