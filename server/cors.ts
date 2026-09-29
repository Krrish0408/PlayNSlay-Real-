import type { Request, Response, NextFunction } from "express";
import {
  config,
  type AppEnvironment,
  getEnvironment,
  REQUIRED_CORS_METHODS,
  REQUIRED_CORS_HEADERS,
  EXPOSED_CORS_HEADERS,
  DEFAULT_DEV_ORIGINS,
  DEFAULT_STAGING_ORIGINS,
  DEFAULT_PROD_ORIGINS,
} from "./config";

/**
 * Testing overrides for deterministic multi-environment CORS testing.
 */
let testEnvOverride: AppEnvironment | null = null;
let testCustomAllowedOrigins: string[] | null = null;

export function setCorsEnvironmentForTesting(env: AppEnvironment | null) {
  testEnvOverride = env;
}

export function setCustomAllowedOriginsForTesting(origins: string[] | null) {
  testCustomAllowedOrigins = origins;
}

export function resetCorsTestingOverrides() {
  testEnvOverride = null;
  testCustomAllowedOrigins = null;
}

/**
 * Validates the syntactic and security structure of an incoming Origin header.
 * Enforces:
 * - Valid URL structure
 * - Disallow 'null', empty, or '*'
 * - Protocol enforcement: HTTPS strictly required for staging and production
 * - No userinfo, query, or path components in origin
 */
