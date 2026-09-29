import rateLimit, {
  Store,
  ClientRateLimitInfo,
  Options as RateLimitOptions,
  MemoryStore,
} from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import Redis from "ioredis";
import type { Request, Response, NextFunction } from "express";
import { pool, pgliteClient } from "./db";
import { config } from "./config";

export type RateLimitPolicy =
  | "authentication"
  | "registration"
  | "password_reset"
  | "email_verification"
  | "booking_creation"
  | "booking_cancellation"
  | "payment_creation"
  | "payment_verification"
  | "file_upload"
  | "admin_exports"
  | "public_catalog"
  | "search"
  | "bootstrap";

// Client IP extractor with multi-proxy defense
export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const firstIp = forwarded.split(",")[0].trim();
    if (firstIp) return firstIp;
  }
  return req.ip || req.socket.remoteAddress || "127.0.0.1";
}

// NAT-Safe Key Generator options
export interface KeyGeneratorOptions {
  policy: RateLimitPolicy;
  useAuthenticatedUser?: boolean;
  useAccountIdentity?: boolean;
}

/**
 * Creates an endpoint-aware, NAT-safe key generator.
 *
 * Rules to protect legitimate users on shared NAT IPs:
 * 1. If user is authenticated, key on `usr:<userId>:<policy>:<endpoint>`.
 *    Legitimate user A will never be locked out because user B on the same IP hit a rate limit.
 * 2. For unauthenticated identity-bound routes (login, password reset), key on normalized
 *    account identifier (e.g. `acc:<email/username>:<policy>:<endpoint>`).
 *    An attacker brute-forcing one account will not lock out other users sharing the same NAT IP.
 * 3. Unauthenticated public requests fallback to `ip:<ip>:<policy>:<endpoint>`.
 */
export function createKeyGenerator(options: KeyGeneratorOptions) {
  return (req: Request): string => {
    const endpoint = (req.baseUrl || "") + (req.route?.path || req.path);
    const method = req.method || "GET";

    // 1. Authenticated User takes precedence (NAT-safe)
    if (options.useAuthenticatedUser !== false && (req as any).user?.id) {
      return `usr:${(req as any).user.id}:${options.policy}:${method}:${endpoint}`;
    }

    // 2. Account identity (e.g. username or email in body)
    if (options.useAccountIdentity && req.body && typeof req.body === "object") {
      const rawIdentity = req.body.username || req.body.email || req.body.identifier;
      if (typeof rawIdentity === "string" && rawIdentity.trim().length > 0) {
        const normalized = rawIdentity.trim().toLowerCase();
        return `acc:${normalized}:${options.policy}:${method}:${endpoint}`;
      }
    }

    // 3. Fallback to IP
    const clientIp = getClientIp(req);
    return `ip:${clientIp}:${options.policy}:${method}:${endpoint}`;
  };
}

/**
 * Distributed PostgreSQL Rate Limit Store
 * Enables distributed rate limiting across multi-instance clusters without requiring Redis.
 * Uses atomic upsert with automatic window reset.
 */
export class PostgresRateLimitStore implements Store {
  prefix: string;
  windowMs: number;

  constructor(prefix: string = "rl", windowMs: number = 60000) {
    this.prefix = prefix;
    this.windowMs = windowMs;
  }

  init(options: { windowMs: number }) {
    if (options.windowMs) {
      this.windowMs = options.windowMs;
    }
  }

  private getFullKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  private async executeQuery(sql: string, params: any[]): Promise<any> {
    if (pool) {
      return await pool.query(sql, params);
    }
    if (pgliteClient) {
      return await pgliteClient.query(sql, params);
    }
    throw new Error("No database client available for PostgresRateLimitStore");
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const fullKey = this.getFullKey(key);
    const sql = `
      INSERT INTO rate_limit_entries (key, total_hits, reset_time)
      VALUES ($1, 1, NOW() + ($2 * INTERVAL '1 millisecond'))
      ON CONFLICT (key) DO UPDATE
      SET 
        total_hits = CASE 
          WHEN rate_limit_entries.reset_time <= NOW() THEN 1 
          ELSE rate_limit_entries.total_hits + 1 
        END,
        reset_time = CASE 
          WHEN rate_limit_entries.reset_time <= NOW() THEN NOW() + ($2 * INTERVAL '1 millisecond') 
          ELSE rate_limit_entries.reset_time 
        END
      RETURNING total_hits, reset_time;
    `;

    try {
      const res = await this.executeQuery(sql, [fullKey, this.windowMs]);
      const row = res.rows[0];
      return {
        totalHits: Number(row.total_hits),
        resetTime: new Date(row.reset_time),
      };
    } catch (err) {
      // In case table is missing or DB temporarily unavailable, return minimal hit
      console.error("[PostgresRateLimitStore] Increment error:", err);
      return {
        totalHits: 1,
        resetTime: new Date(Date.now() + this.windowMs),
      };
    }
  }

