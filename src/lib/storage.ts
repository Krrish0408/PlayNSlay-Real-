import {
  User,
  InsertUser,
  GameType,
  InsertGameType,
  Booking,
  InsertBooking,
  Setting,
  users,
  gameTypes,
  bookings,
  settings,
} from "@/shared/schema";
import { db, pool } from "./db";
import { eq, desc, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, user: Partial<InsertUser | User>): Promise<User>;
  getAllUsers(): Promise<User[]>;

  // Game Types
  getGameTypes(): Promise<GameType[]>;
  getGameType(id: number): Promise<GameType | undefined>;
  createGameType(game: InsertGameType): Promise<GameType>;
  updateGameType(id: number, game: Partial<InsertGameType>): Promise<GameType>;
  deleteGameType(id: number): Promise<void>;

  // Bookings
  getBookings(): Promise<(Booking & { gameType?: GameType | null; user: User })[]>;
  getBookingsByUser(userId: number): Promise<(Booking & { gameType?: GameType | null })[]>;
  createBooking(booking: InsertBooking & { userId: number; totalPrice: number; bookingRef: string; paymentMethod: string; employeeId?: number | null; status?: string; gameTypeId?: number | null }): Promise<Booking>;
  updateBooking(id: number, booking: Partial<Booking>): Promise<Booking>;
  updateBookingStatus(id: number, status: string): Promise<Booking>;

  // Settings
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;

  // Admin Stats
  getAdminStats(): Promise<any>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values({
      ...insertUser,
      role: insertUser.role || "member",
    }).returning();
    return user;
  }

  async updateUser(id: number, user: Partial<InsertUser | User>): Promise<User> {
    const [updated] = await db.update(users).set(user).where(eq(users.id, id)).returning();
    return updated;
  }

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  }

  async getGameTypes(): Promise<GameType[]> {
    return await db.select().from(gameTypes).where(eq(gameTypes.isActive, true));
  }

  async getGameType(id: number): Promise<GameType | undefined> {
    const [gameType] = await db.select().from(gameTypes).where(eq(gameTypes.id, id));
    return gameType;
  }

  async createGameType(game: InsertGameType): Promise<GameType> {
    const [newGame] = await db.insert(gameTypes).values(game).returning();
    return newGame;
  }

  async updateGameType(id: number, game: Partial<InsertGameType>): Promise<GameType> {
    const [updated] = await db.update(gameTypes).set(game).where(eq(gameTypes.id, id)).returning();
    return updated;
  }

  async deleteGameType(id: number): Promise<void> {
    await db.delete(gameTypes).where(eq(gameTypes.id, id));
  }

  async getBookings(): Promise<(Booking & { gameType?: GameType | null; user: User })[]> {
    const rows = await db
      .select({
        booking: bookings,
        gameType: gameTypes,
        user: users,
      })
      .from(bookings)
      .leftJoin(gameTypes, eq(bookings.gameTypeId, gameTypes.id))
      .innerJoin(users, eq(bookings.userId, users.id))
      .orderBy(desc(bookings.createdAt));

    return rows.map((row: any) => ({
      ...row.booking,
      gameType: row.gameType || null,
      user: row.user,
    }));
  }

  async getBookingsByUser(userId: number): Promise<(Booking & { gameType?: GameType | null })[]> {
    const rows = await db
      .select({
        booking: bookings,
        gameType: gameTypes,
      })
      .from(bookings)
      .leftJoin(gameTypes, eq(bookings.gameTypeId, gameTypes.id))
      .where(eq(bookings.userId, userId))
      .orderBy(desc(bookings.createdAt));

    return rows.map((row: any) => ({
      ...row.booking,
      gameType: row.gameType || null,
    }));
  }

  async createBooking(booking: InsertBooking & { userId: number; totalPrice: number; bookingRef: string; paymentMethod: string; employeeId?: number | null; status?: string; gameTypeId?: number | null }): Promise<Booking> {
    const [newBooking] = await db.insert(bookings).values(booking).returning();
    return newBooking;
  }

  async updateBooking(id: number, booking: Partial<Booking>): Promise<Booking> {
    const [updated] = await db.update(bookings).set(booking).where(eq(bookings.id, id)).returning();
    return updated;
  }

  async updateBookingStatus(id: number, status: string): Promise<Booking> {
    const [updated] = await db.update(bookings).set({ status }).where(eq(bookings.id, id)).returning();
    return updated;
  }

  async getSetting(key: string): Promise<string | undefined> {
    const [s] = await db.select().from(settings).where(eq(settings.key, key));
    return s?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  async getAdminStats(): Promise<any> {
    const { getAdminStats } = await import("./stats");
    return await getAdminStats();
  }
}

