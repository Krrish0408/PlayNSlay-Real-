import { User, InsertUser, GameType, InsertGameType, Game, InsertGame, Booking, InsertBooking, Setting, Station, InsertStation, AuditLog, UserSession, IdempotencyKey } from "@shared/schema";
import session from "express-session";
import { db, pool, isBookingConflictError } from "./db";
import { users, gameTypes, games, bookings, settings, stations, auditLogs, userSessions, idempotencyKeys } from "@shared/schema";
import { eq, desc, asc, sql, and, or, ne, lt, gt, gte, lte } from "drizzle-orm";
import connectPg from "connect-pg-simple";

export type SafeUser = Pick<User, "id" | "username" | "email" | "fullName" | "phone" | "avatarUrl" | "membershipTier" | "role" | "createdAt">;

export interface BookingFilters {
  limit?: number;
  offset?: number;
  cursor?: { createdAt: Date; id: number };
  status?: string;
  stationId?: number;
  userId?: number;
  fromDate?: Date;
  toDate?: Date;
}

export interface UserFilters {
  limit?: number;
  offset?: number;
  cursor?: { createdAt: Date; id: number };
  role?: string;
  membershipTier?: string;
}

export interface StationFilters {
  limit?: number;
  offset?: number;
  cursor?: { id: number };
  gameTypeId?: number;
  status?: string;
}

export interface GameFilters {
  limit?: number;
  offset?: number;
  cursor?: { id: number };
  genre?: string;
  platform?: string;
}

export interface AuditLogFilters {
  limit?: number;
  offset?: number;
  userId?: number;
  cursor?: { createdAt: Date; id: number };
  action?: string;
  fromDate?: Date;
  toDate?: Date;
}

export type CreateBookingInput = InsertBooking & {
  userId: number;
  totalPrice: number;
  basePrice?: number | null;
  discountAmount?: number;
  finalPrice?: number | null;
  currency?: string;
  pricingRule?: string;
  bookingRef: string;
  paymentMethod: string;
  employeeId?: number | null;
  status?: string;
  gameTypeId?: number | null;
  stationId?: number | null;
  timerStartedAt?: Date | null;
  timerEndTime?: Date | null;
  gameType?: GameType | null;
};

export interface IStorage {
  sessionStore: session.Store;
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByPhone(phone: string): Promise<User | undefined>;
  getUserByIdentifier(identifier: string): Promise<User | undefined>;
  getUserByVerificationTokenHash(hash: string): Promise<User | undefined>;
  getUserByPasswordResetTokenHash(hash: string): Promise<User | undefined>;
  getUserByGoogleId(googleId: string): Promise<User | undefined>;
  createUser(user: any): Promise<User>;
  updateUser(id: number, user: Partial<InsertUser | User>): Promise<User>;
  invalidateUserSessions(userId: number): Promise<void>;