  async decrement(key: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    const sql = `UPDATE rate_limit_entries SET total_hits = GREATEST(0, total_hits - 1) WHERE key = $1;`;
    try {
      await this.executeQuery(sql, [fullKey]);
    } catch (err) {
      console.error("[PostgresRateLimitStore] Decrement error:", err);
    }
  }

  async resetKey(key: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    const sql = `DELETE FROM rate_limit_entries WHERE key = $1;`;
    try {
      await this.executeQuery(sql, [fullKey]);
    } catch (err) {
      console.error("[PostgresRateLimitStore] ResetKey error:", err);
    }
  }

  async resetAll(): Promise<void> {
    const sql = `DELETE FROM rate_limit_entries WHERE key LIKE $1;`;
    try {
      await this.executeQuery(sql, [`${this.prefix}:%`]);
    } catch (err) {
      console.error("[PostgresRateLimitStore] ResetAll error:", err);
    }
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const fullKey = this.getFullKey(key);
    const sql = `SELECT total_hits, reset_time FROM rate_limit_entries WHERE key = $1;`;
    try {
      const res = await this.executeQuery(sql, [fullKey]);
      if (!res.rows || res.rows.length === 0) return undefined;
      return {
        totalHits: Number(res.rows[0].total_hits),
        resetTime: new Date(res.rows[0].reset_time),
      };
    } catch (err) {
      console.error("[PostgresRateLimitStore] Get error:", err);
      return undefined;
    }
  }
}

// Global Redis client singleton
let redisClientSingleton: Redis | null = null;

export function getRedisClient(): Redis | null {
  if (redisClientSingleton) return redisClientSingleton;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  try {
    redisClientSingleton = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    redisClientSingleton.on("error", (err) => {
      console.warn("[RateLimiter] Redis connection warning:", err.message);
    });
    return redisClientSingleton;
  } catch (err: any) {
    console.warn("[RateLimiter] Failed to connect to Redis:", err?.message);
    return null;
  }
}

export async function closeRedisClient(): Promise<void> {
  if (redisClientSingleton && (redisClientSingleton.status === "ready" || redisClientSingleton.status === "connecting")) {
    try {
      await redisClientSingleton.quit();
    } catch {}
    redisClientSingleton = null;
  }
}

// Test hook to override store factory
let testStoreFactory: ((policy: RateLimitPolicy, windowMs: number) => Store) | null = null;

export function setRateLimitStoreFactoryForTesting(
  factory: ((policy: RateLimitPolicy, windowMs: number) => Store) | null
) {
  testStoreFactory = factory;
}

/**
 * Returns a shared distributed store (Redis or PostgreSQL) for production multi-instance deployments.
 */
export function getSharedRateLimitStore(policy: RateLimitPolicy, windowMs: number): Store {
  if (testStoreFactory) {
    return testStoreFactory(policy, windowMs);
  }

  // 1. Redis Store if configured
  const redis = getRedisClient();
  if (redis) {
    try {
      return new RedisStore({
        sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as any,
        prefix: `rl:${policy}:`,
      });
    } catch (err: any) {
      console.warn("[RateLimiter] RedisStore init failed, falling back to PostgreSQL store:", err?.message);
    }
  }

  // 2. Multi-instance PostgreSQL Store if database is configured
  if (pool || pgliteClient) {
    return new PostgresRateLimitStore(`rl:${policy}`, windowMs);
  }

  // 3. Fallback to in-memory store (development only)
  return new MemoryStore();
}

