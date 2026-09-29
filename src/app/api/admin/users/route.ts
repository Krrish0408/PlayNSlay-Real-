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

    const allUsers = await storage.getAllUsers();
    const sanitized = allUsers.map(({ password: _, ...u }) => u);
    return NextResponse.json(sanitized);
  } catch (error) {
    return NextResponse.json({ message: "Failed to fetch users" }, { status: 500 });
  }
}
