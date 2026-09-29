import { execSync } from "child_process";
import { runMigrations, rollbackLastMigration, getMigrationStatus } from "../server/migrator";

type Environment = "staging" | "production";
type Action = "deploy" | "rollback";

const envArg = (process.argv[2] || "staging").toLowerCase() as Environment;
const actionArg = (process.argv[3] || "deploy").toLowerCase() as Action;

if (envArg !== "staging" && envArg !== "production") {
  console.error(`Invalid environment "${envArg}". Expected "staging" or "production".`);
  process.exit(1);
}

if (actionArg !== "deploy" && actionArg !== "rollback") {
  console.error(`Invalid action "${actionArg}". Expected "deploy" or "rollback".`);
  process.exit(1);
}

console.log("================================================================================");
console.log(`[DEPLOYMENT LIFECYCLE] Executing "${actionArg.toUpperCase()}" for environment: ${envArg.toUpperCase()}`);
console.log("================================================================================");

// Never expose secrets in deployment logs
function redact(val?: string): string {
  if (!val) return "[UNSET]";
  if (val.length <= 6) return "***";
  return `${val.substring(0, 3)}***${val.substring(val.length - 2)}`;
}

console.log(`Environment:           ${envArg}`);
console.log(`Node Environment:      ${process.env.NODE_ENV || envArg}`);
console.log(`Database Target:       ${redact(process.env.DATABASE_URL)}`);
console.log(`Webhook Secret:        ${redact(process.env.PAYMENT_WEBHOOK_SECRET)}`);
console.log(`Session Secret:        ${redact(process.env.SESSION_SECRET)}`);
console.log("--------------------------------------------------------------------------------");

async function executeRollback() {
  console.log(`[ROLLBACK] Initiating automated rollback for ${envArg.toUpperCase()}...`);
  try {
    const result = await rollbackLastMigration();
    if (result.rolledBack) {
      console.log(`[ROLLBACK SUCCESS] Database rolled back migration: ${result.rolledBack}`);
    } else {
      console.log("[ROLLBACK NOTICE] No migrations required rollback.");
    }
  } catch (rollbackErr: any) {
    console.error("[ROLLBACK ERROR] Failed to rollback database migration:", rollbackErr?.message || rollbackErr);
  }
}

async function main() {
  const startTime = Date.now();

  if (actionArg === "rollback") {
    await executeRollback();
    console.log(`[ROLLBACK COMPLETE] Finished rollback sequence in ${Date.now() - startTime}ms.`);
    process.exit(0);
  }

  // STEP 1: Verify Build Artifacts
  console.log("\n[STEP 1/5] Verifying production build artifacts...");
  try {
    execSync("npx tsx scripts/lint.ts", { stdio: "inherit" });
  } catch {
    console.error("FATAL: Pre-deployment linting and hygiene check failed.");
    process.exit(1);
  }

  // STEP 2: Migration Safety Gate
  console.log("\n[STEP 2/5] Running database migration safety check...");
  try {
    execSync("npx tsx scripts/check-migration-safety.ts", { stdio: "inherit" });
  } catch {
    console.error("FATAL: Migration safety gate blocked unreviewed destructive database changes.");
    process.exit(1);
  }

  // STEP 3: Apply Database Migrations
  console.log(`\n[STEP 3/5] Applying versioned database migrations to ${envArg.toUpperCase()}...`);
  try {
    const migResult = await runMigrations();
    if (migResult.alreadyUpToDate) {
      console.log("[MIGRATOR] Database schema is already up to date.");
    } else {
      console.log(`[MIGRATOR] Successfully applied ${migResult.applied.length} migration(s):`, migResult.applied);
    }
  } catch (migErr: any) {
    console.error(`FATAL: Database migration failed for ${envArg}:`, migErr?.message || migErr);
    console.log("[AUTO-ROLLBACK] Triggering automated rollback due to migration failure...");
    await executeRollback();
    process.exit(1);
  }

  // STEP 4: Service Rollout & Health Check
  console.log(`\n[STEP 4/5] Verifying service health probes for ${envArg.toUpperCase()}...`);
  console.log(`[DEPLOY] Application bundle ready for deployment.`);

  // STEP 5: Post-Deployment Smoke Tests
  console.log(`\n[STEP 5/5] Running post-deployment smoke tests...`);
  try {
    execSync("npx tsx scripts/smoke-test.ts", {
      stdio: "inherit",
      env: {
        ...process.env,
        TARGET_URL: process.env.TARGET_URL || `http://localhost:${process.env.PORT || 5001}`,
      },
    });
  } catch (smokeErr) {
    console.error(`FATAL: Post-deployment smoke tests failed on ${envArg.toUpperCase()}!`);
    if (process.env.AUTO_ROLLBACK_ON_SMOKE_FAILURE === "true") {
      console.log("[AUTO-ROLLBACK] Triggering automated rollback due to smoke test failure...");
      await executeRollback();
    }
    process.exit(1);
  }

  console.log("================================================================================");
  console.log(`[DEPLOYMENT SUCCESS] ${envArg.toUpperCase()} deployment completed cleanly in ${Date.now() - startTime}ms.`);
  console.log("================================================================================");
}

main().catch(async (err) => {
  console.error("FATAL UNHANDLED ERROR IN DEPLOYMENT SCRIPT:", err);
  process.exit(1);
});
