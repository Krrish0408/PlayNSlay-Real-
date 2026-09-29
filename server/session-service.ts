import { createHash } from "crypto";
import type { Request } from "express";
import type { User } from "@shared/schema";

export const COOKIE_NAME = "pns_session";

// Session lifetimes
export const MEMBER_SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days (ordinary members)
export const PRIVILEGED_SESSION_MAX_AGE = 8 * 60 * 60 * 1000; // 8 hours (admins and employees)

// Idle timeouts (inactivity timeout)
export const DEFAULT_MEMBER_IDLE_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_PRIVILEGED_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Absolute timeouts (maximum duration regardless of activity)
export const DEFAULT_MEMBER_ABSOLUTE_TIMEOUT = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_PRIVILEGED_ABSOLUTE_TIMEOUT = 8 * 60 * 60 * 1000; // 8 hours

/**
 * Computes a secure SHA-256 hash of a raw session ID for storage in user_sessions.
 * This prevents session hijacking even if the user_sessions metadata table is leaked.
 */
export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export interface SessionTimeoutConfig {
  isPrivileged: boolean;
  maxAge: number;
  idleTimeout: number;
  absoluteTimeout: number;
}

/**
 * Determines session timeouts based on account privilege level.
 * Staff/Admins have significantly shorter idle and absolute lifetimes than ordinary members.
 */
export function getSessionTimeouts(user?: User | null): SessionTimeoutConfig {
  const isPrivileged = Boolean(
    user && (user.role === "admin" || user.role === "employee")
  );

  const idleTimeout = isPrivileged
    ? process.env.PRIVILEGED_IDLE_TIMEOUT_MS
      ? parseInt(process.env.PRIVILEGED_IDLE_TIMEOUT_MS, 10)
      : DEFAULT_PRIVILEGED_IDLE_TIMEOUT
    : process.env.MEMBER_IDLE_TIMEOUT_MS
    ? parseInt(process.env.MEMBER_IDLE_TIMEOUT_MS, 10)
    : DEFAULT_MEMBER_IDLE_TIMEOUT;

  const absoluteTimeout = isPrivileged
    ? process.env.PRIVILEGED_ABSOLUTE_TIMEOUT_MS
      ? parseInt(process.env.PRIVILEGED_ABSOLUTE_TIMEOUT_MS, 10)
      : DEFAULT_PRIVILEGED_ABSOLUTE_TIMEOUT
    : process.env.MEMBER_ABSOLUTE_TIMEOUT_MS
    ? parseInt(process.env.MEMBER_ABSOLUTE_TIMEOUT_MS, 10)
    : DEFAULT_MEMBER_ABSOLUTE_TIMEOUT;

  const maxAge = isPrivileged ? PRIVILEGED_SESSION_MAX_AGE : MEMBER_SESSION_MAX_AGE;

  return { isPrivileged, maxAge, idleTimeout, absoluteTimeout };
}

/**
 * Promisified session regeneration to prevent Session Fixation attacks.
 */
export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    const store = (req as any).sessionStore;
    if (store && typeof store.regenerate === "function") {
      store.regenerate(req, (err: any) => {
        if (err) return reject(err);
        resolve();
      });
      return;
    }
    if (req.session && typeof req.session.regenerate === "function") {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        resolve();
      });
      return;
    }
    resolve();
  });
}
