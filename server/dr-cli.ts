#!/usr/bin/env node
/**
 * Play N' Slay - Database Disaster Recovery CLI
 * 
 * Provides automated backup creation, cryptographically verified integrity checks,
 * sandbox restore verification, GFS retention pruning, and recovery execution.
 * 
 * Usage:
 *   npx tsx server/dr-cli.ts backup
 *   npx tsx server/dr-cli.ts verify [backupId]
 *   npx tsx server/dr-cli.ts restore-test [backupId]
 *   npx tsx server/dr-cli.ts prune
 *   npx tsx server/dr-cli.ts status
 *   npx tsx server/dr-cli.ts restore <backupId> --confirm
 */

import {
  createEncryptedBackup,
  verifyBackupIntegrity,
  performRestoreTest,
  pruneOldBackups,
  getDisasterRecoveryStatus,
  listAvailableBackups,
  restoreBackupToLiveDatabase,
  RPO_MINUTES,
  RTO_MINUTES,
} from "./disaster-recovery";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "status";

  console.log(`\n======================================================`);
  console.log(`  PLAY N' SLAY — DATABASE DISASTER RECOVERY CLI       `);
  console.log(`  RPO Target: ${RPO_MINUTES} mins | RTO Target: ${RTO_MINUTES} mins`);
  console.log(`======================================================\n`);

  switch (command) {
    case "backup": {
      console.log("[CLI] Initiating transactional snapshot & AES-256-GCM encryption...");
      try {
        const { manifest, backupFilePath } = await createEncryptedBackup();
        console.log(`\n✅ Backup Created & Verified Successfully!`);
        console.log(`  Backup ID:        ${manifest.backupId}`);
        console.log(`  Timestamp:        ${manifest.timestamp}`);
        console.log(`  Ciphertext Path:  ${backupFilePath}`);
        console.log(`  Encrypted Size:   ${manifest.encryptedSizeBytes} bytes`);
        console.log(`  Plaintext Size:   ${manifest.uncompressedSizeBytes} bytes`);
        console.log(`  SHA-256 Hash:     ${manifest.ciphertextSha256}`);
        console.log(`  Verified Post-Op: ${manifest.verified ? "PASS (Auth Tag & Checksum match)" : "FAIL"}`);
        console.log(`  Tables Included:  ${manifest.tables.join(", ")}`);
        process.exit(0);
      } catch (err: any) {
        console.error(`\n❌ Backup Failed:`, err.message);
        process.exit(1);
      }
      break;
    }

    case "verify": {
      const backupId = args[1];
      if (!backupId) {
        const backups = listAvailableBackups();
        if (backups.length === 0) {
          console.error("❌ No backups found to verify.");
          process.exit(1);
        }
        console.log(`Verifying latest backup: ${backups[0].backupId}`);
        const result = verifyBackupIntegrity(backups[0].backupId);
        if (result.valid) {
          console.log(`✅ Backup ${backups[0].backupId} integrity verification PASSED.`);
          process.exit(0);
        } else {
          console.error(`❌ Backup verification FAILED: ${result.error}`);
          process.exit(1);
        }
      } else {
        const result = verifyBackupIntegrity(backupId);
        if (result.valid) {
          console.log(`✅ Backup ${backupId} integrity verification PASSED.`);
          process.exit(0);
        } else {
          console.error(`❌ Backup verification FAILED: ${result.error}`);
          process.exit(1);
        }
      }
      break;
    }

    case "restore-test": {
      const backupId = args[1];
      console.log(`[CLI] Running automated restore test in isolated sandbox database...`);
      try {
        const result = await performRestoreTest(backupId);
        if (result.success) {
          console.log(`\n✅ Sandbox Restore Test PASSED!`);
          console.log(`  Backup ID:       ${result.backupId}`);
          console.log(`  Duration:        ${result.durationMs}ms`);
          console.log(`  Table Row Counts Verified:`);
          for (const [table, count] of Object.entries(result.tableCountsVerified)) {
            console.log(`    - ${table}: ${count} rows`);
          }
          process.exit(0);
        } else {
          console.error(`\n❌ Restore Test FAILED:`, result.error);
          process.exit(1);
        }
      } catch (err: any) {
        console.error(`\n❌ Restore Test Threw Error:`, err.message);
        process.exit(1);
      }
      break;
    }

    case "prune": {
      console.log("[CLI] Applying Grandfather-Father-Son retention policy (7D/4W/12M)...");
      try {
        const result = pruneOldBackups();
        console.log(`\n✅ Pruning Complete:`);
        console.log(`  Retained Backups (${result.kept.length}):`);
        result.kept.forEach((id) => console.log(`    ✓ ${id}`));
        console.log(`  Pruned Backups (${result.pruned.length}):`);
        result.pruned.forEach((id) => console.log(`    ✗ ${id}`));
        process.exit(0);
      } catch (err: any) {
        console.error(`\n❌ Retention Pruning Failed:`, err.message);
        process.exit(1);
      }
      break;
    }

    case "status": {
      try {
        const status = await getDisasterRecoveryStatus();
        console.log(`📊 Disaster Recovery Status & SLA Metrics:`);
        console.log(`  SLA Status:             ${status.slaStatus === "HEALTHY" ? "🟢 HEALTHY" : "🔴 " + status.slaStatus}`);
        console.log(`  RPO Target:             ${status.rpoMinutes} minutes`);
        console.log(`  RTO Target:             ${status.rtoMinutes} minutes`);
        console.log(`  Total Backups:          ${status.totalBackupsCount}`);
        console.log(`  Last Backup ID:         ${status.lastBackupId || "N/A"}`);
        console.log(`  Last Backup At:         ${status.lastBackupAt || "None"}`);
        console.log(`  Last Backup Status:     ${status.lastBackupStatus}`);
        console.log(`  Last Backup Size:       ${status.lastBackupSizeBytes ? status.lastBackupSizeBytes + " bytes" : "N/A"}`);
        console.log(`  Last Restore Test At:   ${status.lastRestoreTestAt || "None"}`);
        console.log(`  Last Restore Status:    ${status.lastRestoreTestStatus}`);
        console.log(`  Continuous PITR Ready:  ${status.pitrSupported ? "YES (WAL archive configured)" : "STANDALONE_SNAPSHOTS"}`);
        process.exit(0);
      } catch (err: any) {
        console.error(`❌ Failed to retrieve DR status:`, err.message);
        process.exit(1);
      }
      break;
    }

    case "restore": {
      const backupId = args[1];
      const hasConfirm = args.includes("--confirm");
      if (!backupId) {
        console.error("❌ Must specify backup ID to restore: npx tsx server/dr-cli.ts restore <backupId> --confirm");
        process.exit(1);
      }
      if (!hasConfirm) {
        console.error("⚠️  Safety guard: Restoring a backup overwrites live database state.");
        console.error("    To proceed, re-run with explicit confirmation flag: --confirm");
        process.exit(1);
      }
      try {
        const result = await restoreBackupToLiveDatabase(backupId, { confirm: true });
        console.log(`\n✅ Live Database Restored Successfully!`);
        console.log(`  Target Backup ID:       ${backupId}`);
        if (result.emergencyBackupId) {
          console.log(`  Safety Backup Created:  ${result.emergencyBackupId}`);
        }
        process.exit(0);
      } catch (err: any) {
        console.error(`\n❌ Live Restoration Failed:`, err.message);
        process.exit(1);
      }
      break;
    }

    default: {
      console.log(`Unknown command: ${command}`);
      console.log(`Available commands:`);
      console.log(`  backup              Create an encrypted database backup`);
      console.log(`  verify [backupId]   Verify cryptographic integrity and checksum`);
      console.log(`  restore-test [id]   Run an isolated sandbox restore test`);
      console.log(`  prune               Apply backup retention policy`);
      console.log(`  status              Display current DR SLA status`);
      console.log(`  restore <id> --confirm  Restore backup into live database`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Fatal DR CLI error:", err);
  process.exit(1);
});
