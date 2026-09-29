import fs from "fs";
import path from "path";
import { execSync } from "child_process";

interface LintViolation {
  file: string;
  line?: number;
  rule: string;
  message: string;
}

const ROOT_DIR = process.cwd();
const violations: LintViolation[] = [];

console.log("================================================================================");
console.log("[LINT] Running repository hygiene, security, and code quality checks");
console.log("================================================================================");

// Check 1: Sensitive Files & Environment Hygiene
const FORBIDDEN_FILES = [".env.production", ".env.staging", ".env.local", "secrets.json"];
for (const file of FORBIDDEN_FILES) {
  if (fs.existsSync(path.join(ROOT_DIR, file))) {
    violations.push({
      file,
      rule: "no-committed-secrets",
      message: `Sensitive environment file "${file}" must not be committed to the repository.`,
    });
  }
}

// Check 2: Scan source files for forbidden patterns (hardcoded default credentials, unencrypted secrets)
const SOURCE_DIRS = ["client/src", "server", "shared"];
const FORBIDDEN_CODE_PATTERNS = [
  { regex: /password\s*[:=]\s*["']admin123["']/i, rule: "no-hardcoded-admin-password", message: "Found hardcoded default admin password 'admin123'." },
  { regex: /password\s*[:=]\s*["']password123["']/i, rule: "no-hardcoded-password", message: "Found hardcoded default password 'password123'." },
  { regex: /from\s+["']@\/shared\/inventory["']/i, rule: "no-deprecated-inventory-import", message: "Importing deprecated inventory subsystem." },
  { regex: /from\s+["']\.\.?\/inventory["']/i, rule: "no-deprecated-inventory-import", message: "Importing deprecated inventory subsystem." },
];

function scanDirectory(dir: string) {
  const fullPath = path.join(ROOT_DIR, dir);
  if (!fs.existsSync(fullPath)) return;

  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== "dist") {
        scanDirectory(entryPath);
      }
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      if (entryPath.includes("seed.ts")) return;
      const content = fs.readFileSync(path.join(ROOT_DIR, entryPath), "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        // Skip comment lines
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;

        for (const pattern of FORBIDDEN_CODE_PATTERNS) {
          if (pattern.regex.test(line)) {
            violations.push({
              file: entryPath,
              line: index + 1,
              rule: pattern.rule,
              message: pattern.message,
            });
          }
        }
      });
    }
  }
}

for (const dir of SOURCE_DIRS) {
  scanDirectory(dir);
}

// Check 3: Static Type Checking
console.log("[LINT] Verifying TypeScript type integrity (tsc --noEmit)...");
try {
  execSync("npx tsc --noEmit", { stdio: "pipe" });
  console.log("[LINT] TypeScript compilation check: PASS (0 errors)");
} catch (tscErr: any) {
  violations.push({
    file: "tsconfig.json",
    rule: "typescript-compiler-errors",
    message: `TypeScript compilation failed:\n${tscErr.stdout ? tscErr.stdout.toString() : tscErr.message}`,
  });
}

// Report Results
if (violations.length === 0) {
  console.log("\n[LINT PASS] All repository and code quality checks passed cleanly.");
  process.exit(0);
} else {
  console.error(`\n[LINT FAILED] Found ${violations.length} lint violation(s):`);
  console.table(
    violations.map((v) => ({
      Rule: v.rule,
      File: v.file,
      Line: v.line ?? "-",
      Message: v.message.substring(0, 60),
    }))
  );
  process.exit(1);
}
