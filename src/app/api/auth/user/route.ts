import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { storage } from "@/lib/storage";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return new NextResponse(null, { status: 401 });
  }

  const user = await storage.getUser(session.user.id);
  if (!user) {
    return new NextResponse(null, { status: 401 });
  }

  const { password: _, ...sanitized } = user;
  return NextResponse.json({
    ...sanitized,
    role: sanitized.role,
  });
}
