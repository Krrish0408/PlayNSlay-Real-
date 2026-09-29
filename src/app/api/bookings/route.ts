import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { storage } from "@/lib/storage";
import { insertBookingSchema } from "@/shared/schema";
import { calculateBookingPrice } from "@/shared/pricing";
import { randomBytes } from "crypto";
import { z } from "zod";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Authentication required" }, { status: 401 });
    }

    const user = session.user;
    const isStaff = user.role === "admin" || user.role === "employee";

    if (isStaff) {
      const allBookings = await storage.getBookings();
      return NextResponse.json(allBookings);
    } else {
      const userBookings = await storage.getBookingsByUser(user.id);
      return NextResponse.json(userBookings);
    }
  } catch (error) {
    console.error("[Bookings GET Error]:", error);
    return NextResponse.json({ message: "Failed to fetch bookings" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Authentication required" }, { status: 401 });
    }

    const user = session.user;
    const body = await req.json();
    const input = insertBookingSchema.parse(body);

    if (!input.gameTypeId) {
      return NextResponse.json({ message: "A game station is required" }, { status: 400 });
    }

    const gameType = await storage.getGameType(input.gameTypeId);
    if (!gameType) {
      return NextResponse.json({ message: "Invalid game type station selected" }, { status: 400 });
    }

    // Calculate duration in hours
    const durationMs = new Date(input.endTime).getTime() - new Date(input.startTime).getTime();
    const durationHours = durationMs / (1000 * 60 * 60);

    if (durationHours <= 0) {
      return NextResponse.json({ message: "End time must be after start time" }, { status: 400 });
    }

    const totalPrice = calculateBookingPrice(gameType, durationHours, input.playerCount);

    const isOffline = body.paymentMethod === "offline" || user.role === "employee";
    const refPrefix = isOffline ? "OFF-" : "PNS-";
    const bookingRef = `${refPrefix}${randomBytes(3).toString("hex").toUpperCase()}`;

    const newBooking = await storage.createBooking({
      ...input,
      userId: user.id,
      totalPrice,
      bookingRef,
      paymentMethod: body.paymentMethod || (isOffline ? "offline" : "online"),
      employeeId: user.role === "employee" ? user.id : null,
      status: isOffline ? "Approved" : "Pending",
    });

    return NextResponse.json(newBooking, { status: 201 });
  } catch (error: any) {
    console.error("[Bookings POST Error]:", error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ message: error.errors[0]?.message || "Validation failed" }, { status: 400 });
    }
    return NextResponse.json({ message: "Internal server error" }, { status: 500 });
  }
}
