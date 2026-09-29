#!/usr/bin/env node
/**
 * CLI Tool for Secure Initial Administrator Bootstrap.
 *
 * Usage:
 *   # Check bootstrap status
 *   npx tsx server/bootstrap-cli.ts --status
 *
 *   # Step 1: Initialize MFA setup with bootstrap token
 *   npx tsx server/bootstrap-cli.ts --init-mfa --token <token>
 *
 *   # Step 2: Complete admin creation
 *   npx tsx server/bootstrap-cli.ts \
 *     --token <token> \
 *     --username <username> \
 *     --email <email> \
 *     --password <strong-password> \
 *     --mfa-secret <secret> \
 *     --mfa-token <6-digit-otp>
 */

import {
  isBootstrapAvailable,
  initiateBootstrapMfa,
  completeAdminBootstrap,
  initializeBootstrapToken,
} from "./admin-bootstrap";
import readline from "readline";

function parseArgs(): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        args[key] = argv[i + 1];
        i++;
      } else {
        args[key] = true;
      }
    }
  }

  return args;
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function main() {
  const args = parseArgs();

  const available = await isBootstrapAvailable();

  if (args.status) {
    console.log(`[BOOTSTRAP STATUS] Available: ${available}`);
    process.exit(available ? 0 : 1);
  }

  if (!available) {
    console.error("[ERROR] Administrator bootstrap is permanently disabled. An administrator account already exists.");
    process.exit(1);
  }

  if (args["init-mfa"]) {
    let token = typeof args.token === "string" ? args.token : "";
    if (!token) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      token = await prompt(rl, "Enter bootstrap token: ");
      rl.close();
    }

    try {
      const result = await initiateBootstrapMfa(token);
      console.log("\n=======================================================");
      console.log("  MFA SETUP INITIALIZED FOR INITIAL ADMINISTRATOR");
      console.log("=======================================================");
      console.log(`\nManual Entry Key (TOTP Secret): ${result.manualEntryKey}`);
      console.log(`OTPAUTH URI:                   ${result.otpauthUrl}`);
      console.log("\nRecovery Codes (Save these securely!):");
      result.recoveryCodes.forEach((code, idx) => console.log(`  ${idx + 1}. ${code}`));
      console.log("\nScan the URI or enter the manual entry key in Google Authenticator or 1Password.");
      console.log("Then run bootstrap completion with the generated 6-digit TOTP code.");
      console.log("=======================================================\n");
      process.exit(0);
    } catch (err: any) {
      console.error(`[ERROR] ${err.message}`);
      process.exit(1);
    }
  }

  // If token, username, password, mfa-secret, mfa-token provided via flags:
  if (args.token && args.username && args.email && args.password && args["mfa-secret"] && args["mfa-token"]) {
    try {
      const result = await completeAdminBootstrap({
        bootstrapToken: String(args.token),
        username: String(args.username),
        email: String(args.email),
        password: String(args.password),
        fullName: typeof args["full-name"] === "string" ? args["full-name"] : undefined,
        mfaSecret: String(args["mfa-secret"]),
        mfaToken: String(args["mfa-token"]),
      });
      console.log("\n✅ [SUCCESS] Initial administrator created successfully!");
      console.log(`   User ID:  ${result.user.id}`);
      console.log(`   Username: ${result.user.username}`);
      console.log(`   Email:    ${result.user.email}`);
      console.log(`   Role:     ${result.user.role}`);
      console.log(`\n🔒 Initial-admin bootstrap process is now permanently disabled.\n`);
      process.exit(0);
    } catch (err: any) {
      console.error(`[ERROR] Failed to complete administrator bootstrap: ${err.message}`);
      process.exit(1);
    }
  }

  // Interactive flow
  console.log("\n=======================================================");
  console.log("  SECURE INITIAL ADMINISTRATOR BOOTSTRAP (CLI)");
  console.log("=======================================================\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Check if token exists
    await initializeBootstrapToken();

    const token = await prompt(rl, "1. Enter Bootstrap Token: ");
    const mfaInit = await initiateBootstrapMfa(token);

    console.log(`\nAuthenticator Setup:`);
    console.log(`Manual TOTP Secret: ${mfaInit.manualEntryKey}`);
    console.log(`OTPAUTH URI:       ${mfaInit.otpauthUrl}`);
    console.log("\nRecovery Codes (Save these securely):");
    mfaInit.recoveryCodes.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    console.log("");

    const username = await prompt(rl, "2. Enter Admin Username: ");
    const email = await prompt(rl, "3. Enter Admin Email: ");
    const password = await prompt(rl, "4. Enter Admin Strong Password (min 12 chars, upper, lower, num, sym): ");
    const mfaToken = await prompt(rl, "5. Enter 6-digit Authenticator Code: ");
    const fullName = await prompt(rl, "6. Enter Full Name (optional): ");

    rl.close();

    const result = await completeAdminBootstrap({
      bootstrapToken: token,
      username,
      email,
      password,
      fullName: fullName || undefined,
      mfaSecret: mfaInit.manualEntryKey,
      mfaToken,
    });

    console.log("\n✅ [SUCCESS] Initial administrator account created successfully!");
    console.log(`   User ID:  ${result.user.id}`);
    console.log(`   Username: ${result.user.username}`);
    console.log(`   Email:    ${result.user.email}`);
    console.log(`   Role:     ${result.user.role}`);
    console.log(`\n🔒 Initial-admin bootstrap process is now permanently disabled.\n`);
    process.exit(0);
  } catch (err: any) {
    rl.close();
    console.error(`\n❌ [ERROR] ${err.message}\n`);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error("Fatal bootstrap CLI error:", err);
    process.exit(1);
  });
}
