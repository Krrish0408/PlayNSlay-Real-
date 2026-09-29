/**
 * Secure Initial-Admin Bootstrap Service.
 *
 * Responsibilities:
 * 1. Guarantees production startup does NOT create default/predictable credentials.
 * 2. Provides a one-time, cryptographically secure bootstrap process for the first administrator.
 * 3. Enforces strong password complexity for privileged accounts.
 * 4. Mandates Multi-Factor Authentication (MFA / TOTP) setup during bootstrap.
 * 5. Permanently locks down and disables the bootstrap mechanism upon first successful setup.
 * 6. Zero credential leakage: No passwords, tokens, or MFA secrets are ever logged or exposed in APIs.
 */

import crypto from "crypto";
import { storage } from "./storage";
import { hashPassword } from "./auth";
import {
  generateMfaSetup,
  encryptMfaSecret,
  type MfaSetupData,
} from "./mfa-service";
import { verifySync } from "otplib";
import { sanitizeUser } from "./auth";
import { type SafeUser } from "./storage";

export const BOOTSTRAP_SETTING_COMPLETED = "admin_bootstrap_completed";
export const BOOTSTRAP_SETTING_TOKEN_HASH = "initial_admin_bootstrap_token_hash";

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

const COMMON_PREDICTABLE_WORDS = [
  "admin",
  "admin123",
  "administrator",
  "password",
  "password123",
  "changeme",
  "playnslay",
  "gaminglounge",
  "qwerty",
  "employee",
  "welcome",
  "letmein",
];

/**
 * Enforces strong password complexity for privileged administrator accounts.
 * Minimum 12 characters, requiring uppercase, lowercase, numbers, special characters,
 * and rejecting common predictable terms.
 */
