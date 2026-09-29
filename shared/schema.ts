import { pgTable, text, serial, integer, boolean, timestamp, real, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const USER_ROLES = ["member", "employee", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PERMISSIONS = [
  "BOOKING_READ_OWN",
  "BOOKING_READ_ALL",
  "BOOKING_CREATE",
  "BOOKING_CANCEL_OWN",
  "BOOKING_MANAGE",
  "USER_READ_OWN",
  "USER_UPDATE_OWN",
  "USER_VIEW_ALL",
  "USER_MANAGE",
  "STATION_VIEW",
  "STATION_MANAGE",
  "CATALOG_VIEW",
  "CATALOG_MANAGE",
  "PRICING_MANAGE",
  "EMPLOYEE_STATS_VIEW_OWN",
  "ANALYTICS_VIEW",
  "AUDIT_VIEW",
  "FILE_UPLOAD",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  member: [
    "BOOKING_READ_OWN",
    "BOOKING_CREATE",
    "BOOKING_CANCEL_OWN",
    "USER_READ_OWN",
    "USER_UPDATE_OWN",
    "STATION_VIEW",
    "CATALOG_VIEW",
    "FILE_UPLOAD",
  ],
  employee: [
    "BOOKING_READ_OWN",
    "BOOKING_READ_ALL",
    "BOOKING_CREATE",
    "BOOKING_CANCEL_OWN",
    "BOOKING_MANAGE",
    "USER_READ_OWN",
    "USER_UPDATE_OWN",
    "STATION_VIEW",
    "CATALOG_VIEW",
    "EMPLOYEE_STATS_VIEW_OWN",
    "FILE_UPLOAD",
  ],
  admin: [
    "BOOKING_READ_OWN",
    "BOOKING_READ_ALL",
    "BOOKING_CREATE",
    "BOOKING_CANCEL_OWN",
    "BOOKING_MANAGE",
    "USER_READ_OWN",
    "USER_UPDATE_OWN",
    "USER_VIEW_ALL",
    "USER_MANAGE",
    "STATION_VIEW",
    "STATION_MANAGE",
    "CATALOG_VIEW",
    "CATALOG_MANAGE",
    "PRICING_MANAGE",
    "EMPLOYEE_STATS_VIEW_OWN",
    "ANALYTICS_VIEW",
    "AUDIT_VIEW",
    "FILE_UPLOAD",
  ],
};

export function hasPermission(user: { role?: string } | null | undefined, permission: Permission): boolean {
  if (!user || !user.role) return false;
  const role = user.role as UserRole;
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  return perms.includes(permission);
}

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email").unique(),
  fullName: text("full_name"),
  phone: text("phone"),
  avatarUrl: text("avatar_url"),
  membershipTier: text("membership_tier").default("bronze"), // bronze, silver, gold, platinum
  role: text("role").$type<UserRole>().default("member").notNull(), // member, employee, admin
  authProvider: text("auth_provider").default("local").notNull(), // local, google
  googleId: text("google_id").unique(),
  isEmailVerified: boolean("is_email_verified").default(false).notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  emailVerificationTokenHash: text("email_verification_token_hash"),
  emailVerificationTokenExpiresAt: timestamp("email_verification_token_expires_at", { withTimezone: true }),
  resetRequired: boolean("reset_required").default(false).notNull(),
  passwordResetTokenHash: text("password_reset_token_hash"),
  passwordResetTokenExpiresAt: timestamp("password_reset_token_expires_at", { withTimezone: true }),
  tokenVersion: integer("token_version").default(1).notNull(),
  isMfaEnabled: boolean("is_mfa_enabled").default(false).notNull(),
  mfaSecret: text("mfa_secret"),
  mfaRecoveryCodes: text("mfa_recovery_codes"),
  mfaLastUsedTimestep: integer("mfa_last_used_timestep"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const gameTypes = pgTable("game_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  hourlyPrice: integer("hourly_price").notNull(), // In cents
  maxPlayers: integer("max_players").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  priceModel: text("price_model").default("flat").notNull(), // flat, per_player
  imageUrl: text("image_url"),
});

export const STATION_STATUSES = ["AVAILABLE", "MAINTENANCE", "INACTIVE"] as const;
export type StationStatus = typeof STATION_STATUSES[number];

export const stations = pgTable("stations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // e.g. "PS5-01", "PS5-02", "PC-01"
  gameTypeId: integer("game_type_id").notNull(),
  locationId: text("location_id").default("main-lounge").notNull(), // IANA timezone configured via location
  status: text("status").notNull().default("AVAILABLE"), // AVAILABLE, MAINTENANCE, INACTIVE
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const bookings = pgTable("bookings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  gameTypeId: integer("game_type_id"),
  stationId: integer("station_id"), // Physical gaming station assigned to this booking
  locationId: text("location_id").default("main-lounge").notNull(), // Booking location (determines timezone)
  gameTitle: text("game_title"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  playerCount: integer("player_count").notNull().default(1),
  totalPrice: integer("total_price").notNull(), // In cents (synonymous with final_price for backwards compatibility)
  basePrice: integer("base_price"), // In cents (standard rate before discounts)
  discountAmount: integer("discount_amount").default(0).notNull(), // In cents
  finalPrice: integer("final_price"), // In cents (authoritative final billed price)
  currency: text("currency").default("INR").notNull(),
  pricingRule: text("pricing_rule").default("standard_v1").notNull(),
  paymentMethod: text("payment_method").notNull().default("offline"), // online, offline
  status: text("status").notNull().default("Pending"), // Pending, Approved, Cancelled, Completed
  bookingRef: text("booking_ref").notNull(),
  employeeId: integer("employee_id"), // ID of employee who made offline entry
  timerStartedAt: timestamp("timer_started_at", { withTimezone: true }),
  timerEndTime: timestamp("timer_end_time", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_bookings_user_id").on(table.userId),
  index("idx_bookings_station_id").on(table.stationId),
  index("idx_bookings_start_time").on(table.startTime),
  index("idx_bookings_status").on(table.status),
  index("idx_bookings_created_at").on(table.createdAt),
]);

export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  username: text("username").notNull(),
  action: text("action").notNull(),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_audit_logs_user_id_created_at").on(table.userId, table.createdAt),
  index("idx_audit_logs_created_at").on(table.createdAt),
]);

export const userSessions = pgTable("user_sessions", {
  id: serial("id").primaryKey(),
  sessionIdHash: text("session_id_hash").notNull().unique(),
  userId: integer("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  index("idx_user_sessions_user_id").on(table.userId),
  index("idx_user_sessions_sid_hash").on(table.sessionIdHash),
]);

export type UserSession = typeof userSessions.$inferSelect;

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  requestPath: text("request_path").notNull(),
  requestHash: text("request_hash").notNull(),
  status: text("status").notNull().default("PROCESSING"), // PROCESSING, COMPLETED, FAILED
  statusCode: integer("status_code"),
  responseBody: text("response_body"),
  bookingId: integer("booking_id").references(() => bookings.id, { onDelete: "set null" }),
  lockedAt: timestamp("locked_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("idx_idempotency_user_key").on(table.userId, table.key),
  index("idx_idempotency_expires_at").on(table.expiresAt),
]);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type InsertIdempotencyKey = typeof idempotencyKeys.$inferInsert;

export const games = pgTable("games", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  platforms: text("platforms").notNull(), // e.g., "PS4, PS5", "PS5", "Racing Sim", "VR"
  minPlayers: integer("min_players").notNull().default(1),
  maxPlayers: integer("max_players").notNull().default(1),
  genre: text("genre"), // Action, Sports, Fighting, Racing, VR, etc.
  imageUrl: text("image_url"),
  isActive: boolean("is_active").default(true).notNull(),
});

export type AuditLog = typeof auditLogs.$inferSelect;

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  isEmailVerified: true,
  emailVerifiedAt: true,
  emailVerificationTokenHash: true,
  emailVerificationTokenExpiresAt: true,
  resetRequired: true,
  passwordResetTokenHash: true,
  passwordResetTokenExpiresAt: true,
  tokenVersion: true,
  authProvider: true,
  googleId: true,
  isMfaEnabled: true,
  mfaRecoveryCodes: true,
  mfaLastUsedTimestep: true,
});

