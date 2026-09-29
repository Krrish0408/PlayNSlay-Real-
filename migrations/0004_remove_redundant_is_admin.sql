-- Migration: 0004_remove_redundant_is_admin
-- REVIEWED-DESTRUCTIVE-CHANGE: Approved by Security Audit / Deprecated Column Removal
-- Authoritative migration: migrate users with is_admin = true to role = 'admin'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'is_admin'
  ) THEN
    UPDATE "users" SET "role" = 'admin' WHERE ("is_admin" = TRUE OR "is_admin" IS TRUE) AND "role" != 'admin';
    ALTER TABLE "users" DROP COLUMN "is_admin";
  END IF;
END $$;
