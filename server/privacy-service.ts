import crypto from "crypto";
import { storage } from "./storage";
import { sanitizeUser, hashPassword } from "./auth";
import { logger } from "./observability";
import type { User, Booking, UserSession } from "@shared/schema";

/**
 * Mask an email address to protect privacy from operational staff.
 * Example: "alex.gamer@example.com" -> "a***r@example.com"
 * Example: "a@domain.com" -> "a***@domain.com"
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") return null;
  const trimmed = email.trim();
  const atIndex = trimmed.indexOf("@");
  if (atIndex === -1) return "***@***.***";

  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);

  if (local.length <= 1) {
    return `${local}***@${domain}`;
  }
  if (local.length === 2) {
    return `${local[0]}*${local[1]}@${domain}`;
  }

  const firstChar = local[0];
  const lastChar = local[local.length - 1];
  return `${firstChar}***${lastChar}@${domain}`;
}

/**
 * Mask a phone number to protect privacy from operational staff.
 * Preserves country code if provided, masks leading/middle digits, keeps only last 4 digits.
 * Example: "+91 9876543210" -> "+91 ******3210"
 * Example: "9876543210" -> "******3210"
 * Example: "123" -> "****"
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== "string") return null;
  const trimmed = phone.trim();
  if (trimmed.length < 5) return "****";

  const hasPlus = trimmed.startsWith("+");
  const digitsOnly = trimmed.replace(/\D/g, "");

  if (digitsOnly.length < 5) {
    return "****";
  }

  const last4 = digitsOnly.slice(-4);
  const maskedLength = Math.max(digitsOnly.length - 4, 4);
  const stars = "*".repeat(maskedLength);

  if (hasPlus) {
    // If standard country code format like +91 9876543210
    const parts = trimmed.split(" ");
    if (parts.length > 1 && parts[0].startsWith("+")) {
      return `${parts[0]} ${stars.slice(parts[0].length - 1)}${last4}`;
    }
    return `+${stars}${last4}`;
  }

  return `${stars}${last4}`;
}

/**
 * Mask customer personally identifiable information for non-admin operational employees.
 * Keeps game station workflow possible without exposing customer direct contact info.
 */
export function maskUserPiiForStaff(user: any) {
  if (!user) return user;
  const sanitized = sanitizeUser(user);
  return {
    ...sanitized,
    email: maskEmail(sanitized.email),
    phone: maskPhone(sanitized.phone),
  };
}

export interface UserDataExport {
  exportVersion: string;
  generatedAt: string;
  dataController: string;
  complianceNotice: string;
  userProfile: {
    id: number;
    username: string;
    email: string | null;
    fullName: string | null;
    phone: string | null;
    avatarUrl: string | null;
    membershipTier: string | null;
    role: string;
    authProvider: string;
    isEmailVerified: boolean;
    createdAt: string | null;
  };
  bookings: Array<{
    id: number;
    bookingRef: string;
    startTime: string;
    endTime: string;
    playerCount: number;
    totalPrice: number;
    finalPrice: number | null;
    currency: string;
    paymentMethod: string;
    status: string;
    gameTitle: string | null;
    stationName?: string | null;
    locationId: string;
    createdAt: string | null;
  }>;
  activeSessions: Array<{
    id: number;
    createdAt: string;
    lastSeenAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  }>;
}

/**
 * Generate a complete, portable data export (GDPR Right to Data Portability)
 * for the authenticated user.
 */
export async function generateUserDataExport(userId: number): Promise<UserDataExport> {
  const user = await storage.getUser(userId);
  if (!user) {
    throw new Error("User not found");
  }

  const rawBookings = await storage.getBookingsByUser(userId, { limit: 100 });
  const activeSessions = await storage.getUserActiveSessions(userId, 50);

  const exportData: UserDataExport = {
    exportVersion: "1.0",
    generatedAt: new Date().toISOString(),
    dataController: "Play N Slay Gaming Lounge Management",
    complianceNotice:
      "This export contains your personal data and transaction records in compliance with the General Data Protection Regulation (GDPR) and the Digital Personal Data Protection Act. Invoices and transaction records are retained in compliance with statutory financial and tax obligations.",
    userProfile: {
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      membershipTier: user.membershipTier,
      role: user.role,
      authProvider: user.authProvider,
      isEmailVerified: user.isEmailVerified,
      createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
    },
    bookings: rawBookings.map((b) => ({
      id: b.id,
      bookingRef: b.bookingRef,
      startTime: new Date(b.startTime).toISOString(),
      endTime: new Date(b.endTime).toISOString(),
      playerCount: b.playerCount,
      totalPrice: b.totalPrice,
      finalPrice: b.finalPrice,
      currency: b.currency,
      paymentMethod: b.paymentMethod,
      status: b.status,
      gameTitle: b.gameTitle,
      stationName: b.station?.name || null,
      locationId: b.locationId,
      createdAt: b.createdAt ? new Date(b.createdAt).toISOString() : null,
    })),
    activeSessions: activeSessions.map((s) => ({
      id: s.id,
      createdAt: new Date(s.createdAt).toISOString(),
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
    })),
  };

  logger.info({ userId }, "[PRIVACY] User personal data archive generated for export");
  return exportData;
}

