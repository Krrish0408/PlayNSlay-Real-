import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "crypto";
import { z } from "zod";
import { config, sanitizeDatabaseUrl } from "./config";
import { isDatabaseUnavailableError } from "./db-errors";

/**
 * Generates a unique, cryptographically secure request correlation ID.
 */
export function generateRequestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

/**
 * Middleware that generates or captures a request correlation ID for every incoming request.
 * Sets the correlation ID in the request context and returns it in the X-Request-Id header.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incomingId = (req.headers["x-request-id"] || req.headers["x-correlation-id"]) as string | undefined;

  let requestId: string;
  if (incomingId && typeof incomingId === "string" && /^[a-zA-Z0-9_\-\.]{1,64}$/.test(incomingId)) {
    requestId = incomingId;
  } else {
    requestId = generateRequestId();
  }

  (req as any).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}

/**
 * Base custom application error class.
 */
export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly userFacingMessage: string;
  public readonly isOperational: boolean;
  public readonly details?: any;

  constructor(
    message: string,
    status = 500,
    code = "INTERNAL_SERVER_ERROR",
    userFacingMessage?: string,
    details?: any
  ) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.userFacingMessage = userFacingMessage || message;
    this.isOperational = true;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Invalid request payload or parameters", details?: any) {
    super(message, 400, "BAD_REQUEST", message, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation error", errors?: any) {
    super(message, 400, "VALIDATION_ERROR", message, errors);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Insufficient permissions to perform this action") {
    super(message, 403, "FORBIDDEN", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Requested resource not found") {
    super(message, 404, "NOT_FOUND", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict", code = "CONFLICT") {
    super(message, 409, code, message);
  }
}

export class BookingConflictError extends AppError {
  constructor(message = "The selected station is no longer available.") {
    super(message, 409, "BOOKING_CONFLICT", message);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests. Please slow down.", details?: any) {
    super(message, 429, "RATE_LIMITED", message, details);
  }
}

export class DatabaseUnavailableError extends AppError {
  constructor(message = "Database service is temporarily unavailable. Please try again shortly.") {
    super(message, 503, "DATABASE_UNAVAILABLE", message);
  }
}

export class InternalServerError extends AppError {
  constructor(message = "An internal server error occurred.") {
    super(message, 500, "INTERNAL_SERVER_ERROR", message);
  }
}

/**
 * Patterns that represent internal leaks if exposed to users:
 * - SQL statements and syntax
 * - Database connection strings
 * - Filesystem paths
 * - Secrets, tokens, and password fragments
 * - Stack trace frames
 */
const SENSITIVE_PATTERNS = [
  // SQL queries & syntax & ORM internals
  /\b(SELECT\s+.+\s+FROM|INSERT\s+INTO\s+|UPDATE\s+.+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|ON\s+CONFLICT|pg_catalog)\b/i,
  /syntax\s+error\s+at\s+or\s+near/i,
  /relation\s+"[^"]+"\s+does\s+not\s+exist/i,
  /column\s+"[^"]+"\s+does\s+not\s+exist/i,
  /\b(drizzle-orm|pg-protocol|knex|prisma|sequelize)\b/i,
  // Database connection URLs
  /postgres(ql)?:\/\/[^\s"'<>]+/i,
  /mysql:\/\/[^\s"'<>]+/i,
  /mongodb(\+srv)?:\/\/[^\s"'<>]+/i,
  /redis:\/\/[^\s"'<>]+/i,
  /sqlite:\/\/[^\s"'<>]+/i,
  // Filesystem paths
  /([a-zA-Z]:\\[^\s"'<>]+|(\/(Users|home|var|tmp|etc|app|node_modules|usr|root)\/[^\s"'<>]+))/i,
  /\.(ts|js|mjs|cjs):\d+(:\d+)?/i,
  /node:internal/i,
  // Stack traces
  /\s+at\s+.+\(.+:\d+:\d+\)|\s+at\s+.+:\d+:\d+/i,
  // Internal library / system errors
  /\b(ECONNREFUSED|ENOTFOUND|EADDRINUSE|ETIMEDOUT|EPIPE|EHOSTUNREACH)\b/i,
  // Secrets and environment variables
  /(DATABASE_URL|SESSION_SECRET|JWT_SECRET|API_KEY|PASSWORD|TOKEN|SECRET|STRIPE_KEY|RAZORPAY_KEY)\s*=/i,
  /bearer\s+[a-zA-Z0-9_\-\.]{15,}/i,
];

/**
 * Checks whether a string contains sensitive internal information.
 */
export function containsSensitiveData(text?: string): boolean {
  if (!text || typeof text !== "string") return false;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Sensitive field names that must never be logged in request bodies, query params, or responses.
 */
const SENSITIVE_KEYS = new Set([
  "password",
  "currentpassword",
  "newpassword",
  "confirmpassword",
  "secret",
  "sessionsecret",
  "clientsecret",
  "mfasecret",
  "token",
  "csrftoken",
  "_csrf",
  "resettoken",
  "verificationtoken",
  "emailverificationtoken",
  "cookie",
  "cookies",
  "set-cookie",
  "authorization",
  "auth",
  "session",
  "sessionid",
  "recoverycodes",
  "mfarecoverycodes",
  "creditcard",
  "cardnumber",
  "cvv",
  "cvc",
  "paymentsecret",
  "razorpay_signature",
  "signature",
]);

/**
 * Deeply sanitizes an object or array to redact passwords, session IDs, reset tokens, and payment secrets.
 */
export function sanitizeForLogging(data: any, depth = 0): any {
  if (depth > 6 || data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    // Sanitize any database URLs found in strings
    if (data.includes("postgres://") || data.includes("postgresql://")) {
      return sanitizeDatabaseUrl(data);
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeForLogging(item, depth + 1));
  }

  if (typeof data === "object") {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase().replace(/[_-]/g, "");
      if (
        SENSITIVE_KEYS.has(lowerKey) ||
        lowerKey.includes("password") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("token") ||
        lowerKey.includes("card") ||
        lowerKey.includes("payment") ||
        lowerKey.includes("signature") ||
        lowerKey.includes("cookie") ||
        lowerKey.includes("session") ||
        lowerKey.includes("cvv") ||
        lowerKey.includes("cvc") ||
        lowerKey.includes("auth")
      ) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "object" && value !== null) {
        sanitized[key] = sanitizeForLogging(value, depth + 1);
      } else if (typeof value === "string") {
        if (value.includes("postgres://") || value.includes("postgresql://")) {
          sanitized[key] = sanitizeDatabaseUrl(value);
        } else {
          sanitized[key] = value;
        }
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  return data;
}

/**
 * Server-side error logger that logs internal details with the request correlation ID,
 * while ensuring no passwords, tokens, or secrets are logged.
 */
export function logInternalError(err: any, req: Request, requestId: string) {
  const method = req.method || "UNKNOWN";
  const path = req.originalUrl || req.url || "UNKNOWN";
  const status = err.status || err.statusCode || 500;
  const code = err.code || "INTERNAL_SERVER_ERROR";

  // Sanitize any request details before logging
  const safeBody = req.body ? sanitizeForLogging(req.body) : undefined;
  const safeQuery = req.query ? sanitizeForLogging(req.query) : undefined;

  const logPayload = {
    requestId,
    method,
    path,
    status,
    code,
    message: err.message,
    body: safeBody,
    query: safeQuery,
    user: (req as any).user ? (req as any).user.id : undefined,
  };

  console.error(
    `[ERROR] [${requestId}] ${method} ${path} -> ${status} (${code}): ${err.message}`
  );

  // Stack trace logged server-side only (never in response)
  if (err.stack && status >= 500) {
    console.error(`[ERROR STACK] [${requestId}]:\n${err.stack}`);
  }
}

/**
 * Structured error format required by the specification:
 * {
 *   "error": {
 *     "code": "BOOKING_CONFLICT",
 *     "message": "The selected station is no longer available.",
 *     "requestId": "..."
 *   }
 * }
 */
export interface StructuredErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: any;
  };
  // Backward compatibility fields for legacy clients/tests
  code: string;
  message: string;
  requestId: string;
  details?: any;
  errors?: any;
}

/**
 * Formats a safe user-facing error response.
 * In production, strictly ensures no stack traces, SQL queries, database URLs, filesystem paths, or secrets leak.
 */
export function formatErrorResponse(
  err: any,
  requestId: string,
  isProduction: boolean
): { status: number; payload: StructuredErrorPayload } {
  // 1. Database unavailable error detection
  if (isDatabaseUnavailableError(err)) {
    const code = "DATABASE_UNAVAILABLE";
    const message = "Database service is temporarily unavailable. Please try again shortly.";
    return {
      status: 503,
      payload: {
        error: { code, message, requestId },
        code,
        message,
        requestId,
      },
    };
  }

  // 2. Zod validation errors
  if (err instanceof z.ZodError || err.name === "ZodError") {
    const code = "VALIDATION_ERROR";
    const message = "Request validation failed. Please check your input.";
    const errors = err.errors || err.issues;
    return {
      status: 400,
      payload: {
        error: { code, message, requestId, details: errors },
        code,
        message,
        requestId,
        errors,
      },
    };
  }

  // 3. PostgreSQL constraint violations
  const pgCode = err.code || err.cause?.code;
  if (pgCode === "23P01") {
    // Exclusion constraint violation (booking conflict)
    const code = "BOOKING_CONFLICT";
    const message = "The selected station is no longer available for the requested time slot.";
    return {
      status: 409,
      payload: {
        error: { code, message, requestId },
        code,
        message,
        requestId,
      },
    };
  }

  if (pgCode === "23505") {
    // Unique constraint violation
    const code = "RESOURCE_CONFLICT";
    const message = "A resource with the specified identifier or unique attribute already exists.";
    return {
      status: 409,
      payload: {
        error: { code, message, requestId },
        code,
        message,
        requestId,
      },
    };
  }

  if (pgCode === "23503") {
    // Foreign key violation
    const code = "INVALID_REFERENCE";
    const message = "The referenced resource does not exist.";
    return {
      status: 400,
      payload: {
        error: { code, message, requestId },
        code,
        message,
        requestId,
      },
    };
  }

  // 4. Determine status code
  let status = typeof err.status === "number" ? err.status : (typeof err.statusCode === "number" ? err.statusCode : 500);
  if (status < 400 || status > 599) {
    status = 500;
  }

  // 5. Determine error code
  let code: string;
  if (err.code && typeof err.code === "string" && !containsSensitiveData(err.code)) {
    code = err.code;
  } else if (err instanceof AppError) {
    code = err.code;
  } else {
    switch (status) {
      case 400: code = "BAD_REQUEST"; break;
      case 401: code = "UNAUTHORIZED"; break;
      case 403: code = "FORBIDDEN"; break;
      case 404: code = "NOT_FOUND"; break;
      case 405: code = "METHOD_NOT_ALLOWED"; break;
      case 409: code = "CONFLICT"; break;
      case 422: code = "UNPROCESSABLE_ENTITY"; break;
      case 429: code = "RATE_LIMITED"; break;
      case 503: code = "DATABASE_UNAVAILABLE"; break;
      default: code = "INTERNAL_SERVER_ERROR"; break;
    }
  }

  // 6. User-facing safe message calculation
  let userMessage: string;
  const rawMessage = (err instanceof AppError && err.userFacingMessage)
    ? err.userFacingMessage
    : String(err.message || "");

  // If rawMessage leaks SQL, filesystem paths, connection strings, or secrets: ALWAYS redact!
  if (containsSensitiveData(rawMessage)) {
    if (status >= 500) {
      userMessage = "An unexpected error occurred. Please contact support with your request ID.";
    } else {
      userMessage = "The request could not be processed due to invalid parameters.";
    }
  } else if (status >= 500 && isProduction && !(err instanceof AppError && err.isOperational && err.userFacingMessage)) {
    // In production, unhandled 500 errors get generic user-friendly messages
    userMessage = "An unexpected error occurred. Please contact support with your request ID.";
  } else if (rawMessage && rawMessage.trim().length > 0) {
    userMessage = rawMessage;
  } else {
    userMessage = status >= 500 ? "Internal Server Error" : "Bad Request";
  }

  return {
    status,
    payload: {
      error: {
        code,
        message: userMessage,
        requestId,
        details: isProduction ? undefined : err.details,
      },
      code,
      message: userMessage,
      requestId,
      details: isProduction ? undefined : err.details,
    },
  };
}

/**
 * Centralized Express Error Handling Middleware.
 * Catches all synchronous and asynchronous errors forwarded to next(err).
 * Guarantees safe responses without leaking stack traces, SQL, connection strings, or secrets.
 */
export function errorHandlerMiddleware(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // If response has already started sending, delegate to Express built-in handler
  if (res.headersSent) {
    return next(err);
  }

  const requestId = (req as any).requestId || (res.getHeader("X-Request-Id") as string) || generateRequestId();
  res.setHeader("X-Request-Id", requestId);

  // Log internal error server-side with sanitized inputs and correlation ID
  logInternalError(err, req, requestId);

  const isProduction = config.isProduction || req.app.get("env") === "production";
  const { status, payload } = formatErrorResponse(err, requestId, isProduction);

  res.status(status).json(payload);
}

/**
 * Catch-all 404 handler for unhandled API routes.
 */
export function notFoundHandler(req: Request, res: Response) {
  const requestId = (req as any).requestId || (res.getHeader("X-Request-Id") as string) || generateRequestId();
  res.setHeader("X-Request-Id", requestId);

  const code = "NOT_FOUND";
  const message = `Route '${req.method} ${req.path}' not found`;

  res.status(404).json({
    error: {
      code,
      message,
      requestId,
    },
    code,
    message,
    requestId,
  });
}
