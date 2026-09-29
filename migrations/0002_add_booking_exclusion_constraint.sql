-- Migration: Add PostgreSQL GiST exclusion constraint to prevent overlapping station bookings

-- 1. Enable btree_gist extension for indexing scalar columns (station_id) alongside range expressions in GiST
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2. Ensure start_time and end_time are timestamptz for immutable range calculations
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

-- 3. Drop obsolete non-exclusion index if present
DROP INDEX IF EXISTS "idx_bookings_station_time";

-- 4. Add GiST exclusion constraint preventing overlapping bookings for the same physical station
-- Excludes Cancelled and Rejected bookings from conflict enforcement
-- Ensures Active, Pending, Approved bookings cannot overlap
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
