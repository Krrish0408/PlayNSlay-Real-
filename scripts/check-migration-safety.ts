import fs from "fs";
import path from "path";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

interface DangerMatch {
  file: string;
  line: number;
  statement: string;
  pattern: string;
}

const DESTRUCTIVE_PATTERNS: { regex: RegExp; name: string }[] = [
  { regex: /\bDROP\s+TABLE\b/i, name: "DROP TABLE" },
  { regex: /\bDROP\s+DATABASE\b/i, name: "DROP DATABASE" },
  { regex: /\bDROP\s+SCHEMA\b/i, name: "DROP SCHEMA" },
  { regex: /\bTRUNCATE\b/i, name: "TRUNCATE" },
  { regex: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i, name: "DROP COLUMN" },
];

function checkMigrationSafety() {
  console.log("================================================================================");
  console.log("[MIGRATION SAFETY CHECK] Auditing migrations for unreviewed destructive statements");
  console.log("================================================================================");

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log("[MIGRATION SAFETY] No migrations directory found. Clean.");
    process.exit(0);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();

  const dangers: DangerMatch[] = [];

  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    const hasReviewMarker =
      content.includes("REVIEWED-DESTRUCTIVE-CHANGE") ||
      content.includes("-- REVIEWED:") ||
      process.env.ALLOW_DESTRUCTIVE_MIGRATIONS === "true";

    lines.forEach((line, idx) => {
      // Ignore comment lines
      const trimmed = line.trim();
      if (trimmed.startsWith("--") || trimmed.startsWith("/*")) return;

      for (const pattern of DESTRUCTIVE_PATTERNS) {
        if (pattern.regex.test(line)) {
          if (!hasReviewMarker) {
            dangers.push({
              file,
              line: idx + 1,
              statement: trimmed,
              pattern: pattern.name,
            });
          }
        }
      }
    });
  }

  if (dangers.length === 0) {
    console.log(`[MIGRATION SAFETY PASS] Audited ${files.length} migration(s). Zero unreviewed destructive statements found.`);
    process.exit(0);
  } else {
    console.error(`\n[CRITICAL WARNING] Found ${dangers.length} UNREVIEWED DESTRUCTIVE DATABASE STATEMENT(S):`);
    console.table(
      dangers.map((d) => ({
        File: d.file,
        Line: d.line,
        Type: d.pattern,
        Statement: d.statement.substring(0, 50),
      }))
    );
    console.error("\nPOLICY VIOLATION: Destructive database changes must NOT execute automatically without a reviewed migration.");
    console.error("To permit this migration, either:");
    console.error("  1. Add '-- REVIEWED-DESTRUCTIVE-CHANGE: Approved by <Reviewer/Ticket>' in the migration SQL header, OR");
    console.error("  2. Set ALLOW_DESTRUCTIVE_MIGRATIONS=true in the deployment execution environment after team sign-off.\n");
    process.exit(1);
  }
}

checkMigrationSafety();
