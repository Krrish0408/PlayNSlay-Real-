import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { storage } from "@/lib/storage";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const roleSchema = z.object({
  role: z.enum(["member", "employee", "admin"]),
});

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const isAdmin = session?.user?.role === "admin";
    if (!isAdmin) {
      return NextResponse.json({ message: "Admin authorization required" }, { status: 403 });
    }

    const { id } = await params;
    const numericId = parseInt(id, 10);
    const body = await req.json();
    const { role } = roleSchema.parse(body);

    const updated = await storage.updateUser(numericId, {
      role,
    });

    const { password: _, ...sanitized } = updated;
    return NextResponse.json(sanitized);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ message: error.errors[0]?.message || "Validation failed" }, { status: 400 });
    }
    return NextResponse.json({ message: "Failed to update user role" }, { status: 500 });
  }
}
