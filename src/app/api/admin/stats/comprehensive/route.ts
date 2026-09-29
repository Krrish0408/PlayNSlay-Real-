import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { storage } from "@/lib/storage";

export async function GET() {
  try {
    const session = await auth();
    const isAdmin = session?.user?.role === "admin";
    if (!isAdmin) {
      return NextResponse.json({ message: "Admin authorization required" }, { status: 403 });
    }

    const stats = await storage.getAdminStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[Admin Stats Error]:", error);
    return NextResponse.json({ message: "Failed to fetch admin stats" }, { status: 500 });
  }
}
