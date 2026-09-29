import { runMigrations, rollbackLastMigration, getMigrationStatus } from "./migrator";

async function main() {
  const command = process.argv[2] || "up";

  try {
    switch (command) {
      case "up": {
        console.log("[Migration CLI] Running pending database migrations...");
        const result = await runMigrations();
        if (result.alreadyUpToDate) {
          console.log("[Migration CLI] Database is already up to date. No pending migrations.");
        } else {
          console.log(`[Migration CLI] Successfully applied ${result.applied.length} migration(s):`, result.applied);
        }
        process.exit(0);
        break;
      }
      case "down":
      case "rollback": {
        console.log("[Migration CLI] Rolling back last database migration...");
        const result = await rollbackLastMigration();
        if (result.rolledBack) {
          console.log(`[Migration CLI] ${result.message}`);
        } else {
          console.log("[Migration CLI] No applied migrations to roll back.");
        }
        process.exit(0);
        break;
      }
      case "status": {
        console.log("[Migration CLI] Database Migration Status:");
        const status = await getMigrationStatus();
        console.table(
          status.map((s) => ({
            Migration: s.version,
            Status: s.applied ? "APPLIED" : "PENDING",
            "Applied At": s.appliedAt ? s.appliedAt.toISOString() : "-",
          }))
        );
        process.exit(0);
        break;
      }
      default:
        console.error(`Unknown command: ${command}. Use 'up', 'down' (or 'rollback'), or 'status'.`);
        process.exit(1);
    }
  } catch (err: any) {
    console.error("[Migration CLI] Fatal error during migration execution:", err?.message || err);
    process.exit(1);
  }
}

main();
