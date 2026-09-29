-- Rollback Migration: 0003_add_production_scale_indexes
-- Description: Drop production-scale performance indexes

DROP INDEX IF EXISTS "idx_bookings_user_id";
DROP INDEX IF EXISTS "idx_bookings_station_id";
DROP INDEX IF EXISTS "idx_bookings_start_time";
DROP INDEX IF EXISTS "idx_bookings_status";
DROP INDEX IF EXISTS "idx_bookings_created_at";

DROP INDEX IF EXISTS "idx_audit_logs_user_id_created_at";
DROP INDEX IF EXISTS "idx_audit_logs_created_at";

DROP INDEX IF EXISTS "idx_user_sessions_sid_hash";
DROP INDEX IF EXISTS "idx_user_sessions_user_id";

DROP INDEX IF EXISTS "idx_idempotency_user_key";
DROP INDEX IF EXISTS "idx_idempotency_expires_at";
