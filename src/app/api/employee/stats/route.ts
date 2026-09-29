import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getEmployeeStats } from "@/lib/stats";

export async function GET() {
  try {
    const session = await auth();
    const isStaff = session?.user?.role === "admin" || session?.user?.role === "employee";
    if (!isStaff || !session?.user?.id) {
      return NextResponse.json({ message: "Staff authorization required" }, { status: 403 });
    }

    const stats = await getEmployeeStats(session.user.id);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[Employee Stats Error]:", error);
    return NextResponse.json({ message: "Failed to fetch employee stats" }, { status: 500 });
  }
}