export const rateLimitEntries = pgTable("rate_limit_entries", {
  key: text("key").primaryKey(),
  totalHits: integer("total_hits").notNull().default(1),
  resetTime: timestamp("reset_time", { withTimezone: true }).notNull(),
}, (table) => [
  index("idx_rate_limit_entries_reset_time").on(table.resetTime),
]);

export const insertGameTypeSchema = createInsertSchema(gameTypes).omit({ id: true });
export const insertGameSchema = createInsertSchema(games).omit({ id: true });
export const insertStationSchema = createInsertSchema(stations).omit({ id: true, createdAt: true }).extend({
  status: z.enum(STATION_STATUSES).default("AVAILABLE"),
});

export const insertBookingSchema = createInsertSchema(bookings).omit({
  id: true,
  userId: true,
  status: true,
  bookingRef: true,
  createdAt: true,
  totalPrice: true,
  basePrice: true,
  discountAmount: true,
  finalPrice: true,
  currency: true,
  pricingRule: true,
  employeeId: true,
  timerStartedAt: true,
  timerEndTime: true,
}).extend({
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  locationId: z.string().default("main-lounge").optional(),
  stationId: z.coerce.number().optional().nullable(),
  playerCount: z.coerce.number().int().min(1).default(1),
});

// Types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type GameType = typeof gameTypes.$inferSelect;
export type InsertGameType = z.infer<typeof insertGameTypeSchema>;
export type Station = typeof stations.$inferSelect;
export type InsertStation = z.infer<typeof insertStationSchema>;
export type Game = typeof games.$inferSelect;
export type InsertGame = z.infer<typeof insertGameSchema>;
export type Booking = typeof bookings.$inferSelect;
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type Setting = typeof settings.$inferSelect;
