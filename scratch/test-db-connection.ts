try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {}

import { initDbSchema, checkDatabaseHealth, pool } from "../server/db";
import { storage } from "../server/storage";
import { seedGamesCatalog, seedTestUsers } from "../server/seed";

async function main() {
  console.log("Connecting to Neon database...");
  console.log("Database URL configured:", Boolean(process.env.DATABASE_URL));
  const health = await checkDatabaseHealth();
  console.log("Database health check:", health);

  console.log("Initializing database schema on Neon...");
  await initDbSchema();
  console.log("Database schema initialized successfully!");

  console.log("Seeding initial games and stations catalog...");
  await seedGamesCatalog();
  await seedTestUsers();

  const stations = await storage.getStations();
  console.log(`Successfully verified ${stations.length} stations in Neon DB!`);

  const games = await storage.getGames();
  console.log(`Successfully verified ${games.length} games in Neon DB!`);

  if (pool) {
    await pool.end();
  }
  console.log("Neon DB test completed successfully!");
}

main().catch((err) => {
  console.error("Database connection/init error:", err);
  process.exit(1);
});
