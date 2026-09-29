import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { storage } from "@/lib/storage";
import { insertGameTypeSchema } from "@/shared/schema";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ id: string }>;
}

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
    const validated = insertGameTypeSchema.partial().parse(body);

    const updated = await storage.updateGameType(numericId, validated);
    return NextResponse.json(updated);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ message: error.errors[0]?.message || "Validation failed" }, { status: 400 });
    }
    return NextResponse.json({ message: "Failed to update game type" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const isAdmin = session?.user?.role === "admin";
    if (!isAdmin) {
      return NextResponse.json({ message: "Admin authorization required" }, { status: 403 });
    }

    const { id } = await params;
    const numericId = parseInt(id, 10);
    await storage.deleteGameType(numericId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ message: "Failed to delete game type" }, { status: 500 });
  }
}
