import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { storage } from "@/lib/storage";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const timerSchema = z.object({
  action: z.enum(["start", "stop", "extend"]),
  durationMinutes: z.number().optional(),
});

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const isStaff = session?.user?.role === "admin" || session?.user?.role === "employee";
    if (!isStaff) {
      return NextResponse.json({ message: "Staff authorization required" }, { status: 403 });
    }

    const { id } = await params;
    const numericId = parseInt(id, 10);
    const body = await req.json();
    const { action, durationMinutes } = timerSchema.parse(body);

    const now = new Date();
    let updates: any = {};

    if (action === "start") {
      const minutes = durationMinutes || 60;
      const timerEndTime = new Date(now.getTime() + minutes * 60 * 1000);
      updates = {
        timerStartedAt: now,
        timerEndTime,
        status: "Approved",
      };
    } else if (action === "stop") {
      updates = {
        timerEndTime: now,
        status: "Completed",
      };
    }

    const updated = await storage.updateBooking(numericId, updates);
    return NextResponse.json(updated);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ message: error.errors[0]?.message || "Validation failed" }, { status: 400 });
    }
    return NextResponse.json({ message: "Failed to update timer" }, { status: 500 });
  }
}
