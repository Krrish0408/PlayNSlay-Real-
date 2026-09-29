import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import path from "node:path";
import {
  validateStartupConfig,
  sanitizeDatabaseUrl,
  ConfigurationError,
  getEnvironment,
} from "../server/config";
import { isDatabaseUnavailableError, createDatabaseUnavailableResponse } from "../server/db-errors";
import express from "express";
import http from "node:http";

describe("Production Storage & Configuration Fail-Closed Audit", () => {
  describe("1. Environment Separation & Configuration Validation", () => {
    test("getEnvironment correctly normalizes all 4 environments", () => {
      assert.equal(getEnvironment("production"), "production");
      assert.equal(getEnvironment("prod"), "production");
      assert.equal(getEnvironment("staging"), "staging");
      assert.equal(getEnvironment("stage"), "staging");
      assert.equal(getEnvironment("test"), "test");
      assert.equal(getEnvironment("development"), "development");
      assert.equal(getEnvironment(""), "development");
    });

    test("Production mode fails fast when DATABASE_URL is missing", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "production",
            databaseUrl: "",
            sessionSecret: "valid_secret_key_1234567890",
          });
        },
        (err: any) => {
          assert(err instanceof ConfigurationError);
          assert.equal(err.code, "DATABASE_URL_REQUIRED");
          assert.match(err.message, /DATABASE_URL is required in production environment/i);
          assert.match(err.message, /fails closed/i);
          return true;
        },
      );
    });

    test("Staging mode fails fast when DATABASE_URL is missing", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "staging",
            databaseUrl: undefined,
            sessionSecret: "valid_secret_key_1234567890",
          });
        },
        (err: any) => {
          assert(err instanceof ConfigurationError);
          assert.equal(err.code, "DATABASE_URL_REQUIRED");
          assert.match(err.message, /DATABASE_URL is required in staging environment/i);
          return true;
        },
      );
    });

    test("Production mode rejects invalid database URL protocols (e.g. mysql:// or file://)", () => {
      assert.throws(
        () => {
          validateStartupConfig({
            env: "production",
            databaseUrl: "mysql://root:secret@localhost:3306/lounge",
            sessionSecret: "valid_secret_key_1234567890",
          });
        },
        (err: any) => {
          assert(err instanceof ConfigurationError);
          assert.equal(err.code, "DATABASE_URL_INVALID");
          return true;
        },
      );
    });

    test("Production mode rejects insecure or default SESSION_SECRET", () => {
      const defaultSecrets = [
        "r3pl1t_s3cr3t_k3y",
        "your_secure_session_secret_key_here",
        "dev_session_secret_key_12345",
        "short",
      ];

      for (const secret of defaultSecrets) {
        assert.throws(
          () => {
            validateStartupConfig({
              env: "production",
              databaseUrl: "postgresql://user:pass@localhost:5432/db",
              sessionSecret: secret,
            });
          },
          (err: any) => {
            assert(err instanceof ConfigurationError);
            assert.equal(err.code, "SESSION_SECRET_INSECURE");
            return true;
          },
        );
      }
    });

    test("Production mode succeeds with valid Postgres URL and secure secret", () => {
      const validConfig = validateStartupConfig({
        env: "production",
        databaseUrl: "postgresql://prod_user:secret_pass@aws.neon.tech:5432/gaming_lounge",
        sessionSecret: "very_long_secure_custom_production_secret_32chars",
      });

      assert.equal(validConfig.env, "production");
      assert.equal(validConfig.isProduction, true);
      assert.equal(validConfig.failClosed, true);
      assert.equal(validConfig.allowInMemoryFallback, false);
    });

    test("Development and test modes allow isolated in-memory testing", () => {
      const devConfig = validateStartupConfig({ env: "development", databaseUrl: undefined });
      assert.equal(devConfig.isDevelopment, true);
      assert.equal(devConfig.failClosed, false);
      assert.equal(devConfig.allowInMemoryFallback, true);

      const testConfig = validateStartupConfig({ env: "test", databaseUrl: undefined });
      assert.equal(testConfig.isTest, true);
      assert.equal(testConfig.failClosed, false);
      assert.equal(testConfig.allowInMemoryFallback, true);
    });
  });

  describe("2. Safe Credential Sanitization in Error Logging", () => {
    test("sanitizeDatabaseUrl masks sensitive passwords in logs", () => {
      const sanitized = sanitizeDatabaseUrl("postgresql://admin:super_secret_password@postgres.railway.app:5432/prod_db");
      assert.doesNotMatch(sanitized, /super_secret_password/);
      assert.match(sanitized, /admin:\*\*\*\*\*\*@postgres\.railway\.app/);
    });

    test("sanitizeDatabaseUrl handles missing or malformed URLs safely", () => {
      assert.equal(sanitizeDatabaseUrl(undefined), "<not set>");
      assert.equal(sanitizeDatabaseUrl(""), "<not set>");
      const malformed = sanitizeDatabaseUrl("postgres://myuser:mypw@some-host");
      assert.doesNotMatch(malformed, /mypw/);
    });
  });

  describe("3. Production Subprocess Startup Failure Integration Test", () => {
    test("Production server process crashes immediately with exit code 1 if DATABASE_URL is missing", async () => {
      const serverEntry = path.resolve(process.cwd(), "server/index.ts");

      const proc = spawn("npx", ["tsx", serverEntry], {
        env: {
          ...process.env,
          NODE_ENV: "production",
          DATABASE_URL: "", // explicitly missing
          SESSION_SECRET: "custom_production_secret_32_characters_long",
          PORT: "5999",
        },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });

      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      const exitCode = await new Promise<number>((resolve) => {
        proc.on("close", (code) => {
          resolve(code ?? 0);
        });
      });

      assert.equal(exitCode, 1, `Process should exit with code 1, got ${exitCode}`);
      const combined = stdout + stderr;
      assert.match(combined, /FATAL CONFIGURATION ERROR/i);
      assert.match(combined, /DATABASE_URL is required in production environment/i);
      assert.match(combined, /fails closed/i);
    });
  });

  describe("4. PostgreSQL Availability & Controlled 503 Handling", () => {
    test("isDatabaseUnavailableError accurately detects network and connection loss errors", () => {
      assert.equal(isDatabaseUnavailableError({ code: "ECONNREFUSED" }), true);
      assert.equal(isDatabaseUnavailableError({ code: "ETIMEDOUT" }), true);
      assert.equal(isDatabaseUnavailableError({ code: "57P01" }), true); // admin_shutdown
      assert.equal(isDatabaseUnavailableError({ code: "08006" }), true); // connection_failure
      assert.equal(isDatabaseUnavailableError(new Error("Connection terminated unexpectedly")), true);
      assert.equal(isDatabaseUnavailableError(new Error("Connection lost")), true);
      assert.equal(isDatabaseUnavailableError(new Error("Database service is currently unavailable")), true);

      // Business logic or validation errors should NOT be treated as database unavailable
      assert.equal(isDatabaseUnavailableError(new Error("Invalid game category ID")), false);
      assert.equal(isDatabaseUnavailableError(new Error("Booking duration exceeds maximum")), false);
      assert.equal(isDatabaseUnavailableError({ code: "23505" }), false); // Unique constraint violation
      assert.equal(isDatabaseUnavailableError({ code: "23P01" }), false); // Exclusion constraint violation
    });

    test("createDatabaseUnavailableResponse produces controlled 503 payload", () => {
      const resp = createDatabaseUnavailableResponse();
      assert.equal(resp.status, 503);
      assert.equal(resp.code, "DATABASE_UNAVAILABLE");
      assert.match(resp.message, /temporarily unavailable/i);
    });

    test("Express error handler returns controlled 503 when database disconnects", async () => {
      const app = express();

      app.get("/api/test-db-error", (_req, _res, next) => {
        const dbErr: any = new Error("Connection terminated unexpectedly");
        dbErr.code = "08006";
        next(dbErr);
      });

      app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        if (isDatabaseUnavailableError(err)) {
          return res.status(503).json(createDatabaseUnavailableResponse());
        }
        res.status(500).json({ message: "Internal server error" });
      });

      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

      const res = await fetch(`http://localhost:${port}/api/test-db-error`);
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.code, "DATABASE_UNAVAILABLE");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });
});
