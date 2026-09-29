import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { storage } from "@/lib/storage";
import { calculateBookingPrice } from "@/shared/pricing";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    const isStaff = session?.user?.role === "admin" || session?.user?.role === "employee";
    if (!isStaff) {
      return NextResponse.json({ message: "Staff authorization required" }, { status: 403 });
    }

    const body = await req.json();
    const gameTypeId = parseInt(body.gameTypeId, 10);
    const gameType = await storage.getGameType(gameTypeId);
    if (!gameType) {
      return NextResponse.json({ message: "Invalid game station selected" }, { status: 400 });
    }

    const startTime = new Date(body.startTime);
    const endTime = new Date(body.endTime);
    const durationMs = endTime.getTime() - startTime.getTime();
    const durationHours = durationMs / (1000 * 60 * 60);

    if (durationHours <= 0) {
      return NextResponse.json({ message: "End time must be after start time" }, { status: 400 });
    }

    const playerCount = parseInt(body.playerCount || "1", 10);
    const totalPrice = calculateBookingPrice(gameType, durationHours, playerCount);

    // Find or create customer user
    const username = body.username?.trim() || "Walk-in Guest";
    let customer = await storage.getUserByUsername(username);
    if (!customer) {
      const defaultPass = await bcrypt.hash("guest123", 10);
      customer = await storage.createUser({
        username,
        password: defaultPass,
        role: "member",
      });
    }

    const bookingRef = `OFF-${randomBytes(3).toString("hex").toUpperCase()}`;

    const newBooking = await storage.createBooking({
      gameTypeId,
      userId: customer.id,
      startTime,
      endTime,
      playerCount,
      totalPrice,
      paymentMethod: body.paymentMethod || "offline",
      status: "Approved",
      bookingRef,
      employeeId: session?.user?.id || null,
      timerStartedAt: startTime,
      timerEndTime: endTime,
    });

    return NextResponse.json({
      ...newBooking,
      user: customer,
      gameType,
    }, { status: 201 });
  } catch (error: any) {
    console.error("[Offline Booking Error]:", error);
    return NextResponse.json({ message: error.message || "Failed to process offline entry" }, { status: 500 });
  }
}