export function validatePrivilegedPassword(password: string): PasswordValidationResult {
  const errors: string[] = [];

  if (!password || typeof password !== "string") {
    return { valid: false, errors: ["Password is required and must be a string."] };
  }

  if (password.length < 12) {
    errors.push("Password must be at least 12 characters long.");
  }

  if (!/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter (A-Z).");
  }

  if (!/[a-z]/.test(password)) {
    errors.push("Password must contain at least one lowercase letter (a-z).");
  }

  if (!/[0-9]/.test(password)) {
    errors.push("Password must contain at least one numerical digit (0-9).");
  }

  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
    errors.push("Password must contain at least one special character or symbol.");
  }

  const lower = password.toLowerCase();
  for (const term of COMMON_PREDICTABLE_WORDS) {
    if (lower === term || (term.length >= 6 && lower.includes(term))) {
      errors.push(`Password must not contain common predictable words (e.g. '${term}').`);
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Checks whether the initial-admin bootstrap process is currently available.
 * Fails closed: if an admin user already exists or if the completion flag is set,
 * bootstrap is permanently disabled.
 */
export async function isBootstrapAvailable(): Promise<boolean> {
  // Check permanent lock flag in settings
  const completedFlag = await storage.getSetting(BOOTSTRAP_SETTING_COMPLETED);
  if (completedFlag === "true") {
    return false;
  }

  // Check if any admin account already exists in database
  const hasAdmin = await storage.hasAdminUser();
  if (hasAdmin) {
    // If an admin exists, ensure the completion flag is marked permanently
    await storage.setSetting(BOOTSTRAP_SETTING_COMPLETED, "true");
    await storage.deleteSetting(BOOTSTRAP_SETTING_TOKEN_HASH);
    return false;
  }

  return true;
}

/**
 * Computes a SHA-256 hash of a bootstrap token.
 */
export function hashBootstrapToken(token: string): string {
  return crypto.createHash("sha256").update(token.trim()).digest("hex");
}

/**
 * Resolves or initializes the bootstrap token hash.
 * If an environment variable INITIAL_ADMIN_BOOTSTRAP_TOKEN is provided, its hash is used.
 * Otherwise, generates a secure 256-bit random hex token and stores its hash.
 */
export async function initializeBootstrapToken(): Promise<{
  tokenHash: string;
  generatedToken?: string;
} | null> {
  const available = await isBootstrapAvailable();
  if (!available) {
    return null;
  }

  // Check if hash already stored in settings
  const existingHash = await storage.getSetting(BOOTSTRAP_SETTING_TOKEN_HASH);
  const envToken = process.env.INITIAL_ADMIN_BOOTSTRAP_TOKEN?.trim();

  if (envToken && envToken.length >= 16) {
    const hash = hashBootstrapToken(envToken);
    if (existingHash !== hash) {
      await storage.setSetting(BOOTSTRAP_SETTING_TOKEN_HASH, hash);
    }
    return { tokenHash: hash };
  }

  if (existingHash) {
    return { tokenHash: existingHash };
  }

  // Generate a cryptographically secure 256-bit random token
  const generatedToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashBootstrapToken(generatedToken);
  await storage.setSetting(BOOTSTRAP_SETTING_TOKEN_HASH, tokenHash);

  return { tokenHash, generatedToken };
}

/**
 * Validates a supplied bootstrap token against the stored hash in constant time.
 */
export async function verifyBootstrapToken(providedToken?: string): Promise<boolean> {
  if (!providedToken || typeof providedToken !== "string") {
    return false;
  }

  const available = await isBootstrapAvailable();
  if (!available) {
    return false;
  }

  const storedHash = await storage.getSetting(BOOTSTRAP_SETTING_TOKEN_HASH);
  const envToken = process.env.INITIAL_ADMIN_BOOTSTRAP_TOKEN?.trim();

  let targetHash = storedHash;
  if (!targetHash && envToken) {
    targetHash = hashBootstrapToken(envToken);
  }

  if (!targetHash) {
    return false;
  }

  const candidateHash = hashBootstrapToken(providedToken);

  const candidateBuf = Buffer.from(candidateHash, "hex");
  const targetBuf = Buffer.from(targetHash, "hex");

  if (candidateBuf.length !== targetBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateBuf, targetBuf);
}

export interface BootstrapMfaInitResponse {
  otpauthUrl: string;
  qrCode: string;
  manualEntryKey: string;
  recoveryCodes: string[];
}

/**
 * Step 1 of bootstrap: Validates token and generates a TOTP MFA secret and QR code.
 */
export async function initiateBootstrapMfa(bootstrapToken: string): Promise<BootstrapMfaInitResponse> {
  const available = await isBootstrapAvailable();
  if (!available) {
    const err = new Error("Administrator bootstrap is permanently disabled.");
    (err as any).code = "BOOTSTRAP_DISABLED";
    (err as any).statusCode = 403;
    throw err;
  }

  const isValidToken = await verifyBootstrapToken(bootstrapToken);
  if (!isValidToken) {
    const err = new Error("Invalid or expired bootstrap token.");
    (err as any).code = "INVALID_BOOTSTRAP_TOKEN";
    (err as any).statusCode = 401;
    throw err;
  }

  const setup: MfaSetupData = await generateMfaSetup({
    username: "initial-admin",
    issuer: "Play N' Slay Lounge Admin",
  });

  return {
    otpauthUrl: setup.otpauthUrl,
    qrCode: setup.qrCode,
    manualEntryKey: setup.secret,
    recoveryCodes: setup.recoveryCodes,
  };
}

export interface CompleteBootstrapParams {
  bootstrapToken: string;
  username: string;
  email: string;
  password: string;
  fullName?: string;
  mfaSecret: string;
  mfaToken: string;
}

export interface CompleteBootstrapResult {
  success: boolean;
  message: string;
  user: SafeUser;
}

/**
 * Step 2 of bootstrap: Validates password strength, verifies MFA TOTP code,
 * creates the administrator account, and permanently locks the bootstrap process.
 */
export async function completeAdminBootstrap(params: CompleteBootstrapParams): Promise<CompleteBootstrapResult> {
  const { bootstrapToken, username, email, password, fullName, mfaSecret, mfaToken } = params;

  // 1. Verify bootstrap is available
  const available = await isBootstrapAvailable();
  if (!available) {
    const err = new Error("Administrator bootstrap is permanently disabled.");
    (err as any).code = "BOOTSTRAP_DISABLED";
    (err as any).statusCode = 403;
    throw err;
  }

  // 2. Validate token
  const isValidToken = await verifyBootstrapToken(bootstrapToken);
  if (!isValidToken) {
    const err = new Error("Invalid or expired bootstrap token.");
    (err as any).code = "INVALID_BOOTSTRAP_TOKEN";
    (err as any).statusCode = 401;
    throw err;
  }

  // 3. Validate username & email format
  const cleanUsername = String(username || "").trim();
  if (!cleanUsername || cleanUsername.length < 3 || cleanUsername.length > 50) {
    const err = new Error("Username must be between 3 and 50 characters long.");
    (err as any).code = "INVALID_USERNAME";
    (err as any).statusCode = 400;
    throw err;
  }

  const cleanEmail = String(email || "").trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!cleanEmail || !emailRegex.test(cleanEmail)) {
    const err = new Error("A valid email address is required.");
    (err as any).code = "INVALID_EMAIL";
    (err as any).statusCode = 400;
    throw err;
  }

  // Check if username or email already taken
  const existingByUsername = await storage.getUserByUsername(cleanUsername);
  if (existingByUsername) {
    const err = new Error("Username is already in use.");
    (err as any).code = "USERNAME_EXISTS";
    (err as any).statusCode = 400;
    throw err;
  }

  const existingByEmail = await storage.getUserByEmail(cleanEmail);
  if (existingByEmail) {
    const err = new Error("Email address is already registered.");
    (err as any).code = "EMAIL_EXISTS";
    (err as any).statusCode = 400;
    throw err;
  }

  // 4. Validate privileged password complexity
  const passwordValidation = validatePrivilegedPassword(password);
  if (!passwordValidation.valid) {
    const err = new Error(`Password does not meet complexity requirements: ${passwordValidation.errors.join(" ")}`);
    (err as any).code = "PASSWORD_TOO_WEAK";
    (err as any).statusCode = 400;
    (err as any).details = passwordValidation.errors;
    throw err;
  }

  // 5. Verify MFA TOTP code
  if (!mfaSecret || !mfaToken) {
    const err = new Error("MFA setup and verification are required for initial administrator creation.");
    (err as any).code = "MFA_REQUIRED";
    (err as any).statusCode = 400;
    throw err;
  }

  const cleanMfaToken = String(mfaToken).replace(/\s+/g, "").trim();
  const mfaResult = verifySync({
    token: cleanMfaToken,
    secret: mfaSecret.trim(),
  });

  if (!mfaResult || !mfaResult.valid) {
    const err = new Error("Invalid MFA verification code. Please check your authenticator app and try again.");
    (err as any).code = "INVALID_MFA_CODE";
    (err as any).statusCode = 400;
    throw err;
  }

  // 6. Securely hash password using Argon2id
  const hashedPassword = await hashPassword(password);

  // 7. Encrypt MFA secret for database storage
  const encryptedMfaSecret = encryptMfaSecret(mfaSecret.trim());

  // 8. Create the administrator account
  const newUser = await storage.createUser({
    username: cleanUsername,
    email: cleanEmail,
    password: hashedPassword,
    fullName: (fullName || cleanUsername).trim(),
    role: "admin",
    isEmailVerified: true,
    emailVerifiedAt: new Date(),
    isMfaEnabled: true,
    mfaSecret: encryptedMfaSecret,
    mfaLastUsedTimestep: Math.floor(Date.now() / 1000 / 30),
  });

  // 9. Permanently disable bootstrap process
  await storage.setSetting(BOOTSTRAP_SETTING_COMPLETED, "true");
  await storage.deleteSetting(BOOTSTRAP_SETTING_TOKEN_HASH);

  // 10. Audit log (without logging any credentials, tokens, or secrets)
  await storage.createAuditLog({
    userId: newUser.id,
    username: newUser.username,
    action: "INITIAL_ADMIN_BOOTSTRAP_COMPLETED",
    details: `Initial administrator account '${newUser.username}' successfully created with mandatory MFA. Bootstrap permanently disabled.`,
  });

  return {
    success: true,
    message: "Initial administrator account created successfully with MFA. Bootstrap is now permanently disabled.",
    user: sanitizeUser(newUser),
  };
}
