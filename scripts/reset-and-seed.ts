/**
 * Reset & Seed Production Database
 * 
 * Drops all existing tables and recreates the schema from scratch,
 * then seeds the games catalog.
 * 
 * Usage: npx tsx scripts/reset-and-seed.ts
 */

try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {}

import pg from "pg";
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL not set in .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log("🚀 Starting FULL database reset & seed...\n");

  // Step 1: Check connection
  const start = Date.now();
  await pool.query("SELECT 1");
  console.log(`✅ Connected to Neon database (${Date.now() - start}ms)\n`);

  // Step 2: Check existing tables
  const existing = await pool.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' ORDER BY table_name;
  `);
  console.log("📋 Existing tables:", existing.rows.map(r => r.table_name).join(", ") || "(none)");

  // Step 3: Drop ALL existing tables (clean slate)
  console.log("\n🗑️  Dropping all existing tables...");
  await pool.query(`
    DROP TABLE IF EXISTS booking_items CASCADE;
    DROP TABLE IF EXISTS inventory_items CASCADE;
    DROP TABLE IF EXISTS inventory CASCADE;
    DROP TABLE IF EXISTS idempotency_keys CASCADE;
    DROP TABLE IF EXISTS user_sessions CASCADE;
    DROP TABLE IF EXISTS audit_logs CASCADE;
    DROP TABLE IF EXISTS settings CASCADE;
    DROP TABLE IF EXISTS bookings CASCADE;
    DROP TABLE IF EXISTS stations CASCADE;
    DROP TABLE IF EXISTS game_types CASCADE;
    DROP TABLE IF EXISTS games CASCADE;
    DROP TABLE IF EXISTS rate_limit_entries CASCADE;
    DROP TABLE IF EXISTS session CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
  `);
  console.log("✅ All tables dropped\n");

  // Step 4: Import and run the schema
  console.log("📦 Creating fresh schema...");
  const { SCHEMA_SQL } = await import("../server/db");
  await pool.query(SCHEMA_SQL);
  console.log("✅ Schema created successfully\n");

  // Step 5: Create Express session table (connect-pg-simple)
  console.log("🔐 Creating session table...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
  console.log("✅ Session table created\n");

  // Step 6: Seed games catalog
  console.log("🎮 Seeding games catalog...");
  // We need to use the storage layer for proper seeding
  const { storage } = await import("../server/storage");
  
  const GAMES_LIST = [
    { title: "GTA 5 Premium Edition", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 1, genre: "Action", imageUrl: "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&q=80&w=800" },
    { title: "Mortal Kombat 11", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 2, genre: "Fighting", imageUrl: "https://images.unsplash.com/photo-1555680202-c86f0e12f086?auto=format&fit=crop&q=80&w=800" },
    { title: "WWE 2K24", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 4, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1517438322307-e67111335449?auto=format&fit=crop&q=80&w=800" },
    { title: "God of War Ragnarok", platforms: "PS5", minPlayers: 1, maxPlayers: 1, genre: "Action", imageUrl: "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&q=80&w=800" },
    { title: "Tennis World Tour", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 2, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?auto=format&fit=crop&q=80&w=800" },
    { title: "WWE 2K25", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 4, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1549719386-74dfcbf7dbed?auto=format&fit=crop&q=80&w=800" },
    { title: "Uncharted 4 A Thief's End", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 1, genre: "Action", imageUrl: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&q=80&w=800" },
    { title: "GTA 5", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 1, genre: "Action", imageUrl: "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&q=80&w=800" },
    { title: "Winning Eleven", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 4, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&q=80&w=800" },
    { title: "FC-25", platforms: "PS5", minPlayers: 1, maxPlayers: 4, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&q=80&w=800" },
    { title: "Destiny", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 1, genre: "Shooter", imageUrl: "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?auto=format&fit=crop&q=80&w=800" },
    { title: "NFS Heat", platforms: "PS4, PS5, Racing Sim", minPlayers: 1, maxPlayers: 1, genre: "Racing", imageUrl: "https://images.unsplash.com/photo-1544829099-b9a0c07fad1a?auto=format&fit=crop&q=80&w=800" },
    { title: "FC-24", platforms: "PS5", minPlayers: 1, maxPlayers: 4, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1518091043644-c1d4457512c6?auto=format&fit=crop&q=80&w=800" },
    { title: "Far Cry 5", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 1, genre: "Action", imageUrl: "https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&q=80&w=800" },
    { title: "Cricket 22", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 2, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1531415074968-036ba1b575da?auto=format&fit=crop&q=80&w=800" },
    { title: "Mortal Kombat X", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 2, genre: "Fighting", imageUrl: "https://images.unsplash.com/photo-1514533450685-4493e01d1fdc?auto=format&fit=crop&q=80&w=800" },
    { title: "Playerunknown's Battlegrounds", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 1, genre: "Battle Royale", imageUrl: "https://images.unsplash.com/photo-1542751110-97427bbecf20?auto=format&fit=crop&q=80&w=800" },
    { title: "WWE 2K20", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 4, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&q=80&w=800" },
    { title: "Ghost of Tsushima", platforms: "PS5", minPlayers: 1, maxPlayers: 1, genre: "Action", imageUrl: "https://images.unsplash.com/photo-1618336753974-aae8e04506aa?auto=format&fit=crop&q=80&w=800" },
    { title: "F1 24", platforms: "PS5, Racing Sim", minPlayers: 1, maxPlayers: 2, genre: "Racing", imageUrl: "https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&q=80&w=800" },
    { title: "GT7", platforms: "PS4, PS5, Racing Sim", minPlayers: 1, maxPlayers: 2, genre: "Racing", imageUrl: "https://images.unsplash.com/photo-1617814076367-b759c7d7e738?auto=format&fit=crop&q=80&w=800" },
    { title: "FIFA 2017", platforms: "PS4", minPlayers: 1, maxPlayers: 4, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?auto=format&fit=crop&q=80&w=800" },
    { title: "Playstation VR World", platforms: "PS4, PS5, VR Gaming", minPlayers: 1, maxPlayers: 1, genre: "VR", imageUrl: "https://images.unsplash.com/photo-1593508512255-86ab42a8e620?auto=format&fit=crop&q=80&w=800" },
    { title: "NBA 2K26", platforms: "PS5", minPlayers: 1, maxPlayers: 2, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&q=80&w=800" },
    { title: "Fortnite", platforms: "PS5", minPlayers: 1, maxPlayers: 1, genre: "Battle Royale", imageUrl: "https://images.unsplash.com/photo-1563089145-599997674d42?auto=format&fit=crop&q=80&w=800" },
    { title: "Splitgate", platforms: "PS5", minPlayers: 1, maxPlayers: 1, genre: "Shooter", imageUrl: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&q=80&w=800" },
    { title: "Asphalt Legends", platforms: "PS5, Racing Sim", minPlayers: 1, maxPlayers: 4, genre: "Racing", imageUrl: "https://images.unsplash.com/photo-1542282088-72c9c27ed0cd?auto=format&fit=crop&q=80&w=800" },
    { title: "It Takes Two", platforms: "PS4", minPlayers: 1, maxPlayers: 2, genre: "Co-op", imageUrl: "https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?auto=format&fit=crop&q=80&w=800" },
    { title: "Call of Duty Warzone", platforms: "PS4", minPlayers: 1, maxPlayers: 1, genre: "Shooter", imageUrl: "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=800" },
    { title: "Roblox", platforms: "PS5", minPlayers: 1, maxPlayers: 1, genre: "Sandbox", imageUrl: "https://images.unsplash.com/photo-1580234811497-9df7fd2f357e?auto=format&fit=crop&q=80&w=800" },
    { title: "Forza Horizon 5", platforms: "PS5, Racing Sim", minPlayers: 1, maxPlayers: 1, genre: "Racing", imageUrl: "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&q=80&w=800" },
    { title: "Silent Hill", platforms: "PS5", minPlayers: 1, maxPlayers: 1, genre: "Horror", imageUrl: "https://images.unsplash.com/photo-1509248961158-e54f6934749c?auto=format&fit=crop&q=80&w=800" },
    { title: "Rocket League", platforms: "PS5", minPlayers: 1, maxPlayers: 4, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&q=80&w=800" },
    { title: "Core Fighters", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 2, genre: "Fighting", imageUrl: "https://images.unsplash.com/photo-1534423861386-85a16f5d13fd?auto=format&fit=crop&q=80&w=800" },
    { title: "Vigor", platforms: "PS4", minPlayers: 1, maxPlayers: 1, genre: "Shooter", imageUrl: "https://images.unsplash.com/photo-1519669556878-63bdad8a1a49?auto=format&fit=crop&q=80&w=800" },
    { title: "Trackmania", platforms: "PS5", minPlayers: 1, maxPlayers: 1, genre: "Racing", imageUrl: "https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&q=80&w=800" },
    { title: "Battlefield Royale", platforms: "PS4", minPlayers: 1, maxPlayers: 1, genre: "Shooter", imageUrl: "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=800" },
    { title: "Skate", platforms: "PS4", minPlayers: 1, maxPlayers: 1, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1520045892732-304bc3ac5d8e?auto=format&fit=crop&q=80&w=800" },
  ];

  let seeded = 0;
  for (const g of GAMES_LIST) {
    await pool.query(
      `INSERT INTO games (title, platforms, min_players, max_players, genre, image_url, is_active) 
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [g.title, g.platforms, g.minPlayers, g.maxPlayers, g.genre, g.imageUrl]
    );
    seeded++;
  }
  console.log(`✅ Seeded ${seeded} games\n`);

  // Step 7: Verify everything
  console.log("📊 Final verification:");
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' ORDER BY table_name;
  `);
  console.log("  Tables created:", tables.rows.map(r => r.table_name).join(", "));

  const gamesCount = await pool.query("SELECT COUNT(*) as count FROM games");
  console.log(`  Games seeded: ${gamesCount.rows[0].count}`);
  
  const usersCount = await pool.query("SELECT COUNT(*) as count FROM users");
  console.log(`  Users: ${usersCount.rows[0].count}`);

  console.log("\n✅ Database reset & seed complete! Ready for deployment.");

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("\n❌ Reset & seed failed:", err);
  await pool.end();
  process.exit(1);
});
