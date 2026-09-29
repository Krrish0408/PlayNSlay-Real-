import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { setupAuth, hashPassword } from "../server/auth";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { initDbSchema } from "../server/db";
import { seedTestUsers } from "../server/seed";
import { MemoryStore } from "express-rate-limit";
import { setRateLimitStoreFactoryForTesting } from "../server/rate-limiter";
import { config } from "../server/config";
import {
  generateRequestId,
  requestIdMiddleware,
  AppError,
  BadRequestError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  BookingConflictError,
  RateLimitError,
  DatabaseUnavailableError,
  InternalServerError,
  containsSensitiveData,
  sanitizeForLogging,
  logInternalError,
  formatErrorResponse,
  errorHandlerMiddleware,
  notFoundHandler,
} from "../server/error-handler";

interface TestClient {
  cookieJar: string[];
  setCookie: (cookie: string) => void;
  getCookieValue: (name: string) => string | undefined;
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  patch: (url: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  delete: (url: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
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
    patch: (url, body, headers) => request("PATCH", url, body, headers),
    delete: (url, headers) => request("DELETE", url, undefined, headers),
  };
}

describe("Safe Production Error Handling Test Suite", () => {
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

    // Mount request ID middleware
    app.use(requestIdMiddleware);

    // Setup Auth
    setupAuth(app);

    // Test routes simulating various real-world error conditions
    app.get("/api/test-errors/booking-conflict", (req, res, next) => {
      next(new BookingConflictError());
    });

    app.get("/api/test-errors/sql-leak", (req, res, next) => {
      const sqlError = new Error("syntax error at or near 'SELECT * FROM users WHERE password_hash = 'secret''");
      (sqlError as any).code = "42601";
      next(sqlError);
    });

    app.get("/api/test-errors/connection-string-leak", (req, res, next) => {
      const connError = new Error("Connection failed: postgres://postgres:superSecretPassword123@db.internal.net:5432/production_db");
      next(connError);
    });

    app.get("/api/test-errors/filesystem-leak", (req, res, next) => {
      const fsError = new Error("ENOENT: no such file or directory, open '/Users/production/keys/private_key.pem' at /app/server/crypto.ts:142:5");
      next(fsError);
    });

    app.get("/api/test-errors/stack-trace-leak", (req, res, next) => {
      const errorWithStack = new Error("Crash in internal algorithm");
      next(errorWithStack);
    });

    app.get("/api/test-errors/secrets-leak", (req, res, next) => {
      const secretError = new Error("Failed to authenticate with JWT_SECRET=super_top_secret_jwt_key_9999");
      next(secretError);
    });

    app.get("/api/test-errors/library-leak", (req, res, next) => {
      const libError = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      (libError as any).code = "ECONNREFUSED";
      next(libError);
    });

    app.get("/api/test-errors/pg-exclusion-conflict", (req, res, next) => {
      const pgExclusionError = new Error("conflicting key value violates exclusion constraint 'station_slot_idx'");
      (pgExclusionError as any).code = "23P01";
      next(pgExclusionError);
    });

    app.get("/api/test-errors/pg-unique-conflict", (req, res, next) => {
      const pgUniqueError = new Error("duplicate key value violates unique constraint 'users_username_key'");
      (pgUniqueError as any).code = "23505";
      next(pgUniqueError);
    });

    app.get("/api/test-errors/pg-foreign-key", (req, res, next) => {
      const pgFkError = new Error("insert or update on table 'bookings' violates foreign key constraint 'bookings_station_id_fkey'");
      (pgFkError as any).code = "23503";
      next(pgFkError);
    });

    app.get("/api/test-errors/operational-bad-request", (req, res, next) => {
      next(new BadRequestError("End time must be after start time"));
    });

    app.get("/api/test-errors/operational-forbidden", (req, res, next) => {
      next(new ForbiddenError("Only superadmins can access this system audit log"));
    });

    app.get("/api/test-errors/operational-rate-limit", (req, res, next) => {
      next(new RateLimitError());
    });

    app.get("/api/test-errors/database-unavailable", (req, res, next) => {
      next(new DatabaseUnavailableError());
    });

    // Register official app routes
    server = http.createServer(app);
    registerRoutes(server, app);

    // Catch-all 404 for API routes
    app.use("/api/*", notFoundHandler);

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

  describe("Correlation & Request ID Generation", () => {
    test("Every request receives a unique X-Request-Id header starting with 'req_'", async () => {
      const res = await client.get("/api/health");
      assert.strictEqual(res.status, 200);
      const reqId = res.headers.get("x-request-id");
      assert.ok(reqId, "X-Request-Id header must be present on response");
      assert.match(reqId, /^req_[a-f0-9]{24}$/, "Request ID must be in expected format");
    });

    test("Every error response contains the matching requestId in header and payload", async () => {
      const res = await client.get("/api/test-errors/booking-conflict");
      assert.strictEqual(res.status, 409);
      const headerReqId = res.headers.get("x-request-id");
      assert.ok(headerReqId, "X-Request-Id header must be present");
      assert.strictEqual(res.data.error.requestId, headerReqId);
      assert.strictEqual(res.data.requestId, headerReqId);
    });

    test("Client-provided valid X-Request-Id is preserved across the pipeline", async () => {
      const customId = "trace-client-tx-123456789";
      const res = await client.get("/api/test-errors/booking-conflict", {
        "X-Request-Id": customId,
      });
      assert.strictEqual(res.headers.get("x-request-id"), customId);
      assert.strictEqual(res.data.error.requestId, customId);
      assert.strictEqual(res.data.requestId, customId);
    });

    test("Client-provided invalid/malicious X-Request-Id is rejected and replaced with safe generated ID", async () => {
      const maliciousId = "invalid<script>alert(1)</script>";
      const res = await client.get("/api/test-errors/booking-conflict", {
        "X-Request-Id": maliciousId,
      });
      const returnedId = res.headers.get("x-request-id");
      assert.notStrictEqual(returnedId, maliciousId);
      assert.match(returnedId!, /^req_[a-f0-9]{24}$/);

      // Also verify overly long request IDs (> 64 chars) are rejected
      const longId = "a".repeat(100);
      const resLong = await client.get("/api/test-errors/booking-conflict", {
        "X-Request-Id": longId,
      });
      const returnedLongId = resLong.headers.get("x-request-id");
      assert.notStrictEqual(returnedLongId, longId);
      assert.match(returnedLongId!, /^req_[a-f0-9]{24}$/);
    });
  });

  describe("Structured Error Format Compliance", () => {
    test("Structured error matches exact required format: { error: { code, message, requestId } }", async () => {
      const res = await client.get("/api/test-errors/booking-conflict");
      assert.strictEqual(res.status, 409);

      // Verify prompt's structured error format
      assert.ok(res.data.error, "Must have nested error object");
      assert.strictEqual(res.data.error.code, "BOOKING_CONFLICT");
      assert.strictEqual(res.data.error.message, "The selected station is no longer available.");
      assert.ok(res.data.error.requestId, "Must have correlation requestId");

      // Verify backward-compatibility root fields
      assert.strictEqual(res.data.code, "BOOKING_CONFLICT");
      assert.strictEqual(res.data.message, "The selected station is no longer available.");
      assert.strictEqual(res.data.requestId, res.data.error.requestId);
    });

    test("PostgreSQL exclusion constraint error (23P01) automatically maps to BOOKING_CONFLICT with 409 status", async () => {
      const res = await client.get("/api/test-errors/pg-exclusion-conflict");
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.data.error.code, "BOOKING_CONFLICT");
      assert.match(res.data.error.message, /selected station is no longer available/i);
    });

    test("PostgreSQL unique constraint violation (23505) maps to RESOURCE_CONFLICT with 409 status", async () => {
      const res = await client.get("/api/test-errors/pg-unique-conflict");
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.data.error.code, "RESOURCE_CONFLICT");
    });

    test("PostgreSQL foreign key violation (23503) maps to INVALID_REFERENCE with 400 status", async () => {
      const res = await client.get("/api/test-errors/pg-foreign-key");
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.error.code, "INVALID_REFERENCE");
    });
  });

  describe("Information Leak Prevention in Production", () => {
    test("Production responses never expose raw SQL queries or syntax errors", async () => {
      // Test direct formatting function under isProduction = true
      const rawError = new Error("syntax error at or near 'SELECT * FROM users WHERE password_hash = 'secret''");
      const { status, payload } = formatErrorResponse(rawError, "req_test123", true);

      assert.strictEqual(status, 500);
      assert.strictEqual(payload.error.code, "INTERNAL_SERVER_ERROR");
      assert.doesNotMatch(payload.error.message, /SELECT/i);
      assert.doesNotMatch(payload.error.message, /users/i);
      assert.doesNotMatch(payload.error.message, /password_hash/i);
      assert.strictEqual(payload.error.message, "An unexpected error occurred. Please contact support with your request ID.");
    });

    test("Production responses never expose database connection strings or credentials", async () => {
      const rawError = new Error("Connection failed: postgres://postgres:superSecretPassword123@db.internal.net:5432/production_db");
      const { status, payload } = formatErrorResponse(rawError, "req_test123", true);

      const jsonStr = JSON.stringify(payload);
      assert.doesNotMatch(jsonStr, /superSecretPassword123/);
      assert.doesNotMatch(jsonStr, /postgres:\/\//);
      assert.doesNotMatch(jsonStr, /production_db/);
      assert.strictEqual(payload.error.message, "An unexpected error occurred. Please contact support with your request ID.");
    });

    test("Production responses never expose filesystem paths", async () => {
      const rawError = new Error("ENOENT: no such file or directory, open '/Users/production/keys/private_key.pem' at /app/server/crypto.ts:142:5");
      const { status, payload } = formatErrorResponse(rawError, "req_test123", true);

      const jsonStr = JSON.stringify(payload);
      assert.doesNotMatch(jsonStr, /\/Users\/production/);
      assert.doesNotMatch(jsonStr, /private_key\.pem/);
      assert.doesNotMatch(jsonStr, /\/app\/server/);
      assert.doesNotMatch(jsonStr, /crypto\.ts:142/);
      assert.strictEqual(payload.error.message, "An unexpected error occurred. Please contact support with your request ID.");
    });

    test("Production responses never expose stack traces", async () => {
      const errorWithStack = new Error("Crash in internal algorithm");
      errorWithStack.stack = "Error: Crash in internal algorithm\n    at Object.<anonymous> (/app/server/algo.ts:45:10)\n    at Module._compile (node:internal/modules/cjs/loader:1376:14)";
      const { status, payload } = formatErrorResponse(errorWithStack, "req_test123", true);

      const jsonStr = JSON.stringify(payload);
      assert.doesNotMatch(jsonStr, /Object\.<anonymous>/);
      assert.doesNotMatch(jsonStr, /algo\.ts/);
      assert.doesNotMatch(jsonStr, /node:internal/);
      assert.strictEqual((payload as any).stack, undefined);
      assert.strictEqual((payload.error as any).stack, undefined);
    });

    test("Production responses never expose environment variables or secrets", async () => {
      const secretError = new Error("Failed to authenticate with JWT_SECRET=super_top_secret_jwt_key_9999");
      const { status, payload } = formatErrorResponse(secretError, "req_test123", true);

      const jsonStr = JSON.stringify(payload);
      assert.doesNotMatch(jsonStr, /JWT_SECRET/);
      assert.doesNotMatch(jsonStr, /super_top_secret_jwt_key_9999/);
    });

    test("Production responses never expose internal library network errors", async () => {
      const libError = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      (libError as any).code = "ECONNREFUSED";
      const { status, payload } = formatErrorResponse(libError, "req_test123", true);

      const jsonStr = JSON.stringify(payload);
      assert.doesNotMatch(jsonStr, /ECONNREFUSED/);
      assert.doesNotMatch(jsonStr, /127\.0\.0\.1:5432/);
    });
  });

  describe("HTTP Status Code Mapping", () => {
    test("BadRequestError maps to 400 BAD_REQUEST", async () => {
      const res = await client.get("/api/test-errors/operational-bad-request");
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.error.code, "BAD_REQUEST");
      assert.strictEqual(res.data.error.message, "End time must be after start time");
    });

    test("ForbiddenError maps to 403 FORBIDDEN", async () => {
      const res = await client.get("/api/test-errors/operational-forbidden");
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.data.error.code, "FORBIDDEN");
      assert.strictEqual(res.data.error.message, "Only superadmins can access this system audit log");
    });

    test("BookingConflictError maps to 409 BOOKING_CONFLICT", async () => {
      const res = await client.get("/api/test-errors/booking-conflict");
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.data.error.code, "BOOKING_CONFLICT");
      assert.strictEqual(res.data.error.message, "The selected station is no longer available.");
    });

    test("RateLimitError maps to 429 RATE_LIMITED", async () => {
      const res = await client.get("/api/test-errors/operational-rate-limit");
      assert.strictEqual(res.status, 429);
      assert.strictEqual(res.data.error.code, "RATE_LIMITED");
      assert.strictEqual(res.data.error.message, "Too many requests. Please slow down.");
    });

    test("DatabaseUnavailableError maps to 503 DATABASE_UNAVAILABLE", async () => {
      const res = await client.get("/api/test-errors/database-unavailable");
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.data.error.code, "DATABASE_UNAVAILABLE");
      assert.match(res.data.error.message, /Database service is temporarily unavailable/);
    });

    test("Unknown API route maps to 404 NOT_FOUND with structured error", async () => {
      const res = await client.get("/api/non-existent-endpoint-98765");
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.data.error.code, "NOT_FOUND");
      assert.match(res.data.error.message, /not found/i);
      assert.ok(res.data.error.requestId);
    });
  });

  describe("Server-Side Logging & Sensitive Data Redaction", () => {
    test("sanitizeForLogging redacts passwords in objects", () => {
      const data = {
        username: "johndoe",
        password: "MySuperSecretPassword123!",
        nested: {
          currentPassword: "OldPassword456!",
          newPassword: "NewPassword789!",
        },
      };
      const sanitized = sanitizeForLogging(data);
      assert.strictEqual(sanitized.username, "johndoe");
      assert.strictEqual(sanitized.password, "[REDACTED]");
      assert.strictEqual(sanitized.nested.currentPassword, "[REDACTED]");
      assert.strictEqual(sanitized.nested.newPassword, "[REDACTED]");
    });

    test("sanitizeForLogging redacts session IDs, reset tokens, and CSRF tokens", () => {
      const data = {
        sessionId: "s_abc123xyz789",
        resetToken: "rst_secret_reset_token",
        csrfToken: "csrf_token_secret",
        authorization: "Bearer secret-jwt-token",
        recoveryCodes: ["code1", "code2"],
      };
      const sanitized = sanitizeForLogging(data);
      assert.strictEqual(sanitized.sessionId, "[REDACTED]");
      assert.strictEqual(sanitized.resetToken, "[REDACTED]");
      assert.strictEqual(sanitized.csrfToken, "[REDACTED]");
      assert.strictEqual(sanitized.authorization, "[REDACTED]");
      assert.strictEqual(sanitized.recoveryCodes, "[REDACTED]");
    });

    test("sanitizeForLogging redacts payment secrets and credit card numbers", () => {
      const data = {
        orderId: "ord_1001",
        creditCard: "4111111111111111",
        cvv: "123",
        paymentSecret: "sk_live_secretkey999",
        razorpay_signature: "sig_abcde12345",
      };
      const sanitized = sanitizeForLogging(data);
      assert.strictEqual(sanitized.orderId, "ord_1001");
      assert.strictEqual(sanitized.creditCard, "[REDACTED]");
      assert.strictEqual(sanitized.cvv, "[REDACTED]");
      assert.strictEqual(sanitized.paymentSecret, "[REDACTED]");
      assert.strictEqual(sanitized.razorpay_signature, "[REDACTED]");
    });

    test("sanitizeForLogging sanitizes database connection URLs in string values", () => {
      const data = {
        databaseUrl: "postgres://admin:topSecretPassword@postgres-db.internal:5432/gaming_db",
      };
      const sanitized = sanitizeForLogging(data);
      assert.strictEqual(
        sanitized.databaseUrl,
        "postgres://admin:******@postgres-db.internal:5432/gaming_db"
      );
    });

    test("logInternalError logs requestId without printing unredacted secrets", () => {
      const originalConsoleError = console.error;
      const logs: string[] = [];
      console.error = (...args: any[]) => {
        logs.push(args.join(" "));
      };

      try {
        const fakeReq = {
          method: "POST",
          originalUrl: "/api/login",
          body: {
            username: "hacker",
            password: "TopSecretPasswordDoNotLog!",
          },
          query: {},
        } as any;

        const fakeError = new Error("Invalid password attempt");
        (fakeError as any).status = 401;
        (fakeError as any).code = "UNAUTHORIZED";

        logInternalError(fakeError, fakeReq, "req_audit_test_999");

        const allLogs = logs.join("\n");
        assert.ok(allLogs.includes("req_audit_test_999"), "Must log requestId");
        assert.doesNotMatch(allLogs, /TopSecretPasswordDoNotLog!/, "Must not log plaintext password");
      } finally {
        console.error = originalConsoleError;
      }
    });
  });
});

