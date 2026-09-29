/**
 * Curated High-Definition Game & Game Type Artwork Registry
 * Maps each specific game title, station type, and genre to matching visual artwork.
 */

// Precise Title-to-Artwork Mapping
export const GAME_IMAGES_MAP: Record<string, string> = {
  // Action & Open World / Heists
  "GTA 5 Premium Edition": "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&q=80&w=800",
  "GTA 5": "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&q=80&w=800",
  "God of War Ragnarok": "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&q=80&w=800",
  "Ghost of Tsushima": "https://images.unsplash.com/photo-1618336753974-aae8e04506aa?auto=format&fit=crop&q=80&w=800",
  "Uncharted 4 A Thief's End": "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&q=80&w=800",
  "Far Cry 5": "https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&q=80&w=800",

  // Fighting & Combat Arena
  "Mortal Kombat 11": "https://images.unsplash.com/photo-1555680202-c86f0e12f086?auto=format&fit=crop&q=80&w=800",
  "Mortal Kombat X": "https://images.unsplash.com/photo-1514533450685-4493e01d1fdc?auto=format&fit=crop&q=80&w=800",
  "Core Fighters": "https://images.unsplash.com/photo-1534423861386-85a16f5d13fd?auto=format&fit=crop&q=80&w=800",

  // Pro Wrestling / WWE
  "WWE 2K24": "https://images.unsplash.com/photo-1517438322307-e67111335449?auto=format&fit=crop&q=80&w=800",
  "WWE 2K25": "https://images.unsplash.com/photo-1549719386-74dfcbf7dbed?auto=format&fit=crop&q=80&w=800",
  "WWE 2K20": "https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&q=80&w=800",

  // Football / Soccer
  "FC-25": "https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&q=80&w=800",
  "FC-24": "https://images.unsplash.com/photo-1518091043644-c1d4457512c6?auto=format&fit=crop&q=80&w=800",
  "FIFA 2017": "https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?auto=format&fit=crop&q=80&w=800",
  "Winning Eleven": "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&q=80&w=800",

  // Sports (Tennis, Basketball, Cricket, Skate, Rocket League)
  "Tennis World Tour": "https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?auto=format&fit=crop&q=80&w=800",
  "Cricket 22": "https://images.unsplash.com/photo-1531415074968-036ba1b575da?auto=format&fit=crop&q=80&w=800",
  "NBA 2K26": "https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&q=80&w=800",
  "Skate": "https://images.unsplash.com/photo-1520045892732-304bc3ac5d8e?auto=format&fit=crop&q=80&w=800",
  "Rocket League": "https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&q=80&w=800",

  // Racing Simulators & Supercars
  "F1 24": "https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&q=80&w=800",
  "GT7": "https://images.unsplash.com/photo-1617814076367-b759c7d7e738?auto=format&fit=crop&q=80&w=800",
  "NFS Heat": "https://images.unsplash.com/photo-1544829099-b9a0c07fad1a?auto=format&fit=crop&q=80&w=800",
  "Forza Horizon 5": "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&q=80&w=800",
  "Asphalt Legends": "https://images.unsplash.com/photo-1542282088-72c9c27ed0cd?auto=format&fit=crop&q=80&w=800",
  "Trackmania": "https://images.unsplash.com/photo-1511919884226-fd3cad34687c?auto=format&fit=crop&q=80&w=800",

  // VR Arena
  "Playstation VR World": "https://images.unsplash.com/photo-1593508512255-86ab42a8e620?auto=format&fit=crop&q=80&w=800",
  "IB Cricket": "https://images.unsplash.com/photo-1531415074968-036ba1b575da?auto=format&fit=crop&q=80&w=800",

  // Shooters & Battle Royale
  "Call of Duty Warzone": "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=800",
  "Playerunknown's Battlegrounds": "https://images.unsplash.com/photo-1542751110-97427bbecf20?auto=format&fit=crop&q=80&w=800",
  "Battlefield Royale": "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=800",
  "Destiny": "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?auto=format&fit=crop&q=80&w=800",
  "Fortnite": "https://images.unsplash.com/photo-1563089145-599997674d42?auto=format&fit=crop&q=80&w=800",
  "Splitgate": "https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&q=80&w=800",
  "Vigor": "https://images.unsplash.com/photo-1519669556878-63bdad8a1a49?auto=format&fit=crop&q=80&w=800",

  // Co-op, Horror & Sandbox
  "It Takes Two": "https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?auto=format&fit=crop&q=80&w=800",
  "Roblox": "https://images.unsplash.com/photo-1580234811497-9df7fd2f357e?auto=format&fit=crop&q=80&w=800",
  "Silent Hill": "https://images.unsplash.com/photo-1509248961158-e54f6934749c?auto=format&fit=crop&q=80&w=800",
};

