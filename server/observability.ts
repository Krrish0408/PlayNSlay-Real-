import type { Request, Response, NextFunction } from "express";
import type { Server } from "http";
import pino from "pino";
import { WebSocketServer, WebSocket } from "ws";
import { checkDatabaseHealth, getPoolStats, pool, pgliteClient } from "./db";
import { config, sanitizeDatabaseUrl } from "./config";
import { sanitizeForLogging } from "./error-handler";

/**
 * PRODUCTION STRUCTURED LOGGER (PINO)
 *
 * Configured with strict redaction paths to guarantee that secrets,
 * passwords, reset tokens, session identifiers, and payment data
 * are NEVER written to logs or stdout.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (config.isProduction ? "info" : "debug"),
  redact: {
    paths: [
      "password",
      "*.password",
      "*.*.password",
      "currentPassword",
      "newPassword",
      "confirmPassword",
      "token",
      "*.token",
      "*.*.token",
      "resetToken",
      "csrfToken",
      "_csrf",
      "emailVerificationToken",
      "secret",
      "*.secret",
      "*.*.secret",
      "sessionSecret",
      "clientSecret",
      "mfaSecret",
      "authorization",
      "cookie",
      "cookies",
      "headers.cookie",
      "headers.authorization",
      "headers.set-cookie",
      "session",
      "sessionId",
      "creditCard",
      "cardNumber",
      "cvv",
      "cvc",
      "paymentSecret",
      "razorpay_signature",
      "signature",
      "recoveryCodes",
      "mfaRecoveryCodes",
      "email",
      "*.email",
      "*.*.email",
      "phone",
      "*.phone",
      "*.*.phone",
      "fullName",
      "*.fullName",
      "*.*.fullName",
      "full_name",
      "*.full_name",
      "*.*.full_name",
      "ipAddress",
      "*.ipAddress",
      "*.*.ipAddress",
      "userAgent",
      "*.userAgent",
      "*.*.userAgent",
      "googleId",
      "*.googleId",
      "*.*.googleId",
    ],
    censor: "[REDACTED]",
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Bounded quantile reservoir for computing exact p50, p95, and p99 percentiles.
 * Retains up to `maxSamples` values in a rolling circular buffer.
 */
export class QuantileReservoir {
  private samples: number[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples = 5000) {
    this.maxSamples = maxSamples;
  }

  public record(value: number): void {
    if (isNaN(value) || value < 0) return;
    if (this.samples.length >= this.maxSamples) {
      // Evict oldest sample
      this.samples.shift();
    }
    this.samples.push(value);
  }

  public getPercentile(percentile: number): number {
    if (this.samples.length === 0) return 0;
    if (percentile <= 0) return this.samples[0];
    if (percentile >= 100) return this.samples[this.samples.length - 1];

    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = (percentile / 100) * (sorted.length - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    if (low === high) return sorted[low];
    const weight = rank - low;
    return Math.round((sorted[low] * (1 - weight) + sorted[high] * weight) * 100) / 100;
  }

  public getAverage(): number {
    if (this.samples.length === 0) return 0;
    const sum = this.samples.reduce((acc, v) => acc + v, 0);
    return Math.round((sum / this.samples.length) * 100) / 100;
  }

  public getSampleCount(): number {
    return this.samples.length;
  }

  public reset(): void {
    this.samples = [];
  }
}

/**
 * Sliding window counter for measuring rates (events per minute).
 */
export class SlidingWindowRateTracker {
  private timestamps: number[] = [];
  private readonly windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  public record(count = 1): void {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      this.timestamps.push(now);
    }
    this.cleanup(now);
  }

  private cleanup(now: number): void {
    const cutoff = now - this.windowMs;
    // Evict items older than window
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }

  public getRatePerMinute(): number {
    const now = Date.now();
    this.cleanup(now);
    const windowMinutes = this.windowMs / 60_000;
    return Math.round((this.timestamps.length / windowMinutes) * 100) / 100;
  }

  public reset(): void {
    this.timestamps = [];
  }
}

/**
 * PRODUCTION METRICS COLLECTOR
 *
 * Tracks all required observability dimensions:
 * - request count
 * - error rate (5xx / total)
 * - p50 latency
 * - p95 latency
 * - p99 latency
 * - database latency (p50, p95, p99, avg)
 * - active connections (in-flight HTTP requests)
 * - booking creation rate
 * - booking conflict rate
 * - payment failures
 * - authentication failures
 * - rate-limit events
 * - queue depth (database pool wait queue)
 * - WebSocket connections (active connected clients)
 */
