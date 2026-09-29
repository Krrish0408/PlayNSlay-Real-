-- Migration: 0003_add_production_scale_indexes
-- Description: Add high-frequency performance indexes on bookings, audit logs, sessions, and idempotency keys

-- 1. Bookings high-frequency query indexes
CREATE INDEX IF NOT EXISTS "idx_bookings_user_id" ON "bookings"("user_id");
CREATE INDEX IF NOT EXISTS "idx_bookings_station_id" ON "bookings"("station_id");
CREATE INDEX IF NOT EXISTS "idx_bookings_start_time" ON "bookings"("start_time");
CREATE INDEX IF NOT EXISTS "idx_bookings_status" ON "bookings"("status");
CREATE INDEX IF NOT EXISTS "idx_bookings_created_at" ON "bookings"("created_at" DESC);

-- 2. Audit logs security and user event tracking indexes
CREATE INDEX IF NOT EXISTS "idx_audit_logs_user_id_created_at" ON "audit_logs"("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_audit_logs_created_at" ON "audit_logs"("created_at" DESC);

-- 3. Session lookup and revocation indexes
CREATE INDEX IF NOT EXISTS "idx_user_sessions_sid_hash" ON "user_sessions"("session_id_hash");
CREATE INDEX IF NOT EXISTS "idx_user_sessions_user_id" ON "user_sessions"("user_id");

-- 4. Idempotency keys uniqueness and expiration cleanup indexes
CREATE UNIQUE INDEX IF NOT EXISTS "idx_idempotency_user_key" ON "idempotency_keys"("user_id", "key");
CREATE INDEX IF NOT EXISTS "idx_idempotency_expires_at" ON "idempotency_keys"("expires_at");