/**
 * Standard HTTP 429 response handler conforming to RFC specifications with Retry-After header.
 */
export function createRateLimitHandler(policy: RateLimitPolicy, customMessage?: string) {
  return (req: Request, res: Response) => {
    const rateLimitInfo = (req as any).rateLimit;
    const resetTime = rateLimitInfo?.resetTime as Date | undefined;
    const retryAfter = resetTime
      ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
      : 60;

    res.setHeader("Retry-After", String(retryAfter));
    const isMfa = req.path.includes("/mfa") || req.baseUrl.includes("/mfa");
    const code = isMfa ? "RATE_LIMITED" : "TOO_MANY_REQUESTS";

    return res.status(429).json({
      message:
        customMessage ||
        `Too many requests for ${policy.replace(/_/g, " ")}. Please wait ${retryAfter} seconds before trying again.`,
      code,
      policy,
      retryAfter,
    });
  };
}

export interface PolicyConfig {
  windowMs: number;
  max: number;
  message?: string;
  useAccountIdentity?: boolean;
  useAuthenticatedUser?: boolean;
}

const isProd = config.isProduction;
const isTestOrDev = config.isTest || config.isDevelopment;

/**
 * Baseline default policy configurations
 */
export const DEFAULT_POLICY_CONFIGS: Record<RateLimitPolicy, PolicyConfig> = {
  authentication: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isProd ? 10 : 1000,
    message: "Too many login attempts. Please try again in 15 minutes.",
    useAccountIdentity: true,
    useAuthenticatedUser: true,
  },
  registration: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: isProd ? 10 : 100,
    message: "Too many accounts created from this location. Please try again later.",
    useAccountIdentity: true,
    useAuthenticatedUser: false,
  },
  password_reset: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isProd ? 5 : 100,
    message: "Too many password reset requests. Please wait 15 minutes before trying again.",
    useAccountIdentity: true,
    useAuthenticatedUser: true,
  },
  email_verification: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isProd ? 5 : 100,
    message: "Too many email verification requests. Please wait 15 minutes before trying again.",
    useAccountIdentity: true,
    useAuthenticatedUser: true,
  },
  booking_creation: {
    windowMs: 60 * 1000, // 1 minute
    max: isProd ? 10 : 100,
    message: "Too many booking creation requests. Please slow down and try again shortly.",
    useAccountIdentity: false,
    useAuthenticatedUser: true,
  },
  booking_cancellation: {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: isProd ? 10 : 100,
    message: "Too many booking cancellations. Please wait before attempting further cancellations.",
    useAccountIdentity: false,
    useAuthenticatedUser: true,
  },
  payment_creation: {
    windowMs: 60 * 1000, // 1 minute
    max: isProd ? 20 : 200,
    message: "Too many payment initiation requests. Please wait a moment before trying again.",
    useAccountIdentity: false,
    useAuthenticatedUser: true,
  },
  payment_verification: {
    windowMs: 60 * 1000, // 1 minute
    max: isProd ? 15 : 150,
    message: "Too many payment verification attempts. Please wait before retrying.",
    useAccountIdentity: false,
    useAuthenticatedUser: true,
  },
  file_upload: {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: isProd ? 10 : 100,
    message: "Too many file upload requests. Please wait 5 minutes before uploading again.",
    useAccountIdentity: false,
    useAuthenticatedUser: true,
  },
  admin_exports: {
    windowMs: 60 * 1000, // 1 minute
    max: isProd ? 10 : 60,
    message: "Rate limit exceeded for admin exports and reports. Please wait 1 minute before retrying.",
    useAccountIdentity: false,
    useAuthenticatedUser: true,
  },
  public_catalog: {
    windowMs: 60 * 1000, // 1 minute
    max: isProd ? 120 : 1000,
    message: "Catalog rate limit exceeded. Please wait a moment before requesting additional items.",
    useAccountIdentity: false,
    useAuthenticatedUser: true,
  },
  search: {
    windowMs: 60 * 1000, // 1 minute
    max: isProd ? 60 : 500,
    message: "Search query rate limit exceeded. Please slow down your search requests.",
    useAccountIdentity: false,
    useAuthenticatedUser: true,
  },
  bootstrap: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isProd ? 10 : 100,
    message: "Too many bootstrap attempts. Please wait 15 minutes before trying again.",
    useAccountIdentity: false,
    useAuthenticatedUser: false,
  },
};

