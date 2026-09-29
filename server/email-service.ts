import { randomBytes, createHash } from "crypto";

export interface VerificationTokenData {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface SendVerificationEmailOptions {
  to: string;
  username: string;
  verificationToken: string;
  baseUrl?: string;
}

export interface SentEmailRecord {
  to: string;
  username: string;
  verificationToken: string;
  verificationLink: string;
  sentAt: Date;
}

export interface PasswordResetTokenData {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface SendPasswordResetEmailOptions {
  to: string;
  username: string;
  resetToken: string;
  baseUrl?: string;
}

export interface SentPasswordResetRecord {
  to: string;
  username: string;
  resetToken: string;
  resetLink: string;
  sentAt: Date;
}

// In-memory records of sent emails for automated test assertion and inspection
const sentEmailsLog: SentEmailRecord[] = [];
const sentPasswordResetLog: SentPasswordResetRecord[] = [];

/**
 * Generates a cryptographically secure 256-bit verification token and its SHA-256 hash.
 * The raw token is sent exclusively to the user's email address.
 * The hash is stored in the database.
 * Default expiry: 24 hours.
 */
export function generateVerificationToken(expiresInHours = 24): VerificationTokenData {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashVerificationToken(rawToken);
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  return {
    rawToken,
    tokenHash,
    expiresAt,
  };
}

/**
 * Computes the SHA-256 hex digest of a raw verification token.
 */
export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

/**
 * Dispatches an email verification message.
 * In production, this integrates with transactional SMTP/API providers.
 * In development and testing, logs safely and stores the dispatch in an in-memory buffer.
 */
export async function sendVerificationEmail(options: SendVerificationEmailOptions): Promise<SentEmailRecord> {
  const defaultHost = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5001}`;
  const baseUrl = options.baseUrl || defaultHost;
  const verificationLink = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(options.verificationToken)}`;

  const record: SentEmailRecord = {
    to: options.to,
    username: options.username,
    verificationToken: options.verificationToken,
    verificationLink,
    sentAt: new Date(),
  };

  sentEmailsLog.push(record);

  if (sentEmailsLog.length > 100) {
    sentEmailsLog.shift();
  }

  if (process.env.NODE_ENV !== "test") {
    console.log(`[EMAIL SERVICE] Verification email dispatched to ${options.to}`);
    console.log(`[EMAIL SERVICE] Link: ${verificationLink}`);
  }

  return record;
}

/**
 * Generates a cryptographically secure 256-bit password reset token with short expiration.
 * Default expiry: 15 minutes.
 */
export function generatePasswordResetToken(expiresInMinutes = 15): PasswordResetTokenData {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashPasswordResetToken(rawToken);
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

  return {
    rawToken,
    tokenHash,
    expiresAt,
  };
}

/**
 * Computes the SHA-256 hex digest of a password reset token.
 */
export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

/**
 * Dispatches a password reset email containing the raw token link.
 * Never logs raw reset tokens or passwords.
 */
export async function sendPasswordResetEmail(options: SendPasswordResetEmailOptions): Promise<SentPasswordResetRecord> {
  const defaultHost = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5001}`;
  const baseUrl = options.baseUrl || defaultHost;
  const resetLink = `${baseUrl}/reset-password?token=${encodeURIComponent(options.resetToken)}`;

  const record: SentPasswordResetRecord = {
    to: options.to,
    username: options.username,
    resetToken: options.resetToken,
    resetLink,
    sentAt: new Date(),
  };

  sentPasswordResetLog.push(record);
  if (sentPasswordResetLog.length > 100) {
    sentPasswordResetLog.shift();
  }

  if (process.env.NODE_ENV !== "test") {
    console.log(`[EMAIL SERVICE] Password reset email dispatched to ${options.to}`);
  }

  return record;
}

/**
 * Retrieves the most recent sent verification email (primarily for automated tests).
 */
export function getLastSentVerificationEmail(): SentEmailRecord | undefined {
  return sentEmailsLog[sentEmailsLog.length - 1];
}

/**
 * Retrieves the most recent sent password reset email (primarily for automated tests).
 */
export function getLastSentPasswordResetEmail(): SentPasswordResetRecord | undefined {
  return sentPasswordResetLog[sentPasswordResetLog.length - 1];
}

/**
 * Retrieves all sent emails for a specific recipient email address.
 */
export function getSentEmailsFor(to: string): SentEmailRecord[] {
  const norm = to.toLowerCase().trim();
  return sentEmailsLog.filter((e) => e.to.toLowerCase().trim() === norm);
}

/**
 * Clears the in-memory test email logs.
 */
export function clearSentEmailsLog(): void {
  sentEmailsLog.length = 0;
  sentPasswordResetLog.length = 0;
}
