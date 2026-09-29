import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { setupAuth } from "../server/auth";
import { registerRoutes } from "../server/routes";
import {
  validatePrivilegedPassword,
  isBootstrapAvailable,
  hashBootstrapToken,
  verifyBootstrapToken,
  initiateBootstrapMfa,
  completeAdminBootstrap,
  BOOTSTRAP_SETTING_COMPLETED,
  BOOTSTRAP_SETTING_TOKEN_HASH,
} from "../server/admin-bootstrap";
import { storage } from "../server/storage";
import { initDbSchema } from "../server/db";
import {
  validateStartupConfig,
  ConfigurationError,
} from "../server/config";
import {
  secretManager,
  redactSecret,
  BANNED_SECRET_PATTERNS,
} from "../server/secret-manager";
import { seedTestUsers } from "../server/seed";
import { generateSync } from "otplib";

describe("Hardened Production Secrets & Initial Admin Bootstrap", () => {
  const TEST_BOOTSTRAP_TOKEN = "test_secure_bootstrap_token_1234567890abcdef";

  before(async () => {
    await initDbSchema();
  });

  beforeEach(async () => {
    // Reset settings state
    await storage.deleteSetting(BOOTSTRAP_SETTING_COMPLETED);
    await storage.deleteSetting(BOOTSTRAP_SETTING_TOKEN_HASH);

    // Set test bootstrap token
    process.env.INITIAL_ADMIN_BOOTSTRAP_TOKEN = TEST_BOOTSTRAP_TOKEN;
    const tokenHash = hashBootstrapToken(TEST_BOOTSTRAP_TOKEN);
    await storage.setSetting(BOOTSTRAP_SETTING_TOKEN_HASH, tokenHash);
  });

  describe("Privileged Password Complexity Validation", () => {
    test("rejects passwords shorter than 12 characters", () => {
      const res = validatePrivilegedPassword("Short1!");
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("at least 12 characters")));
    });

    test("rejects passwords missing uppercase letters", () => {
      const res = validatePrivilegedPassword("lowercase_only_123!");
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("uppercase letter")));
    });

    test("rejects passwords missing lowercase letters", () => {
      const res = validatePrivilegedPassword("UPPERCASE_ONLY_123!");
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("lowercase letter")));
    });

    test("rejects passwords missing numbers", () => {
      const res = validatePrivilegedPassword("NoNumbersHereAtAll!");
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("numerical digit")));
    });

    test("rejects passwords missing special characters", () => {
      const res = validatePrivilegedPassword("NoSpecialChars123456");
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("special character")));
    });

    test("rejects passwords with predictable/common terms", () => {
      const res1 = validatePrivilegedPassword("Admin123456789!@#");
      assert.equal(res1.valid, false);
      assert.ok(res1.errors.some((e) => e.includes("predictable")));

      const res2 = validatePrivilegedPassword("Password123456789!@#");
      assert.equal(res2.valid, false);
      assert.ok(res2.errors.some((e) => e.includes("predictable")));

      const res3 = validatePrivilegedPassword("Changeme123456789!@#");
      assert.equal(res3.valid, false);
      assert.ok(res3.errors.some((e) => e.includes("predictable")));
    });

    test("accepts high-entropy privileged passwords meeting all criteria", () => {
      const res = validatePrivilegedPassword("V3ry$ecureP@ssw0rd2026!!");
      assert.equal(res.valid, true);
      assert.equal(res.errors.length, 0);
    });
  });

  describe("Initial Admin Bootstrap Lifecycle & Permanent Lockdown", () => {
    test("verifies bootstrap token in constant time and rejects invalid tokens", async () => {
      const isValid = await verifyBootstrapToken(TEST_BOOTSTRAP_TOKEN);
      assert.equal(isValid, true);

      const isInvalid = await verifyBootstrapToken("wrong_token_value_attempt");
      assert.equal(isInvalid, false);

      const isBlank = await verifyBootstrapToken("");
      assert.equal(isBlank, false);
    });

    test("initiateBootstrapMfa produces valid MFA setup data with valid token", async () => {
      const setup = await initiateBootstrapMfa(TEST_BOOTSTRAP_TOKEN);
      assert.ok(setup.manualEntryKey, "Should return manual entry key");
      assert.ok(setup.otpauthUrl.startsWith("otpauth://totp/"), "Should return valid otpauth URL");
      assert.ok(setup.qrCode.startsWith("data:image/png;base64,"), "Should return QR code data URI");
      assert.ok(Array.isArray(setup.recoveryCodes), "Should return recovery codes array");
      assert.equal(setup.recoveryCodes.length, 8, "Should return 8 recovery codes");
    });

    test("initiateBootstrapMfa rejects invalid bootstrap token with 401", async () => {
      await assert.rejects(
        async () => {
          await initiateBootstrapMfa("invalid_token_123");
        },
        (err: any) => {
          assert.equal(err.code, "INVALID_BOOTSTRAP_TOKEN");
          assert.equal(err.statusCode, 401);
          return true;
        }
      );
    });

    test("completeAdminBootstrap rejects weak passwords", async () => {
      const mfaSetup = await initiateBootstrapMfa(TEST_BOOTSTRAP_TOKEN);
      const mfaToken = generateSync({ secret: mfaSetup.manualEntryKey });

      await assert.rejects(
        async () => {
          await completeAdminBootstrap({
            bootstrapToken: TEST_BOOTSTRAP_TOKEN,
            username: `admin_weak_${Date.now()}`,
            email: `admin_weak_${Date.now()}@test.com`,
            password: "weak",
            mfaSecret: mfaSetup.manualEntryKey,
            mfaToken,
          });
        },
        (err: any) => {
          assert.equal(err.code, "PASSWORD_TOO_WEAK");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    });

    test("completeAdminBootstrap rejects invalid MFA codes", async () => {
      const mfaSetup = await initiateBootstrapMfa(TEST_BOOTSTRAP_TOKEN);

      await assert.rejects(
        async () => {
          await completeAdminBootstrap({
            bootstrapToken: TEST_BOOTSTRAP_TOKEN,
            username: `admin_badmfa_${Date.now()}`,
            email: `admin_badmfa_${Date.now()}@test.com`,
            password: "V3ry$tr0ngP@ssw0rd#2026",
            mfaSecret: mfaSetup.manualEntryKey,
            mfaToken: "000000", // invalid token
          });
        },
        (err: any) => {
          assert.equal(err.code, "INVALID_MFA_CODE");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    });

    test("completeAdminBootstrap creates admin, enables MFA, and permanently disables bootstrap", async () => {
      const mfaSetup = await initiateBootstrapMfa(TEST_BOOTSTRAP_TOKEN);
      const mfaToken = generateSync({ secret: mfaSetup.manualEntryKey });
      const uniqueSuffix = Date.now();

      const result = await completeAdminBootstrap({
        bootstrapToken: TEST_BOOTSTRAP_TOKEN,
        username: `sysadmin_${uniqueSuffix}`,
        email: `sysadmin_${uniqueSuffix}@gaminglounge.com`,
        password: "V3ry$tr0ngP@ssw0rd#2026",
        fullName: "System Super Admin",
        mfaSecret: mfaSetup.manualEntryKey,
        mfaToken,
      });

      // 1. Verify response structure (Zero leaked passwords/secrets)
      assert.equal(result.success, true);
      assert.equal(result.user.username, `sysadmin_${uniqueSuffix}`);
      assert.equal(result.user.email, `sysadmin_${uniqueSuffix}@gaminglounge.com`);
      assert.equal(result.user.role, "admin");
      assert.equal((result.user as any).password, undefined, "Password must not be returned in API");
      assert.equal((result.user as any).mfaSecret, undefined, "MFA secret must not be returned in API");

      // 2. Verify stored database state has MFA enabled and secret encrypted
      const storedUser = await storage.getUser(result.user.id);
      assert.ok(storedUser);
      assert.equal(storedUser.role, "admin");
      assert.equal(storedUser.isMfaEnabled, true);
      assert.ok(storedUser.mfaSecret && storedUser.mfaSecret.includes(":"), "MFA secret must be stored encrypted (iv:authTag:cipher)");

      // 3. Verify bootstrap is permanently locked
      const isAvailableAfter = await isBootstrapAvailable();
      assert.equal(isAvailableAfter, false, "Bootstrap must be permanently disabled once admin exists");

      const completedSetting = await storage.getSetting(BOOTSTRAP_SETTING_COMPLETED);
      assert.equal(completedSetting, "true");

      // 4. Verify any further bootstrap attempt is rejected with 403 Forbidden
      await assert.rejects(
        async () => {
          await initiateBootstrapMfa(TEST_BOOTSTRAP_TOKEN);
        },
        (err: any) => {
          assert.equal(err.code, "BOOTSTRAP_DISABLED");
          assert.equal(err.statusCode, 403);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await completeAdminBootstrap({
            bootstrapToken: TEST_BOOTSTRAP_TOKEN,
            username: `another_admin_${uniqueSuffix}`,
            email: `another_${uniqueSuffix}@test.com`,
            password: "V3ry$tr0ngP@ssw0rd#2026",
            mfaSecret: mfaSetup.manualEntryKey,
            mfaToken,
          });
        },
        (err: any) => {
          assert.equal(err.code, "BOOTSTRAP_DISABLED");
          assert.equal(err.statusCode, 403);
          return true;
        }
      );
    });
  });

  describe("Automatic Test User Seeding Prohibition in Production/Staging", () => {
    test("seedTestUsers strictly throws in production", async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        await assert.rejects(
          async () => {
            await seedTestUsers();
          },
          (err: any) => {
            assert.ok(err.message.includes("strictly forbidden in production"));
            return true;
          }
        );
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    test("seedTestUsers strictly throws in staging", async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "staging";
      try {
        await assert.rejects(
          async () => {
            await seedTestUsers();
          },
          (err: any) => {
            assert.ok(err.message.includes("strictly forbidden in production"));
            return true;
          }
        );
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });

  describe("Production Environment Variable & Secret Validation (Fail-Closed)", () => {
    test("rejects missing DATABASE_URL in production", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "production",
            databaseUrl: "",
            sessionSecret: "a_very_secure_production_session_secret_32_chars!",
            prodOrigins: "https://gaminglounge.com",
          });
        },
        (err: any) => {
          assert.ok(err instanceof ConfigurationError);
          assert.equal(err.code, "DATABASE_URL_REQUIRED");
          return true;
        }
      );
    });

    test("rejects non-postgres DATABASE_URL in production", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "production",
            databaseUrl: "mysql://user:pass@localhost/db",
            sessionSecret: "a_very_secure_production_session_secret_32_chars!",
            prodOrigins: "https://gaminglounge.com",
          });
        },
        (err: any) => {
          assert.ok(err instanceof ConfigurationError);
          assert.equal(err.code, "DATABASE_URL_INVALID");
          return true;
        }
      );
    });

    test("rejects dummy placeholder credentials in DATABASE_URL in production", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "production",
            databaseUrl: "postgresql://user:password@db.example.com:5432/production_db",
            sessionSecret: "a_very_secure_production_session_secret_32_chars!",
            prodOrigins: "https://gaminglounge.com",
          });
        },
        (err: any) => {
          assert.ok(err instanceof ConfigurationError);
          assert.equal(err.code, "DATABASE_URL_DUMMY");
          return true;
        }
      );
    });

    test("rejects session secret shorter than 16 characters in production", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "production",
            databaseUrl: "postgresql://dbuser:real_strong_password_987@db.example.com:5432/prod_db",
            sessionSecret: "short_secret", // < 16 chars
            prodOrigins: "https://gaminglounge.com",
          });
        },
        (err: any) => {
          assert.ok(err instanceof ConfigurationError);
          assert.equal(err.code, "SESSION_SECRET_INSECURE");
          return true;
        }
      );
    });

    test("rejects known default or insecure session secret in production", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "production",
            databaseUrl: "postgresql://dbuser:real_strong_password_987@db.example.com:5432/prod_db",
            sessionSecret: "your_secure_session_secret_key_here",
            prodOrigins: "https://gaminglounge.com",
          });
        },
        (err: any) => {
          assert.ok(err instanceof ConfigurationError);
          assert.equal(err.code, "SESSION_SECRET_INSECURE");
          return true;
        }
      );
    });

    test("rejects placeholder Cloudinary credentials in production", () => {
      const origName = process.env.CLOUDINARY_CLOUD_NAME;
      const origKey = process.env.CLOUDINARY_API_KEY;
      const origSecret = process.env.CLOUDINARY_API_SECRET;

      process.env.CLOUDINARY_CLOUD_NAME = "your_cloud_name";
      process.env.CLOUDINARY_API_KEY = "your_api_key";
      process.env.CLOUDINARY_API_SECRET = "your_api_secret";

      try {
        assert.throws(
          () => {
            validateStartupConfig({
              env: "production",
              databaseUrl: "postgresql://prod_user:RealPass9876543210!@prod.db.com:5432/prod_db",
              sessionSecret: "a_very_secure_production_session_secret_32_chars!",
              prodOrigins: "https://gaminglounge.com",
            });
          },
          (err: any) => {
            assert.ok(err instanceof ConfigurationError);
            assert.equal(err.code, "CLOUDINARY_CONFIG_DUMMY");
            return true;
          }
        );
      } finally {
        process.env.CLOUDINARY_CLOUD_NAME = origName;
        process.env.CLOUDINARY_API_KEY = origKey;
        process.env.CLOUDINARY_API_SECRET = origSecret;
      }
    });

    test("passes validation when all production secrets are valid and secure", () => {
      const config = validateStartupConfig({
        env: "production",
        databaseUrl: "postgresql://prod_user:RealPass9876543210!@prod.db.com:5432/prod_db",
        sessionSecret: "a_very_secure_production_session_secret_32_chars!",
        prodOrigins: "https://gaminglounge.com",
      });

      assert.equal(config.isProduction, true);
      assert.equal(config.sessionSecret, "a_very_secure_production_session_secret_32_chars!");
      assert.equal(config.databaseUrl, "postgresql://prod_user:RealPass9876543210!@prod.db.com:5432/prod_db");
    });
  });

  describe("Secret Manager Abstraction & Redaction", () => {
    test("EnvSecretManager retrieves existing environment variables", async () => {
      process.env.TEST_SECRET_KEY = "super_secret_value";
      const val = await secretManager.getSecret("TEST_SECRET_KEY");
      assert.equal(val, "super_secret_value");

      const has = await secretManager.hasSecret("TEST_SECRET_KEY");
      assert.equal(has, true);

      delete process.env.TEST_SECRET_KEY;
    });

    test("redactSecret masks sensitive values without leaking content", () => {
      assert.equal(redactSecret(undefined), "<not set>");
      assert.equal(redactSecret(""), "<not set>");
      assert.equal(redactSecret("123"), "******");
      const redacted = redactSecret("my_super_secret_api_key_12345");
      assert.ok(redacted.startsWith("my***45"));
      assert.ok(redacted.includes("len: 29"));
      assert.ok(!redacted.includes("super_secret_api_key"));
    });
  });

  describe("Initial Administrator Bootstrap API Endpoints", () => {
    let server: http.Server;
    let baseUrl: string;

    before(async () => {
      const app = express();
      app.use(express.json());
      app.use(express.urlencoded({ extended: false }));
      setupAuth(app);
      server = http.createServer(app);
      await registerRoutes(server, app);
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as any;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    test("GET /api/bootstrap/status returns availability flag (false when admin exists)", async () => {
      const res = await fetch(`${baseUrl}/api/bootstrap/status`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.bootstrapAvailable, false);
    });

    test("POST /api/bootstrap/init-mfa rejects missing token with 400", async () => {
      const res = await fetch(`${baseUrl}/api/bootstrap/init-mfa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, "TOKEN_REQUIRED");
    });

    test("POST /api/bootstrap/init-mfa enforces permanent lockdown (403 Forbidden) once bootstrap completed", async () => {
      const res = await fetch(`${baseUrl}/api/bootstrap/init-mfa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bootstrapToken: TEST_BOOTSTRAP_TOKEN }),
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "BOOTSTRAP_DISABLED");
    });

    test("POST /api/bootstrap/create-admin rejects missing parameters with 400", async () => {
      const res = await fetch(`${baseUrl}/api/bootstrap/create-admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bootstrapToken: TEST_BOOTSTRAP_TOKEN }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, "MISSING_REQUIRED_FIELDS");
    });

    test("POST /api/bootstrap/create-admin enforces permanent lockdown (403 Forbidden) once bootstrap completed", async () => {
      const res = await fetch(`${baseUrl}/api/bootstrap/create-admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bootstrapToken: TEST_BOOTSTRAP_TOKEN,
          username: "late_admin",
          email: "late_admin@example.com",
          password: "V3ry$ecureP@ssw0rd2026!!",
          mfaSecret: "JBSWY3DPEHPK3PXP",
          mfaToken: "123456",
        }),
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.code, "BOOTSTRAP_DISABLED");
    });
  });
});

