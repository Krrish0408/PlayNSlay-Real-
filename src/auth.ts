import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { storage } from "@/lib/storage";

const isProd = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";
const authSecret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.SESSION_SECRET;
if (isProd && (!authSecret || authSecret.includes("r3pl1t_s3cr3t"))) {
  throw new Error("[FATAL] AUTH_SECRET or NEXTAUTH_SECRET is required and must not use default keys in production.");
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 }, // 30 days
  secret: authSecret || "dev_auth_secret_for_local_development_only_12345",
  trustHost: true,
  pages: {
    signIn: "/auth",
    error: "/auth",
  },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;
        const username = credentials.username as string;
        const password = credentials.password as string;

        const user = await storage.getUserByUsername(username);
        if (!user) return null;

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) return null;

        return {
          id: user.id,
          name: user.username,
          username: user.username,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = Number((user as any).id);
        token.username = (user as any).username;
        token.role = (user as any).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        (session.user as any).id = token.id;
        (session.user as any).username = token.username;
        (session.user as any).role = token.role;
      }
      return session;
    },
  },
});
