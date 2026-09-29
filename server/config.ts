/**
 * Configuration module with strict environment separation and fail-closed validation.
 *
 * Environments:
 * - development: Local developer workflow; optional in-memory fallback with prominent warning.
 * - test: Automated test suites; allows isolated test database engines.
 * - staging: Pre-production verification; strictly fails closed (production rules apply).
 * - production: Live production; strictly fails closed, zero in-memory fallback.
 */

export type AppEnvironment = "development" | "test" | "staging" | "production";

export interface GoogleOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackUrl?: string;
}

export interface DatabasePoolConfig {
  max: number;
  min: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  maxUses: number;
}

export interface CorsConfig {
  developmentOrigins: string[];
  stagingOrigins: string[];
  productionOrigins: string[];
  activeAllowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  maxAge: number;
}

export const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:5001",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:5001",
  "http://127.0.0.1:5173",
];

export const DEFAULT_STAGING_ORIGINS = [
  "https://staging.gaminglounge.com",
  "https://app.staging.gaminglounge.com",
  "https://admin.staging.gaminglounge.com",
];

export const DEFAULT_PROD_ORIGINS = [
  "https://gaminglounge.com",
  "https://app.gaminglounge.com",
  "https://admin.gaminglounge.com",
];

export const REQUIRED_CORS_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
];

export const REQUIRED_CORS_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-CSRF-Token",
  "X-Requested-With",
  "Accept",
  "Idempotency-Key",
  "X-Request-Id",
  "X-Correlation-Id",
];

export const EXPOSED_CORS_HEADERS = [
  "X-CSRF-Token",
  "X-Next-Cursor",
  "X-Has-More",
  "X-Pagination-Limit",
  "Retry-After",
  "Idempotent-Replayed",
  "X-Request-Id",
  "X-Correlation-Id",
];

export function parseOriginList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        const u = new URL(o);
        return u.origin.toLowerCase();
      } catch {
        return o.toLowerCase();
      }
    });
}

export function getPoolConfigForEnv(env: AppEnvironment): DatabasePoolConfig {
  const isProduction = env === "production";
  const isStaging = env === "staging";
  return {
    max: isProduction ? 20 : isStaging ? 10 : 5,
    min: isProduction ? 2 : isStaging ? 1 : 0,
    idleTimeoutMillis: isProduction || isStaging ? 30000 : 10000,
    connectionTimeoutMillis: 5000,
    maxUses: isProduction || isStaging ? 7500 : 5000,
  };
}

export interface AppConfig {
  env: AppEnvironment;
  isProduction: boolean;
  isStaging: boolean;
  isTest: boolean;
  isDevelopment: boolean;
  failClosed: boolean;
  allowInMemoryFallback: boolean;
  databaseUrl?: string;
  sessionSecret: string;
  port: number;
  pool: DatabasePoolConfig;
  cors: CorsConfig;
  google: GoogleOAuthConfig;
  auth: {
    enforceStaffMfa: boolean;
  };
}

import {
  secretManager,
  redactSecret,
  BANNED_SECRET_PATTERNS,
} from "./secret-manager";

export const INSECURE_DEFAULT_SECRETS = new Set([
  "r3pl1t_s3cr3t_k3y",
  "your_secure_session_secret_key_here",
  "dev_session_secret_key_12345",
  "secret",
  "changeme",
  "password",
  "admin",
  "admin123",
  "employee123",
  "changeme_admin123",
  "changeme_employee123",
  "default_secret",
  "prod_webhook_secret_key_v1",
]);

/**
 * Sanitizes a database connection URL so that credentials are never leaked in logs or error messages.
 */
export function sanitizeDatabaseUrl(url?: string): string {
  if (!url) return "<not set>";
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "******";
    }
    return parsed.toString();
  } catch {
    return url.replace(/:\/\/[^@]+@/, "://***:***@");
  }
}

/**
 * Detects the normalized application environment from process.env.
 */
export function getEnvironment(rawEnv?: string): AppEnvironment {
  const env = (rawEnv || process.env.NODE_ENV || "development").trim().toLowerCase();
  if (env === "production" || env === "prod") return "production";
  if (env === "staging" || env === "stage") return "staging";
  if (env === "test") return "test";
  return "development";
}