export class MemStorage implements IStorage {
  private users = new Map<number, User>();
  private gameTypes = new Map<number, GameType>();
  private bookings = new Map<number, Booking>();
  private settings = new Map<string, string>();

  private currentUserId = 1;
  private currentGameTypeId = 1;
  private currentBookingId = 1;

  constructor() {
    this.seedDefaults();
  }

  private seedDefaults() {
    // Seed Game Types
    const defaultGames = [
      { name: "PS5", description: "Sony PlayStation 5 4K 120Hz station", hourlyPrice: 120, maxPlayers: 4, isActive: true, priceModel: "per_player", imageUrl: "/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg" },
      { name: "PS4", description: "Sony PlayStation 4 Pro station", hourlyPrice: 70, maxPlayers: 4, isActive: true, priceModel: "per_player", imageUrl: "/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg" },
      { name: "PC Gaming", description: "RTX 4080 Gaming Rig, 240Hz OLED", hourlyPrice: 80, maxPlayers: 1, isActive: true, priceModel: "flat", imageUrl: "/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg" },
      { name: "XBOX", description: "Xbox Series X station", hourlyPrice: 120, maxPlayers: 4, isActive: true, priceModel: "per_player", imageUrl: "/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg" },
      { name: "VR Setup", description: "Meta Quest 3 / Valve Index Room-Scale", hourlyPrice: 150, maxPlayers: 1, isActive: true, priceModel: "flat", imageUrl: "/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg" },
      { name: "Racing Simulator", description: "Direct Drive Wheel & Hydraulic Pedals", hourlyPrice: 200, maxPlayers: 1, isActive: true, priceModel: "flat", imageUrl: "/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg" },
    ];

    for (const g of defaultGames) {
      const id = this.currentGameTypeId++;
      this.gameTypes.set(id, { id, ...g });
    }

    // Seed a sample booking
    const now = new Date();
    const endTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    this.bookings.set(1, {
      id: 1,
      userId: 1,
      gameTypeId: 1,
      gameTitle: "GTA 5 Premium Edition",
      startTime: now,
      endTime: endTime,
      playerCount: 2,
      totalPrice: 360,
      paymentMethod: "offline",
      status: "Approved",
      bookingRef: "PNS-DEMO-01",
      employeeId: 2,
      timerStartedAt: now,
      timerEndTime: endTime,
      createdAt: now,
    });
    this.currentBookingId = 2;
  }

