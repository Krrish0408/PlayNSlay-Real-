import crypto from "crypto";
import type { Request } from "express";
import type { IStorage } from "./storage";
import type { IdempotencyKey } from "@shared/schema";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_REPLAY_HEADER = "Idempotent-Replayed";
export const IDEMPOTENCY_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const IDEMPOTENCY_LOCK_TIMEOUT_MS = 30 * 1000; // 30 seconds
export const IDEMPOTENCY_POLL_INTERVAL_MS = 100;
export const IDEMPOTENCY_POLL_TIMEOUT_MS = 3000;

export function extractIdempotencyKey(req: Request): string | null {
  const rawKey = req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
  if (!rawKey) return null;
  const keyStr = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (typeof keyStr !== "string") return null;
  const trimmed = keyStr.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;
  return trimmed;
}

export function canonicalizeJson(obj: any): any {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== "object") return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) {
    return obj.map(canonicalizeJson);
  }
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, any> = {};
  for (const k of sortedKeys) {
    if (k === "_csrf" || k === "csrfToken" || k === "csrf_token") continue;
    if (obj[k] === undefined) continue;
    result[k] = canonicalizeJson(obj[k]);
  }
  return result;
}

export function computeRequestHash(payload: any): string {
  const canonical = canonicalizeJson(payload);
  const jsonStr = JSON.stringify(canonical);
  return crypto.createHash("sha256").update(jsonStr).digest("hex");
}

export async function waitForIdempotentCompletion(
  storage: IStorage,
  userId: number,
  key: string,
  timeoutMs = IDEMPOTENCY_POLL_TIMEOUT_MS,
  pollIntervalMs = IDEMPOTENCY_POLL_INTERVAL_MS
): Promise<IdempotencyKey | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const record = await storage.getIdempotencyKey(userId, key);
    if (!record) return undefined;
    if (record.status === "COMPLETED" || record.status === "FAILED") {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return await storage.getIdempotencyKey(userId, key);
}