export class ConfigurationError extends Error {
  public readonly code: string;
  constructor(message: string, code = "CONFIG_ERROR") {
    super(message);
    this.name = "ConfigurationError";
    this.code = code;
  }
}

/**
 * Validates configuration strictly according to the active environment.
 * In production and staging, any missing required variable causes a fatal fail-fast error.
 */
export function validateStartupConfig(overrides?: {
  env?: string;
  databaseUrl?: string;
  sessionSecret?: string;
  port?: string | number;
  googleClientId?: string;
  googleClientSecret?: string;
  googleCallbackUrl?: string;
  enforceStaffMfa?: boolean;
  devOrigins?: string | string[];
  stagingOrigins?: string | string[];
  prodOrigins?: string | string[];
}): AppConfig {
  const env = getEnvironment(overrides?.env);
  const isProduction = env === "production";
  const isStaging = env === "staging";
  const isTest = env === "test";
  const isDevelopment = env === "development";

  const failClosed = isProduction || isStaging;
  const allowInMemoryFallback = isDevelopment || isTest;

  const rawDbUrl = overrides?.databaseUrl !== undefined ? overrides.databaseUrl : process.env.DATABASE_URL;
  const databaseUrl = rawDbUrl?.trim() || undefined;

  const rawSecret = overrides?.sessionSecret !== undefined ? overrides.sessionSecret : process.env.SESSION_SECRET;
  const sessionSecret = rawSecret?.trim() || "";

  const portVal = overrides?.port !== undefined ? overrides.port : process.env.PORT;
  const port = typeof portVal === "number" ? portVal : parseInt(portVal || "5001", 10);

  // FAIL-CLOSED VALIDATION: Production & Staging
  if (failClosed) {
    if (!databaseUrl) {
      const safeErrorMsg = `[FATAL CONFIGURATION ERROR] DATABASE_URL is required in ${env} environment. Production configuration fails closed. In-memory storage (MemStorage/PGlite) fallback is strictly forbidden.`;
      console.error(safeErrorMsg);
      throw new ConfigurationError(safeErrorMsg, "DATABASE_URL_REQUIRED");
    }

    const isValidPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
    if (!isValidPostgres) {
      const safeErrorMsg = `[FATAL CONFIGURATION ERROR] DATABASE_URL must be a valid PostgreSQL connection string starting with postgres:// or postgresql://. Received: ${sanitizeDatabaseUrl(databaseUrl)}`;
      console.error(safeErrorMsg);
      throw new ConfigurationError(safeErrorMsg, "DATABASE_URL_INVALID");
    }

    if (databaseUrl.includes(":password@") || databaseUrl.includes("user:password@")) {
      const safeErrorMsg = `[FATAL CONFIGURATION ERROR] DATABASE_URL in ${env} contains placeholder dummy credentials ('user:password'). Please configure valid production database credentials.`;
      console.error(safeErrorMsg);
      throw new ConfigurationError(safeErrorMsg, "DATABASE_URL_DUMMY");
    }

    const minSecretLength = 16;
    if (!sessionSecret || sessionSecret.length < minSecretLength || INSECURE_DEFAULT_SECRETS.has(sessionSecret)) {
      const safeErrorMsg = `[FATAL CONFIGURATION ERROR] SESSION_SECRET must be set to a secure, non-default string of at least ${minSecretLength} characters in ${env} environment.`;
      console.error(safeErrorMsg);
      throw new ConfigurationError(safeErrorMsg, "SESSION_SECRET_INSECURE");
    }

    // Cloudinary Credentials Validation
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
    const cloudKey = process.env.CLOUDINARY_API_KEY?.trim();
    const cloudSecret = process.env.CLOUDINARY_API_SECRET?.trim();
    if (cloudName || cloudKey || cloudSecret) {
      if (!cloudName || !cloudKey || !cloudSecret) {
        const safeErrorMsg = `[FATAL CONFIGURATION ERROR] Incomplete Cloudinary configuration in ${env}. All of CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET must be provided.`;
        console.error(safeErrorMsg);
        throw new ConfigurationError(safeErrorMsg, "CLOUDINARY_CONFIG_INCOMPLETE");
      }
      if (cloudName === "your_cloud_name" || cloudKey === "your_api_key" || cloudSecret === "your_api_secret") {
        const safeErrorMsg = `[FATAL CONFIGURATION ERROR] Placeholder Cloudinary credentials detected in ${env}. Please configure valid secrets or remove them.`;
        console.error(safeErrorMsg);
        throw new ConfigurationError(safeErrorMsg, "CLOUDINARY_CONFIG_DUMMY");
      }
    }

    // Payment Webhook Secret Validation
    const paymentWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET?.trim();
    if (paymentWebhookSecret && (paymentWebhookSecret.length < 16 || INSECURE_DEFAULT_SECRETS.has(paymentWebhookSecret))) {
      const safeErrorMsg = `[FATAL CONFIGURATION ERROR] PAYMENT_WEBHOOK_SECRET in ${env} must be a secure, non-default string of at least 16 characters.`;
      console.error(safeErrorMsg);
      throw new ConfigurationError(safeErrorMsg, "PAYMENT_WEBHOOK_SECRET_INSECURE");
    }

    // Initial Admin Bootstrap Token Validation (if set)
    const bootstrapToken = process.env.INITIAL_ADMIN_BOOTSTRAP_TOKEN?.trim();
    if (bootstrapToken && (bootstrapToken.length < 16 || BANNED_SECRET_PATTERNS.some((p) => bootstrapToken.toLowerCase().includes(p)))) {
      const safeErrorMsg = `[FATAL CONFIGURATION ERROR] INITIAL_ADMIN_BOOTSTRAP_TOKEN in ${env} must be at least 16 characters long and non-predictable.`;
      console.error(safeErrorMsg);
      throw new ConfigurationError(safeErrorMsg, "BOOTSTRAP_TOKEN_INSECURE");
    }
  }

  // Development mode notices
  if (isDevelopment && !databaseUrl) {
    console.warn(
      `[DEV-ONLY NOTICE] DATABASE_URL is not set. Running in local development mode with isolated engine. Data will NOT persist across server restarts. Do NOT use this configuration in production.`,
    );
  }

  const googleClientId = overrides?.googleClientId !== undefined ? overrides.googleClientId : process.env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = overrides?.googleClientSecret !== undefined ? overrides.googleClientSecret : process.env.GOOGLE_CLIENT_SECRET?.trim();
  const googleCallbackUrl = overrides?.googleCallbackUrl !== undefined ? overrides.googleCallbackUrl : process.env.GOOGLE_CALLBACK_URL?.trim();

  const enforceStaffMfa = overrides?.enforceStaffMfa !== undefined
    ? overrides.enforceStaffMfa
    : (process.env.ENFORCE_STAFF_MFA === "true" || isProduction);

  // CORS Configuration: Environment Separation & Fail-Closed Validation
  const rawDev = overrides?.devOrigins !== undefined
    ? (Array.isArray(overrides.devOrigins) ? overrides.devOrigins.join(",") : overrides.devOrigins)
    : (process.env.DEV_ALLOWED_ORIGINS || process.env.DEVELOPMENT_ORIGINS);
  const devOrigins = rawDev ? parseOriginList(rawDev) : [...DEFAULT_DEV_ORIGINS];

  const rawStaging = overrides?.stagingOrigins !== undefined
    ? (Array.isArray(overrides.stagingOrigins) ? overrides.stagingOrigins.join(",") : overrides.stagingOrigins)
    : (process.env.STAGING_ALLOWED_ORIGINS || process.env.STAGING_ORIGINS);
  const stagingOrigins = rawStaging ? parseOriginList(rawStaging) : [...DEFAULT_STAGING_ORIGINS];

  const rawProd = overrides?.prodOrigins !== undefined
    ? (Array.isArray(overrides.prodOrigins) ? overrides.prodOrigins.join(",") : overrides.prodOrigins)
    : (process.env.PRODUCTION_ALLOWED_ORIGINS || process.env.PRODUCTION_ORIGINS || process.env.ALLOWED_ORIGINS);
  const productionOrigins = rawProd ? parseOriginList(rawProd) : [...DEFAULT_PROD_ORIGINS];

  let activeAllowedOrigins: string[];
  if (isProduction) {
    activeAllowedOrigins = productionOrigins;
  } else if (isStaging) {
    activeAllowedOrigins = stagingOrigins;
  } else {
    activeAllowedOrigins = devOrigins;
  }

  // FAIL-CLOSED CORS VALIDATION: Production & Staging
  if (failClosed) {
    if (activeAllowedOrigins.length === 0) {
      const safeErrorMsg = `[FATAL CONFIGURATION ERROR] At least one explicit CORS origin is required in ${env} environment.`;
      console.error(safeErrorMsg);
      throw new ConfigurationError(safeErrorMsg, "CORS_ORIGIN_REQUIRED");
    }

    for (const origin of activeAllowedOrigins) {
      if (origin === "*") {
        const safeErrorMsg = `[FATAL CONFIGURATION ERROR] Wildcard CORS origin '*' is strictly prohibited in ${env} environment. Access-Control-Allow-Origin: * must never be used with credentials.`;
        console.error(safeErrorMsg);
        throw new ConfigurationError(safeErrorMsg, "CORS_ORIGIN_WILDCARD_FORBIDDEN");
      }
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== "https:") {
          const safeErrorMsg = `[FATAL CONFIGURATION ERROR] CORS origin in ${env} must use HTTPS. Insecure HTTP origin rejected: ${origin}`;
          console.error(safeErrorMsg);
          throw new ConfigurationError(safeErrorMsg, "CORS_ORIGIN_INSECURE");
        }
        if (parsed.pathname !== "" && parsed.pathname !== "/") {
          const safeErrorMsg = `[FATAL CONFIGURATION ERROR] CORS origin in ${env} cannot contain a path component. Received: ${origin}`;
          console.error(safeErrorMsg);
          throw new ConfigurationError(safeErrorMsg, "CORS_ORIGIN_INVALID");
        }
      } catch (err: any) {
        if (err instanceof ConfigurationError) throw err;
        const safeErrorMsg = `[FATAL CONFIGURATION ERROR] Malformed CORS origin in ${env}: ${origin}`;
        console.error(safeErrorMsg);
        throw new ConfigurationError(safeErrorMsg, "CORS_ORIGIN_INVALID");
      }
    }
  }

  const cors: CorsConfig = {
    developmentOrigins: devOrigins,
    stagingOrigins,
    productionOrigins,
    activeAllowedOrigins,
    allowedMethods: [...REQUIRED_CORS_METHODS],
    allowedHeaders: [...REQUIRED_CORS_HEADERS],
    exposedHeaders: [...EXPOSED_CORS_HEADERS],
    maxAge: 86400,
  };

  // Connection pool defaults based on deployment topology
  const defaultPoolMax = isProduction ? 20 : isStaging ? 10 : 5;
  const defaultPoolMin = isProduction ? 2 : isStaging ? 1 : 0;
  const defaultIdleTimeout = isProduction || isStaging ? 30000 : 10000;
  const defaultConnTimeout = 5000;
  const defaultMaxUses = isProduction || isStaging ? 7500 : 5000;

  const pool: DatabasePoolConfig = {
    max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : defaultPoolMax,
    min: process.env.DB_POOL_MIN ? parseInt(process.env.DB_POOL_MIN, 10) : defaultPoolMin,
    idleTimeoutMillis: process.env.DB_IDLE_TIMEOUT_MS ? parseInt(process.env.DB_IDLE_TIMEOUT_MS, 10) : defaultIdleTimeout,
    connectionTimeoutMillis: process.env.DB_CONN_TIMEOUT_MS ? parseInt(process.env.DB_CONN_TIMEOUT_MS, 10) : defaultConnTimeout,
    maxUses: process.env.DB_MAX_USES ? parseInt(process.env.DB_MAX_USES, 10) : defaultMaxUses,
  };

  return {
    env,
    isProduction,
    isStaging,
    isTest,
    isDevelopment,
    failClosed,
    allowInMemoryFallback,
    databaseUrl,
    sessionSecret: sessionSecret || (isTest ? "test_session_secret_12345" : "dev_session_secret_key_12345"),
    port: isNaN(port) ? 5001 : port,
    pool,
    cors,
    google: {
      clientId: googleClientId || undefined,
      clientSecret: googleClientSecret || undefined,
      callbackUrl: googleCallbackUrl || undefined,
    },
    auth: {
      enforceStaffMfa,
    },
  };
}

// Current runtime configuration (evaluated dynamically so test overrides work cleanly)
export const config: AppConfig = validateStartupConfig();