export class MetricsCollector {
  private totalRequests = 0;
  private totalErrors = 0;
  private requestsByStatus: Record<number, number> = {};
  private requestsByRoute: Record<string, number> = {};

  private requestLatencyReservoir = new QuantileReservoir(5000);
  private databaseLatencyReservoir = new QuantileReservoir(2000);

  private activeConnectionsCount = 0;
  private webSocketConnectionsCount = 0;

  private totalBookingCreations = 0;
  private totalBookingConflicts = 0;
  private bookingCreationRateTracker = new SlidingWindowRateTracker(60_000);
  private bookingConflictRateTracker = new SlidingWindowRateTracker(60_000);

  private totalPaymentFailures = 0;
  private totalAuthFailures = 0;
  private totalRateLimitEvents = 0;

  private manualQueueDepthOverride: number | null = null;

  // --- Request & Latency Tracking ---

  public recordRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    this.totalRequests++;
    this.requestsByStatus[statusCode] = (this.requestsByStatus[statusCode] || 0) + 1;

    const routeKey = `${method} ${route}`;
    this.requestsByRoute[routeKey] = (this.requestsByRoute[routeKey] || 0) + 1;

    if (statusCode >= 500) {
      this.totalErrors++;
    }

    this.requestLatencyReservoir.record(durationMs);
  }

  public recordDatabaseLatency(durationMs: number): void {
    this.databaseLatencyReservoir.record(durationMs);
  }

  // --- Connection Tracking ---

  public incrementActiveConnections(): void {
    this.activeConnectionsCount++;
  }

  public decrementActiveConnections(): void {
    if (this.activeConnectionsCount > 0) {
      this.activeConnectionsCount--;
    }
  }

  public getActiveConnections(): number {
    return this.activeConnectionsCount;
  }

  public incrementWebSocketConnections(): void {
    this.webSocketConnectionsCount++;
  }

  public decrementWebSocketConnections(): void {
    if (this.webSocketConnectionsCount > 0) {
      this.webSocketConnectionsCount--;
    }
  }

  public setWebSocketConnections(count: number): void {
    this.webSocketConnectionsCount = Math.max(0, count);
  }

  public getWebSocketConnections(): number {
    return this.webSocketConnectionsCount;
  }

  // --- Business & Security Events ---

  public recordBookingCreated(): void {
    this.totalBookingCreations++;
    this.bookingCreationRateTracker.record();
  }

  public recordBookingConflict(): void {
    this.totalBookingConflicts++;
    this.bookingConflictRateTracker.record();
  }

  public recordPaymentFailure(): void {
    this.totalPaymentFailures++;
  }

  public recordAuthFailure(): void {
    this.totalAuthFailures++;
  }

  public recordRateLimitEvent(): void {
    this.totalRateLimitEvents++;
  }

  public setQueueDepth(depth: number): void {
    this.manualQueueDepthOverride = depth;
  }

  public getQueueDepth(): number {
    if (this.manualQueueDepthOverride !== null) {
      return this.manualQueueDepthOverride;
    }
    const poolStats = getPoolStats();
    return poolStats ? poolStats.waitingCount : 0;
  }

  // --- Snapshot Generation ---

  public getSnapshot() {
    const errorRate = this.totalRequests > 0
      ? Math.round((this.totalErrors / this.totalRequests) * 10000) / 10000
      : 0;

    const p50Latency = this.requestLatencyReservoir.getPercentile(50);
    const p95Latency = this.requestLatencyReservoir.getPercentile(95);
    const p99Latency = this.requestLatencyReservoir.getPercentile(99);

    const dbP50 = this.databaseLatencyReservoir.getPercentile(50);
    const dbP95 = this.databaseLatencyReservoir.getPercentile(95);
    const dbP99 = this.databaseLatencyReservoir.getPercentile(99);
    const dbAvg = this.databaseLatencyReservoir.getAverage();

    const bookingCreationRate = this.bookingCreationRateTracker.getRatePerMinute();
    const bookingConflictRate = this.bookingConflictRateTracker.getRatePerMinute();

    return {
      requestCount: this.totalRequests,
      errorRate,
      p50Latency,
      p95Latency,
      p99Latency,
      databaseLatency: {
        p50: dbP50,
        p95: dbP95,
        p99: dbP99,
        avg: dbAvg,
        samples: this.databaseLatencyReservoir.getSampleCount(),
      },
      activeConnections: this.activeConnectionsCount,
      bookingCreationRate,
      bookingConflictRate,
      bookingCreationsTotal: this.totalBookingCreations,
      bookingConflictsTotal: this.totalBookingConflicts,
      paymentFailures: this.totalPaymentFailures,
      authenticationFailures: this.totalAuthFailures,
      rateLimitEvents: this.totalRateLimitEvents,
      queueDepth: this.getQueueDepth(),
      webSocketConnections: this.webSocketConnectionsCount,
      requestsByStatus: { ...this.requestsByStatus },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Serializes metrics into standard Prometheus / OpenTelemetry text format.
   */
  public toPrometheus(): string {
    const s = this.getSnapshot();
    const lines = [
      "# HELP http_requests_total Total number of HTTP requests",
      "# TYPE http_requests_total counter",
      `http_requests_total ${s.requestCount}`,

      "# HELP http_error_rate Ratio of 5xx errors to total HTTP requests",
      "# TYPE http_error_rate gauge",
      `http_error_rate ${s.errorRate}`,

      "# HELP http_request_duration_seconds HTTP request latency percentiles in seconds",
      "# TYPE http_request_duration_seconds summary",
      `http_request_duration_seconds{quantile="0.5"} ${(s.p50Latency / 1000).toFixed(4)}`,
      `http_request_duration_seconds{quantile="0.95"} ${(s.p95Latency / 1000).toFixed(4)}`,
      `http_request_duration_seconds{quantile="0.99"} ${(s.p99Latency / 1000).toFixed(4)}`,

      "# HELP database_duration_seconds Database query latency percentiles in seconds",
      "# TYPE database_duration_seconds summary",
      `database_duration_seconds{quantile="0.5"} ${(s.databaseLatency.p50 / 1000).toFixed(4)}`,
      `database_duration_seconds{quantile="0.95"} ${(s.databaseLatency.p95 / 1000).toFixed(4)}`,
      `database_duration_seconds{quantile="0.99"} ${(s.databaseLatency.p99 / 1000).toFixed(4)}`,

      "# HELP active_connections In-flight active HTTP connections",
      "# TYPE active_connections gauge",
      `active_connections ${s.activeConnections}`,

      "# HELP booking_creations_total Total number of bookings successfully created",
      "# TYPE booking_creations_total counter",
      `booking_creations_total ${s.bookingCreationsTotal}`,

      "# HELP booking_creation_rate_per_minute Rate of bookings created per minute",
      "# TYPE booking_creation_rate_per_minute gauge",
      `booking_creation_rate_per_minute ${s.bookingCreationRate}`,

      "# HELP booking_conflicts_total Total number of booking conflicts",
      "# TYPE booking_conflicts_total counter",
      `booking_conflicts_total ${s.bookingConflictsTotal}`,

      "# HELP booking_conflict_rate_per_minute Rate of booking conflicts per minute",
      "# TYPE booking_conflict_rate_per_minute gauge",
      `booking_conflict_rate_per_minute ${s.bookingConflictRate}`,

      "# HELP payment_failures_total Total number of payment failures",
      "# TYPE payment_failures_total counter",
      `payment_failures_total ${s.paymentFailures}`,

      "# HELP auth_failures_total Total number of authentication failures",
      "# TYPE auth_failures_total counter",
      `auth_failures_total ${s.authenticationFailures}`,

      "# HELP rate_limit_events_total Total number of HTTP 429 rate limit events",
      "# TYPE rate_limit_events_total counter",
      `rate_limit_events_total ${s.rateLimitEvents}`,

      "# HELP database_queue_depth Database connection pool wait queue depth",
      "# TYPE database_queue_depth gauge",
      `database_queue_depth ${s.queueDepth}`,

      "# HELP websocket_connections Active WebSocket connections",
      "# TYPE websocket_connections gauge",
      `websocket_connections ${s.webSocketConnections}`,
    ];

    return lines.join("\n") + "\n";
  }

  public resetForTesting(): void {
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.requestsByStatus = {};
    this.requestsByRoute = {};
    this.requestLatencyReservoir.reset();
    this.databaseLatencyReservoir.reset();
    this.activeConnectionsCount = 0;
    this.webSocketConnectionsCount = 0;
    this.totalBookingCreations = 0;
    this.totalBookingConflicts = 0;
    this.bookingCreationRateTracker.reset();
    this.bookingConflictRateTracker.reset();
    this.totalPaymentFailures = 0;
    this.totalAuthFailures = 0;
    this.totalRateLimitEvents = 0;
    this.manualQueueDepthOverride = null;
  }
}

export const metrics = new MetricsCollector();

// Instrument database clients for automatic database latency tracking
if (pool && !(pool as any).__instrumentedForMetrics) {
  const originalQuery = pool.query.bind(pool);
  (pool as any).query = async function (...args: any[]) {
    const start = Date.now();
    try {
      return await (originalQuery as any)(...args);
    } finally {
      metrics.recordDatabaseLatency(Date.now() - start);
    }
  };
  (pool as any).__instrumentedForMetrics = true;
}

if (pgliteClient && !(pgliteClient as any).__instrumentedForMetrics) {
  const originalExec = pgliteClient.exec.bind(pgliteClient);
  (pgliteClient as any).exec = async function (...args: any[]) {
    const start = Date.now();
    try {
      return await (originalExec as any)(...args);
    } finally {
      metrics.recordDatabaseLatency(Date.now() - start);
    }
  };
  (pgliteClient as any).__instrumentedForMetrics = true;
}

/**
 * PRODUCTION OBSERVABILITY & REQUEST LOGGING MIDDLEWARE
 *
 * Guarantees every request has:
 * - request ID
 * - method
 * - route
 * - status
 * - latency
 *
 * Emits structured JSON logs through Pino and increments active connection counters.
 */
export function observabilityMiddleware(req: Request, res: Response, next: NextFunction) {
  if ((req as any).__observabilityHandled) {
    return next();
  }
  (req as any).__observabilityHandled = true;

  const startHrTime = process.hrtime.bigint();
  const requestId = (req as any).requestId || (res.getHeader("X-Request-Id") as string) || "unknown";

  metrics.incrementActiveConnections();

  let finished = false;
  const finalize = () => {
    if (finished) return;
    finished = true;

    metrics.decrementActiveConnections();

    const endHrTime = process.hrtime.bigint();
    const durationMs = Number(endHrTime - startHrTime) / 1_000_000;
    const roundedLatency = Math.round(durationMs * 100) / 100;

    const base = req.baseUrl || "";
    const route = req.route?.path ? `${base}${req.route.path}` : (req.originalUrl || req.path);
    const method = req.method;
    const status = res.statusCode;

    // Record request into metrics collector
    metrics.recordRequest(method, route, status, durationMs);

    // Record domain & security events automatically from HTTP response status and route
    if (status === 401) {
      metrics.recordAuthFailure();
    } else if (status === 429) {
      metrics.recordRateLimitEvent();
    } else if (method === "POST" && (route.includes("/api/bookings") || req.path === "/api/bookings") && status === 201) {
      metrics.recordBookingCreated();
    } else if (status === 409 && (route.includes("booking") || req.path.includes("booking") || route.includes("conflict") || req.path.includes("conflict"))) {
      metrics.recordBookingConflict();
    } else if (status >= 400 && (route.includes("/api/payments") || req.path.includes("/api/payments"))) {
      metrics.recordPaymentFailure();
    }

    // Structured JSON log with Pino
    const logPayload = {
      requestId,
      method,
      route,
      path: req.originalUrl || req.path,
      status,
      latency: roundedLatency,
    };

    if (status >= 500) {
      logger.error(logPayload, `HTTP ${method} ${route} ${status} in ${roundedLatency}ms`);
    } else if (status >= 400) {
      logger.warn(logPayload, `HTTP ${method} ${route} ${status} in ${roundedLatency}ms`);
    } else {
      logger.info(logPayload, `HTTP ${method} ${route} ${status} in ${roundedLatency}ms`);
    }
  };

  res.on("finish", finalize);
  res.on("close", finalize);

  next();
}

/**
 * LIVENESS HEALTH CHECK: GET /health/live
 *
 * Verifies the application process is running.
 * Always returns 200 OK without touching dependencies,
 * preventing spurious container restart loops.
 */
export function livenessHandler(_req: Request, res: Response) {
  res.status(200).json({
    status: "live",
    uptime: Math.round(process.uptime() * 100) / 100,
    timestamp: new Date().toISOString(),
  });
}

let serverShuttingDown = false;

export function setShuttingDown(val: boolean) {
  serverShuttingDown = val;
}

export function isServerShuttingDown(): boolean {
  return serverShuttingDown;
}

/**
 * READINESS HEALTH CHECK: GET /health/ready
 *
 * Verifies that application dependencies required for serving traffic
 * (e.g., PostgreSQL database) are reachable and healthy.
 *
 * Strictly adheres to security rules: DOES NOT expose sensitive diagnostic
 * info (database URLs, connection strings, pool passwords, or stack traces).
 */
export async function readinessHandler(_req: Request, res: Response) {
  if (serverShuttingDown) {
    return res.status(503).json({
      status: "shutting_down",
      dependencies: {
        database: "unavailable",
      },
      timestamp: new Date().toISOString(),
    });
  }

  // Enforce a strict 2-second timeout on readiness checks
  let isReady = false;

  try {
    const healthPromise = checkDatabaseHealth();
    const timeoutPromise = new Promise<{ healthy: boolean }>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), 2000)
    );

    const result = await Promise.race([healthPromise, timeoutPromise]);
    isReady = Boolean(result.healthy);
  } catch {
    isReady = false;
  }

  if (isReady) {
    return res.status(200).json({
      status: "ready",
      dependencies: {
        database: "ready",
      },
      timestamp: new Date().toISOString(),
    });
  }

  return res.status(503).json({
    status: "not_ready",
    dependencies: {
      database: "unavailable",
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * METRICS ENDPOINT: GET /metrics and GET /api/metrics
 *
 * Exposes all tracked metrics in Prometheus or JSON format.
 */
export function metricsHandler(req: Request, res: Response) {
  const acceptHeader = req.headers.accept || "";
  const formatQuery = (req.query.format as string)?.toLowerCase();
  const isApiRoute = req.path.startsWith("/api") || req.originalUrl?.includes("/api/metrics");

  if (formatQuery === "json" || isApiRoute || acceptHeader.includes("application/json")) {
    res.setHeader("Content-Type", "application/json");
    return res.json(metrics.getSnapshot());
  }

  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  return res.send(metrics.toPrometheus());
}

/**
 * WEBSOCKET OBSERVABILITY SETUP
 *
 * Attaches WebSocket connection tracking to the HTTP server.
 * Increments active WebSocket connections on client connect,
 * decrements on close, and tracks ping/pong liveness.
 */
export function setupWebSocketObservability(httpServer: Server, wsPath = "/ws"): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: wsPath });

  wss.on("connection", (ws: WebSocket, req) => {
    metrics.incrementWebSocketConnections();
    const clientIp = req.socket.remoteAddress;
    logger.debug({ clientIp, activeWebSockets: metrics.getWebSocketConnections() }, "WebSocket client connected");

    ws.on("close", () => {
      metrics.decrementWebSocketConnections();
      logger.debug({ activeWebSockets: metrics.getWebSocketConnections() }, "WebSocket client disconnected");
    });

    ws.on("error", (err) => {
      logger.warn({ error: err.message }, "WebSocket client error");
    });

    // Simple ping/pong heartbeat
    ws.on("message", (message) => {
      if (message.toString() === "ping") {
        ws.send("pong");
      }
    });
  });

  return wss;
}

