import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { scrypt, randomBytes, timingSafeEqual, createHmac } from "crypto";
import { promisify } from "util";
import rateLimit from "express-rate-limit";
import argon2 from "argon2";
import { storage } from "./storage";
import { User, ROLE_PERMISSIONS, UserRole } from "@shared/schema";
import { isStaff, isAdmin } from "./authorization";
import {
  generateVerificationToken,
  hashVerificationToken,
  sendVerificationEmail,
  generatePasswordResetToken,
  hashPasswordResetToken,
  sendPasswordResetEmail,
} from "./email-service";
import { config } from "./config";
import {
  GOOGLE_AUTH_URL,
  verifyGoogleIdToken,
  exchangeGoogleAuthCode,
  handleGoogleUser,
} from "./google-auth";
import {
  generateMfaSetup,
  verifyTotpToken,
  verifyAndConsumeRecoveryCode,
} from "./mfa-service";
import {
  COOKIE_NAME,
  MEMBER_SESSION_MAX_AGE,
  PRIVILEGED_SESSION_MAX_AGE,
  getSessionTimeouts,
  hashSessionId,
  regenerateSession,
} from "./session-service";
import {
  corsMiddleware,
  csrfProtectionMiddleware,
  generateCsrfToken,
  setCsrfCookie,
  CSRF_COOKIE_NAME,
} from "./csrf";

const scryptAsync = promisify(scrypt);

// Endpoint-aware distributed rate limiters (backed by Redis or PostgreSQL shared store, NAT-safe)
import {
  authLimiter as loginLimiter,
  registerLimiter,
  emailVerificationLimiter as resendVerificationLimiter,
  passwordResetLimiter,
  mfaVerifyLimiter,
} from "./rate-limiter";

// Strip password and secret verification/reset tokens and MFA secrets from user object before sending to client
export function sanitizeUser(user: User | any) {
  if (!user) return user;
  const {
    password: _,
    emailVerificationTokenHash: __,
    emailVerificationTokenExpiresAt: ___,
    passwordResetTokenHash: ____,
    passwordResetTokenExpiresAt: _____,
    mfaSecret: ______,
    mfaRecoveryCodes: _______,
    mfaLastUsedTimestep: ________,
    ...safe
  } = user;
  return safe;
}

export async function hashPassword(password: string): Promise<string> {
  return await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,       // 3 iterations
    parallelism: 1,    // 1 thread
  });
}

export async function comparePasswords(supplied: string, stored: string): Promise<boolean> {
  if (!supplied || !stored) return false;

  // Modern Argon2id hash format ($argon2id$...)
  if (stored.startsWith("$argon2")) {
    try {
      return await argon2.verify(stored, supplied);
    } catch {
      return false;
    }
  }

  // Legacy scrypt hash format (<hex>.<saltHex>) for backward compatibility
  if (stored.includes(".")) {
    try {
      const [hashed, salt] = stored.split(".");
      if (!hashed || !salt) return false;
      const hashedBuf = Buffer.from(hashed, "hex");
      const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
      if (hashedBuf.length !== suppliedBuf.length) return false;
      return timingSafeEqual(hashedBuf, suppliedBuf);
    } catch {
      return false;
    }
  }

  return false;
}

