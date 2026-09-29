import type { Request, Response, NextFunction } from "express";
import { randomBytes, timingSafeEqual } from "crypto";

export const CSRF_COOKIE_NAME = "pns_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Parses raw Cookie header string into key-value map.
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx !== -1) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

/**
 * Constant-time string equality check to prevent timing attacks.
 */
export function safeCompareTokens(a?: string | null, b?: string | null): boolean {
  if (!a || !b || typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Generates a 256-bit cryptographically secure random hex string for CSRF tokens.
 */
export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

import { getRequestHost, isOriginAllowed, corsMiddleware } from "./cors";
export { getRequestHost, isOriginAllowed, corsMiddleware };

/**
 * Validates Origin and Referer headers on state-changing requests as defense in depth.
 */
export function verifyOriginAndReferer(req: Request): { valid: boolean; reason?: string } {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return { valid: true };
  }

  const origin = req.headers["origin"] as string | undefined;
  if (origin !== undefined) {
    if (origin === "null") {
      return { valid: false, reason: "Untrusted origin 'null' rejected" };
    }
    if (!isOriginAllowed(origin, req)) {
      return {
        valid: false,
        reason: `Cross-origin request rejected: Origin '${origin}' is not an authorized origin`,
      };
    }
    return { valid: true };
  }

  const referer = req.headers["referer"] as string | undefined;
  if (referer !== undefined) {
    try {
      const refUrl = new URL(referer);
      if (!isOriginAllowed(refUrl.origin, req)) {
        return {
          valid: false,
          reason: `Cross-origin request rejected: Referer '${refUrl.origin}' is not an authorized origin`,
        };
      }
    } catch {
      return { valid: false, reason: "Cross-origin request rejected: malformed Referer header" };
    }
    return { valid: true };
  }

  return { valid: true };
}

/**
 * Sets or refreshes the CSRF token cookie on the response.
 */
export function setCsrfCookie(res: Response, token: string, isProduction: boolean) {
  res.cookie(CSRF_COOKIE_NAME, token, {
    path: "/",
    sameSite: "lax",
    secure: isProduction,
    httpOnly: false, // Accessible to legitimate client-side JavaScript
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}



/**
 * Synchronizer Token & Double-Submit CSRF Protection Middleware:
 * Protects state-changing browser requests (POST, PUT, PATCH, DELETE).
 */
export function csrfProtectionMiddleware(req: Request, res: Response, next: NextFunction) {
  const isProduction = req.app.get("env") === "production";
  const cookies = parseCookies(req.headers["cookie"]);
  const cookieToken = cookies[CSRF_COOKIE_NAME];

  // Ensure session has a CSRF token assigned
  if (req.session && !(req.session as any).csrfToken) {
    (req.session as any).csrfToken = generateCsrfToken();
  }

  const sessionToken = (req.session as any)?.csrfToken as string | undefined;
  // Prime or synchronize the client-readable CSRF cookie for browser requests or token endpoint
  const hasBrowserIndicators = Boolean(
    req.headers["origin"] ||
    req.headers["referer"] ||
    req.headers["sec-fetch-site"] ||
    req.path === "/api/csrf-token"
  );

  const activeToken = sessionToken || cookieToken;
  if (hasBrowserIndicators && activeToken && (!cookieToken || cookieToken !== activeToken)) {
    setCsrfCookie(res, activeToken, isProduction);
  }

  // Safe HTTP methods do not require CSRF token validation
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return next();
  }

  // Defense-in-depth 1: Origin and Referer validation
  const originResult = verifyOriginAndReferer(req);
  if (!originResult.valid) {
    return res.status(403).json({
      message: originResult.reason || "Cross-origin request blocked by CSRF policy",
      code: "CSRF_ORIGIN_MISMATCH",
    });
  }

  // Defense-in-depth 2: Sec-Fetch-Site check
  const secFetchSite = req.headers["sec-fetch-site"];
  if (secFetchSite === "cross-site") {
    return res.status(403).json({
      message: "Cross-site browser requests are forbidden by CSRF policy",
      code: "CSRF_CROSS_SITE_BLOCKED",
    });
  }

  // Determine if this is a browser request requiring CSRF token validation
  const isBrowserRequest = Boolean(
    req.headers["origin"] ||
    req.headers["referer"] ||
    req.headers["sec-fetch-site"] ||
    req.headers["x-requested-with"] ||
    req.headers["x-csrf-token"] ||
    req.headers["csrf-token"] ||
    req.headers["x-xsrf-token"] ||
    (req.body && typeof req.body === "object" && (req.body._csrf || req.body.csrfToken))
  );

  if (!isBrowserRequest) {
    return next();
  }

  // Extract client-supplied CSRF token
  const headerToken = (
    req.headers["x-csrf-token"] ||
    req.headers["csrf-token"] ||
    req.headers["x-xsrf-token"]
  ) as string | undefined;

  const bodyToken = (
    req.body && typeof req.body === "object"
      ? req.body._csrf || req.body.csrfToken
      : undefined
  ) as string | undefined;

  const clientToken = headerToken || bodyToken;

  if (!clientToken || typeof clientToken !== "string" || !clientToken.trim()) {
    return res.status(403).json({
      message: "CSRF token missing. Provide valid token in X-CSRF-Token header or _csrf parameter.",
      code: "CSRF_TOKEN_MISSING",
    });
  }

  const trimmedToken = clientToken.trim();

  // Validate against Session Synchronizer Token or Double-Submit Cookie
  const matchesSession = Boolean(sessionToken && safeCompareTokens(trimmedToken, sessionToken));
  const matchesCookie = Boolean(cookieToken && safeCompareTokens(trimmedToken, cookieToken));

  if (!matchesSession && !matchesCookie) {
    return res.status(403).json({
      message: "Invalid CSRF token. Request rejected.",
      code: "CSRF_TOKEN_INVALID",
    });
  }

  next();
}
