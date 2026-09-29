-- Migration: Add Physical Gaming Stations
-- 1. Create stations table
CREATE TABLE IF NOT EXISTS "stations" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "game_type_id" INTEGER NOT NULL REFERENCES "game_types"("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
  "created_at" TIMESTAMP DEFAULT NOW()
);

-- 2. Add station_id column to bookings table
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "station_id" INTEGER REFERENCES "stations"("id") ON DELETE SET NULL;

-- 3. Create indices for fast lookup and conflict prevention
CREATE INDEX IF NOT EXISTS "idx_stations_game_type_id" ON "stations"("game_type_id");
CREATE INDEX IF NOT EXISTS "idx_stations_status" ON "stations"("status");
CREATE INDEX IF NOT EXISTS "idx_bookings_station_time" ON "bookings"("station_id", "start_time", "end_time") WHERE "status" != 'Cancelled';
