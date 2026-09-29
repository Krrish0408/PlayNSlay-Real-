import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { storage } from "@/lib/storage";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const statusSchema = z.object({
  status: z.enum(["Pending", "Approved", "Cancelled", "Completed"]),
});

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const isStaff = session?.user?.role === "admin" || session?.user?.role === "employee";
    if (!isStaff) {
      return NextResponse.json({ message: "Staff authorization required" }, { status: 403 });
    }

    const { id } = await params;
    const numericId = parseInt(id, 10);
    const body = await req.json();
    const { status } = statusSchema.parse(body);

    const updated = await storage.updateBookingStatus(numericId, status);
    return NextResponse.json(updated);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ message: error.errors[0]?.message || "Validation failed" }, { status: 400 });
    }
    return NextResponse.json({ message: "Failed to update status" }, { status: 500 });
  }
}
