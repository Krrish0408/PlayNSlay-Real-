-- Rollback Migration: 0004_remove_redundant_is_admin
-- Re-add is_admin column for backward compatibility
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill is_admin based on authoritative role = 'admin'
UPDATE "users" SET "is_admin" = TRUE WHERE "role" = 'admin';
