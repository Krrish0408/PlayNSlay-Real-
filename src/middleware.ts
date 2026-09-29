import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const secret =
  process.env.AUTH_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  "r3pl1t_s3cr3t_k3y_for_session_encryption_1234567890";

export async function middleware(req: NextRequest) {
  const { nextUrl } = req;
  const pathname = nextUrl.pathname;

  const token = await getToken({
    req,
    secret,
    cookieName:
      process.env.NODE_ENV === "production"
        ? "__Secure-authjs.session-token"
        : "authjs.session-token",
  }) || await getToken({
    req,
    secret,
    cookieName:
      process.env.NODE_ENV === "production"
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
  });

  const isLoggedIn = !!token;
  const user = token;

  // Protect Admin Routes
  if (pathname.startsWith("/admin")) {
    if (!isLoggedIn) {
      return NextResponse.redirect(new URL("/auth", nextUrl));
    }
    const isAdmin = user?.role === "admin";
    if (!isAdmin) {
      return NextResponse.redirect(new URL("/dashboard", nextUrl));
    }
  }

  // Protect Employee Routes
  if (pathname.startsWith("/employee")) {
    if (!isLoggedIn) {
      return NextResponse.redirect(new URL("/auth", nextUrl));
    }
    const isStaff = user?.role === "admin" || user?.role === "employee";
    if (!isStaff) {
      return NextResponse.redirect(new URL("/dashboard", nextUrl));
    }
  }

  // Protect Member Dashboard
  if (pathname.startsWith("/dashboard")) {
    if (!isLoggedIn) {
      return NextResponse.redirect(new URL("/auth", nextUrl));
    }
  }

  // Redirect from /auth if already logged in
  if (pathname === "/auth" && isLoggedIn) {
    if (user?.role === "admin") {
      return NextResponse.redirect(new URL("/admin", nextUrl));
    }
    if (user?.role === "employee") {
      return NextResponse.redirect(new URL("/employee", nextUrl));
    }
    return NextResponse.redirect(new URL("/dashboard", nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/employee/:path*", "/dashboard/:path*", "/auth"],
};
