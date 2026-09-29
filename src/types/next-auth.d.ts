import { DefaultSession } from "next-auth";
import { JWT } from "next-auth/jwt";

declare module "next-auth" {
  interface User {
    id: number;
    username: string;
    role: string;
    permissions?: string[];
  }

  interface Session {
    user: {
      id: number;
      username: string;
      role: string;
      permissions?: string[];
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: number;
    username: string;
    role: string;
    permissions?: string[];
  }
}

