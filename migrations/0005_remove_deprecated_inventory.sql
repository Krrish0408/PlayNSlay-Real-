-- Migration: 0005_remove_deprecated_inventory
-- REVIEWED-DESTRUCTIVE-CHANGE: Approved by Architecture Board / Deprecated Subsystem Decommission
-- Description: Completely purges deprecated inventory and booking_items subsystem from the database

DROP TABLE IF EXISTS "booking_items" CASCADE;
DROP TABLE IF EXISTS "inventory_items" CASCADE;
DROP TABLE IF EXISTS "inventory" CASCADE;
