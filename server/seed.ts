import { storage } from "./storage";
import { hashPassword } from "./auth";

const TEST_USERS = [
  {
    username: "admin",
    password: "admin123",
    email: "admin@playnslaylounge.com",
    fullName: "Admin User",
    role: "admin" as const,
    phone: null,
    avatarUrl: null,
    membershipTier: "platinum" as const,
  },
  {
    username: "employee",
    password: "employee123",
    email: "employee@playnslaylounge.com",
    fullName: "Staff Member",
    role: "employee" as const,
    phone: null,
    avatarUrl: null,
    membershipTier: "bronze" as const,
  },
  {
    username: "member",
    password: "member123",
    email: "member@playnslaylounge.com",
    fullName: "Regular Member",
    role: "member" as const,
    phone: null,
    avatarUrl: null,
    membershipTier: "silver" as const,
  },
];

const GAMES_LIST = [
  { title: "GTA 5 Premium Edition", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 1, genre: "Action", imageUrl: "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&q=80&w=800" },
  { title: "Mortal Kombat 11", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 2, genre: "Fighting", imageUrl: "https://images.unsplash.com/photo-1555680202-c86f0e12f086?auto=format&fit=crop&q=80&w=800" },
  { title: "WWE 2K24", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 4, genre: "Sports", imageUrl: "https://images.unsplash.com/photo-1517438322307-e67111335449?auto=format&fit=crop&q=80&w=800" },
  { title: "Mortal Kombat X", platforms: "PS4, PS5", minPlayers: 1, maxPlayers: 2, genre: "Fighting", imageUrl: "https://images.unsplash.com/photo-1514533450685-4493e01d1fdc?auto=format&fit=crop&q=80&w=800" },
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

import { config } from "./config";

export async function seedGamesCatalog() {
  try {
    const { initDbSchema } = await import("./db");
    await initDbSchema();

    const existingGames = await storage.getGames();
    if (existingGames.length === 0) {
      for (const g of GAMES_LIST) {
        await storage.createGame({
          ...g,
          isActive: true,
        });
      }
      console.log(`🎮  Seeded ${GAMES_LIST.length} games with cover images into Games Catalog.`);
    } else {
      // Always synchronize game images with matching catalog artwork
      for (const g of existingGames) {
        const match = GAMES_LIST.find((m) => m.title.toLowerCase() === g.title.toLowerCase());
        if (match && match.imageUrl) {
          await storage.updateGame(g.id, {
            imageUrl: match.imageUrl,
            genre: match.genre,
            platforms: match.platforms,
          });
        }
      }
      console.log(`🎮  Synchronized ${existingGames.length} game covers & genres in Games Catalog.`);
    }
  } catch (err) {
    console.error("Failed to seed games catalog:", err);
  }
}

export async function seedTestUsers() {
  const currentEnv = (process.env.NODE_ENV || "").trim().toLowerCase();
  if (currentEnv === "production" || currentEnv === "staging" || config.isProduction || config.isStaging) {
    throw new Error("[SECURITY VIOLATION] Automatic default credential seeding is strictly forbidden in production and staging environments.");
  }

  const { initDbSchema } = await import("./db");
  await initDbSchema();

  let seeded = 0;
  for (const u of TEST_USERS) {
    try {
      const existing = await storage.getUserByUsername(u.username);
      if (!existing) {
        const hashed = await hashPassword(u.password);
        await storage.createUser({
          ...u,
          password: hashed,
          isEmailVerified: true,
          emailVerifiedAt: new Date(),
        });
        seeded++;
      } else if (!existing.isEmailVerified) {
        await storage.updateUser(existing.id, {
          isEmailVerified: true,
          emailVerifiedAt: new Date(),
        });
      }
    } catch {
      // ignore — user already exists or storage not ready
    }
  }

  // Seed Games Catalog
  await seedGamesCatalog();

  if (seeded > 0 && (config.isDevelopment || config.isTest)) {
    console.log(`\n🎮  [DEV ONLY] Test accounts initialized for development/test environment.`);
  }
}

