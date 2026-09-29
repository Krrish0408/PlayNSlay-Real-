import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { generateSecret, verifySync, generateURI } from "otplib";
import QRCode from "qrcode";
import { config } from "./config";

/**
 * Derives a 32-byte AES-256 encryption key from MFA_ENCRYPTION_KEY or SESSION_SECRET.
 */
function getEncryptionKey(): Buffer {
  const secretSource =
    process.env.MFA_ENCRYPTION_KEY ||
    config.sessionSecret ||
    "play_n_slay_mfa_default_key_32_bytes_long_secret";
  return createHash("sha256").update(secretSource).digest();
}

/**
 * Encrypts an MFA secret at rest using AES-256-GCM.
 * Stored format: <ivHex>:<authTagHex>:<ciphertextHex>
 */
export function encryptMfaSecret(secret: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12); // Standard 96-bit IV for AES-GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts an AES-256-GCM encrypted MFA secret.
 */
export function decryptMfaSecret(encryptedPayload: string): string {
  const parts = encryptedPayload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted MFA payload format");
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Normalizes and computes SHA-256 hash of a recovery code.
 */
export function hashRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Generates single-use recovery codes.
 * Returns raw codes (presented to user once) and hashed codes (stored in DB).
 */
export function generateRecoveryCodes(count = 8): { rawCodes: string[]; hashedCodes: string[] } {
  const rawCodes: string[] = [];
  const hashedCodes: string[] = [];

  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString("hex").toUpperCase(); // 10 chars
    const formatted = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    rawCodes.push(formatted);
    hashedCodes.push(hashRecoveryCode(formatted));
  }

  return { rawCodes, hashedCodes };
}

/**
 * Validates and consumes a single-use recovery code.
 * If valid, the hash is permanently removed from the recovery codes array.
 */
export function verifyAndConsumeRecoveryCode(
  inputCode: string,
  storedHashedCodesJson: string | null | undefined
): { valid: boolean; remainingHashedCodesJson: string | null } {
  if (!storedHashedCodesJson) {
    return { valid: false, remainingHashedCodesJson: null };
  }

  let codeHashes: string[];
  try {
    codeHashes = JSON.parse(storedHashedCodesJson);
    if (!Array.isArray(codeHashes)) {
      return { valid: false, remainingHashedCodesJson: null };
    }
  } catch {
    return { valid: false, remainingHashedCodesJson: null };
  }

  const targetHash = hashRecoveryCode(inputCode);
  const foundIndex = codeHashes.indexOf(targetHash);

  if (foundIndex === -1) {
    return { valid: false, remainingHashedCodesJson: storedHashedCodesJson };
  }

  // Remove the single-use recovery code
  codeHashes.splice(foundIndex, 1);
  return {
    valid: true,
    remainingHashedCodesJson: JSON.stringify(codeHashes),
  };
}

export interface MfaSetupData {
  secret: string;
  encryptedSecret: string;
  otpauthUrl: string;
  qrCode: string;
  recoveryCodes: string[];
  hashedRecoveryCodes: string[];
}

/**
 * Initiates MFA setup by generating a TOTP secret, QR code, and single-use recovery codes.
 */
export async function generateMfaSetup({
  username,
  issuer = "Play N' Slay Gaming Lounge",
}: {
  username: string;
  issuer?: string;
}): Promise<MfaSetupData> {
  const secret = generateSecret();
  const encryptedSecret = encryptMfaSecret(secret);
  const otpauthUrl = generateURI({ label: username, issuer, secret });
  const qrCode = await QRCode.toDataURL(otpauthUrl);
  const { rawCodes, hashedCodes } = generateRecoveryCodes(8);

  return {
    secret,
    encryptedSecret,
    otpauthUrl,
    qrCode,
    recoveryCodes: rawCodes,
    hashedRecoveryCodes: hashedCodes,
  };
}

export interface TotpVerifyResult {
  valid: boolean;
  reason?: "INVALID_TOKEN" | "REPLAY_DETECTED";
  timeStep?: number;
}

/**
 * Verifies a TOTP token against the encrypted secret with replay prevention.
 */
export function verifyTotpToken({
  token,
  encryptedSecret,
  lastUsedTimestep,
}: {
  token: string;
  encryptedSecret: string;
  lastUsedTimestep?: number | null;
}): TotpVerifyResult {
  try {
    const secret = decryptMfaSecret(encryptedSecret);
    const cleanToken = token.replace(/\s+/g, "").trim();

    const result = verifySync({ token: cleanToken, secret });
    if (!result || !result.valid) {
      return { valid: false, reason: "INVALID_TOKEN" };
    }

    const timeStep = (result as any).timeStep ?? Math.floor(Date.now() / 1000 / 30);
    if (
      timeStep !== undefined &&
      lastUsedTimestep !== undefined &&
      lastUsedTimestep !== null &&
      timeStep <= lastUsedTimestep
    ) {
      return { valid: false, reason: "REPLAY_DETECTED", timeStep };
    }

    return { valid: true, timeStep };
  } catch (err) {
    return { valid: false, reason: "INVALID_TOKEN" };
  }
}
