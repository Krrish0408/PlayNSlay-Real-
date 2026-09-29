import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { storage } from "@/lib/storage";
import { insertGameTypeSchema } from "@/shared/schema";
import { z } from "zod";

export async function GET() {
  try {
    const types = await storage.getGameTypes();
    return NextResponse.json(types);
  } catch (error) {
    return NextResponse.json({ message: "Failed to fetch game types" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    const isAdmin = session?.user?.role === "admin";
    if (!isAdmin) {
      return NextResponse.json({ message: "Admin authorization required" }, { status: 403 });
    }

    const body = await req.json();
    const validated = insertGameTypeSchema.parse(body);
    const gameType = await storage.createGameType(validated);
    return NextResponse.json(gameType, { status: 201 });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ message: error.errors[0]?.message || "Validation failed" }, { status: 400 });
    }
    return NextResponse.json({ message: "Internal server error" }, { status: 500 });
  }
}