/**
 * MONITORING INTEGRATION BRIDGE (OpenTelemetry / Sentry / Datadog / Grafana)
 *
 * Prepares the application for OpenTelemetry trace and metric collection,
 * Sentry error tracking, and Datadog/Grafana agent scraping.
 */
export const monitoring = {
  getServiceContext() {
    return {
      serviceName: "gaming-lounge-manager",
      environment: config.env,
      version: "1.0.0",
      host: process.env.HOSTNAME || "localhost",
    };
  },

  addBreadcrumb(category: string, message: string, data?: Record<string, any>) {
    // Sanitized breadcrumb for Sentry / OpenTelemetry traces
    const safeData = data ? sanitizeForLogging(data) : undefined;
    logger.debug({ category, message, data: safeData }, `[TRACE BREADCRUMB] ${category}: ${message}`);
  },

  captureException(error: Error, context?: Record<string, any>) {
    const safeContext = context ? sanitizeForLogging(context) : undefined;
    logger.error({ err: error, context: safeContext }, `[ERROR CAPTURED] ${error.message}`);
  },

  getOpenTelemetryMetricDescriptors() {
    return [
      { name: "http_requests_total", type: "counter", unit: "1" },
      { name: "http_request_duration_seconds", type: "histogram", unit: "s" },
      { name: "database_duration_seconds", type: "histogram", unit: "s" },
      { name: "active_connections", type: "updowncounter", unit: "1" },
      { name: "booking_creations_total", type: "counter", unit: "1" },
      { name: "booking_conflicts_total", type: "counter", unit: "1" },
      { name: "payment_failures_total", type: "counter", unit: "1" },
      { name: "auth_failures_total", type: "counter", unit: "1" },
      { name: "rate_limit_events_total", type: "counter", unit: "1" },
      { name: "database_queue_depth", type: "gauge", unit: "1" },
      { name: "websocket_connections", type: "updowncounter", unit: "1" },
    ];
  },
};