  private createUserSync(data: { username: string; password: string; role: string }): User {
    const id = this.currentUserId++;
    const user: User = {
      id,
      email: null,
      fullName: null,
      phone: null,
      avatarUrl: null,
      membershipTier: "bronze",
      createdAt: new Date(),
      ...data,
    };
    this.users.set(id, user);
    return user;
  }

  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find((u) => u.username.toLowerCase() === username.toLowerCase() || (u.email && u.email.toLowerCase() === username.toLowerCase()));
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.currentUserId++;
    const user: User = {
      id,
      email: insertUser.email ?? null,
      fullName: insertUser.fullName ?? null,
      phone: insertUser.phone ?? null,
      avatarUrl: insertUser.avatarUrl ?? null,
      membershipTier: insertUser.membershipTier ?? "bronze",
      createdAt: new Date(),
      role: insertUser.role || "member",
      ...insertUser,
    };
    this.users.set(id, user);
    return user;
  }

  async updateUser(id: number, user: Partial<InsertUser | User>): Promise<User> {
    const existing = this.users.get(id);
    if (!existing) throw new Error("User not found");
    const updated = { ...existing, ...user } as User;
    this.users.set(id, updated);
    return updated;
  }

  async getAllUsers(): Promise<User[]> {
    return Array.from(this.users.values()).sort(
      (a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0)
    );
  }

  async getGameTypes(): Promise<GameType[]> {
    return Array.from(this.gameTypes.values());
  }

  async getGameType(id: number): Promise<GameType | undefined> {
    return this.gameTypes.get(id);
  }

  async createGameType(game: InsertGameType): Promise<GameType> {
    const id = this.currentGameTypeId++;
    const newGame: GameType = { id, ...game, isActive: game.isActive ?? true };
    this.gameTypes.set(id, newGame);
    return newGame;
  }

  async updateGameType(id: number, game: Partial<InsertGameType>): Promise<GameType> {
    const existing = this.gameTypes.get(id);
    if (!existing) throw new Error("Game type not found");
    const updated = { ...existing, ...game } as GameType;
    this.gameTypes.set(id, updated);
    return updated;
  }

  async deleteGameType(id: number): Promise<void> {
    this.gameTypes.delete(id);
  }

  async getBookings(): Promise<(Booking & { gameType?: GameType | null; user: User })[]> {
    const result: (Booking & { gameType?: GameType | null; user: User })[] = [];
    for (const booking of Array.from(this.bookings.values())) {
      const gameType = booking.gameTypeId ? this.gameTypes.get(booking.gameTypeId) || null : null;
      const user = this.users.get(booking.userId);
      if (user) {
        result.push({ ...booking, gameType, user });
      }
    }
    return result.sort(
      (a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0)
    );
  }

  async getBookingsByUser(userId: number): Promise<(Booking & { gameType?: GameType | null })[]> {
    const result: (Booking & { gameType?: GameType | null })[] = [];
    for (const booking of Array.from(this.bookings.values())) {
      if (booking.userId === userId) {
        const gameType = booking.gameTypeId ? this.gameTypes.get(booking.gameTypeId) || null : null;
        result.push({ ...booking, gameType });
      }
    }
    return result.sort(
      (a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0)
    );
  }

  async createBooking(booking: InsertBooking & { userId: number; totalPrice: number; bookingRef: string; paymentMethod: string; employeeId?: number | null; status?: string; gameTypeId?: number | null }): Promise<Booking> {
    const id = this.currentBookingId++;
    const newBooking: Booking = {
      id,
      gameTypeId: booking.gameTypeId ?? null,
      gameTitle: booking.gameTitle ?? null,
      playerCount: booking.playerCount ?? 1,
      status: booking.status || "Pending",
      employeeId: booking.employeeId ?? null,
      timerStartedAt: null,
      timerEndTime: null,
      createdAt: new Date(),
      ...booking,
    };
    this.bookings.set(id, newBooking);
    return newBooking;
  }

  async updateBooking(id: number, booking: Partial<Booking>): Promise<Booking> {
    const existing = this.bookings.get(id);
    if (!existing) throw new Error("Booking not found");
    const updated = { ...existing, ...booking } as Booking;
    this.bookings.set(id, updated);
    return updated;
  }

  async updateBookingStatus(id: number, status: string): Promise<Booking> {
    const booking = this.bookings.get(id);
    if (!booking) throw new Error("Booking not found");
    const updated = { ...booking, status } as Booking;
    this.bookings.set(id, updated);
    return updated;
  }

  async getSetting(key: string): Promise<string | undefined> {
    return this.settings.get(key);
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async getAdminStats(): Promise<any> {
    const { getAdminStats } = await import("./stats");
    return await getAdminStats();
  }
}

// Export singleton instance - fail closed in production/staging
const isProdOrStaging = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
if (isProdOrStaging && !process.env.DATABASE_URL) {
  const errorMsg = "[FATAL CONFIGURATION ERROR] DATABASE_URL is missing in production/staging. In-memory storage fallback is disabled.";
  console.error(errorMsg);
  throw new Error(errorMsg);
}

export const storage: IStorage = process.env.DATABASE_URL
  ? new DatabaseStorage()
  : new MemStorage();