/**
 * Anonymize user account while PRESERVING legally required financial transaction records.
 *
 * Statutory Compliance:
 * Under applicable commercial and tax law, invoice records, financial totals, and transaction
 * timestamps must be retained for 7 years for auditing and tax compliance.
 *
 * Privacy Strategy:
 * 1. Personal identifiers in the user record are irreversibly anonymized/nullified.
 * 2. All login credentials and session tokens are invalidated and scrambled with a random unusable hash.
 * 3. All active and remembered sessions are revoked immediately.
 * 4. Booking transaction rows remain in the database linked to the anonymized user ID, ensuring
 *    balance sheets and historical occupancy statistics remain accurate without identifying the customer.
 */
export async function anonymizeUserAccount(
  userId: number,
  options?: { reason?: string; performedByUserId?: number }
): Promise<{ success: boolean; message: string; anonymizedUserId: number }> {
  const user = await storage.getUser(userId);
  if (!user) {
    throw new Error("User not found");
  }

  // Prevent anonymizing if the account is already anonymized
  if (user.username.startsWith("deleted_user_") && user.email?.endsWith("@anonymized.invalid")) {
    return {
      success: true,
      message: "Account is already anonymized",
      anonymizedUserId: userId,
    };
  }

  // Safety: Prevent deleting the last remaining admin
  if (user.role === "admin") {
    const allUsers = await storage.getAllUsers();
    const activeAdmins = allUsers.filter(
      (u) => u.role === "admin" && !u.username.startsWith("deleted_user_")
    );
    if (activeAdmins.length <= 1) {
      throw new Error("Cannot delete or anonymize the only active system administrator");
    }
  }

  const anonymizedUsername = `deleted_user_${userId}`;
  const anonymizedEmail = `deleted_${userId}@anonymized.invalid`;
  const anonymizedFullName = "Anonymized Gamer";
  const scrambledPassword = await hashPassword(crypto.randomBytes(32).toString("hex"));

  // 1. Irreversibly update user record to remove all PII
  await storage.updateUser(userId, {
    username: anonymizedUsername,
    email: anonymizedEmail,
    fullName: anonymizedFullName,
    phone: null,
    avatarUrl: null,
    googleId: null,
    isEmailVerified: false,
    emailVerifiedAt: null,
    emailVerificationTokenHash: null,
    emailVerificationTokenExpiresAt: null,
    passwordResetTokenHash: null,
    passwordResetTokenExpiresAt: null,
    password: scrambledPassword,
    tokenVersion: (user.tokenVersion || 1) + 1,
    isMfaEnabled: false,
    mfaSecret: null,
    mfaRecoveryCodes: null,
    mfaLastUsedTimestep: null,
  });

  // 2. Revoke all active sessions
  await storage.revokeAllUserSessions(userId);

  // 3. Log audit event (anonymization rationale)
  const auditUserId = options?.performedByUserId || userId;
  const reason = options?.reason || "Customer Right to Erasure / Account Deletion Request";

  await storage.createAuditLog({
    userId: auditUserId,
    username: options?.performedByUserId ? `admin_action` : anonymizedUsername,
    action: "PRIVACY_ACCOUNT_ANONYMIZED",
    details: JSON.stringify({
      targetUserId: userId,
      reason,
      anonymizedAt: new Date().toISOString(),
      statutoryNotice: "Transaction records preserved without personal identifiers for 7-year legal tax retention.",
    }),
  });

  logger.info(
    { userId, reason },
    "[PRIVACY] Customer account successfully anonymized. Financial transaction records retained for legal compliance."
  );

  return {
    success: true,
    message: "Personal data permanently anonymized. Legally required transaction history retained for statutory accounting.",
    anonymizedUserId: userId,
  };
}

/**
 * Execute Data Retention Policy:
 * 1. Revoked/Expired sessions older than 30 days are pruned.
 * 2. Expired idempotency records older than 24 hours are pruned.
 * 3. Unverified member accounts older than 90 days with zero bookings are pruned.
 */
export async function applyDataRetentionPolicy(options?: {
  sessionDays?: number;
  idempotencyHours?: number;
  unverifiedDays?: number;
}): Promise<{
  prunedSessions: number;
  prunedIdempotencyKeys: number;
  prunedUnverifiedUsers: number;
}> {
  const sessionDays = options?.sessionDays ?? 30;
  const idempotencyHours = options?.idempotencyHours ?? 24;
  const unverifiedDays = options?.unverifiedDays ?? 90;

  const sessionCutoff = new Date(Date.now() - sessionDays * 24 * 60 * 60 * 1000);
  const idempotencyCutoff = new Date(Date.now() - idempotencyHours * 60 * 60 * 1000);
  const unverifiedCutoff = new Date(Date.now() - unverifiedDays * 24 * 60 * 60 * 1000);

  const prunedSessions = await storage.deleteExpiredUserSessions(sessionCutoff);
  const prunedIdempotencyKeys = await storage.deleteExpiredIdempotencyKeys(idempotencyCutoff);
  const prunedUnverifiedUsers = await storage.deleteStaleUnverifiedUsers(unverifiedCutoff);

  logger.info(
    { prunedSessions, prunedIdempotencyKeys, prunedUnverifiedUsers },
    "[PRIVACY] Data retention cleanup completed."
  );

  await storage.createAuditLog({
    userId: null,
    username: "system_retention",
    action: "PRIVACY_RETENTION_PRUNED",
    details: JSON.stringify({
      prunedSessions,
      prunedIdempotencyKeys,
      prunedUnverifiedUsers,
      executedAt: new Date().toISOString(),
    }),
  });

  return {
    prunedSessions,
    prunedIdempotencyKeys,
    prunedUnverifiedUsers,
  };
}
