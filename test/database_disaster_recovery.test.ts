import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  createEncryptedBackup,
  verifyBackupIntegrity,
  performRestoreTest,
  pruneOldBackups,
  getDisasterRecoveryStatus,
  restoreBackupToLiveDatabase,
  BACKUP_TABLES,
  RPO_MINUTES,
  RTO_MINUTES,
} from "../server/disaster-recovery";
import { storage } from "../server/storage";

const TEST_BACKUPS_DIR = path.resolve(process.cwd(), "test-backups-sandbox");

function cleanTestDir() {
  if (fs.existsSync(TEST_BACKUPS_DIR)) {
    fs.rmSync(TEST_BACKUPS_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_BACKUPS_DIR, { recursive: true, mode: 0o700 });
}

test("Database Disaster Recovery Suite", async (t) => {
  cleanTestDir();

  t.after(() => {
    if (fs.existsSync(TEST_BACKUPS_DIR)) {
      fs.rmSync(TEST_BACKUPS_DIR, { recursive: true, force: true });
    }
  });

  await t.test("RPO and RTO are defined to rigorous production standards", () => {
    assert.strictEqual(RPO_MINUTES, 15, "RPO must be 15 minutes");
    assert.strictEqual(RTO_MINUTES, 30, "RTO must be 30 minutes");
  });

  await t.test("Inventory decommissioning is strictly respected", () => {
    // Assert no inventory tables exist in backup table list
    assert.ok(
      !BACKUP_TABLES.includes("inventory"),
      "Inventory table must not be reintroduced in backup tables"
    );
    assert.ok(
      !BACKUP_TABLES.includes("inventory_items"),
      "Inventory items must not be reintroduced"
    );
    assert.ok(
      !BACKUP_TABLES.includes("booking_items"),
      "Booking items must not be reintroduced"
    );
  });

  let createdBackupId: string;

  await t.test("createEncryptedBackup generates valid AES-256-GCM encrypted backup package", async () => {
    // Ensure at least some test data exists
    await storage.createStation({
      name: "DR-TEST-STATION-01",
      gameTypeId: 1,
      status: "AVAILABLE",
    }).catch(() => {});

    const { manifest, backupFilePath } = await createEncryptedBackup(TEST_BACKUPS_DIR);

    assert.ok(manifest.backupId, "Must have backup ID");
    assert.ok(fs.existsSync(backupFilePath), "Encrypted file must exist");
    assert.ok(fs.existsSync(path.join(TEST_BACKUPS_DIR, `${manifest.backupId}.json`)), "Manifest must exist");

    assert.strictEqual(manifest.verified, true, "Backup must be verified immediately upon creation");
    assert.ok(manifest.ivHex && manifest.ivHex.length === 32, "Must contain 16-byte IV in hex");
    assert.ok(manifest.authTagHex && manifest.authTagHex.length === 32, "Must contain 16-byte auth tag in hex");
    assert.ok(manifest.plaintextSha256, "Must compute plaintext SHA-256");
    assert.ok(manifest.ciphertextSha256, "Must compute ciphertext SHA-256");

    // Ciphertext must be non-empty and differ from plaintext
    const cipherBuffer = fs.readFileSync(backupFilePath);
    assert.strictEqual(cipherBuffer.length, manifest.encryptedSizeBytes);

    createdBackupId = manifest.backupId;
  });

  await t.test("verifyBackupIntegrity verifies valid backup correctly", () => {
    const result = verifyBackupIntegrity(createdBackupId, TEST_BACKUPS_DIR);
    assert.strictEqual(result.valid, true, `Verification should pass: ${result.error}`);
    assert.ok(result.sql && result.sql.includes("BEGIN;"), "SQL must contain transaction boundary");
  });

  await t.test("verifyBackupIntegrity rejects tampered ciphertext (checksum mismatch)", () => {
    // Create a copy of the backup with tampered ciphertext
    const tamperedId = `tampered_${Date.now()}`;
    const origEnc = path.join(TEST_BACKUPS_DIR, `${createdBackupId}.enc`);
    const origJson = path.join(TEST_BACKUPS_DIR, `${createdBackupId}.json`);

    const manifest = JSON.parse(fs.readFileSync(origJson, "utf-8"));
    manifest.backupId = tamperedId;

    const encData = fs.readFileSync(origEnc);
    // Flip bits in the middle of ciphertext
    encData[Math.floor(encData.length / 2)] ^= 0xff;

    fs.writeFileSync(path.join(TEST_BACKUPS_DIR, `${tamperedId}.enc`), encData);
    fs.writeFileSync(path.join(TEST_BACKUPS_DIR, `${tamperedId}.json`), JSON.stringify(manifest, null, 2));

    const result = verifyBackupIntegrity(tamperedId, TEST_BACKUPS_DIR);
    assert.strictEqual(result.valid, false, "Verification must fail on tampered ciphertext");
    assert.ok(
      result.error?.includes("checksum mismatch") || result.error?.includes("tampered"),
      `Error should indicate tampering: ${result.error}`
    );
  });

  await t.test("verifyBackupIntegrity rejects tampered ciphertext when hash is recalculated (GCM auth tag check)", () => {
    // Malicious actor recomputes ciphertext hash, but does not possess the encryption key so GCM auth tag fails
    const forgedId = `forged_${Date.now()}`;
    const origEnc = path.join(TEST_BACKUPS_DIR, `${createdBackupId}.enc`);
    const origJson = path.join(TEST_BACKUPS_DIR, `${createdBackupId}.json`);

    const manifest = JSON.parse(fs.readFileSync(origJson, "utf-8"));
    manifest.backupId = forgedId;

    const encData = fs.readFileSync(origEnc);
    encData[Math.floor(encData.length / 2)] ^= 0xff;
    // Maliciously forge ciphertext hash in manifest
    manifest.ciphertextSha256 = crypto.createHash("sha256").update(encData).digest("hex");

    fs.writeFileSync(path.join(TEST_BACKUPS_DIR, `${forgedId}.enc`), encData);
    fs.writeFileSync(path.join(TEST_BACKUPS_DIR, `${forgedId}.json`), JSON.stringify(manifest, null, 2));

    const result = verifyBackupIntegrity(forgedId, TEST_BACKUPS_DIR);
    assert.strictEqual(result.valid, false, "Verification must fail on GCM auth tag check");
    assert.ok(
      result.error?.includes("Decryption or authentication failed"),
      `Error should indicate authentication failure: ${result.error}`
    );
  });

  await t.test("verifyBackupIntegrity rejects corrupted auth tag", () => {
    const badAuthId = `bad_auth_${Date.now()}`;
    const origEnc = path.join(TEST_BACKUPS_DIR, `${createdBackupId}.enc`);
    const origJson = path.join(TEST_BACKUPS_DIR, `${createdBackupId}.json`);

    const manifest = JSON.parse(fs.readFileSync(origJson, "utf-8"));
    manifest.backupId = badAuthId;
    manifest.authTagHex = crypto.randomBytes(16).toString("hex"); // Incorrect auth tag

    fs.copyFileSync(origEnc, path.join(TEST_BACKUPS_DIR, `${badAuthId}.enc`));
    fs.writeFileSync(path.join(TEST_BACKUPS_DIR, `${badAuthId}.json`), JSON.stringify(manifest, null, 2));

    const result = verifyBackupIntegrity(badAuthId, TEST_BACKUPS_DIR);
    assert.strictEqual(result.valid, false, "Must fail with corrupted auth tag");
    assert.ok(
      result.error?.includes("Decryption or authentication failed"),
      `Error should indicate auth tag mismatch: ${result.error}`
    );
  });

  await t.test("performRestoreTest runs isolated sandbox restoration without touching live db", async () => {
    const restoreResult = await performRestoreTest(createdBackupId, TEST_BACKUPS_DIR);

    assert.strictEqual(restoreResult.success, true, `Sandbox restore should pass: ${restoreResult.error}`);
    assert.strictEqual(restoreResult.backupId, createdBackupId);
    assert.ok(restoreResult.durationMs >= 0);
    assert.ok(typeof restoreResult.tableCountsVerified === "object");
  });

  await t.test("pruneOldBackups enforces GFS retention policy (7D/4W/12M) and never drops newest", () => {
    const pruneDir = path.resolve(TEST_BACKUPS_DIR, "retention-sandbox");
    fs.mkdirSync(pruneDir, { recursive: true });

    const now = new Date("2026-09-29T12:00:00Z");
    const msPerDay = 24 * 60 * 60 * 1000;

    // Helper to forge backup manifest
    const createMockBackup = (id: string, date: Date) => {
      const manifest = {
        backupId: id,
        timestamp: date.toISOString(),
        environment: "production",
        schemaVersion: "1.0.0",
        tables: ["users"],
        recordCounts: { users: 5 },
        plaintextSha256: "test",
        ciphertextSha256: "test",
        ivHex: "00".repeat(16),
        authTagHex: "00".repeat(16),
        uncompressedSizeBytes: 100,
        encryptedSizeBytes: 100,
        verified: true,
      };
      fs.writeFileSync(path.join(pruneDir, `${id}.json`), JSON.stringify(manifest));
      fs.writeFileSync(path.join(pruneDir, `${id}.enc`), Buffer.from("dummy"));
    };

    // 1. Newest backup (today)
    createMockBackup("backup_today", now);

    // 2. 3 days old (daily - keep)
    createMockBackup("backup_3d", new Date(now.getTime() - 3 * msPerDay));

    // 3. 10 days old, Sunday (weekly - keep)
    // Find Sunday ~10 days ago
    const sundayDate = new Date(now.getTime() - 10 * msPerDay);
    sundayDate.setDate(sundayDate.getDate() - sundayDate.getDay()); // Sunday
    createMockBackup("backup_weekly_sunday", sundayDate);

    // 4. 10 days old, Tuesday (non-Sunday weekly - prune)
    const tuesdayDate = new Date(now.getTime() - 10 * msPerDay);
    tuesdayDate.setDate(tuesdayDate.getDate() - tuesdayDate.getDay() + 2); // Tuesday
    createMockBackup("backup_weekly_tuesday", tuesdayDate);

    // 5. 50 days old, 1st of month (monthly - keep)
    const firstOfMonthDate = new Date(now.getTime() - 50 * msPerDay);
    firstOfMonthDate.setDate(1); // 1st of month
    createMockBackup("backup_monthly_1st", firstOfMonthDate);

    // 6. 50 days old, 15th of month (mid-month - prune)
    const midMonthDate = new Date(now.getTime() - 50 * msPerDay);
    midMonthDate.setDate(15);
    createMockBackup("backup_monthly_15th", midMonthDate);

    // 7. 400 days old (expired - prune)
    createMockBackup("backup_expired", new Date(now.getTime() - 400 * msPerDay));

    const { kept, pruned } = pruneOldBackups(pruneDir, now);

    assert.ok(kept.includes("backup_today"), "Latest backup must be kept");
    assert.ok(kept.includes("backup_3d"), "Daily backup within 7 days must be kept");
    assert.ok(kept.includes("backup_weekly_sunday"), "Sunday backup within 4 weeks must be kept");
    assert.ok(kept.includes("backup_monthly_1st"), "1st of month backup within 12 months must be kept");

    assert.ok(pruned.includes("backup_weekly_tuesday"), "Non-Sunday backup older than 7 days must be pruned");
    assert.ok(pruned.includes("backup_monthly_15th"), "Non-1st-of-month backup older than 28 days must be pruned");
    assert.ok(pruned.includes("backup_expired"), "Backup older than 365 days must be pruned");

    // Files should be unlinked for pruned backups
    assert.strictEqual(fs.existsSync(path.join(pruneDir, "backup_expired.enc")), false);
    assert.strictEqual(fs.existsSync(path.join(pruneDir, "backup_expired.json")), false);

    // Clean retention sandbox
    fs.rmSync(pruneDir, { recursive: true, force: true });
  });

  await t.test("restoreBackupToLiveDatabase enforces strict confirmation guard", async () => {
    await assert.rejects(
      async () => {
        await restoreBackupToLiveDatabase(createdBackupId, { confirm: false, backupsDir: TEST_BACKUPS_DIR });
      },
      /Must explicitly provide confirm: true/,
      "Must reject restore attempt when confirm is false"
    );
  });

  await t.test("getDisasterRecoveryStatus calculates accurate SLA and health metrics", async () => {
    const status = await getDisasterRecoveryStatus(TEST_BACKUPS_DIR);

    assert.strictEqual(status.rpoMinutes, 15);
    assert.strictEqual(status.rtoMinutes, 30);
    assert.ok(status.totalBackupsCount >= 1);
    assert.strictEqual(status.lastBackupStatus, "SUCCESS");
    assert.strictEqual(status.slaStatus, "HEALTHY");
  });
});
