import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@/shared/schema";

const { Pool } = pg;

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    })
  : undefined;

export const db = pool ? drizzle(pool, { schema }) : (null as any);

if (!process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging") {
    const errorMsg = "[FATAL CONFIGURATION ERROR] DATABASE_URL is required in production/staging environment.";
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
  console.warn("[DEV-ONLY WARNING] DATABASE_URL not set. Running in development mode.");
}