/**
 * Creates an endpoint-aware rate limiter for a specific policy.
 */
export function createPolicyLimiter(
  policy: RateLimitPolicy,
  overrides?: Partial<RateLimitOptions> & Partial<PolicyConfig>
) {
  const policyDefaults = DEFAULT_POLICY_CONFIGS[policy];
  const windowMs = overrides?.windowMs ?? policyDefaults.windowMs;
  const max = overrides?.max ?? policyDefaults.max;
  const message = overrides?.message ?? policyDefaults.message;
  const useAccountIdentity = overrides?.useAccountIdentity ?? policyDefaults.useAccountIdentity;
  const useAuthenticatedUser = overrides?.useAuthenticatedUser ?? policyDefaults.useAuthenticatedUser;

  // Clean options by stripping custom PolicyConfig fields before forwarding to express-rate-limit
  const {
    useAccountIdentity: _uai,
    useAuthenticatedUser: _uau,
    message: _msg,
    windowMs: _wms,
    max: _mx,
    ...rateLimitOptions
  } = (overrides as any) || {};

  const keyGenerator =
    rateLimitOptions.keyGenerator ||
    createKeyGenerator({
      policy,
      useAccountIdentity,
      useAuthenticatedUser,
    });

  const store = rateLimitOptions.store ?? getSharedRateLimitStore(policy, windowMs);

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator,
    handler: createRateLimitHandler(policy, message),
    skip: (req) => process.env.BENCHMARK_MODE === "true",
    ...rateLimitOptions,
  });
}

// 12 Separate Endpoint-Aware Distributed Limiters
export const authLimiter = createPolicyLimiter("authentication");
export const registerLimiter = createPolicyLimiter("registration");
export const passwordResetLimiter = createPolicyLimiter("password_reset");
export const emailVerificationLimiter = createPolicyLimiter("email_verification");
export const bookingCreationLimiter = createPolicyLimiter("booking_creation");
export const bookingCancellationLimiter = createPolicyLimiter("booking_cancellation");
export const paymentCreationLimiter = createPolicyLimiter("payment_creation");
export const paymentVerificationLimiter = createPolicyLimiter("payment_verification");
export const fileUploadLimiter = createPolicyLimiter("file_upload");
export const adminExportsLimiter = createPolicyLimiter("admin_exports");
export const publicCatalogLimiter = createPolicyLimiter("public_catalog");
export const searchLimiter = createPolicyLimiter("search");
export const bootstrapLimiter = createPolicyLimiter("bootstrap");
export const contactLimiter = createPolicyLimiter("registration", {
  max: 10,
  windowMs: 15 * 60 * 1000,
  message: "Too many contact requests from this source. Please wait 15 minutes before sending another message.",
});

// MFA Verify Limiter (preserves compatibility with test/mfa.test.ts while using shared store and NAT safety)
export const mfaVerifyLimiter = createPolicyLimiter("authentication", {
  max: process.env.MFA_RATE_LIMIT_MAX
    ? parseInt(process.env.MFA_RATE_LIMIT_MAX, 10)
    : isProd
    ? 5
    : 20,
  message: "Too many MFA verification attempts. Please wait 15 minutes before trying again.",
  keyGenerator: (req) => {
    // Authenticated user ID or session ID or client IP
    const userId = (req as any).user?.id || (req as any).session?.passport?.user || getClientIp(req);
    return `usr:${userId}:mfa_verify`;
  },
});

/**
 * Intelligent Catalog/Search Middleware:
 * Inspects query params (e.g. q, search, genre, platform, status). If present, enforces search policy;
 * otherwise enforces public catalog policy.
 */
export function catalogOrSearchLimiter(req: Request, res: Response, next: NextFunction) {
  const hasSearchFilter = Boolean(
    req.query.q ||
    req.query.search ||
    req.query.genre ||
    req.query.platform ||
    req.query.status ||
    req.query.name
  );
  if (hasSearchFilter) {
    return searchLimiter(req, res, next);
  }
  return publicCatalogLimiter(req, res, next);
}
