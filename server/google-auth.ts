import { randomBytes } from "crypto";
import { storage } from "./storage";
import { config } from "./config";
import { hashPassword } from "./auth";
import type { User } from "@shared/schema";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export interface GoogleUserProfile {
  sub: string;
  email: string;
  email_verified: boolean | string;
  nonce?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

// In-memory test mock tokens store for automated testing environments
const mockGoogleTokens = new Map<string, GoogleUserProfile>();

export function registerMockGoogleToken(token: string, profile: GoogleUserProfile) {
  mockGoogleTokens.set(token, profile);
}

export function clearMockGoogleTokens() {
  mockGoogleTokens.clear();
}

/**
 * Validates a Google ID token and returns the verified Google user profile.
 * Validates signature, audience, issuer, expiration, issued-at, nonce, and verified email status.
 */
export async function verifyGoogleIdToken(idToken: string, expectedNonce?: string): Promise<GoogleUserProfile> {
  if (!idToken || typeof idToken !== "string" || !idToken.trim()) {
    throw new Error("Google ID token is required.");
  }

  const trimmedToken = idToken.trim();

  // Support mocked tokens during automated testing
  if (mockGoogleTokens.has(trimmedToken)) {
    const profile = mockGoogleTokens.get(trimmedToken)!;
    const isVerified = profile.email_verified === true || profile.email_verified === "true";
    if (!isVerified) {
      throw new Error("Google account email is not verified.");
    }
    if (expectedNonce && profile.nonce !== expectedNonce) {
      throw new Error("Google ID token nonce mismatch.");
    }
    return profile;
  }

  // Verify against Google's tokeninfo endpoint
  const url = `${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(trimmedToken)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error_description || "Invalid or expired Google ID token.");
  }

  const payload: any = await res.json();

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Malformed Google token: missing stable user identifier (sub).");
  }

  if (!payload.email || typeof payload.email !== "string") {
    throw new Error("Malformed Google token: missing email address.");
  }

  // Verify audience if Google Client ID is configured
  if (config.google.clientId && payload.aud !== config.google.clientId) {
    throw new Error("Google ID token audience mismatch.");
  }

  // Verify issuer
  const validIssuers = ["accounts.google.com", "https://accounts.google.com"];
  if (!validIssuers.includes(payload.iss)) {
    throw new Error("Invalid Google token issuer.");
  }

  // Verify expiration
  if (payload.exp && Number(payload.exp) * 1000 < Date.now()) {
    throw new Error("Google ID token has expired.");
  }

  // Verify issued-at (clock skew protection)
  if (payload.iat && Number(payload.iat) * 1000 > Date.now() + 300000) {
    throw new Error("Google ID token issued in the future.");
  }

  // Verify OIDC Nonce if expected
  if (expectedNonce) {
    if (!payload.nonce || payload.nonce !== expectedNonce) {
      throw new Error("Google ID token nonce mismatch.");
    }
  }

  // Require Google verified email
  const isVerified = payload.email_verified === true || payload.email_verified === "true";
  if (!isVerified) {
    throw new Error("Google account email is not verified. Please verify your email with Google.");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    email_verified: true,
    nonce: payload.nonce,
    name: payload.name,
    given_name: payload.given_name,
    family_name: payload.family_name,
    picture: payload.picture,
  };
}

/**
 * Exchanges a Google OAuth authorization code for tokens and returns the verified user profile.
 */
export async function exchangeGoogleAuthCode(
  code: string,
  redirectUri: string,
  expectedNonce?: string
): Promise<GoogleUserProfile> {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error("Google OAuth credentials are not configured on this server.");
  }

  const params = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data: any = await res.json();

  if (!res.ok) {
    throw new Error(data.error_description || data.error || "Failed to exchange Google authorization code.");
  }

  if (data.id_token) {
    return await verifyGoogleIdToken(data.id_token, expectedNonce);
  }

  if (data.access_token) {
    // Fetch profile from Google UserInfo endpoint
    const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (!userinfoRes.ok) {
      throw new Error("Failed to fetch Google user profile.");
    }
    const profile: any = await userinfoRes.json();
    return {
      sub: profile.sub,
      email: profile.email,
      email_verified: profile.email_verified === true || profile.email_verified === "true",
      name: profile.name,
      given_name: profile.given_name,
      family_name: profile.family_name,
      picture: profile.picture,
    };
  }

  throw new Error("No ID token or access token received from Google.");
}

/**
 * Resolves a Google user profile into an authenticated Play N' Slay user account:
 * 1. Checks if an account exists linked with Google's stable identifier (sub).
 * 2. If not, checks if an account exists with the verified Google email and links it safely.
 * 3. If neither exists, automatically creates a new member account with isEmailVerified=true.
 * 4. Ensures no separate email verification link is required for Google users.
 */
export async function handleGoogleUser(profile: GoogleUserProfile): Promise<{ user: User; isNew: boolean; linked: boolean }> {
  const normEmail = profile.email.toLowerCase().trim();
  const sub = profile.sub.trim();

  // 1. Check if user exists by Google's stable user identifier (sub)
  let user = await storage.getUserByGoogleId(sub);
  if (user) {
    // User already linked via Google
    if (!user.isEmailVerified) {
      user = await storage.updateUser(user.id, {
        isEmailVerified: true,
        emailVerifiedAt: user.emailVerifiedAt || new Date(),
      });
    }
    return { user, isNew: false, linked: false };
  }

  // 2. Check if user exists by email address (Safe Account Linking)
  user = await storage.getUserByEmail(normEmail);
  if (user) {
    // Link existing account to Google
    user = await storage.updateUser(user.id, {
      googleId: sub,
      authProvider: user.authProvider === "local" ? "google" : user.authProvider,
      isEmailVerified: true,
      emailVerifiedAt: user.emailVerifiedAt || new Date(),
      avatarUrl: user.avatarUrl || profile.picture || null,
      fullName: user.fullName || profile.name || null,
    });

    await storage.createAuditLog({
      userId: user.id,
      username: user.username,
      action: "GOOGLE_ACCOUNT_LINKED",
      details: `Linked Google identity (sub: ${sub}) to existing account (${user.username}).`,
    });

    return { user, isNew: false, linked: true };
  }

  // 3. Automatically create new user account
  // Generate unique, clean username
  const rawBase = (profile.name || profile.given_name || normEmail.split("@")[0])
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 20);

  let username = rawBase || `player_${sub.slice(-6)}`;
  let existingUser = await storage.getUserByUsername(username);
  let attempts = 0;
  while (existingUser && attempts < 10) {
    attempts++;
    const suffix = randomBytes(2).toString("hex");
    username = `${rawBase.slice(0, 15)}_${suffix}`;
    existingUser = await storage.getUserByUsername(username);
  }

  // Generate secure unguessable random password hash
  const randomPassword = randomBytes(32).toString("hex");
  const hashedPassword = await hashPassword(randomPassword);

  user = await storage.createUser({
    username,
    password: hashedPassword,
    email: normEmail,
    fullName: profile.name || profile.given_name || null,
    avatarUrl: profile.picture || null,
    role: "member",
    membershipTier: "bronze",
    authProvider: "google",
    googleId: sub,
    isEmailVerified: true, // Google accounts come pre-verified by Google
    emailVerifiedAt: new Date(),
    resetRequired: false,
    tokenVersion: 1,
  });

  await storage.createAuditLog({
    userId: user.id,
    username: user.username,
    action: "GOOGLE_ACCOUNT_CREATED",
    details: `Created new Play N' Slay member account via Google OAuth (sub: ${sub}, email: ${normEmail}).`,
  });

  return { user, isNew: true, linked: false };
}
