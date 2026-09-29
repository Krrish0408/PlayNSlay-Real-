import { storage } from "./storage";

export async function getAdminStats() {
  const users = await storage.getAllUsers();
  const bookings = await storage.getBookings();

  // Calculate total revenue
  const totalRevenue = bookings.reduce((acc, curr) => {
    return curr.status === "Completed" || curr.status === "Approved"
      ? acc + curr.totalPrice
      : acc;
  }, 0);

  // Revenue Split (Online vs Offline)
  const revenueSplit = bookings.reduce(
    (acc, curr) => {
      if (curr.status === "Completed" || curr.status === "Approved") {
        const type = curr.bookingRef.startsWith("OFF-") ? "offline" : "online";
        acc[type] = (acc[type] || 0) + curr.totalPrice;
      }
      return acc;
    },
    { online: 0, offline: 0 } as Record<string, number>
  );

  // Employee Performance
  const employeeStats = getUserStats(users, bookings);

  return {
    totalRevenue,
    totalBookings: bookings.length,
    revenueSplit,
    employeeStats,
  };
}

export async function getEmployeeStats(employeeId: number) {
  const bookings = await storage.getBookings();

  // Filter for this employee's offline entries
  const employeeBookings = bookings.filter((b) => b.employeeId === employeeId);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dailyEntries = employeeBookings.filter(
    (b) => new Date(b.createdAt!).getTime() >= today.getTime()
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

function getUserStats(users: any[], bookings: any[]) {
  return users
    .filter((u) => u.role === "employee" || u.role === "admin")
    .map((u) => {
      const userBookings = bookings.filter(
        (b) => b.userId === u.id || b.employeeId === u.id
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
}
