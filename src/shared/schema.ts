import { pgTable, text, serial, integer, boolean, timestamp, real } from "drizzle-orm/pg-core";
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
  role: text("role").default("member").notNull(), // member, admin, employee
  createdAt: timestamp("created_at").defaultNow(),
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
  status: text("status").notNull().default("AVAILABLE"), // AVAILABLE, MAINTENANCE, INACTIVE
  createdAt: timestamp("created_at").defaultNow(),
});

export const bookings = pgTable("bookings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  gameTypeId: integer("game_type_id"), // Nullable for snacks/retail-only orders
  stationId: integer("station_id"), // Physical gaming station assigned to this booking
  gameTitle: text("game_title"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  playerCount: integer("player_count").notNull().default(1),
  totalPrice: integer("total_price").notNull(), // In cents
  paymentMethod: text("payment_method").notNull().default("offline"), // online, offline
  status: text("status").notNull().default("Pending"), // Pending, Approved, Cancelled, Completed
  bookingRef: text("booking_ref").notNull(),
  employeeId: integer("employee_id"), // ID of employee who made offline entry
  timerStartedAt: timestamp("timer_started_at"),
  timerEndTime: timestamp("timer_end_time"),
  createdAt: timestamp("created_at").defaultNow(),
});

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
  createdAt: timestamp("created_at").defaultNow(),
});

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

// Schemas
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
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
  totalPrice: true
}).extend({
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  stationId: z.coerce.number().optional().nullable(),
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
