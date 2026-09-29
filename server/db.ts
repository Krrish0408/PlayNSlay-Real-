import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import * as schema from "@shared/schema";

const { Pool } = pg;

export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  email TEXT UNIQUE,
  full_name TEXT,
  phone TEXT,
  avatar_url TEXT,
  membership_tier TEXT DEFAULT 'bronze',
  role TEXT NOT NULL DEFAULT 'member',
  auth_provider TEXT NOT NULL DEFAULT 'local',
  google_id TEXT UNIQUE,
  is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified_at TIMESTAMPTZ,
  email_verification_token_hash TEXT,
  email_verification_token_expires_at TIMESTAMPTZ,
  reset_required BOOLEAN NOT NULL DEFAULT FALSE,
  password_reset_token_hash TEXT,
  password_reset_token_expires_at TIMESTAMPTZ,
  token_version INTEGER NOT NULL DEFAULT 1,
  is_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret TEXT,
  mfa_recovery_codes TEXT,
  mfa_last_used_timestep INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_types (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  hourly_price INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  price_model TEXT NOT NULL DEFAULT 'flat',
  image_url TEXT
);

CREATE TABLE IF NOT EXISTS stations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  game_type_id INTEGER NOT NULL REFERENCES game_types(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL DEFAULT 'main-lounge',
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game_type_id INTEGER REFERENCES game_types(id),
  station_id INTEGER REFERENCES stations(id) ON DELETE SET NULL,
  location_id TEXT NOT NULL DEFAULT 'main-lounge',
  game_title TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  player_count INTEGER NOT NULL DEFAULT 1,
  total_price INTEGER NOT NULL,
  base_price INTEGER,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  final_price INTEGER,
  currency TEXT NOT NULL DEFAULT 'INR',
  pricing_rule TEXT NOT NULL DEFAULT 'standard_v1',
  payment_method TEXT NOT NULL DEFAULT 'offline',
  status TEXT NOT NULL DEFAULT 'Pending',
  booking_ref TEXT NOT NULL,
  employee_id INTEGER,
  timer_started_at TIMESTAMPTZ,
  timer_end_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_station_id ON bookings(station_id);
CREATE INDEX IF NOT EXISTS idx_bookings_location_id ON bookings(location_id);
CREATE INDEX IF NOT EXISTS idx_bookings_start_time ON bookings(start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id_created_at ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY,
  session_id_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_sid_hash ON user_sessions(session_id_hash);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROCESSING',
  status_code INTEGER,
  response_body TEXT,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_user_key ON idempotency_keys(user_id, key);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  platforms TEXT NOT NULL,
  min_players INTEGER NOT NULL DEFAULT 1,
  max_players INTEGER NOT NULL DEFAULT 1,
  genre TEXT,
  image_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'bookings' AND column_name = 'start_time' AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE "bookings" 
      ALTER COLUMN "start_time" TYPE TIMESTAMPTZ USING "start_time" AT TIME ZONE 'UTC',
      ALTER COLUMN "end_time" TYPE TIMESTAMPTZ USING "end_time" AT TIME ZONE 'UTC';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'is_email_verified'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "is_email_verified" BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ;
    ALTER TABLE "users" ADD COLUMN "email_verification_token_hash" TEXT;
    ALTER TABLE "users" ADD COLUMN "email_verification_token_expires_at" TIMESTAMPTZ;
    -- Backfill existing established users as verified
    UPDATE "users" SET "is_email_verified" = TRUE, "email_verified_at" = NOW() WHERE "is_email_verified" IS FALSE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'reset_required'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "reset_required" BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE "users" ADD COLUMN "password_reset_token_hash" TEXT;
    ALTER TABLE "users" ADD COLUMN "password_reset_token_expires_at" TIMESTAMPTZ;
    ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 1;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'auth_provider'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "auth_provider" TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE "users" ADD COLUMN "google_id" TEXT UNIQUE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'is_mfa_enabled'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "is_mfa_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE "users" ADD COLUMN "mfa_secret" TEXT;
    ALTER TABLE "users" ADD COLUMN "mfa_recovery_codes" TEXT;
    ALTER TABLE "users" ADD COLUMN "mfa_last_used_timestep" INTEGER;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'user_sessions'
  ) THEN
    CREATE TABLE "user_sessions" (
      id SERIAL PRIMARY KEY,
      session_id_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_sid_hash ON user_sessions(session_id_hash);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'rate_limit_entries'
  ) THEN
    CREATE TABLE "rate_limit_entries" (
      key TEXT PRIMARY KEY,
      total_hits INTEGER NOT NULL DEFAULT 1,
      reset_time TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_entries_reset_time ON rate_limit_entries(reset_time);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'is_admin'
  ) THEN
    UPDATE "users" SET "role" = 'admin' WHERE "is_admin" = TRUE AND "role" != 'admin';
    ALTER TABLE "users" DROP COLUMN "is_admin";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'bookings' AND column_name = 'base_price'
  ) THEN
    ALTER TABLE "bookings" ADD COLUMN "base_price" INTEGER;
    ALTER TABLE "bookings" ADD COLUMN "discount_amount" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "bookings" ADD COLUMN "final_price" INTEGER;
    ALTER TABLE "bookings" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR';
    ALTER TABLE "bookings" ADD COLUMN "pricing_rule" TEXT NOT NULL DEFAULT 'standard_v1';
    UPDATE "bookings" SET "base_price" = "total_price", "final_price" = "total_price" WHERE "final_price" IS NULL;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_bookings_station_time;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'no_overlapping_station_bookings'
  ) THEN
    ALTER TABLE "bookings"
      ADD CONSTRAINT "no_overlapping_station_bookings"
      EXCLUDE USING gist (
        "station_id" WITH =,
        tstzrange("start_time", "end_time", '[)') WITH &&
      )
      WHERE ("station_id" IS NOT NULL AND "status" NOT IN ('Cancelled', 'Rejected'));
  END IF;
