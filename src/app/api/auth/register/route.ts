import { NextRequest, NextResponse } from "next/server";
import { storage } from "@/lib/storage";
import { insertUserSchema } from "@/shared/schema";
import bcrypt from "bcryptjs";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for") || "unknown";
    const limiter = rateLimit(`register:${ip}`, { limit: 5, windowMs: 60 * 1000 });
    if (!limiter.success) {
      return NextResponse.json(
        { message: "Too many registration attempts. Please try again later." },
        { status: 429 }
      );
    }

    const body = await req.json();
    const validated = insertUserSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { message: validated.error.errors[0]?.message || "Invalid input data" },
        { status: 400 }
      );
    }

    const existingUser = await storage.getUserByUsername(validated.data.username);
    if (existingUser) {
      return NextResponse.json(
        { message: "An account with this username already exists" },
        { status: 400 }
      );
    }

    // Hash password with bcrypt (salt rounds 10)
    const hashedPassword = await bcrypt.hash(validated.data.password, 10);

    const user = await storage.createUser({
      username: validated.data.username,
      password: hashedPassword,
      role: validated.data.role || "member",
    });

    const { password: _, ...sanitizedUser } = user;
    return NextResponse.json(sanitizedUser, { status: 201 });
  } catch (error: any) {
    console.error("[Register Error]:", error);
    return NextResponse.json({ message: "Internal server error" }, { status: 500 });
  }
}
