import { db, pool, pgliteClient } from "./db";
import { sql } from "drizzle-orm";
import { bookings, users } from "@shared/schema";
import { storage } from "./storage";
import { getStartOfDayInTimezone, getLoungeTimezone } from "@shared/timezone";

export async function getAdminStats() {
  if (pool || pgliteClient) {
    try {
      // 1. Total revenue, total bookings, online & offline revenue via single SQL aggregation
      const [revenueRow]: any = await db
        .select({
          totalRevenue: sql<number>`COALESCE(SUM(CASE WHEN ${bookings.status} IN ('Completed', 'Approved') THEN ${bookings.totalPrice} ELSE 0 END), 0)::int`,
          totalBookings: sql<number>`COUNT(*)::int`,
          onlineRevenue: sql<number>`COALESCE(SUM(CASE WHEN ${bookings.status} IN ('Completed', 'Approved') AND ${bookings.bookingRef} NOT LIKE 'OFF-%' THEN ${bookings.totalPrice} ELSE 0 END), 0)::int`,
          offlineRevenue: sql<number>`COALESCE(SUM(CASE WHEN ${bookings.status} IN ('Completed', 'Approved') AND ${bookings.bookingRef} LIKE 'OFF-%' THEN ${bookings.totalPrice} ELSE 0 END), 0)::int`,
        })
        .from(bookings);

      // 2. Employee stats via grouped SQL aggregation
      const staffRows = await db
        .select({
          username: users.username,
          bookingsCount: sql<number>`COUNT(b.id)::int`,
          revenue: sql<number>`COALESCE(SUM(CASE WHEN b.status IN ('Completed', 'Approved') THEN b.total_price ELSE 0 END), 0)::int`,
        })
        .from(users)
        .leftJoin(
          sql`bookings b`,
          sql`b.user_id = ${users.id} OR b.employee_id = ${users.id}`
        )
        .where(sql`${users.role} IN ('employee', 'admin')`)
        .groupBy(users.id, users.username);

      return {
        totalRevenue: Number(revenueRow?.totalRevenue || 0),
        totalBookings: Number(revenueRow?.totalBookings || 0),
        revenueSplit: {
          online: Number(revenueRow?.onlineRevenue || 0),
          offline: Number(revenueRow?.offlineRevenue || 0),
        },
        employeeStats: staffRows.map((r: any) => ({
          username: r.username,
          bookingsCount: Number(r.bookingsCount || 0),
          revenue: Number(r.revenue || 0),
        })),
      };
    } catch (err) {
      console.warn("[Stats] SQL aggregation query error, falling back:", err);
    }
  }

  // Fallback for in-memory or legacy
  const allUsers = await storage.getAllUsers();
  const allBookings = await storage.getBookings();

  const totalRevenue = allBookings.reduce((acc, curr) => {
    return curr.status === "Completed" || curr.status === "Approved"
      ? acc + curr.totalPrice
      : acc;
  }, 0);

  const revenueSplit = allBookings.reduce(
    (acc, curr) => {
      if (curr.status === "Completed" || curr.status === "Approved") {
        const type = curr.bookingRef.startsWith("OFF-") ? "offline" : "online";
        acc[type] = (acc[type] || 0) + curr.totalPrice;
      }
      return acc;
    },
    { online: 0, offline: 0 } as Record<string, number>
  );

  const employeeStats = allUsers
    .filter((u: any) => u.role === "employee" || u.role === "admin")
    .map((u: any) => {
      const userBookings = allBookings.filter(
        (b) => b.userId === u.id || (b as any).employeeId === u.id
      );
      const revenue = userBookings.reduce((acc, curr) => {
        return curr.status === "Completed" || curr.status === "Approved"
          ? acc + curr.totalPrice
          : acc;
      }, 0);

      return {
        username: u.username,
        bookingsCount: userBookings.length,
        revenue,
      };
    });

  return {
    totalRevenue,
    totalBookings: allBookings.length,
    revenueSplit,
    employeeStats,
  };
}

export async function getEmployeeStats(employeeId: number) {
  const timeZone = getLoungeTimezone();
  const startOfDay = getStartOfDayInTimezone(new Date(), timeZone);

  if (pool || pgliteClient) {
    try {
      const [empStats]: any = await db
        .select({
          totalEntries: sql<number>`COUNT(*)::int`,
          dailyEntries: sql<number>`COALESCE(SUM(CASE WHEN ${bookings.createdAt} >= ${startOfDay} THEN 1 ELSE 0 END), 0)::int`,
          totalRevenue: sql<number>`COALESCE(SUM(CASE WHEN ${bookings.status} IN ('Completed', 'Approved') THEN ${bookings.totalPrice} ELSE 0 END), 0)::int`,
        })
        .from(bookings)
        .where(sql`${bookings.employeeId} = ${employeeId}`);

      return {
        dailyEntries: Number(empStats?.dailyEntries || 0),
        totalRevenue: Number(empStats?.totalRevenue || 0),
        totalEntries: Number(empStats?.totalEntries || 0),
      };
    } catch (err) {
      console.warn("[Stats] SQL employee stats error, falling back:", err);
    }
  }

  const allBookings = await storage.getBookings();
  const employeeBookings = allBookings.filter((b) => (b as any).employeeId === employeeId);

  const dailyEntries = employeeBookings.filter(
    (b) => new Date(b.createdAt!).getTime() >= startOfDay.getTime()
  );

  const totalRevenue = employeeBookings.reduce((acc, curr) => {
    return curr.status === "Completed" || curr.status === "Approved"
      ? acc + curr.totalPrice
      : acc;
  }, 0);

  return {
    dailyEntries: dailyEntries.length,
    totalRevenue,
    totalEntries: employeeBookings.length,
  };
}