END $$;

-- Purge deprecated inventory and booking_items tables if present from legacy schemas
DROP TABLE IF EXISTS "booking_items" CASCADE;
DROP TABLE IF EXISTS "inventory_items" CASCADE;
DROP TABLE IF EXISTS "inventory" CASCADE;
`;

import { config, ConfigurationError } from "./config";

if ((config.isProduction || config.isStaging) && !config.databaseUrl) {
  const errorMsg = `[FATAL] Cannot initialize database in ${config.env} mode without DATABASE_URL. In-memory storage fallback is disabled.`;
  console.error(errorMsg);
  throw new ConfigurationError(errorMsg, "DATABASE_URL_REQUIRED");
}

export const pool = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      ssl: (config.isProduction || config.isStaging || (config.databaseUrl && (config.databaseUrl.includes("sslmode=require") || config.databaseUrl.includes("neon.tech") || config.databaseUrl.includes("supabase.co"))))
        ? { rejectUnauthorized: false }
        : undefined,
      max: config.pool.max,
      min: config.pool.min,
      idleTimeoutMillis: config.pool.idleTimeoutMillis,
      connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
      maxUses: config.pool.maxUses,
    })
  : undefined;

if (pool) {
  pool.on("error", (err) => {
    console.error("[PostgreSQL Pool Error]", err.message);
  });
}

export function getPoolStats(): {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  max: number;
} | null {
  if (!pool) return null;
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    max: (pool as any).options?.max || config.pool.max,
  };
}

// In-memory fallback engine (PGlite) is ONLY allowed in development and automated testing
export const pgliteClient = pool
  ? undefined
  : config.allowInMemoryFallback
    ? new PGlite({ extensions: { btree_gist } })
    : undefined;

if (!pool && !pgliteClient) {
  const errorMsg = `[FATAL] No database provider available for environment: ${config.env}. In-memory fallback is forbidden in production/staging.`;
  console.error(errorMsg);
  throw new ConfigurationError(errorMsg, "NO_DB_PROVIDER");
}

export const db: any = pool
  ? drizzleNodePg(pool, { schema })
  : drizzlePglite(pgliteClient!, { schema });

let schemaInitialized = false;
let initPromise: Promise<void> | null = null;

export async function initDbSchema(): Promise<void> {
  if (schemaInitialized) return;
  if (!initPromise) {
    initPromise = (async () => {
      if (pool) {
        await pool.query(SCHEMA_SQL);
      } else if (pgliteClient) {
        try {
          await pgliteClient.exec("SET max_stack_depth = '100MB';");
        } catch {
          // ignore if unsupported
        }
        await pgliteClient.exec(SCHEMA_SQL);
      }
      schemaInitialized = true;
    })();
  }
  return initPromise;
}

export async function checkDatabaseHealth(): Promise<{
  healthy: boolean;
  latencyMs?: number;
  pool?: { totalCount: number; idleCount: number; waitingCount: number; max: number };
  error?: string;
}> {
  const start = Date.now();
  const poolStats = getPoolStats() || undefined;
  try {
    if (pool) {
      await pool.query("SELECT 1;");
      return { healthy: true, latencyMs: Date.now() - start, pool: poolStats };
    }
    if (pgliteClient) {
      await pgliteClient.exec("SELECT 1;");
      return { healthy: true, latencyMs: Date.now() - start };
    }
    return { healthy: false, latencyMs: Date.now() - start, pool: poolStats, error: "No database client configured" };
  } catch (err: any) {
    return { healthy: false, latencyMs: Date.now() - start, pool: poolStats, error: err?.message || "Health check query failed" };
  }
}

// Auto-initialize schema
initDbSchema().catch((err) => {
  console.error("Failed to initialize database schema:", err);
});

export function isBookingConflictError(err: any): boolean {
  if (!err) return false;
  const target = err.cause || err;
  const code = target.code || err.code;
  const constraint = target.constraint || err.constraint;
  const msg = String(target.message || err.message || "");

  // PostgreSQL SQLSTATE 23P01: exclusion_violation
  if (code === "23P01") return true;
  // PostgreSQL unique violation: 23505
  if (code === "23505") return true;
  // Check constraint name
  if (constraint && String(constraint).includes("no_overlapping_station_bookings")) {
    return true;
  }
  if (
    msg.includes("exclusion constraint") ||
    msg.includes("violates exclusion constraint") ||
    msg.includes("conflicting key value violates exclusion constraint") ||
    msg.includes("no_overlapping_station_bookings")
  ) {
    return true;
  }
  if (
    msg.includes("already booked for this time") ||
    msg.includes("fully booked for the selected time slot") ||
    msg.includes("Selected station is unavailable") ||
    msg.includes("No active stations available")
  ) {
    return true;
  }
  return false;
}