export function validateOrigin(
  origin: string,
  env: AppEnvironment = testEnvOverride || config.env
): { valid: boolean; normalized?: string; reason?: string } {
  if (!origin || typeof origin !== "string") {
    return { valid: false, reason: "Missing or invalid origin string" };
  }

  const trimmed = origin.trim();
  if (trimmed === "null") {
    return { valid: false, reason: "Untrusted origin 'null' rejected" };
  }
  if (trimmed === "*") {
    return { valid: false, reason: "Wildcard origin '*' is not allowed" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: "Malformed origin URL" };
  }

  // Ensure origin doesn't contain userinfo, path, query, or hash
  if (parsed.username || parsed.password) {
    return { valid: false, reason: "Origin cannot contain user credentials" };
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    return { valid: false, reason: "Origin cannot contain path component" };
  }
  if (parsed.search || parsed.hash) {
    return { valid: false, reason: "Origin cannot contain query or hash" };
  }

  // Strict protocol check: HTTPS required in staging and production
  const isProd = env === "production";
  const isStage = env === "staging";
  if ((isProd || isStage) && parsed.protocol !== "https:") {
    return {
      valid: false,
      reason: `Insecure HTTP origin rejected in ${env} environment; HTTPS required`,
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { valid: false, reason: `Unsupported protocol: ${parsed.protocol}` };
  }

  return { valid: true, normalized: parsed.origin.toLowerCase() };
}

/**
 * Extracts request host from headers (handling reverse proxy forwarded host).
 */
export function getRequestHost(req: Request): string {
  const forwarded = req.headers["x-forwarded-host"] as string | undefined;
  if (forwarded) {
    return forwarded.split(",")[0].trim().toLowerCase();
  }
  const host = req.headers["host"];
  return typeof host === "string" ? host.trim().toLowerCase() : "";
}

/**
 * Checks whether an origin is allowed for the active environment.
 * Strict environment separation:
 * - Development: allows localhost/127.0.0.1 and configured dev origins.
 * - Staging: allows staging origins only. Dev/localhost strictly rejected.
 * - Production: allows production origins only. Dev/localhost strictly rejected.
 */
export function isOriginAllowed(
  origin: string,
  req?: Request,
  envOverride?: AppEnvironment
): boolean {
  const activeEnv = envOverride || testEnvOverride || config.env;
  const validation = validateOrigin(origin, activeEnv);
  if (!validation.valid || !validation.normalized) {
    return false;
  }

  const normalized = validation.normalized;

  // Custom testing override
  if (testCustomAllowedOrigins) {
    return testCustomAllowedOrigins.map((o) => o.toLowerCase()).includes(normalized);
  }

  // Same-origin detection: when request originates from the same host
  if (req) {
    const currentHost = getRequestHost(req);
    if (currentHost) {
      let originHost = "";
      try {
        originHost = new URL(normalized).host.toLowerCase();
      } catch {
        return false;
      }

      if (originHost === currentHost) {
        if (activeEnv === "development" || activeEnv === "test") {
          return true;
        }
        // In production/staging, only allow if currentHost is part of the approved domains
        const allowedHosts = (
          activeEnv === "production"
            ? config.cors.productionOrigins
            : config.cors.stagingOrigins
        ).map((o) => {
          try {
            return new URL(o).host.toLowerCase();
          } catch {
            return "";
          }
        });
        if (allowedHosts.includes(currentHost)) {
          return true;
        }
      }
    }
  }

  // Environment-specific allowlist check
  if (activeEnv === "production") {
    // Strictly production origins only
    const prodList = config.cors.productionOrigins.map((o) => o.toLowerCase());
    return prodList.includes(normalized);
  }

  if (activeEnv === "staging") {
    // Strictly staging origins only
    const stagingList = config.cors.stagingOrigins.map((o) => o.toLowerCase());
    return stagingList.includes(normalized);
  }

  // Development or Test
  const devList = config.cors.developmentOrigins.map((o) => o.toLowerCase());
  if (devList.includes(normalized)) {
    return true;
  }

  // In dev/test, also accept standard localhost/127.0.0.1 on any local port
  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Checks whether an incoming request requires or carries credentials (cookies, auth headers).
 */
export function isCredentialRequired(req: Request): boolean {
  if (req.headers["cookie"] || req.headers["authorization"]) {
    return true;
  }
  const path = req.path || req.url;
  // Non-credentialed public endpoints
  if (path === "/api/health" || path === "/api/health/db") {
    return false;
  }
  // API endpoints and auth endpoints require credentials
  if (path.startsWith("/api/") || path.startsWith("/auth/")) {
    return true;
  }
  return false;
}

/**
 * Hardened CORS middleware:
 * - Enforces explicit production allowlists (NEVER wildcard '*' with credentials)
 * - Separates development, staging, and production origins
 * - Binds allowed methods and allowed headers strictly
 * - Validates Origin server-side and blocks unauthorized origins on authenticated operations
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers["origin"] as string | undefined;

  // Requests without Origin header (e.g. server-to-server or non-browser curl requests)
  if (!origin) {
    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    return next();
  }

  const allowed = isOriginAllowed(origin, req);

  // UNAUTHORIZED ORIGIN
  if (!allowed) {
    // Preflight from unauthorized origin must be rejected with 403
    if (req.method === "OPTIONS") {
      return res.status(403).json({
        message: "CORS preflight rejected: unauthorized origin",
        code: "CORS_ORIGIN_NOT_ALLOWED",
      });
    }

    // Authenticated API request from unauthorized origin: server-side origin validation fails closed
    if (isCredentialRequired(req)) {
      const reason = origin === "null"
        ? "Untrusted Origin 'null' rejected"
        : "Cross-origin request rejected: unauthorized Origin cannot perform authenticated API operations";
      return res.status(403).json({
        message: reason,
        code: "CORS_ORIGIN_NOT_ALLOWED",
      });
    }

    // Non-credentialed public endpoint from untrusted origin:
    // Do NOT set Access-Control-Allow-Origin or Access-Control-Allow-Credentials
    return next();
  }

  // AUTHORIZED ORIGIN
  const validation = validateOrigin(origin);
  const normalizedOrigin = validation.normalized || origin;

  // Explicitly mirror the authorized origin (NEVER wildcard '*')
  res.setHeader("Access-Control-Allow-Origin", normalizedOrigin);

  // Set credentials only where required/requested
  const requiresCreds = isCredentialRequired(req) || req.headers["access-control-request-headers"] !== undefined;
  if (requiresCreds) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader("Vary", "Origin");

  // PREFLIGHT OPTIONS HANDLING
  if (req.method === "OPTIONS") {
    const requestedMethod = req.headers["access-control-request-method"] as string | undefined;
    if (requestedMethod) {
      const upperMethod = requestedMethod.toUpperCase();
      if (!REQUIRED_CORS_METHODS.includes(upperMethod)) {
        return res.status(405).json({
          message: `CORS preflight rejected: method '${requestedMethod}' is not permitted`,
          code: "CORS_METHOD_NOT_ALLOWED",
        });
      }
    }

    const requestedHeaders = req.headers["access-control-request-headers"] as string | undefined;
    if (requestedHeaders) {
      const allowedHeadersLower = REQUIRED_CORS_HEADERS.map((h) => h.toLowerCase());
      const incomingHeaders = requestedHeaders.split(",").map((h) => h.trim().toLowerCase());
      const disallowed = incomingHeaders.filter((h) => !allowedHeadersLower.includes(h));
      if (disallowed.length > 0) {
        return res.status(403).json({
          message: `CORS preflight rejected: header(s) '${disallowed.join(", ")}' not permitted`,
          code: "CORS_HEADER_NOT_ALLOWED",
        });
      }
    }

    res.setHeader("Access-Control-Allow-Methods", config.cors.allowedMethods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", config.cors.allowedHeaders.join(", "));
    res.setHeader("Access-Control-Expose-Headers", config.cors.exposedHeaders.join(", "));
    res.setHeader("Access-Control-Max-Age", String(config.cors.maxAge));
    return res.sendStatus(204);
  }

  next();
}