  // Session metadata & multi-device tracking
  createUserSession(data: {
    sessionIdHash: string;
    userId: number;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<UserSession>;
  getUserSessionByHash(sessionIdHash: string): Promise<UserSession | undefined>;
  touchUserSession(sessionIdHash: string, lastSeenAt: Date, expiresAt?: Date): Promise<void>;
  revokeUserSession(sessionIdHash: string): Promise<void>;
  revokeUserSessionById(sessionId: number, userId: number): Promise<boolean>;
  revokeAllUserSessions(userId: number, exceptSessionIdHash?: string): Promise<void>;
  getUserActiveSessions(userId: number, limit?: number): Promise<UserSession[]>;

  createAuditLog(log: { userId?: number | null; username: string; action: string; details?: string }): Promise<AuditLog>;
  getAuditLogs(filters?: AuditLogFilters | number, offset?: number, userId?: number): Promise<AuditLog[]>;
  getGameTypes(limit?: number, cursorId?: number): Promise<GameType[]>;
  getGameType(id: number): Promise<GameType | undefined>;
  createGameType(game: InsertGameType): Promise<GameType>;
  updateGameType(id: number, game: Partial<InsertGameType>): Promise<GameType>;
  deleteGameType(id: number): Promise<void>;

  // Stations
  getStations(filters?: StationFilters): Promise<(Station & { gameType?: GameType | null })[]>;
  getStationsByGameType(gameTypeId: number, limit?: number): Promise<Station[]>;
  getStation(id: number): Promise<Station | undefined>;
  createStation(station: InsertStation): Promise<Station>;
  updateStation(id: number, station: Partial<InsertStation>): Promise<Station>;
  deleteStation(id: number): Promise<void>;
  findAvailableStation(gameTypeId: number, startTime: Date, endTime: Date, excludeBookingId?: number): Promise<Station | undefined>;
  checkStationConflict(stationId: number, startTime: Date, endTime: Date, excludeBookingId?: number): Promise<Booking | undefined>;

  // Games Catalog
  getGames(filters?: GameFilters): Promise<Game[]>;
  getGame(id: number): Promise<Game | undefined>;
  createGame(game: InsertGame): Promise<Game>;
  updateGame(id: number, game: Partial<InsertGame>): Promise<Game>;
  deleteGame(id: number): Promise<void>;

  // Bookings
  getBookings(filters?: BookingFilters): Promise<(Booking & { gameType?: GameType | null; station?: Station | null; user?: SafeUser | User })[]>;
  getBooking(id: number): Promise<(Booking & { gameType?: GameType | null; station?: Station | null; user?: SafeUser | User | null }) | undefined>;
  getBookingsByUser(userId: number, filters?: BookingFilters): Promise<(Booking & { gameType?: GameType | null; station?: Station | null; user?: SafeUser | User })[]>;
  createBooking(booking: CreateBookingInput): Promise<Booking>;
  createBookingWithAutoStation(booking: CreateBookingInput & { gameTypeId: number }, idempotencyRecordId?: number): Promise<{ booking: Booking; station: Station }>;
  updateBooking(id: number, booking: Partial<Booking>): Promise<Booking>;
  updateBookingStatus(id: number, status: string): Promise<Booking>;
  checkBookingConflict(gameTypeId: number, startTime: Date, endTime: Date, excludeBookingId?: number): Promise<Booking | undefined>;
  getAllUsers(filters?: UserFilters): Promise<SafeUser[]>;
  withTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;

  // Settings
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  hasAdminUser(): Promise<boolean>;

  // Admin Stats
  getAdminStats(): Promise<any>;

  // Idempotency
  getIdempotencyKey(userId: number, key: string): Promise<IdempotencyKey | undefined>;
  createIdempotencyKey(data: {
    key: string;
    userId: number;
    requestPath: string;
    requestHash: string;
    expiresAt: Date;
  }): Promise<IdempotencyKey>;
  updateIdempotencyKey(id: number, data: Partial<IdempotencyKey>): Promise<IdempotencyKey>;
  deleteIdempotencyKey(id: number): Promise<void>;

  // Privacy & Retention
  deleteExpiredUserSessions(cutoffDate: Date): Promise<number>;
  deleteExpiredIdempotencyKeys(cutoffDate: Date): Promise<number>;
  deleteStaleUnverifiedUsers(cutoffDate: Date): Promise<number>;
}

const PostgresSessionStore = connectPg(session);

export class DatabaseStorage implements IStorage {
  sessionStore: session.Store;

  constructor() {
    if (pool) {
      this.sessionStore = new PostgresSessionStore({
        pool,
        createTableIfMissing: true,
      });
    } else {
      this.sessionStore = new session.MemoryStore();
    }
  }

  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return this.getUserByIdentifier(username);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const term = email.toLowerCase().trim();
    const [user] = await db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = ${term}`);
    return user;
  }

  async getUserByPhone(phone: string): Promise<User | undefined> {
    const raw = phone.trim();
    const digitsOnly = raw.replace(/\D/g, "");
    if (!digitsOnly) return undefined;
    const [user] = await db
      .select()
      .from(users)
      .where(
        sql`${users.phone} = ${raw} OR REGEXP_REPLACE(COALESCE(${users.phone}, ''), '[^0-9]', '', 'g') = ${digitsOnly}`
      );
    return user;
  }

  async getUserByIdentifier(identifier: string): Promise<User | undefined> {
    const term = identifier.toLowerCase().trim();
    const digitsOnly = identifier.replace(/\D/g, "");

    if (digitsOnly.length >= 7 && !term.includes("@")) {
      const [user] = await db
        .select()
        .from(users)
        .where(
          sql`LOWER(${users.username}) = ${term} OR LOWER(${users.email}) = ${term} OR ${users.phone} = ${identifier.trim()} OR REGEXP_REPLACE(COALESCE(${users.phone}, ''), '[^0-9]', '', 'g') = ${digitsOnly}`
        );
      return user;
    }

    const [user] = await db
      .select()
      .from(users)
      .where(sql`LOWER(${users.username}) = ${term} OR LOWER(${users.email}) = ${term}`);
    return user;
  }

  async getUserByVerificationTokenHash(hash: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.emailVerificationTokenHash, hash));
    return user;
  }

  async getUserByPasswordResetTokenHash(hash: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.passwordResetTokenHash, hash));
    return user;
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.googleId, googleId));
    return user;
  }

  async invalidateUserSessions(userId: number): Promise<void> {
    await db
      .update(users)
      .set({ tokenVersion: sql`COALESCE(${users.tokenVersion}, 1) + 1` })
      .where(eq(users.id, userId));

    await this.revokeAllUserSessions(userId).catch(() => {});

    try {
      if (pool) {
        await pool.query(
          `DELETE FROM session WHERE sess::text LIKE $1`,
          [`%"id":${userId}%`]
        );
      }
    } catch {
      // If table doesn't exist or query fails, tokenVersion increment provides bulletproof invalidation in deserializeUser
    }
  }

  async createUserSession(data: {
    sessionIdHash: string;
    userId: number;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<UserSession> {
    const [sessionRecord] = await db
      .insert(userSessions)
      .values({
        sessionIdHash: data.sessionIdHash,
        userId: data.userId,
        expiresAt: data.expiresAt,
        ipAddress: data.ipAddress ?? null,
        userAgent: data.userAgent ?? null,
      })
      .returning();
    return sessionRecord;
  }

  async getUserSessionByHash(sessionIdHash: string): Promise<UserSession | undefined> {
    const [sessionRecord] = await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.sessionIdHash, sessionIdHash));
    return sessionRecord;
  }

  async touchUserSession(sessionIdHash: string, lastSeenAt: Date, expiresAt?: Date): Promise<void> {
    const updateData: any = { lastSeenAt };
    if (expiresAt) {
      updateData.expiresAt = expiresAt;
    }
    await db
      .update(userSessions)
      .set(updateData)
      .where(eq(userSessions.sessionIdHash, sessionIdHash));
  }

  async revokeUserSession(sessionIdHash: string): Promise<void> {
    await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(userSessions.sessionIdHash, sessionIdHash));
  }

  async revokeUserSessionById(sessionId: number, userId: number): Promise<boolean> {
    const [existing] = await db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, userId)));
    if (!existing) return false;

    await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(userSessions.id, sessionId));

    return true;
  }

  async revokeAllUserSessions(userId: number, exceptSessionIdHash?: string): Promise<void> {
    const condition = exceptSessionIdHash
      ? and(eq(userSessions.userId, userId), ne(userSessions.sessionIdHash, exceptSessionIdHash))
      : eq(userSessions.userId, userId);

    await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(condition);
  }

  async getUserActiveSessions(userId: number, limit = 50): Promise<UserSession[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, userId),
          sql`${userSessions.revokedAt} IS NULL`,
          gt(userSessions.expiresAt, new Date())
        )
      )
      .orderBy(desc(userSessions.lastSeenAt), desc(userSessions.id))
      .limit(safeLimit);
  }

  async getIdempotencyKey(userId: number, key: string): Promise<IdempotencyKey | undefined> {
    const [record] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    return record;
  }

  async createIdempotencyKey(data: {
    key: string;
    userId: number;
    requestPath: string;
    requestHash: string;
    expiresAt: Date;
  }): Promise<IdempotencyKey> {
    const [record] = await db
      .insert(idempotencyKeys)
      .values({
        key: data.key,
        userId: data.userId,
        requestPath: data.requestPath,
        requestHash: data.requestHash,
        status: "PROCESSING",
        expiresAt: data.expiresAt,
      })
      .returning();
    return record;
  }

  async updateIdempotencyKey(id: number, data: Partial<IdempotencyKey>): Promise<IdempotencyKey> {
    const [updated] = await db
      .update(idempotencyKeys)
      .set(data)
      .where(eq(idempotencyKeys.id, id))
      .returning();
    return updated;
  }

  async deleteIdempotencyKey(id: number): Promise<void> {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
  }

  async deleteExpiredUserSessions(cutoffDate: Date): Promise<number> {
    const result = await db.delete(userSessions).where(
      or(
        lt(userSessions.expiresAt, cutoffDate),
        and(sql`${userSessions.revokedAt} IS NOT NULL`, lt(userSessions.revokedAt, cutoffDate))
      )
    );
    return (result as any)?.rowCount || 0;
  }

  async deleteExpiredIdempotencyKeys(cutoffDate: Date): Promise<number> {
    const result = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, cutoffDate));
    return (result as any)?.rowCount || 0;
  }

  async deleteStaleUnverifiedUsers(cutoffDate: Date): Promise<number> {
    const candidates = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.isEmailVerified, false),
          eq(users.role, "member"),
          lt(users.createdAt, cutoffDate)
        )
      );

    let deleted = 0;
    for (const c of candidates) {
      const [booking] = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.userId, c.id))
        .limit(1);
      if (!booking) {
        await db.delete(users).where(eq(users.id, c.id));
        deleted++;
      }
    }
    return deleted;
  }

  async createAuditLog(log: { userId?: number | null; username: string; action: string; details?: string }): Promise<AuditLog> {
    const [entry] = await db.insert(auditLogs).values({
      userId: log.userId ?? null,
      username: log.username,
      action: log.action,
      details: log.details ?? null,
    }).returning();
    return entry;
  }

  async getAuditLogs(
    filtersOrLimit?: AuditLogFilters | number,
    offset = 0,
    maybeUserId?: number
  ): Promise<AuditLog[]> {
    let filters: AuditLogFilters | undefined;
    let safeLimit = 25;
    let safeOffset = 0;

    if (typeof filtersOrLimit === "object" && filtersOrLimit !== null) {
      filters = filtersOrLimit;
      safeLimit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
      safeOffset = Math.max(filters.offset ?? 0, 0);
    } else {
      safeLimit = Math.min(Math.max(typeof filtersOrLimit === "number" ? filtersOrLimit : 25, 1), 100);
      safeOffset = Math.max(offset, 0);
      if (maybeUserId !== undefined) {
        filters = { userId: maybeUserId, limit: safeLimit, offset: safeOffset };
      }
    }

    const conditions = [];
    if (filters?.userId !== undefined) {
      conditions.push(eq(auditLogs.userId, filters.userId));
    }
    if (filters?.action) {
      conditions.push(eq(auditLogs.action, filters.action));
    }
    if (filters?.fromDate) {
      conditions.push(gte(auditLogs.createdAt, filters.fromDate));
    }
    if (filters?.toDate) {
      conditions.push(lte(auditLogs.createdAt, filters.toDate));
    }
    if (filters?.cursor) {
      conditions.push(
        or(
          lt(auditLogs.createdAt, filters.cursor.createdAt),
          and(eq(auditLogs.createdAt, filters.cursor.createdAt), lt(auditLogs.id, filters.cursor.id))
        )
      );
    }

    const baseQuery = conditions.length > 0
      ? db.select().from(auditLogs).where(and(...conditions))
      : db.select().from(auditLogs);

    const fetchLimit = safeLimit + 1;

    return await (baseQuery as any)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(fetchLimit)
      .offset(filters?.cursor ? 0 : safeOffset);
  }

  async withTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    return await db.transaction(callback);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(id: number, user: Partial<InsertUser | User>): Promise<User> {
    const [updated] = await db.update(users).set(user).where(eq(users.id, id)).returning();
    return updated;
  }

  async getGameTypes(limit = 50, cursorId?: number): Promise<GameType[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    let query = db.select().from(gameTypes);
    if (cursorId) {
      query = query.where(gt(gameTypes.id, cursorId)) as any;
    }
    return await (query as any).orderBy(asc(gameTypes.id)).limit(safeLimit);
  }

  async getGameType(id: number): Promise<GameType | undefined> {
    const [game] = await db.select().from(gameTypes).where(eq(gameTypes.id, id));
    return game;
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

  // Stations
  async getStations(filters?: StationFilters): Promise<(Station & { gameType?: GameType | null })[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 25, 1), 100);
    const offset = Math.max(filters?.offset ?? 0, 0);
    const conditions: any[] = [];
    if (filters?.gameTypeId) {
      conditions.push(eq(stations.gameTypeId, filters.gameTypeId));
    }
    if (filters?.status) {
      conditions.push(eq(stations.status, filters.status));
    }
    if (filters?.cursor) {
      conditions.push(gt(stations.id, filters.cursor.id));
    }

    let query = db
      .select({
        station: stations,
        gameType: gameTypes,
      })
      .from(stations)
      .leftJoin(gameTypes, eq(stations.gameTypeId, gameTypes.id));

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const fetchLimit = limit + 1;

    const rows = await (query as any)
      .orderBy(asc(stations.id))
      .limit(fetchLimit)
      .offset(filters?.cursor ? 0 : offset);

    return rows.map((r: any) => ({
      ...r.station,
      gameType: r.gameType || null,
    }));
  }

  async getStationsByGameType(gameTypeId: number, limit = 50): Promise<Station[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return await db
      .select()
      .from(stations)
      .where(eq(stations.gameTypeId, gameTypeId))
      .orderBy(asc(stations.id))
      .limit(safeLimit);
  }

  async getStation(id: number): Promise<Station | undefined> {
    const [station] = await db.select().from(stations).where(eq(stations.id, id));
    return station;
  }

  async createStation(station: InsertStation): Promise<Station> {
    const [newStation] = await db.insert(stations).values(station).returning();
    return newStation;
  }

  async updateStation(id: number, station: Partial<InsertStation>): Promise<Station> {
    const [updated] = await db.update(stations).set(station).where(eq(stations.id, id)).returning();
    return updated;
  }

  async deleteStation(id: number): Promise<void> {
    await db.delete(stations).where(eq(stations.id, id));
  }

  async checkStationConflict(stationId: number, startTime: Date, endTime: Date, excludeBookingId?: number): Promise<Booking | undefined> {
    const conditions = [
      eq(bookings.stationId, stationId),
      sql`${bookings.status} NOT IN ('Cancelled', 'Rejected')`,
      lt(bookings.startTime, endTime),
      gt(bookings.endTime, startTime),
    ];
    if (excludeBookingId) {
      conditions.push(ne(bookings.id, excludeBookingId));
    }
    const [conflict] = await db.select().from(bookings).where(and(...conditions));
    return conflict;
  }

  async findAvailableStation(gameTypeId: number, startTime: Date, endTime: Date, excludeBookingId?: number): Promise<Station | undefined> {
    const candidateStations = await db
      .select()
      .from(stations)
      .where(and(eq(stations.gameTypeId, gameTypeId), sql`UPPER(${stations.status}) = 'AVAILABLE'`))
      .orderBy(stations.id);

    for (const candidate of candidateStations) {
      const conflict = await this.checkStationConflict(candidate.id, startTime, endTime, excludeBookingId);
      if (!conflict) {
        return candidate;
      }
    }
    return undefined;
  }

  async getBookings(filters?: BookingFilters): Promise<(Booking & { gameType?: GameType | null; station?: Station | null; user: SafeUser })[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 25, 1), 100);
    const offset = Math.max(filters?.offset ?? 0, 0);

    const conditions: any[] = [];
    if (filters?.status) {
      conditions.push(eq(bookings.status, filters.status));
    }
    if (filters?.stationId) {
      conditions.push(eq(bookings.stationId, filters.stationId));
    }
    if (filters?.userId) {
      conditions.push(eq(bookings.userId, filters.userId));
    }
    if (filters?.fromDate) {
      conditions.push(gte(bookings.startTime, filters.fromDate));
    }
    if (filters?.toDate) {
      conditions.push(lte(bookings.endTime, filters.toDate));
    }
    if (filters?.cursor) {
      conditions.push(
        or(
          lt(bookings.createdAt, filters.cursor.createdAt),
          and(eq(bookings.createdAt, filters.cursor.createdAt), lt(bookings.id, filters.cursor.id))
        )
      );
    }

    let query: any = db
      .select({
        booking: bookings,
        gameType: gameTypes,
        station: stations,
        user: {
          id: users.id,
          username: users.username,
          email: users.email,
          fullName: users.fullName,
          phone: users.phone,
          avatarUrl: users.avatarUrl,
          membershipTier: users.membershipTier,
          role: users.role,
          createdAt: users.createdAt,
        },
      })
      .from(bookings)
      .leftJoin(gameTypes, eq(bookings.gameTypeId, gameTypes.id))
      .leftJoin(stations, eq(bookings.stationId, stations.id))
      .innerJoin(users, eq(bookings.userId, users.id));

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const fetchLimit = limit + 1;

    const rows = await query
      .orderBy(desc(bookings.createdAt), desc(bookings.id))
      .limit(fetchLimit)
      .offset(filters?.cursor ? 0 : offset);

    return rows.map((row: any) => ({
      ...row.booking,
      gameType: row.gameType || null,
      station: row.station || null,
      user: row.user,
    }));
  }

  async getBooking(id: number): Promise<(Booking & { gameType?: GameType | null; station?: Station | null; user?: SafeUser | null }) | undefined> {
    const rows = await db
      .select({
        booking: bookings,
        gameType: gameTypes,
        station: stations,
        user: {
          id: users.id,
          username: users.username,
          email: users.email,
          fullName: users.fullName,
          phone: users.phone,
          avatarUrl: users.avatarUrl,
          membershipTier: users.membershipTier,
          role: users.role,
          createdAt: users.createdAt,
        },
      })
      .from(bookings)
      .leftJoin(gameTypes, eq(bookings.gameTypeId, gameTypes.id))
      .leftJoin(stations, eq(bookings.stationId, stations.id))
      .leftJoin(users, eq(bookings.userId, users.id))
      .where(eq(bookings.id, id));

    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      ...row.booking,
      gameType: row.gameType || null,
      station: row.station || null,
      user: row.user || null,
    };
  }

  async getAllUsers(filters?: UserFilters): Promise<SafeUser[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 25, 1), 100);
    const offset = Math.max(filters?.offset ?? 0, 0);

    const conditions: any[] = [];
    if (filters?.role) {
      conditions.push(eq(users.role, filters.role as any));
    }
    if (filters?.membershipTier) {
      conditions.push(eq(users.membershipTier, filters.membershipTier));
    }
    if (filters?.cursor) {
      conditions.push(
        or(
          lt(users.createdAt, filters.cursor.createdAt),
          and(eq(users.createdAt, filters.cursor.createdAt), lt(users.id, filters.cursor.id))
        )
      );
    }

    let query: any = db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        fullName: users.fullName,
        phone: users.phone,
        avatarUrl: users.avatarUrl,
        membershipTier: users.membershipTier,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users);

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const fetchLimit = limit + 1;

    return await query
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(fetchLimit)
      .offset(filters?.cursor ? 0 : offset);
  }

  async getBookingsByUser(
    userId: number,
    filters?: BookingFilters
  ): Promise<(Booking & { gameType?: GameType | null; station?: Station | null; user?: SafeUser | User })[]> {
    return this.getBookings({ ...filters, userId });
  }

  async createBooking(booking: CreateBookingInput): Promise<Booking> {
    const [newBooking] = await db.insert(bookings).values(booking).returning();
    return newBooking;
  }

  async createBookingWithAutoStation(bookingData: CreateBookingInput & { gameTypeId: number }, idempotencyRecordId?: number): Promise<{ booking: Booking; station: Station }> {
    return await db.transaction(async (tx: any) => {
      const { gameType, ...insertData } = bookingData;
      if (bookingData.stationId) {
        const [targetStation] = await tx
          .select()
          .from(stations)
          .where(and(eq(stations.id, bookingData.stationId), sql`UPPER(${stations.status}) = 'AVAILABLE'`))
          .for("update");

        if (!targetStation) {
          throw new Error("Selected station is unavailable or does not exist.");
        }

        const conflictConditions = [
          eq(bookings.stationId, targetStation.id),
          sql`${bookings.status} NOT IN ('Cancelled', 'Rejected')`,
          lt(bookings.startTime, bookingData.endTime),
          gt(bookings.endTime, bookingData.startTime),
        ];
        const [conflict] = await tx.select().from(bookings).where(and(...conflictConditions));
        if (conflict) {
          throw new Error(`Station ${targetStation.name} is already booked for this time.`);
        }

        // Database-level GiST exclusion constraint guarantees no double-booking atomically
        const [createdBooking] = await tx.insert(bookings).values({
          ...insertData,
          stationId: targetStation.id,
          locationId: targetStation.locationId || bookingData.locationId || "main-lounge",
        }).returning();

        // Transactionally associate idempotency completion with booking creation
        if (idempotencyRecordId) {
          await tx
            .update(idempotencyKeys)
            .set({
              status: "COMPLETED",
              statusCode: 201,
              responseBody: JSON.stringify({ ...createdBooking, gameType: gameType || null, station: targetStation }),
              bookingId: createdBooking.id,
            })
            .where(eq(idempotencyKeys.id, idempotencyRecordId));
        }

        return { booking: createdBooking, station: targetStation };
      }

      // Concurrency protection: lock available stations for update within transaction in deterministic order
      const candidateStations = await tx
        .select()
        .from(stations)
        .where(and(eq(stations.gameTypeId, bookingData.gameTypeId), sql`UPPER(${stations.status}) = 'AVAILABLE'`))
        .orderBy(stations.id)
        .for("update");

      if (candidateStations.length === 0) {
        throw new Error("No active stations available for this gaming category.");
      }

      for (const candidate of candidateStations) {
        const conflictConditions = [
          eq(bookings.stationId, candidate.id),
          sql`${bookings.status} NOT IN ('Cancelled', 'Rejected')`,
          lt(bookings.startTime, bookingData.endTime),
          gt(bookings.endTime, bookingData.startTime),
        ];
        const [conflict] = await tx.select().from(bookings).where(and(...conflictConditions));
        if (!conflict) {
          try {
            // Use SAVEPOINT so a concurrent conflict on candidate doesn't abort the outer transaction
            const [createdBooking] = await tx.transaction(async (sp: any) => {
              return await sp.insert(bookings).values({
                ...insertData,
                stationId: candidate.id,
                locationId: candidate.locationId || bookingData.locationId || "main-lounge",
              }).returning();
            });

            // Transactionally associate idempotency completion with booking creation
            if (idempotencyRecordId) {
              await tx
                .update(idempotencyKeys)
                .set({
                  status: "COMPLETED",
                  statusCode: 201,
                  responseBody: JSON.stringify({ ...createdBooking, gameType: gameType || null, station: candidate }),
                  bookingId: createdBooking.id,
                })
                .where(eq(idempotencyKeys.id, idempotencyRecordId));
            }

            return { booking: createdBooking, station: candidate };
          } catch (insertErr: any) {
            if (isBookingConflictError(insertErr)) {
              continue;
            }
            throw insertErr;
          }
        }
      }

      throw new Error("All stations for this category are fully booked for the selected time slot.");
    });
  }

  async updateBooking(id: number, booking: Partial<Booking>): Promise<Booking> {
    const [updated] = await db.update(bookings).set(booking).where(eq(bookings.id, id)).returning();
    return updated;
  }

  async updateBookingStatus(id: number, status: string): Promise<Booking> {
    const [updated] = await db.update(bookings).set({ status }).where(eq(bookings.id, id)).returning();
    return updated;
  }

  async checkBookingConflict(gameTypeId: number, startTime: Date, endTime: Date, excludeBookingId?: number): Promise<Booking | undefined> {
    const availableStation = await this.findAvailableStation(gameTypeId, startTime, endTime, excludeBookingId);
    if (!availableStation) {
      const conditions = [
        eq(bookings.gameTypeId, gameTypeId),
        sql`${bookings.status} NOT IN ('Cancelled', 'Rejected')`,
        lt(bookings.startTime, endTime),
        gt(bookings.endTime, startTime)
      ];
      if (excludeBookingId) {
        conditions.push(ne(bookings.id, excludeBookingId));
      }
      const [conflict] = await db.select().from(bookings).where(and(...conditions));
      return conflict || ({ startTime, endTime, status: "Booked" } as any);
    }
    return undefined;
  }

  async getSetting(key: string): Promise<string | undefined> {
    const [s] = await db.select().from(settings).where(eq(settings.key, key));
    return s?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  async deleteSetting(key: string): Promise<void> {
    await db.delete(settings).where(eq(settings.key, key));
  }

  async hasAdminUser(): Promise<boolean> {
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
    return Boolean(admin);
  }

  async getGames(filters?: GameFilters): Promise<Game[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 25, 1), 100);
    const offset = Math.max(filters?.offset ?? 0, 0);
    const conditions: any[] = [];
    if (filters?.genre) {
      conditions.push(eq(games.genre, filters.genre));
    }
    if (filters?.platform) {
      conditions.push(sql`${games.platforms} ILIKE ${'%' + filters.platform + '%'}`);
    }
    if (filters?.cursor) {
      conditions.push(gt(games.id, filters.cursor.id));
    }

    let query: any = db.select().from(games);
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const fetchLimit = limit + 1;

    return await query
      .orderBy(asc(games.id))
      .limit(fetchLimit)
      .offset(filters?.cursor ? 0 : offset);
  }

  async getGame(id: number): Promise<Game | undefined> {
    const [game] = await db.select().from(games).where(eq(games.id, id));
    return game;
  }

  async createGame(game: InsertGame): Promise<Game> {
    const [newGame] = await db.insert(games).values(game).returning();
    return newGame;
  }

  async updateGame(id: number, game: Partial<InsertGame>): Promise<Game> {
    const [updated] = await db.update(games).set(game).where(eq(games.id, id)).returning();
    return updated;
  }

  async deleteGame(id: number): Promise<void> {
    await db.delete(games).where(eq(games.id, id));
  }

  async getAdminStats(): Promise<any> {
    const { getAdminStats } = await import("./stats");
    return await getAdminStats();
  }
}

export class MemStorage implements IStorage {
  private users = new Map<number, User>();
  private gameTypes = new Map<number, GameType>();
  private games = new Map<number, Game>();
  private stations = new Map<number, Station>();
  private bookings = new Map<number, Booking>();
  private settings = new Map<string, string>();
  private userSessions = new Map<number, UserSession>();
  private idempotencyKeys = new Map<number, IdempotencyKey>();
  sessionStore: session.Store;

  private currentUserId = 1;
  private currentGameTypeId = 1;
  private currentGameId = 1;
  private currentStationId = 1;
  private currentBookingId = 1;
  private currentUserSessionId = 1;
  private currentIdempotencyId = 1;

  constructor() {
    this.sessionStore = new session.MemoryStore();
  }

  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return this.getUserByIdentifier(username);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const term = email.toLowerCase().trim();
    return Array.from(this.users.values()).find(
      u => u.email && u.email.toLowerCase().trim() === term
    );
  }

  async getUserByPhone(phone: string): Promise<User | undefined> {
    const raw = phone.trim();
    const cleanDigits = raw.replace(/\D/g, "");
    return Array.from(this.users.values()).find(u => {
      if (!u.phone) return false;
      if (u.phone.trim() === raw) return true;
      return cleanDigits.length >= 7 && u.phone.replace(/\D/g, "") === cleanDigits;
    });
  }

  async getUserByIdentifier(identifier: string): Promise<User | undefined> {
    const term = identifier.toLowerCase().trim();
    const cleanDigits = identifier.replace(/\D/g, "");
    return Array.from(this.users.values()).find(u => {
      if (u.username.toLowerCase().trim() === term) return true;
      if (u.email && u.email.toLowerCase().trim() === term) return true;
      if (u.phone) {
        if (u.phone.trim() === identifier.trim()) return true;
        if (cleanDigits.length >= 7 && u.phone.replace(/\D/g, "") === cleanDigits) return true;
      }
      return false;
    });
  }

  async getUserByVerificationTokenHash(hash: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      u => u.emailVerificationTokenHash === hash
    );
  }

  async getUserByPasswordResetTokenHash(hash: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      u => u.passwordResetTokenHash === hash
    );
  }

  async getUserByGoogleId(googleId: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      u => u.googleId === googleId
    );
  }

  async createUser(insertUser: any): Promise<User> {
    const id = this.currentUserId++;
    const user: User = {
      id,
      createdAt: new Date(),
      role: insertUser.role || "member",
      username: insertUser.username,
      password: insertUser.password,
      email: insertUser.email ?? null,
      fullName: insertUser.fullName ?? null,
      phone: insertUser.phone ?? null,
      avatarUrl: insertUser.avatarUrl ?? null,
      membershipTier: insertUser.membershipTier ?? "bronze",
      authProvider: insertUser.authProvider ?? "local",
      googleId: insertUser.googleId ?? null,
      isEmailVerified: Boolean(insertUser.isEmailVerified),
      emailVerifiedAt: insertUser.emailVerifiedAt ?? null,
      emailVerificationTokenHash: insertUser.emailVerificationTokenHash ?? null,
      emailVerificationTokenExpiresAt: insertUser.emailVerificationTokenExpiresAt ?? null,
      resetRequired: Boolean(insertUser.resetRequired),
      passwordResetTokenHash: insertUser.passwordResetTokenHash ?? null,
      passwordResetTokenExpiresAt: insertUser.passwordResetTokenExpiresAt ?? null,
      tokenVersion: insertUser.tokenVersion ?? 1,
      isMfaEnabled: Boolean(insertUser.isMfaEnabled),
      mfaSecret: insertUser.mfaSecret ?? null,
      mfaRecoveryCodes: insertUser.mfaRecoveryCodes ?? null,
      mfaLastUsedTimestep: insertUser.mfaLastUsedTimestep ?? null,
    };
    this.users.set(id, user);
    return user;
  }

  async invalidateUserSessions(userId: number): Promise<void> {
    const user = this.users.get(userId);
    if (user) {
      user.tokenVersion = (user.tokenVersion || 1) + 1;
      this.users.set(userId, user);
    }
    await this.revokeAllUserSessions(userId);
  }

  async createUserSession(data: {
    sessionIdHash: string;
    userId: number;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<UserSession> {
    const id = this.currentUserSessionId++;
    const now = new Date();
    const sessionRecord: UserSession = {
      id,
      sessionIdHash: data.sessionIdHash,
      userId: data.userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: data.expiresAt,
      ipAddress: data.ipAddress ?? null,
      userAgent: data.userAgent ?? null,
      revokedAt: null,
    };
    this.userSessions.set(id, sessionRecord);
    return sessionRecord;
  }

  async getUserSessionByHash(sessionIdHash: string): Promise<UserSession | undefined> {
    return Array.from(this.userSessions.values()).find(
      (s) => s.sessionIdHash === sessionIdHash
    );
  }

  async touchUserSession(sessionIdHash: string, lastSeenAt: Date, expiresAt?: Date): Promise<void> {
    const sessionRecord = await this.getUserSessionByHash(sessionIdHash);
    if (sessionRecord) {
      sessionRecord.lastSeenAt = lastSeenAt;
      if (expiresAt) {
        sessionRecord.expiresAt = expiresAt;
      }
      this.userSessions.set(sessionRecord.id, sessionRecord);
    }
  }

  async revokeUserSession(sessionIdHash: string): Promise<void> {
    const sessionRecord = await this.getUserSessionByHash(sessionIdHash);
    if (sessionRecord) {
      sessionRecord.revokedAt = new Date();
      this.userSessions.set(sessionRecord.id, sessionRecord);
    }
  }

  async revokeUserSessionById(sessionId: number, userId: number): Promise<boolean> {
    const sessionRecord = this.userSessions.get(sessionId);
    if (!sessionRecord || sessionRecord.userId !== userId) {
      return false;
    }
    sessionRecord.revokedAt = new Date();
    this.userSessions.set(sessionId, sessionRecord);
    return true;
  }

  async revokeAllUserSessions(userId: number, exceptSessionIdHash?: string): Promise<void> {
    for (const [id, sessionRecord] of this.userSessions.entries()) {
      if (sessionRecord.userId === userId) {
        if (!exceptSessionIdHash || sessionRecord.sessionIdHash !== exceptSessionIdHash) {
          sessionRecord.revokedAt = new Date();
          this.userSessions.set(id, sessionRecord);
        }
      }
    }
  }

  async getUserActiveSessions(userId: number, limit = 50): Promise<UserSession[]> {
    const now = new Date();
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return Array.from(this.userSessions.values())
      .filter((s) => s.userId === userId && !s.revokedAt && s.expiresAt > now)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .slice(0, safeLimit);
  }

  async getIdempotencyKey(userId: number, key: string): Promise<IdempotencyKey | undefined> {
    return Array.from(this.idempotencyKeys.values()).find(
      (ik) => ik.userId === userId && ik.key === key
    );
  }

  async createIdempotencyKey(data: {
    key: string;
    userId: number;
    requestPath: string;
    requestHash: string;
    expiresAt: Date;
  }): Promise<IdempotencyKey> {
    const existing = await this.getIdempotencyKey(data.userId, data.key);
    if (existing) {
      const err: any = new Error("Unique constraint violation for idempotency key");
      err.code = "23505";
      throw err;
    }
    const id = this.currentIdempotencyId++;
    const now = new Date();
    const record: IdempotencyKey = {
      id,
      key: data.key,
      userId: data.userId,
      requestPath: data.requestPath,
      requestHash: data.requestHash,
      status: "PROCESSING",
      statusCode: null,
      responseBody: null,
      bookingId: null,
      lockedAt: now,
      createdAt: now,
      expiresAt: data.expiresAt,
    };
    this.idempotencyKeys.set(id, record);
    return record;
  }

  async updateIdempotencyKey(id: number, data: Partial<IdempotencyKey>): Promise<IdempotencyKey> {
    const existing = this.idempotencyKeys.get(id);
    if (!existing) throw new Error("Idempotency key not found");
    const updated = { ...existing, ...data } as IdempotencyKey;
    this.idempotencyKeys.set(id, updated);
    return updated;
  }

  async deleteIdempotencyKey(id: number): Promise<void> {
    this.idempotencyKeys.delete(id);
  }

  async deleteExpiredUserSessions(cutoffDate: Date): Promise<number> {
    let count = 0;
    for (const [id, s] of this.userSessions.entries()) {
      if (s.expiresAt < cutoffDate || (s.revokedAt && s.revokedAt < cutoffDate)) {
        this.userSessions.delete(id);
        count++;
      }
    }
    return count;
  }

  async deleteExpiredIdempotencyKeys(cutoffDate: Date): Promise<number> {
    let count = 0;
    for (const [id, k] of this.idempotencyKeys.entries()) {
      if (k.expiresAt < cutoffDate) {
        this.idempotencyKeys.delete(id);
        count++;
      }
    }
    return count;
  }

  async deleteStaleUnverifiedUsers(cutoffDate: Date): Promise<number> {
    let count = 0;
    for (const [id, u] of this.users.entries()) {
      if (u.isEmailVerified === false && u.role === "member" && u.createdAt && u.createdAt < cutoffDate) {
        const hasBookings = Array.from(this.bookings.values()).some((b) => b.userId === id);
        if (!hasBookings) {
          this.users.delete(id);
          count++;
        }
      }
    }
    return count;
  }

  async updateUser(id: number, user: Partial<InsertUser | User>): Promise<User> {
    const existing = this.users.get(id);
    if (!existing) throw new Error("User not found");
    const updated = { ...existing, ...user } as User;
    this.users.set(id, updated);
    return updated;
  }

  async getGameTypes(limit = 50, cursorId?: number): Promise<GameType[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    let list = Array.from(this.gameTypes.values()).sort((a, b) => a.id - b.id);
    if (cursorId !== undefined) {
      list = list.filter(gt => gt.id > cursorId);
    }
    return list.slice(0, safeLimit);
  }

  async getGameType(id: number): Promise<GameType | undefined> {
    return this.gameTypes.get(id);
  }

  async createGameType(game: InsertGameType): Promise<GameType> {
    const id = this.currentGameTypeId++;
    const newGame: GameType = {
      id,
      isActive: true,
      priceModel: "flat",
      description: null,
      imageUrl: null,
      ...game
    };
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

  // Stations
  async getStations(filters?: StationFilters): Promise<(Station & { gameType?: GameType | null })[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 25, 1), 100);
    const offset = Math.max(filters?.offset ?? 0, 0);

    let list = Array.from(this.stations.values());
    if (filters?.gameTypeId) {
      list = list.filter(s => s.gameTypeId === filters.gameTypeId);
    }
    if (filters?.status) {
      list = list.filter(s => s.status === filters.status);
    }

    list.sort((a, b) => a.id - b.id);

    if (filters?.cursor) {
      list = list.filter(s => s.id > filters.cursor!.id);
    }

    const fetchLimit = limit + 1;
    const paged = list.slice(filters?.cursor ? 0 : offset, (filters?.cursor ? 0 : offset) + fetchLimit);

    return paged.map(station => ({
      ...station,
      gameType: this.gameTypes.get(station.gameTypeId) || null,
    }));
  }

  async getStationsByGameType(gameTypeId: number, limit = 50): Promise<Station[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return Array.from(this.stations.values())
      .filter(s => s.gameTypeId === gameTypeId)
      .sort((a, b) => a.id - b.id)
      .slice(0, safeLimit);
  }

  async getStation(id: number): Promise<Station | undefined> {
    return this.stations.get(id);
  }

  async createStation(station: InsertStation): Promise<Station> {
    const id = this.currentStationId++;
    const newStation: Station = {
      id,
      name: station.name,
      gameTypeId: station.gameTypeId,
      status: (station.status || "AVAILABLE").toUpperCase() as any,
      locationId: (station as any).locationId || "loc_kolkata_main",
      createdAt: new Date(),
    };
    this.stations.set(id, newStation);
    return newStation;
  }

  async updateStation(id: number, station: Partial<InsertStation>): Promise<Station> {
    const existing = this.stations.get(id);
    if (!existing) throw new Error("Station not found");
    const updated: Station = {
      ...existing,
      ...station,
      status: station.status ? (station.status.toUpperCase() as any) : existing.status,
    };
    this.stations.set(id, updated);
    return updated;
  }

  async deleteStation(id: number): Promise<void> {
    this.stations.delete(id);
  }

  async checkStationConflict(stationId: number, startTime: Date, endTime: Date, excludeBookingId?: number): Promise<Booking | undefined> {
    const startMs = new Date(startTime).getTime();
    const endMs = new Date(endTime).getTime();

    for (const b of Array.from(this.bookings.values())) {
      if (b.stationId === stationId && b.status !== 'Cancelled' && b.status !== 'Rejected' && (!excludeBookingId || b.id !== excludeBookingId)) {
        const bStart = new Date(b.startTime).getTime();
        const bEnd = new Date(b.endTime).getTime();
        if (bStart < endMs && bEnd > startMs) {
          return b;
        }
      }
    }
    return undefined;
  }

  async findAvailableStation(gameTypeId: number, startTime: Date, endTime: Date, excludeBookingId?: number): Promise<Station | undefined> {
    const candidateStations = Array.from(this.stations.values())
      .filter(s => s.gameTypeId === gameTypeId && s.status?.toUpperCase() === 'AVAILABLE')
      .sort((a, b) => a.id - b.id);

    for (const candidate of candidateStations) {
      const conflict = await this.checkStationConflict(candidate.id, startTime, endTime, excludeBookingId);
      if (!conflict) {
        return candidate;
      }
    }
    return undefined;
  }

  async getGames(filters?: GameFilters): Promise<Game[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 25, 1), 100);
    const offset = Math.max(filters?.offset ?? 0, 0);

    let list = Array.from(this.games.values());
    if (filters?.genre) {
      list = list.filter(g => g.genre?.toLowerCase() === filters.genre!.toLowerCase());
    }
    if (filters?.platform) {
      list = list.filter(g => g.platforms?.toLowerCase().includes(filters.platform!.toLowerCase()));
    }

    list.sort((a, b) => a.id - b.id);

    if (filters?.cursor) {
      list = list.filter(g => g.id > filters.cursor!.id);
    }

    const fetchLimit = limit + 1;
    return list.slice(filters?.cursor ? 0 : offset, (filters?.cursor ? 0 : offset) + fetchLimit);
  }

  async getGame(id: number): Promise<Game | undefined> {
    return this.games.get(id);
  }

  async createGame(game: InsertGame): Promise<Game> {
    const id = this.currentGameId++;
    const newGame: Game = {
      id,
      isActive: true,
      imageUrl: null,
      genre: null,
      minPlayers: 1,
      maxPlayers: 1,
      ...game
    };
    this.games.set(id, newGame);
    return newGame;
  }

  async updateGame(id: number, game: Partial<InsertGame>): Promise<Game> {
    const existing = this.games.get(id);
    if (!existing) throw new Error("Game not found");
    const updated = { ...existing, ...game } as Game;
    this.games.set(id, updated);
    return updated;
  }

  async deleteGame(id: number): Promise<void> {
    this.games.delete(id);
  }

  async getBookings(filters?: BookingFilters): Promise<(Booking & { gameType?: GameType | null; station?: Station | null; user: SafeUser })[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 25, 1), 100);
    const offset = Math.max(filters?.offset ?? 0, 0);

    let list = Array.from(this.bookings.values());
    if (filters?.status) list = list.filter(b => b.status === filters.status);
    if (filters?.stationId) list = list.filter(b => b.stationId === filters.stationId);
    if (filters?.userId) list = list.filter(b => b.userId === filters.userId);
    if (filters?.fromDate) list = list.filter(b => new Date(b.startTime).getTime() >= filters.fromDate!.getTime());
    if (filters?.toDate) list = list.filter(b => new Date(b.endTime).getTime() <= filters.toDate!.getTime());

    list.sort((a, b) => {
      const timeDiff = (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0);
      if (timeDiff !== 0) return timeDiff;
      return b.id - a.id;
    });

    if (filters?.cursor) {
      const cursorTime = filters.cursor.createdAt.getTime();
      const cursorId = filters.cursor.id;
      list = list.filter(b => {
        const bTime = b.createdAt?.getTime() || 0;
        if (bTime < cursorTime) return true;
        if (bTime === cursorTime && b.id < cursorId) return true;
        return false;
      });
    }

    const fetchLimit = limit + 1;
    const paged = list.slice(filters?.cursor ? 0 : offset, (filters?.cursor ? 0 : offset) + fetchLimit);

    const result: (Booking & { gameType?: GameType | null; station?: Station | null; user: SafeUser })[] = [];
    for (const booking of paged) {
      const gameType = booking.gameTypeId ? this.gameTypes.get(booking.gameTypeId) : null;
      const station = booking.stationId ? this.stations.get(booking.stationId) : null;
      const rawUser = this.users.get(booking.userId);
      const user: SafeUser = rawUser
        ? {
            id: rawUser.id,
            username: rawUser.username,
            email: rawUser.email,
            fullName: rawUser.fullName,
            phone: rawUser.phone,
            avatarUrl: rawUser.avatarUrl,
            membershipTier: rawUser.membershipTier,
            role: rawUser.role,
            createdAt: rawUser.createdAt,
          }
        : {
            id: booking.userId,
            username: "Unknown",
            email: null,
            fullName: null,
            phone: null,
            avatarUrl: null,
            membershipTier: "bronze",
            role: "member",
            createdAt: new Date(),
          };

      result.push({ ...booking, gameType: gameType || null, station: station || null, user });
    }
    return result;
  }

  async getBooking(id: number): Promise<(Booking & { gameType?: GameType | null; station?: Station | null; user?: SafeUser | null }) | undefined> {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    const gameType = booking.gameTypeId ? this.gameTypes.get(booking.gameTypeId) || null : null;
    const station = booking.stationId ? this.stations.get(booking.stationId) || null : null;
    const rawUser = this.users.get(booking.userId);
    const user: SafeUser | null = rawUser
      ? {
          id: rawUser.id,
          username: rawUser.username,
          email: rawUser.email,
          fullName: rawUser.fullName,
          phone: rawUser.phone,
          avatarUrl: rawUser.avatarUrl,
          membershipTier: rawUser.membershipTier,
          role: rawUser.role,
          createdAt: rawUser.createdAt,
        }
      : null;
    return {
      ...booking,
      gameType,
      station,
      user,
    };
  }

  async getBookingsByUser(
    userId: number,
    filters?: BookingFilters
  ): Promise<(Booking & { gameType?: GameType | null; station?: Station | null; user?: SafeUser | User })[]> {
    return this.getBookings({ ...filters, userId });
  }

  async createBooking(booking: CreateBookingInput): Promise<Booking> {
    const id = this.currentBookingId++;
    const newBooking: Booking = {
      id,
      createdAt: new Date(),
      status: "Pending",
      timerStartedAt: null,
      timerEndTime: null,
      employeeId: null,
      gameTitle: booking.gameTitle ?? null,
      gameTypeId: booking.gameTypeId ?? null,
      stationId: booking.stationId ?? null,
      basePrice: booking.basePrice ?? booking.totalPrice,
      discountAmount: booking.discountAmount ?? 0,
      finalPrice: booking.finalPrice ?? booking.totalPrice,
      currency: booking.currency ?? "INR",
      pricingRule: booking.pricingRule ?? "standard_v1",
      ...booking,
      locationId: booking.locationId || "loc_kolkata_main",
      playerCount: booking.playerCount ?? 1,
    };
    this.bookings.set(id, newBooking);
    return newBooking;
  }

  async createBookingWithAutoStation(bookingData: CreateBookingInput & { gameTypeId: number }, idempotencyRecordId?: number): Promise<{ booking: Booking; station: Station }> {
    const { gameType, ...insertData } = bookingData;
    if (bookingData.stationId) {
      const targetStation = this.stations.get(bookingData.stationId);
      if (!targetStation || targetStation.status?.toUpperCase() !== 'AVAILABLE') {
        throw new Error("Selected station is unavailable or does not exist.");
      }
      const conflict = await this.checkStationConflict(targetStation.id, bookingData.startTime, bookingData.endTime);
      if (conflict) {
        throw new Error(`Station ${targetStation.name} is already booked for this time.`);
      }
      const booking = await this.createBooking({
        ...insertData,
        stationId: targetStation.id,
        locationId: targetStation.locationId || bookingData.locationId || "main-lounge",
      });
      if (idempotencyRecordId) {
        const existingKey = this.idempotencyKeys.get(idempotencyRecordId);
        if (existingKey) {
          this.idempotencyKeys.set(idempotencyRecordId, {
            ...existingKey,
            status: "COMPLETED",
            statusCode: 201,
            responseBody: JSON.stringify({ ...booking, gameType: gameType || null, station: targetStation }),
            bookingId: booking.id,
          });
        }
      }
      return { booking, station: targetStation };
    }

    const candidateStations = Array.from(this.stations.values())
      .filter(s => s.gameTypeId === bookingData.gameTypeId && s.status?.toUpperCase() === 'AVAILABLE')
      .sort((a, b) => a.id - b.id);

    if (candidateStations.length === 0) {
      throw new Error("No active stations available for this gaming category.");
    }

    for (const candidate of candidateStations) {
      const conflict = await this.checkStationConflict(candidate.id, bookingData.startTime, bookingData.endTime);
      if (!conflict) {
        const booking = await this.createBooking({
          ...insertData,
          stationId: candidate.id,
          locationId: candidate.locationId || bookingData.locationId || "main-lounge",
        });
        if (idempotencyRecordId) {
          const existingKey = this.idempotencyKeys.get(idempotencyRecordId);
          if (existingKey) {
            this.idempotencyKeys.set(idempotencyRecordId, {
              ...existingKey,
              status: "COMPLETED",
              statusCode: 201,
              responseBody: JSON.stringify({ ...booking, gameType: gameType || null, station: candidate }),
              bookingId: booking.id,
            });
          }
        }
        return { booking, station: candidate };
      }
    }

    throw new Error("All stations for this category are fully booked for the selected time slot.");
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

  async checkBookingConflict(gameTypeId: number, startTime: Date, endTime: Date, excludeBookingId?: number): Promise<Booking | undefined> {
    const availableStation = await this.findAvailableStation(gameTypeId, startTime, endTime, excludeBookingId);
    if (!availableStation) {
      const startMs = new Date(startTime).getTime();
      const endMs = new Date(endTime).getTime();
      for (const b of Array.from(this.bookings.values())) {
        if (b.gameTypeId === gameTypeId && b.status !== 'Cancelled' && b.status !== 'Rejected' && (!excludeBookingId || b.id !== excludeBookingId)) {
          const bStart = new Date(b.startTime).getTime();
          const bEnd = new Date(b.endTime).getTime();
          if (bStart < endMs && bEnd > startMs) {
            return b;
          }
        }
      }
      return { startTime, endTime, status: "Booked" } as any;
    }
    return undefined;
  }

  async getAllUsers(filters?: UserFilters): Promise<SafeUser[]> {
    const limit = Math.min(Math.max(filters?.limit ?? 25, 1), 100);
    const offset = Math.max(filters?.offset ?? 0, 0);

    let list = Array.from(this.users.values());
    if (filters?.role) list = list.filter(u => u.role === filters.role);
    if (filters?.membershipTier) list = list.filter(u => u.membershipTier === filters.membershipTier);

    list.sort((a, b) => {
      const timeDiff = (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0);
      if (timeDiff !== 0) return timeDiff;
      return b.id - a.id;
    });

    if (filters?.cursor) {
      const cursorTime = filters.cursor.createdAt.getTime();
      const cursorId = filters.cursor.id;
      list = list.filter(u => {
        const uTime = u.createdAt?.getTime() || 0;
        if (uTime < cursorTime) return true;
        if (uTime === cursorTime && u.id < cursorId) return true;
        return false;
      });
    }

    const fetchLimit = limit + 1;
    const paged = list.slice(filters?.cursor ? 0 : offset, (filters?.cursor ? 0 : offset) + fetchLimit);

    return paged.map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      fullName: u.fullName,
      phone: u.phone,
      avatarUrl: u.avatarUrl,
      membershipTier: u.membershipTier,
      role: u.role,
      createdAt: u.createdAt,
    }));
  }

  async withTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    return await callback(this);
  }

  async getSetting(key: string): Promise<string | undefined> {
    return this.settings.get(key);
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async deleteSetting(key: string): Promise<void> {
    this.settings.delete(key);
  }

  async hasAdminUser(): Promise<boolean> {
    return Array.from(this.users.values()).some((u) => u.role === "admin");
  }

  private auditLogsList: AuditLog[] = [];
  private currentAuditLogId = 1;

  async createAuditLog(log: { userId?: number | null; username: string; action: string; details?: string }): Promise<AuditLog> {
    const entry: AuditLog = {
      id: this.currentAuditLogId++,
      userId: log.userId ?? null,
      username: log.username,
      action: log.action,
      details: log.details ?? null,
      createdAt: new Date(),
    };
    this.auditLogsList.push(entry);
    return entry;
  }

  async getAuditLogs(
    filtersOrLimit?: AuditLogFilters | number,
    offset = 0,
    maybeUserId?: number
  ): Promise<AuditLog[]> {
    let filters: AuditLogFilters | undefined;
    let safeLimit = 25;
    let safeOffset = 0;

    if (typeof filtersOrLimit === "object" && filtersOrLimit !== null) {
      filters = filtersOrLimit;
      safeLimit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
      safeOffset = Math.max(filters.offset ?? 0, 0);
    } else {
      safeLimit = Math.min(Math.max(typeof filtersOrLimit === "number" ? filtersOrLimit : 25, 1), 100);
      safeOffset = Math.max(offset, 0);
      if (maybeUserId !== undefined) {
        filters = { userId: maybeUserId, limit: safeLimit, offset: safeOffset };
      }
    }

    let list = [...this.auditLogsList];
    if (filters?.userId !== undefined) {
      list = list.filter(l => l.userId === filters!.userId);
    }
    if (filters?.action) {
      list = list.filter(l => l.action === filters!.action);
    }
    if (filters?.fromDate) {
      list = list.filter(l => (l.createdAt ? l.createdAt.getTime() : 0) >= filters!.fromDate!.getTime());
    }
    if (filters?.toDate) {
      list = list.filter(l => (l.createdAt ? l.createdAt.getTime() : 0) <= filters!.toDate!.getTime());
    }

    list.sort((a, b) => {
      const timeDiff = (b.createdAt ? b.createdAt.getTime() : 0) - (a.createdAt ? a.createdAt.getTime() : 0);
      if (timeDiff !== 0) return timeDiff;
      return b.id - a.id;
    });

    if (filters?.cursor) {
      const cursorTime = filters.cursor.createdAt.getTime();
      const cursorId = filters.cursor.id;
      list = list.filter(l => {
        const lTime = l.createdAt ? l.createdAt.getTime() : 0;
        if (lTime < cursorTime) return true;
        if (lTime === cursorTime && l.id < cursorId) return true;
        return false;
      });
    }

    const fetchLimit = safeLimit + 1;
    return list.slice(filters?.cursor ? 0 : safeOffset, (filters?.cursor ? 0 : safeOffset) + fetchLimit);
  }

  async getAdminStats(): Promise<any> {
    const { getAdminStats } = await import("./stats");
    return await getAdminStats();
  }
}

export const storage: IStorage = new DatabaseStorage();
