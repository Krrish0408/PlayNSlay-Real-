/**
 * Production Database Seed Script
 * 
 * Initializes the database schema and seeds the games catalog
 * on the production Neon PostgreSQL database.
 * 
 * Usage: npx tsx scripts/seed-production.ts
 */

try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // .env file not present
}

async function main() {
  console.log("🚀 Starting production database seed...\n");

  // Step 1: Initialize schema
  console.log("📦 Step 1: Initializing database schema...");
  const { initDbSchema, pool, checkDatabaseHealth } = await import("../server/db");

  // Verify connection first
  const health = await checkDatabaseHealth();
  if (!health.healthy) {
    console.error("❌ Cannot connect to database:", health.error);
    process.exit(1);
  }
  console.log(`✅ Database connected (latency: ${health.latencyMs}ms)\n`);

  await initDbSchema();
  console.log("✅ Schema initialized successfully\n");

  // Step 2: Seed games catalog
  console.log("🎮 Step 2: Seeding games catalog...");
  const { seedGamesCatalog } = await import("../server/seed");
  await seedGamesCatalog();
  console.log("✅ Games catalog seeded\n");

  // Step 3: Verify tables
  console.log("📊 Step 3: Verifying database tables...");
  if (pool) {
    const tables = await pool.query(`
      SELECT table_name, 
             (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_name = t.table_name) as column_count
      FROM information_schema.tables t
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    
    console.log("\n  Table Name                    | Columns");
    console.log("  " + "-".repeat(50));
    for (const row of tables.rows) {
      console.log(`  ${row.table_name.padEnd(30)} | ${row.column_count}`);
    }

    // Count rows in key tables
    const counts = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) as users,
        (SELECT COUNT(*) FROM games) as games,
        (SELECT COUNT(*) FROM game_types) as game_types,
        (SELECT COUNT(*) FROM stations) as stations,
        (SELECT COUNT(*) FROM bookings) as bookings;
    `);
    
    const c = counts.rows[0];
    console.log("\n  📈 Row counts:");
    console.log(`    Users:      ${c.users}`);
    console.log(`    Games:      ${c.games}`);
    console.log(`    Game Types: ${c.game_types}`);
    console.log(`    Stations:   ${c.stations}`);
    console.log(`    Bookings:   ${c.bookings}`);
  }

  console.log("\n✅ Production database seed complete!");
  
  // Clean exit
  if (pool) await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Seed failed:", err);
  process.exit(1);
});