export function setupAuth(app: Express) {
  const sessionSettings: session.SessionOptions = {
    name: COOKIE_NAME,
    secret: config.sessionSecret || "dev_session_secret_key_12345",
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      httpOnly: true,
      secure: app.get("env") === "production",
      maxAge: MEMBER_SESSION_MAX_AGE,
      sameSite: "lax",
      path: "/",
    },
  };

  if (app.get("env") === "production") {
    app.set("trust proxy", 1);
  }

  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  // Explicit CORS configuration (strictly rejects wildcard origins with credentials)
  app.use(corsMiddleware);

  // Synchronizer Token & Double-Submit CSRF Protection for state-changing browser requests
  app.use(csrfProtectionMiddleware);

  // Endpoint to obtain/refresh an authoritative CSRF token
  app.get("/api/csrf-token", (req, res) => {
    if (req.session && !(req.session as any).csrfToken) {
      (req.session as any).csrfToken = generateCsrfToken();
    }
    const token = (req.session as any)?.csrfToken || generateCsrfToken();
    if (req.session) {
      (req.session as any).csrfToken = token;
    }
    setCsrfCookie(res, token, app.get("env") === "production");
    res.json({ csrfToken: token });
  });

  // Session Timeout & Revocation Middleware (Idle and Absolute Timeouts)
  app.use(async (req, res, next) => {
    if (!req.session || !req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return next();
    }

    const user = req.user as User;
    const { idleTimeout, absoluteTimeout } = getSessionTimeouts(user);
    const now = Date.now();

    const sessionData = req.session as any;
    const createdAt = sessionData.sessionCreatedAt || now;
    const lastActiveAt = sessionData.lastActiveAt || now;

    const sid = req.sessionID;
    const sidHash = sid ? hashSessionId(sid) : null;

    // Check if session has been revoked in user_sessions metadata table
    if (sidHash) {
      const userSession = await storage.getUserSessionByHash(sidHash).catch(() => undefined);
      if (userSession && userSession.revokedAt) {
        delete (req as any).user;
        return req.session.destroy(() => {
          res.clearCookie(COOKIE_NAME, { path: "/" });
          return res.status(401).json({
            message: "Your session has been revoked. Please log in again.",
            code: "SESSION_REVOKED",
            revoked: true,
          });
        });
      }
    }

    // Check absolute timeout
    if (now - createdAt > absoluteTimeout) {
      if (sidHash) {
        await storage.revokeUserSession(sidHash).catch(() => {});
      }
      delete (req as any).user;
      return req.session.destroy(() => {
        res.clearCookie(COOKIE_NAME, { path: "/" });
        return res.status(401).json({
          message: "Session expired (maximum session duration reached). Please log in again.",
          code: "SESSION_ABSOLUTE_TIMEOUT",
          expired: true,
        });
      });
    }

    // Check idle timeout
    if (now - lastActiveAt > idleTimeout) {
      if (sidHash) {
        await storage.revokeUserSession(sidHash).catch(() => {});
      }
      delete (req as any).user;
      return req.session.destroy(() => {
        res.clearCookie(COOKIE_NAME, { path: "/" });
        return res.status(401).json({
          message: "Session expired due to inactivity. Please log in again.",
          code: "SESSION_IDLE_TIMEOUT",
          expired: true,
        });
      });
    }

    // Update timestamps
    sessionData.lastActiveAt = now;
    if (!sessionData.sessionCreatedAt) {
      sessionData.sessionCreatedAt = now;
    }

    if (sidHash) {
      storage.touchUserSession(sidHash, new Date(now)).catch(() => {});
    }

    next();
  });

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        const user = await storage.getUserByIdentifier(username);
        if (!user || !(await comparePasswords(password, user.password))) {
          return done(null, false, { message: "Invalid username or password" });
        }
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }),
  );

  passport.serializeUser((user, done) => {
    const u = user as User;
    done(null, { id: u.id, tokenVersion: u.tokenVersion ?? 1 });
  });

  passport.deserializeUser(async (serialized: any, done) => {
    try {
      const id = typeof serialized === "object" ? serialized.id : serialized;
      const sessionTokenVersion = typeof serialized === "object" ? serialized.tokenVersion : undefined;
      const user = await storage.getUser(id);
      if (!user) {
        return done(null, false);
      }
      // If session tokenVersion doesn't match active tokenVersion, session is invalidated
      if (sessionTokenVersion !== undefined && user.tokenVersion !== undefined && sessionTokenVersion !== user.tokenVersion) {
        return done(null, false);
      }
      done(null, user);
    } catch (err) {
      done(err);
    }
  });

  // User Registration (Supports single identifier: username OR email OR phone number + password)
  app.post("/api/register", registerLimiter, async (req, res, next) => {
    try {
      const { identifier, username, password, fullName, email, phone, avatarUrl } = req.body;
      if (!password || typeof password !== "string" || password.length < 6) {
        return res.status(400).json({ message: "Password is required and must be at least 6 characters long." });
      }

      // Extract the primary credential provided
      const rawInput = (identifier || username || email || phone || "").toString().trim();
      if (!rawInput) {
        return res.status(400).json({ message: "Please provide a username, email, or phone number to register." });
      }

      // Detect credential type if not explicitly split
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawInput);
      const isPhone = /^(\+?[0-9\s\-()]{7,20})$/.test(rawInput) && !/[a-zA-Z]/.test(rawInput);

      let finalUsername = (username || "").toString().trim();
      let finalEmail = email ? email.toString().toLowerCase().trim() : (isEmail ? rawInput.toLowerCase() : null);
      let finalPhone = phone ? phone.toString().trim() : (isPhone ? rawInput : null);

      if (finalEmail) {
        // Defense against user enumeration: do not reveal whether an email is already registered
        const existingByEmail = await storage.getUserByEmail(finalEmail);
        if (existingByEmail) {
          return res.status(201).json({
            message: "Registration successful. Please check your email for a verification link.",
            emailVerificationRequired: true,
          });
        }
        if (!finalUsername) {
          const baseName = finalEmail.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 15) || "user";
          let candidate = baseName.length >= 3 ? baseName : `${baseName}_player`;
          let attempts = 0;
          while (await storage.getUserByUsername(candidate)) {
            candidate = `${baseName}_${Math.floor(100 + Math.random() * 900)}`;
            attempts++;
            if (attempts > 10) {
              candidate = `${baseName}_${Date.now().toString().slice(-4)}`;
              break;
            }
          }
          finalUsername = candidate;
        }
      } else if (finalPhone) {
        const cleanDigits = finalPhone.replace(/\D/g, "");
        if (cleanDigits.length < 7) {
          return res.status(400).json({ message: "Please enter a valid phone number with at least 7 digits." });
        }
        const existingByPhone = await storage.getUserByPhone(finalPhone);
        if (existingByPhone) {
          return res.status(400).json({ message: "An account with this phone number already exists. Please log in." });
        }
        if (!finalUsername) {
          const lastFour = cleanDigits.slice(-4);
          let candidate = `player_${lastFour}`;
          let attempts = 0;
          while (await storage.getUserByUsername(candidate)) {
            candidate = `player_${lastFour}_${Math.floor(100 + Math.random() * 900)}`;
            attempts++;
            if (attempts > 10) {
              candidate = `player_${Date.now().toString().slice(-4)}`;
              break;
            }
          }
          finalUsername = candidate;
        }
      } else {
        if (!finalUsername) {
          finalUsername = rawInput;
        }
      }

      if (finalUsername.length < 3) {
        return res.status(400).json({ message: "Username must be at least 3 characters long." });
      }

      const existingUser = await storage.getUserByUsername(finalUsername);
      if (existingUser) {
        return res.status(400).json({ message: "Username already exists" });
      }

      const hashedPassword = await hashPassword(password);
      const verification = finalEmail ? generateVerificationToken(24) : null;

      const user = await storage.createUser({
        username: finalUsername,
        password: hashedPassword,
        fullName: fullName || null,
        email: finalEmail,
        phone: finalPhone,
        avatarUrl: avatarUrl || null,
        role: "member",
        membershipTier: "bronze",
        isEmailVerified: false,
        emailVerifiedAt: null,
        emailVerificationTokenHash: verification?.tokenHash ?? null,
        emailVerificationTokenExpiresAt: verification?.expiresAt ?? null,
      });

      if (finalEmail && verification) {
        await sendVerificationEmail({
          to: user.email!,
          username: user.username,
          verificationToken: verification.rawToken,
        }).catch((e) => console.error("[EMAIL] Failed to send verification email:", e));
      }

      await regenerateSession(req);
      if (req.session) {
        (req.session as any).csrfToken = generateCsrfToken();
      }

      req.login(user, async (err) => {
        if (err) return next(err);

        const { maxAge } = getSessionTimeouts(user);
        req.session.cookie.maxAge = maxAge;
        (req.session as any).sessionCreatedAt = Date.now();
        (req.session as any).lastActiveAt = Date.now();

        const sid = req.sessionID;
        if (sid) {
          const sidHash = hashSessionId(sid);
          const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null;
          const userAgent = (req.headers["user-agent"] as string) || null;
          await storage.createUserSession({
            sessionIdHash: sidHash,
            userId: user.id,
            expiresAt: new Date(Date.now() + maxAge),
            ipAddress,
            userAgent,
          }).catch(() => {});
        }

        res.status(201).json({
          ...sanitizeUser(user),
          emailVerificationSent: Boolean(email),
        });
      });
    } catch (err) {
      next(err);
    }
  });

  // Verify Email Endpoint (POST - programmatic API calls)
  app.post("/api/auth/verify-email", resendVerificationLimiter, async (req, res) => {
    try {
      const { token } = req.body;
      if (!token || typeof token !== "string" || !token.trim()) {
        return res.status(400).json({ message: "Verification token is required", code: "TOKEN_REQUIRED" });
      }

      const tokenHash = hashVerificationToken(token.trim());
      const user = await storage.getUserByVerificationTokenHash(tokenHash);

      if (!user) {
        return res.status(400).json({
          message: "Invalid or expired verification token. Please request a new verification email.",
          code: "INVALID_TOKEN",
        });
      }

      if (user.emailVerificationTokenExpiresAt && new Date(user.emailVerificationTokenExpiresAt) < new Date()) {
        return res.status(400).json({
          message: "Verification token has expired. Please request a new verification email.",
          code: "TOKEN_EXPIRED",
        });
      }

      // Mark email as verified and invalidate token (single-use, prevent reuse)
      const updatedUser = await storage.updateUser(user.id, {
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
        emailVerificationTokenHash: null,
        emailVerificationTokenExpiresAt: null,
      });

      res.status(200).json({
        message: "Email successfully verified. You can now make online bookings.",
        user: sanitizeUser(updatedUser),
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  // Verify Email Link Endpoint (GET - browser clickable links from email)
  app.get("/api/auth/verify-email", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token || typeof token !== "string" || !token.trim()) {
        return res.status(400).json({ message: "Verification token is required", code: "TOKEN_REQUIRED" });
      }

      const tokenHash = hashVerificationToken(token.trim());
      const user = await storage.getUserByVerificationTokenHash(tokenHash);

      if (!user) {
        return res.status(400).json({
          message: "Invalid or expired verification token. Please request a new verification email.",
          code: "INVALID_TOKEN",
        });
      }

      if (user.emailVerificationTokenExpiresAt && new Date(user.emailVerificationTokenExpiresAt) < new Date()) {
        return res.status(400).json({
          message: "Verification token has expired. Please request a new verification email.",
          code: "TOKEN_EXPIRED",
        });
      }

      // Mark email as verified and invalidate token (single-use, prevent reuse)
      const updatedUser = await storage.updateUser(user.id, {
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
        emailVerificationTokenHash: null,
        emailVerificationTokenExpiresAt: null,
      });

      if (req.accepts("html")) {
        return res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Email Verified - Play N' Slay</title>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; border: 1px solid #334155; text-align: center; max-width: 440px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
                h1 { color: #10b981; margin-bottom: 0.5rem; font-size: 1.6rem; }
                p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; margin-bottom: 1.5rem; }
                a { display: inline-block; background: #6366f1; color: white; padding: 0.75rem 1.5rem; border-radius: 0.5rem; text-decoration: none; font-weight: 600; }
              </style>
            </head>
            <body>
              <div class="card">
                <h1>Email Verified!</h1>
                <p>Your email has been successfully verified. You can now access full lounge member privileges including online station bookings.</p>
                <a href="/">Go to Lounge Dashboard</a>
              </div>
            </body>
          </html>
        `);
      }

      res.status(200).json({
        message: "Email successfully verified. You can now make online bookings.",
        user: sanitizeUser(updatedUser),
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  // Resend Verification Email (Rate-limited, prevents email enumeration)
  app.post("/api/auth/resend-verification", resendVerificationLimiter, async (req, res) => {
    try {
      let email = req.body?.email;
      if (!email && req.isAuthenticated && req.isAuthenticated()) {
        email = (req.user as User).email;
      }

      if (!email || typeof email !== "string" || !email.trim()) {
        return res.status(400).json({ message: "Email address is required" });
      }

      const normEmail = email.toLowerCase().trim();
      const user = await storage.getUserByEmail(normEmail);

      // Generic response ensures non-disclosure of whether email is registered or verified
      const genericResponse = {
        message: "If an unverified account exists with this email address, a new verification link has been sent.",
      };

      if (!user || user.isEmailVerified) {
        return res.status(200).json(genericResponse);
      }

      // Generate a new token and update hash
      const { rawToken, tokenHash, expiresAt } = generateVerificationToken(24);
      await storage.updateUser(user.id, {
        emailVerificationTokenHash: tokenHash,
        emailVerificationTokenExpiresAt: expiresAt,
      });

      await sendVerificationEmail({
        to: user.email!,
        username: user.username,
        verificationToken: rawToken,
      });

      res.status(200).json(genericResponse);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  // Forgot Password (Rate-limited, anti-enumeration, sends short-lived cryptographically secure hashed token)
  app.post("/api/auth/forgot-password", passwordResetLimiter, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string" || !email.trim()) {
        return res.status(400).json({ message: "Email address is required" });
      }

      const normEmail = email.toLowerCase().trim();
      const user = await storage.getUserByEmail(normEmail);

      // Generic response ensures non-disclosure of whether email is registered (prevents enumeration)
      const genericResponse = {
        message: "If an account exists with this email address, password reset instructions have been sent.",
      };

      if (!user || !user.email) {
        return res.status(200).json(genericResponse);
      }

      // Generate cryptographically secure token with 15-minute expiration
      const { rawToken, tokenHash, expiresAt } = generatePasswordResetToken(15);
      await storage.updateUser(user.id, {
        passwordResetTokenHash: tokenHash,
        passwordResetTokenExpiresAt: expiresAt,
      });

      await sendPasswordResetEmail({
        to: user.email,
        username: user.username,
        resetToken: rawToken,
      });

      await storage.createAuditLog({
        userId: user.id,
        username: user.username,
        action: "PASSWORD_RESET_REQUESTED",
        details: "Password reset instructions sent to registered email.",
      });

      res.status(200).json(genericResponse);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  // Reset Password (Validates hashed token, enforces short expiry, single-use, invalidates all sessions)
  app.post("/api/auth/reset-password", passwordResetLimiter, async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      if (!token || typeof token !== "string" || !token.trim()) {
        return res.status(400).json({ message: "Reset token is required", code: "TOKEN_REQUIRED" });
      }
      if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters long.", code: "INVALID_PASSWORD" });
      }

      const tokenHash = hashPasswordResetToken(token.trim());
      const user = await storage.getUserByPasswordResetTokenHash(tokenHash);

      if (!user) {
        return res.status(400).json({
          message: "Invalid or expired password reset token.",
          code: "INVALID_TOKEN",
        });
      }

      if (user.passwordResetTokenExpiresAt && new Date(user.passwordResetTokenExpiresAt) < new Date()) {
        return res.status(400).json({
          message: "Password reset token has expired. Please request a new reset link.",
          code: "TOKEN_EXPIRED",
        });
      }

      // Hash new password and clear reset token (single-use) and resetRequired flag
      const hashedPassword = await hashPassword(newPassword);
      await storage.updateUser(user.id, {
        password: hashedPassword,
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
        resetRequired: false,
      });

      // Invalidate all existing sessions for this user across all devices
      await storage.invalidateUserSessions(user.id);

      // Record security audit event
      await storage.createAuditLog({
        userId: user.id,
        username: user.username,
        action: "PASSWORD_RESET_COMPLETED",
        details: "User password successfully reset. All active sessions invalidated.",
      });

      // Require reauthentication: invalidate current request session if any
      delete (req as any).user;
      if (req.session) {
        req.session.destroy(() => {});
      }
      res.clearCookie(COOKIE_NAME, { path: "/" });

      res.status(200).json({
        message: "Password has been reset successfully. Please log in with your new password.",
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  app.post("/api/login", loginLimiter, (req, res, next) => {
    passport.authenticate("local", async (err: any, user: User | false, info: any) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ message: info?.message || "Invalid username or password" });
      }

      if (user.resetRequired) {
        return res.status(403).json({
          message: "A password reset is required for your account before logging in. Please use the reset link sent to your email or request a password reset.",
          code: "RESET_REQUIRED",
          resetRequired: true,
        });
      }

      // SESSION FIXATION DEFENSE: Regenerate session ID upon successful login
      await regenerateSession(req);
      if (req.session) {
        (req.session as any).csrfToken = generateCsrfToken();
      }

      req.login(user, async (loginErr) => {
        if (loginErr) return next(loginErr);

        const { maxAge } = getSessionTimeouts(user);
        req.session.cookie.maxAge = maxAge;
        (req.session as any).sessionCreatedAt = Date.now();
        (req.session as any).lastActiveAt = Date.now();

        // Track session in user_sessions table
        const sid = req.sessionID;
        if (sid) {
          const sidHash = hashSessionId(sid);
          const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null;
          const userAgent = (req.headers["user-agent"] as string) || null;
          const expiresAt = new Date(Date.now() + maxAge);

          await storage.createUserSession({
            sessionIdHash: sidHash,
            userId: user.id,
            expiresAt,
            ipAddress,
            userAgent,
          }).catch((e) => console.error("[USER SESSION RECORD ERROR]", e));
        }

        const isStaffUser = isStaff(user);
        const enforceStaffMfa = config.auth.enforceStaffMfa;

        if (user.isMfaEnabled) {
          (req.session as any).mfaVerified = false;
          return res.status(200).json({
            mfaRequired: true,
            message: "Two-factor authentication required. Please verify with your authenticator code or recovery code.",
            userId: user.id,
            username: user.username,
          });
        } else if (enforceStaffMfa && isStaffUser) {
          (req.session as any).mfaVerified = false;
          return res.status(200).json({
            mfaSetupRequired: true,
            message: "MFA setup is required for administrator and employee accounts. Please complete two-factor authentication setup.",
            userId: user.id,
            username: user.username,
            user: sanitizeUser(user),
          });
        }

        (req.session as any).mfaVerified = true;
        res.status(200).json(sanitizeUser(user));
      });
    })(req, res, next);
  });

  app.post("/api/logout", async (req, res) => {
    const sid = req.sessionID;
    if (sid) {
      const sidHash = hashSessionId(sid);
      await storage.revokeUserSession(sidHash).catch(() => {});
    }

    delete (req as any).user;
    if (req.session) {
      req.session.destroy((destroyErr) => {
        if (destroyErr) {
          console.error("[SESSION DESTROY ERROR]", destroyErr);
        }
        res.clearCookie(COOKIE_NAME, { path: "/" });
        res.clearCookie(CSRF_COOKIE_NAME, { path: "/" });
        res.sendStatus(200);
      });
    } else {
      res.clearCookie(COOKIE_NAME, { path: "/" });
      res.clearCookie(CSRF_COOKIE_NAME, { path: "/" });
      res.sendStatus(200);
    }
  });

  // List Active Sessions for Current User
  app.get("/api/auth/sessions", async (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Authentication required", code: "AUTH_REQUIRED" });
    }

    const user = req.user as User;
    const currentSidHash = req.sessionID ? hashSessionId(req.sessionID) : null;
    const sessions = await storage.getUserActiveSessions(user.id);

    const safeSessions = sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      isCurrent: Boolean(currentSidHash && s.sessionIdHash === currentSidHash),
    }));

    res.status(200).json(safeSessions);
  });

  // Revoke Individual Session by ID
  app.delete("/api/auth/sessions/:id", async (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Authentication required", code: "AUTH_REQUIRED" });
    }

    const user = req.user as User;
    const sessionId = parseInt(req.params.id, 10);
    if (isNaN(sessionId)) {
      return res.status(400).json({ message: "Invalid session ID", code: "INVALID_ID" });
    }

    const activeSessions = await storage.getUserActiveSessions(user.id);
    const targetSession = activeSessions.find((s) => s.id === sessionId);

    if (!targetSession) {
      return res.status(404).json({ message: "Session not found or already revoked", code: "SESSION_NOT_FOUND" });
    }

    await storage.revokeUserSessionById(sessionId, user.id);

    // If revoking the current session, log out and destroy session
    const currentSidHash = req.sessionID ? hashSessionId(req.sessionID) : null;
    if (currentSidHash && targetSession.sessionIdHash === currentSidHash) {
      delete (req as any).user;
      if (req.session) {
        return req.session.destroy(() => {
          res.clearCookie(COOKIE_NAME, { path: "/" });
          res.status(200).json({
            success: true,
            message: "Current session has been revoked and logged out.",
            isCurrent: true,
          });
        });
      }
      res.clearCookie(COOKIE_NAME, { path: "/" });
      return res.status(200).json({
        success: true,
        message: "Current session has been revoked and logged out.",
        isCurrent: true,
      });
    }

    res.status(200).json({
      success: true,
      message: "Session has been revoked successfully.",
      isCurrent: false,
    });
  });

  // Revoke All Sessions / Logout All Devices
  app.post(["/api/auth/sessions/revoke-all", "/api/auth/logout-all"], async (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Authentication required", code: "AUTH_REQUIRED" });
    }

    const user = req.user as User;
    const { preserveCurrent } = req.body || {};
    const currentSidHash = req.sessionID ? hashSessionId(req.sessionID) : undefined;

    if (preserveCurrent && currentSidHash) {
      // Invalidate all OTHER sessions
      await storage.revokeAllUserSessions(user.id, currentSidHash);
      return res.status(200).json({
        success: true,
        message: "All other device sessions have been revoked.",
      });
    }

    // Invalidate ALL sessions including current
    await storage.revokeAllUserSessions(user.id);
    await storage.invalidateUserSessions(user.id);

    delete (req as any).user;
    if (req.session) {
      return req.session.destroy(() => {
        res.clearCookie(COOKIE_NAME, { path: "/" });
        res.status(200).json({
          success: true,
          message: "All sessions have been revoked across all devices.",
        });
      });
    }
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.status(200).json({
      success: true,
      message: "All sessions have been revoked across all devices.",
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const user = req.user as User;
    const isStaffUser = isStaff(user);
    const enforceStaffMfa = config.auth.enforceStaffMfa;
    const isMfaPending = Boolean(user.isMfaEnabled && !(req.session as any)?.mfaVerified);
    const isMfaSetupRequired = Boolean(enforceStaffMfa && isStaffUser && !user.isMfaEnabled);
    res.json({
      ...sanitizeUser(user),
      role: user.role,
      permissions: ROLE_PERMISSIONS[user.role as UserRole] || [],
      mfaVerified: Boolean((req.session as any)?.mfaVerified),
      mfaRequired: isMfaPending,
      mfaSetupRequired: isMfaSetupRequired,
    });
  });

  // Get MFA Status
  app.get("/api/auth/mfa/status", (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Authentication required", code: "AUTH_REQUIRED" });
    }
    const user = req.user as User;
    res.json({
      isMfaEnabled: Boolean(user.isMfaEnabled),
      mfaVerified: Boolean((req.session as any)?.mfaVerified),
    });
  });

  // Initiate MFA Setup (Generates TOTP secret, QR code, and single-use recovery codes)
  app.post("/api/auth/mfa/setup", async (req, res) => {
    try {
      if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
        return res.status(401).json({ message: "Authentication required", code: "AUTH_REQUIRED" });
      }

      const user = req.user as User;

      if (user.isMfaEnabled) {
        return res.status(400).json({
          message: "MFA is already enabled on this account. Please disable or reset it before reconfiguring.",
          code: "MFA_ALREADY_ENABLED",
        });
      }

      const setup = await generateMfaSetup({ username: user.username });

      // Store pending setup in session - NOT activated in database until verified!
      (req.session as any).mfaPendingSetup = {
        secret: setup.secret,
        encryptedSecret: setup.encryptedSecret,
        recoveryCodes: setup.recoveryCodes,
        hashedRecoveryCodes: setup.hashedRecoveryCodes,
      };

      res.status(200).json({
        qrCode: setup.qrCode,
        otpauthUrl: setup.otpauthUrl,
        manualEntryKey: setup.secret,
        recoveryCodes: setup.recoveryCodes,
        message: "Scan the QR code with your authenticator app and enter the 6-digit code to activate MFA.",
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  // Activate MFA (Verifies TOTP token before enabling MFA in database)
  app.post("/api/auth/mfa/activate", async (req, res) => {
    try {
      if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
        return res.status(401).json({ message: "Authentication required", code: "AUTH_REQUIRED" });
      }

      const user = req.user as User;
      const pending = (req.session as any).mfaPendingSetup;

      if (!pending || !pending.encryptedSecret) {
        return res.status(400).json({
          message: "No pending MFA setup found. Please initiate setup first.",
          code: "NO_PENDING_MFA",
        });
      }

      const { token, code } = req.body || {};
      const inputToken = String(token || code || "").trim();

      if (!inputToken) {
        return res.status(400).json({
          message: "Verification code is required to activate MFA.",
          code: "TOKEN_REQUIRED",
        });
      }

      // Verify OTP before activation
      const result = verifyTotpToken({
        token: inputToken,
        encryptedSecret: pending.encryptedSecret,
        lastUsedTimestep: null,
      });

      if (!result.valid) {
        return res.status(400).json({
          message: "Invalid verification code. Please check your authenticator app and try again.",
          code: "INVALID_MFA_TOKEN",
        });
      }

      // Commit to database
      const updatedUser = await storage.updateUser(user.id, {
        isMfaEnabled: true,
        mfaSecret: pending.encryptedSecret,
        mfaRecoveryCodes: JSON.stringify(pending.hashedRecoveryCodes),
        mfaLastUsedTimestep: result.timeStep ?? Math.floor(Date.now() / 1000 / 30),
      });

      // Update session state
      (req.session as any).mfaVerified = true;
      delete (req.session as any).mfaPendingSetup;

      await storage.createAuditLog({
        userId: user.id,
        username: user.username,
        action: "MFA_ENABLED",
        details: `Two-factor authentication enabled by ${user.role} user '${user.username}'.`,
      });

      res.status(200).json({
        success: true,
        message: "Two-factor authentication enabled successfully.",
        user: sanitizeUser(updatedUser),
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  // Verify MFA (Rate-limited, supports TOTP token or single-use recovery code)
  app.post("/api/auth/mfa/verify", mfaVerifyLimiter, async (req, res) => {
    try {
      if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
        return res.status(401).json({ message: "Authentication required", code: "AUTH_REQUIRED" });
      }

      const user = req.user as User;
      if (!user.isMfaEnabled) {
        return res.status(400).json({ message: "MFA is not enabled for this account.", code: "MFA_NOT_ENABLED" });
      }

      const { code, token } = req.body || {};
      const input = String(code || token || "").trim();

      if (!input) {
        return res.status(400).json({
          message: "Verification code or recovery code is required.",
          code: "CODE_REQUIRED",
        });
      }

      // Check if it matches a recovery code
      const isRecoveryFormat = input.includes("-") || input.length >= 8;
      if (user.mfaRecoveryCodes && (isRecoveryFormat || !/^\d{6}$/.test(input))) {
        const recoveryResult = verifyAndConsumeRecoveryCode(input, user.mfaRecoveryCodes);
        if (recoveryResult.valid) {
          const updatedUser = await storage.updateUser(user.id, {
            mfaRecoveryCodes: recoveryResult.remainingHashedCodesJson,
          });

          (req.session as any).mfaVerified = true;

          await storage.createAuditLog({
            userId: user.id,
            username: user.username,
            action: "MFA_RECOVERY_CODE_USED",
            details: `User '${user.username}' successfully authenticated using a single-use recovery code.`,
          });

          return res.status(200).json({
            success: true,
            message: "MFA verified successfully via recovery code.",
            user: sanitizeUser(updatedUser),
            usedRecoveryCode: true,
          });
        }

        if (isRecoveryFormat) {
          await storage.createAuditLog({
            userId: user.id,
            username: user.username,
            action: "MFA_VERIFY_FAILED",
            details: `Failed recovery code verification attempt for user '${user.username}'.`,
          });
          return res.status(400).json({
            message: "Invalid or already used recovery code.",
            code: "INVALID_RECOVERY_CODE",
          });
        }
      }

      // Verify as TOTP token
      if (!user.mfaSecret) {
        return res.status(500).json({
          message: "MFA secret is missing from account.",
          code: "MFA_SECRET_MISSING",
        });
      }

      const totpResult = verifyTotpToken({
        token: input,
        encryptedSecret: user.mfaSecret,
        lastUsedTimestep: user.mfaLastUsedTimestep,
      });

      if (!totpResult.valid) {
        if (totpResult.reason === "REPLAY_DETECTED") {
          await storage.createAuditLog({
            userId: user.id,
            username: user.username,
            action: "MFA_VERIFY_FAILED",
            details: `Replayed TOTP token rejected for user '${user.username}'.`,
          });
          return res.status(400).json({
            message: "Token has already been used. Please wait for the next token.",
            code: "MFA_TOKEN_REPLAY",
          });
        }

        await storage.createAuditLog({
          userId: user.id,
          username: user.username,
          action: "MFA_VERIFY_FAILED",
          details: `Invalid TOTP verification attempt for user '${user.username}'.`,
        });
        return res.status(400).json({
          message: "Invalid two-factor authentication code.",
          code: "INVALID_MFA_TOKEN",
        });
      }

      // Valid TOTP! Update last used timestep to prevent token replay
      const updatedUser = await storage.updateUser(user.id, {
        mfaLastUsedTimestep: totpResult.timeStep ?? Math.floor(Date.now() / 1000 / 30),
      });

      (req.session as any).mfaVerified = true;

      await storage.createAuditLog({
        userId: user.id,
        username: user.username,
        action: "MFA_VERIFIED",
        details: `Two-factor authentication verified for user '${user.username}'.`,
      });

      return res.status(200).json({
        success: true,
        message: "MFA verified successfully.",
        user: sanitizeUser(updatedUser),
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  // Disable MFA (Strictly requires reauthentication before disabling)
  app.post("/api/auth/mfa/disable", async (req, res) => {
    try {
      if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
        return res.status(401).json({ message: "Authentication required", code: "AUTH_REQUIRED" });
      }

      const user = req.user as User;
      if (!user.isMfaEnabled) {
        return res.status(400).json({ message: "MFA is not enabled on this account.", code: "MFA_NOT_ENABLED" });
      }

      const { password, code, token } = req.body || {};
      const mfaCode = String(code || token || "").trim();

      // Require reauthentication: local accounts must provide correct password
      if (user.authProvider === "local") {
        if (!password || typeof password !== "string") {
          return res.status(401).json({
            message: "Reauthentication password is required to disable MFA.",
            code: "PASSWORD_REQUIRED",
          });
        }

        const passwordOk = await comparePasswords(password, user.password);
        if (!passwordOk) {
          await storage.createAuditLog({
            userId: user.id,
            username: user.username,
            action: "MFA_DISABLE_FAILED",
            details: `Failed reauthentication attempt to disable MFA for user '${user.username}'.`,
          });
          return res.status(401).json({
            message: "Invalid reauthentication password.",
            code: "INVALID_CREDENTIALS",
          });
        }
      }

      // Proof of possession: must also provide valid TOTP code or recovery code
      if (!mfaCode) {
        return res.status(400).json({
          message: "Verification code or recovery code is required to disable MFA.",
          code: "MFA_CODE_REQUIRED",
        });
      }

      let codeValid = false;
      if (user.mfaRecoveryCodes) {
        const recResult = verifyAndConsumeRecoveryCode(mfaCode, user.mfaRecoveryCodes);
        if (recResult.valid) {
          codeValid = true;
        }
      }

      if (!codeValid && user.mfaSecret) {
        const totpRes = verifyTotpToken({
          token: mfaCode,
          encryptedSecret: user.mfaSecret,
          lastUsedTimestep: user.mfaLastUsedTimestep,
        });
        if (totpRes.valid) {
          codeValid = true;
        }
      }

      if (!codeValid) {
        await storage.createAuditLog({
          userId: user.id,
          username: user.username,
          action: "MFA_DISABLE_FAILED",
          details: `Invalid MFA code or recovery code provided when attempting to disable MFA for '${user.username}'.`,
        });
        return res.status(400).json({
          message: "Invalid MFA verification code or recovery code.",
          code: "INVALID_MFA_TOKEN",
        });
      }

      // Successfully reauthenticated! Disable MFA
      const updatedUser = await storage.updateUser(user.id, {
        isMfaEnabled: false,
        mfaSecret: null,
        mfaRecoveryCodes: null,
        mfaLastUsedTimestep: null,
      });

      (req.session as any).mfaVerified = false;

      await storage.createAuditLog({
        userId: user.id,
        username: user.username,
        action: "MFA_DISABLED",
        details: `MFA disabled for user '${user.username}' (${user.role}) after successful reauthentication.`,
      });

      return res.status(200).json({
        success: true,
        message: "Two-factor authentication has been disabled.",
        user: sanitizeUser(updatedUser),
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  // Admin Revoke / Reset MFA for another user (Requires Admin Reauthentication)
  app.post("/api/admin/users/:id/mfa/reset", async (req, res) => {
    try {
      if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
        return res.status(401).json({ message: "Authentication required", code: "AUTH_REQUIRED" });
      }

      const adminUser = req.user as User;
      if (!isAdmin(adminUser)) {
        return res.status(403).json({ message: "Admin access required", code: "FORBIDDEN" });
      }

      const targetUserId = parseInt(req.params.id, 10);
      if (isNaN(targetUserId)) {
        return res.status(400).json({ message: "Invalid user ID", code: "INVALID_ID" });
      }

      const targetUser = await storage.getUser(targetUserId);
      if (!targetUser) {
        return res.status(404).json({ message: "User not found", code: "NOT_FOUND" });
      }

      // Reauthentication for admin performing the reset
      const { adminPassword } = req.body || {};
      if (adminUser.authProvider === "local") {
        if (!adminPassword || typeof adminPassword !== "string") {
          return res.status(401).json({
            message: "Admin password reauthentication is required to reset MFA.",
            code: "PASSWORD_REQUIRED",
          });
        }
        const ok = await comparePasswords(adminPassword, adminUser.password);
        if (!ok) {
          return res.status(401).json({
            message: "Invalid admin password.",
            code: "INVALID_CREDENTIALS",
          });
        }
      }

      // Reset MFA for target user
      await storage.updateUser(targetUserId, {
        isMfaEnabled: false,
        mfaSecret: null,
        mfaRecoveryCodes: null,
        mfaLastUsedTimestep: null,
      });

      // Invalidate target user's active sessions immediately
      await storage.invalidateUserSessions(targetUserId);

      await storage.createAuditLog({
        userId: adminUser.id,
        username: adminUser.username,
        action: "MFA_REVOKED_BY_ADMIN",
        details: `Admin '${adminUser.username}' reset MFA for user '${targetUser.username}' (ID ${targetUserId}). Sessions invalidated.`,
      });

      res.status(200).json({
        success: true,
        message: `MFA has been revoked and reset for user '${targetUser.username}'.`,
      });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Internal server error" });
    }
  });

  // Google OAuth Helper Utilities
  function getGoogleRedirectUri(req: any): string {
    if (config.google.callbackUrl) {
      return config.google.callbackUrl;
    }
    const host = req.get("host") || "localhost:5001";
    const isLocal = host.includes("localhost") || host.includes("127.0.0.1");
    const forwardedProto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim();
    const proto = forwardedProto || req.protocol;
    // Cloud and production environments behind reverse proxies must always use HTTPS for Google redirect_uri
    const effectiveProto = isLocal ? proto : "https";
    return `${effectiveProto}://${host}/api/auth/google/callback`;
  }

  interface OAuthStatePayload {
    s: string;
    n?: string;
    t: number;
  }

  function signOAuthState(payload: OAuthStatePayload, secret: string): string {
    const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", secret).update(data).digest("base64url");
    return `${data}.${sig}`;
  }

  function verifyOAuthState(stateStr: string, secret: string): OAuthStatePayload | null {
    try {
      if (!stateStr || typeof stateStr !== "string") return null;
      const parts = stateStr.split(".");
      if (parts.length !== 2) return null;
      const [data, sig] = parts;
      const expectedSig = createHmac("sha256", secret).update(data).digest("base64url");
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expectedSig);
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        return null;
      }
      const payload: OAuthStatePayload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
      if (!payload.t || Date.now() - payload.t > 15 * 60 * 1000) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  // Google OAuth Config Endpoint (Safe, non-secret public metadata for client-side Google SDK)
  app.get("/api/auth/google/config", (_req, res) => {
    res.json({
      clientId: config.google.clientId || null,
      enabled: Boolean(config.google.clientId),
    });
  });

  // Initiate Google OAuth Redirect Flow
  app.get("/api/auth/google", (req, res) => {
    if (!config.google.clientId) {
      if (req.headers["accept"]?.includes("application/json") || !req.accepts("html")) {
        return res.status(503).json({
          message: "Google OAuth is not configured on this server.",
          code: "GOOGLE_NOT_CONFIGURED",
        });
      }
      return res.redirect("/auth?error=google_not_configured");
    }

    const stateRandom = randomBytes(16).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    const signedState = signOAuthState({ s: stateRandom, n: nonce, t: Date.now() }, config.sessionSecret);

    (req.session as any).oauthState = signedState;
    (req.session as any).oauthNonce = nonce;

    const redirectUri = getGoogleRedirectUri(req);

    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: signedState,
      nonce,
      prompt: "select_account",
    });

    // Explicitly persist session before redirecting to avoid cross-domain race conditions
    req.session.save((err) => {
      if (err) {
        console.error("[GOOGLE OAUTH] Failed to persist session before redirect:", err);
      }
      res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
    });
  });

  // Handle Google OAuth Redirect Callback
  app.get("/api/auth/google/callback", async (req, res) => {
    try {
      const { code, state, error } = req.query;

      // Handle user cancellation or OAuth error
      if (error) {
        return res.redirect(`/auth?error=${encodeURIComponent(String(error))}`);
      }

      // Validate CSRF state (dual-layer: session state + cryptographically signed state token)
      const stateStr = typeof state === "string" ? state : "";
      const verifiedState = verifyOAuthState(stateStr, config.sessionSecret);
      const sessionState = (req.session as any)?.oauthState;
      const sessionNonce = (req.session as any)?.oauthNonce;

      delete (req.session as any)?.oauthState;
      delete (req.session as any)?.oauthNonce;

      const isStateValid = Boolean(
        (sessionState && stateStr === sessionState) || (verifiedState && verifiedState.s)
      );

      if (!stateStr || !isStateValid) {
        return res.redirect("/auth?error=invalid_state");
      }

      if (!code || typeof code !== "string") {
        return res.redirect("/auth?error=missing_code");
      }

      const redirectUri = getGoogleRedirectUri(req);
      const expectedNonce = sessionNonce || verifiedState?.n;

      const profile = await exchangeGoogleAuthCode(code, redirectUri, expectedNonce);
      const { user } = await handleGoogleUser(profile);

      // Session fixation defense: regenerate session ID on successful OAuth login
      await regenerateSession(req);
      if (req.session) {
        const csrfToken = generateCsrfToken();
        (req.session as any).csrfToken = csrfToken;
        setCsrfCookie(res, csrfToken, config.isProduction || config.isStaging);
      }

      req.login(user, async (err) => {
        if (err) {
          return res.redirect("/auth?error=session_error");
        }

        const { maxAge } = getSessionTimeouts(user);
        req.session.cookie.maxAge = maxAge;
        (req.session as any).sessionCreatedAt = Date.now();
        (req.session as any).lastActiveAt = Date.now();

        const sid = req.sessionID;
        if (sid) {
          const sidHash = hashSessionId(sid);
          const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null;
          const userAgent = (req.headers["user-agent"] as string) || null;
          await storage.createUserSession({
            sessionIdHash: sidHash,
            userId: user.id,
            expiresAt: new Date(Date.now() + maxAge),
            ipAddress,
            userAgent,
          }).catch(() => {});
        }

        const isStaffUser = isStaff(user);
        const enforceStaffMfa = config.auth.enforceStaffMfa;

        if (user.isMfaEnabled) {
          (req.session as any).mfaVerified = false;
          return res.redirect("/auth/mfa-verify");
        } else if (enforceStaffMfa && isStaffUser) {
          (req.session as any).mfaVerified = false;
          return res.redirect("/auth/mfa-setup");
        }
        (req.session as any).mfaVerified = true;
        if (user.role === "admin") {
          return res.redirect("/admin");
        } else if (user.role === "employee") {
          return res.redirect("/employee");
        } else {
          return res.redirect("/dashboard");
        }
      });
    } catch (err: any) {
      console.error("[GOOGLE OAUTH CALLBACK ERROR]", err);
      res.redirect(`/auth?error=${encodeURIComponent(err?.message || "oauth_failed")}`);
    }
  });

  // Verify Google ID Token (Credential) or Authorization Code directly via POST (Google One Tap / GIS SDK)
  app.post("/api/auth/google", loginLimiter, async (req, res) => {
    try {
      const { idToken, credential, code, redirectUri, nonce } = req.body || {};
      const token = idToken || credential;

      let profile;
      if (token && typeof token === "string") {
        profile = await verifyGoogleIdToken(token, nonce);
      } else if (code && typeof code === "string") {
        const cbUrl = redirectUri || getGoogleRedirectUri(req);
        profile = await exchangeGoogleAuthCode(code, cbUrl, nonce);
      } else {
        return res.status(400).json({
          message: "Google ID token (credential) or authorization code is required.",
          code: "GOOGLE_TOKEN_REQUIRED",
        });
      }

      const { user, isNew, linked } = await handleGoogleUser(profile);

      // Session fixation defense: regenerate session ID on successful GIS/Google login
      await regenerateSession(req);
      if (req.session) {
        (req.session as any).csrfToken = generateCsrfToken();
      }

      req.login(user, async (err) => {
        if (err) {
          return res.status(500).json({ message: "Failed to establish user session." });
        }

        const { maxAge } = getSessionTimeouts(user);
        req.session.cookie.maxAge = maxAge;
        (req.session as any).sessionCreatedAt = Date.now();
        (req.session as any).lastActiveAt = Date.now();

        const sid = req.sessionID;
        if (sid) {
          const sidHash = hashSessionId(sid);
          const ipAddress = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null;
          const userAgent = (req.headers["user-agent"] as string) || null;
          await storage.createUserSession({
            sessionIdHash: sidHash,
            userId: user.id,
            expiresAt: new Date(Date.now() + maxAge),
            ipAddress,
            userAgent,
          }).catch(() => {});
        }

        const isStaffUser = isStaff(user);
        const enforceStaffMfa = config.auth.enforceStaffMfa;

        if (user.isMfaEnabled) {
          (req.session as any).mfaVerified = false;
          return res.status(200).json({
            mfaRequired: true,
            message: "Two-factor authentication required. Please verify with your authenticator code or recovery code.",
            userId: user.id,
            username: user.username,
          });
        } else if (enforceStaffMfa && isStaffUser) {
          (req.session as any).mfaVerified = false;
          return res.status(200).json({
            mfaSetupRequired: true,
            message: "Two-factor authentication setup is required for administrator and employee accounts.",
            userId: user.id,
            username: user.username,
            user: sanitizeUser(user),
          });
        }
        (req.session as any).mfaVerified = true;
        res.status(200).json({
          message: isNew
            ? "Account created and authenticated via Google successfully."
            : linked
            ? "Google account linked and authenticated successfully."
            : "Authenticated via Google successfully.",
          user: sanitizeUser(user),
          isNew,
          linked,
        });
      });
    } catch (err: any) {
      res.status(400).json({
        message: err?.message || "Google authentication failed.",
        code: "GOOGLE_AUTH_FAILED",
      });
    }
  });
}