// Genre & Station Type Fallback Images
export const GENRE_IMAGES_FALLBACK: Record<string, string> = {
  racing: "https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&q=80&w=800",
  fighting: "https://images.unsplash.com/photo-1555680202-c86f0e12f086?auto=format&fit=crop&q=80&w=800",
  wrestling: "https://images.unsplash.com/photo-1517438322307-e67111335449?auto=format&fit=crop&q=80&w=800",
  football: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&q=80&w=800",
  soccer: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&q=80&w=800",
  sports: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&q=80&w=800",
  action: "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&q=80&w=800",
  shooter: "https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&q=80&w=800",
  "battle royale": "https://images.unsplash.com/photo-1542751110-97427bbecf20?auto=format&fit=crop&q=80&w=800",
  vr: "https://images.unsplash.com/photo-1593508512255-86ab42a8e620?auto=format&fit=crop&q=80&w=800",
  horror: "https://images.unsplash.com/photo-1509248961158-e54f6934749c?auto=format&fit=crop&q=80&w=800",
  coop: "https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?auto=format&fit=crop&q=80&w=800",
  "co-op": "https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?auto=format&fit=crop&q=80&w=800",
  sandbox: "https://images.unsplash.com/photo-1580234811497-9df7fd2f357e?auto=format&fit=crop&q=80&w=800",
};

export const STATION_IMAGES_FALLBACK: Record<string, string> = {
  ps5: "https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?auto=format&fit=crop&q=80&w=800",
  ps4: "https://images.unsplash.com/photo-1507457379470-08b8006adbec?auto=format&fit=crop&q=80&w=800",
  racing: "https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&q=80&w=800",
  vr: "https://images.unsplash.com/photo-1593508512255-86ab42a8e620?auto=format&fit=crop&q=80&w=800",
  pc: "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&q=80&w=800",
};

/**
 * Resolves the appropriate cover image for a game based on:
 * 1. Explicit currentUrl if set and not a generic placeholder
 * 2. Exact title match in GAME_IMAGES_MAP
 * 3. Fuzzy title match in GAME_IMAGES_MAP
 * 4. Genre fallback matching
 * 5. Station/platform fallback matching
 * 6. High-tech default fallback
 */
export function resolveGameCover(
  title: string,
  currentUrl?: string | null,
  genre?: string | null,
  platforms?: string | null
): string {
  if (currentUrl && currentUrl.trim() !== "" && !currentUrl.includes("photo-1550745165-9bc0b252726f")) {
    return currentUrl;
  }

  // Exact title lookup
  if (GAME_IMAGES_MAP[title]) {
    return GAME_IMAGES_MAP[title];
  }

  // Fuzzy title lookup
  const t = title.toLowerCase().trim();
  for (const [key, url] of Object.entries(GAME_IMAGES_MAP)) {
    const k = key.toLowerCase();
    if (k === t || t.includes(k) || k.includes(t)) {
      return url;
    }
  }

  // Check WWE / Wrestling
  if (t.includes("wwe") || t.includes("wrestling")) {
    return GAME_IMAGES_MAP["WWE 2K24"];
  }

  // Check Mortal Kombat / Fighting
  if (t.includes("mortal kombat") || t.includes("kombat") || t.includes("tekken") || t.includes("street fighter")) {
    return GAME_IMAGES_MAP["Mortal Kombat 11"];
  }

  // Check FIFA / FC / Football
  if (t.includes("fc") || t.includes("fifa") || t.includes("soccer") || t.includes("football") || t.includes("eleven") || t.includes("pes")) {
    return GAME_IMAGES_MAP["FC-25"];
  }

  // Check Racing / F1 / Gran Turismo / NFS
  if (t.includes("f1") || t.includes("gt7") || t.includes("forza") || t.includes("nfs") || t.includes("speed") || t.includes("asphalt") || t.includes("trackmania")) {
    return GAME_IMAGES_MAP["F1 24"];
  }

  // Genre fallback matching
  if (genre) {
    const gLower = genre.toLowerCase();
    for (const [genreKey, url] of Object.entries(GENRE_IMAGES_FALLBACK)) {
      if (gLower.includes(genreKey)) {
        return url;
      }
    }
  }

  // Platform/Station fallback matching
  if (platforms) {
    const pLower = platforms.toLowerCase();
    if (pLower.includes("racing")) return STATION_IMAGES_FALLBACK.racing;
    if (pLower.includes("vr")) return STATION_IMAGES_FALLBACK.vr;
    if (pLower.includes("ps5")) return STATION_IMAGES_FALLBACK.ps5;
    if (pLower.includes("ps4")) return STATION_IMAGES_FALLBACK.ps4;
  }

  return "https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&q=80&w=800";
}
