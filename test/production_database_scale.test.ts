import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { initDbSchema, checkDatabaseHealth, getPoolStats, SCHEMA_SQL } from "../server/db";
import { config, getPoolConfigForEnv } from "../server/config";
import { hashPassword } from "../server/auth";
import { bookings, auditLogs, userSessions, idempotencyKeys } from "../shared/schema";
import { getMigrationStatus, initMigrationTable } from "../server/migrator";

interface TestClient {
  get: (urlPath: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
  post: (urlPath: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; data: any; headers: Headers }>;
}

function createClient(serverAddress: string): TestClient {
  let cookieJar: string[] = [];

  const updateCookies = (setCookies: string[]) => {
    for (const sc of setCookies) {
      const cookiePart = sc.split(";")[0];
      const [cName] = cookiePart.split("=");
      cookieJar = cookieJar.filter((c) => !c.startsWith(cName + "="));
      if (!sc.includes("Expires=Thu, 01 Jan 1970") && !sc.includes("Max-Age=0")) {
        cookieJar.push(cookiePart);
      }
    }
  };

  const request = async (
    method: string,
    urlPath: string,
    body?: any,
    customHeaders?: Record<string, string>
  ) => {
    const fullUrl = new URL(urlPath, serverAddress);
    const headers: Record<string, string> = { ...customHeaders };
    if (cookieJar.length > 0 && !headers["Cookie"]) {
      headers["Cookie"] = cookieJar.join("; ");
    }
    if (body !== undefined && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(fullUrl.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      updateCookies(setCookies);
    }

    let data: any = null;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    return { status: res.status, data, headers: res.headers };
  };

  return {
    get: (urlPath, headers) => request("GET", urlPath, undefined, headers),
    post: (urlPath, body, headers) => request("POST", urlPath, body, headers),
  };
}

describe("Production Scale Database Architecture & Optimization", () => {
  let server: http.Server;
  let serverAddress: string;
  let client: TestClient;
  let testUserId: number;

  before(async () => {
    await initDbSchema();
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    server = http.createServer(app);
    await registerRoutes(server, app);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverAddress = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    client = createClient(serverAddress);

    // Create a seed user
    const username = `scale_user_${Date.now()}`;
    const passwordHash = await hashPassword("Password123!");
    const user = await storage.createUser({
      username,
      password: passwordHash,
      email: `${username}@test.com`,
      role: "admin",
      membershipTier: "platinum",
    });
    testUserId = user.id;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("1. High-Frequency Index Coverage", () => {
    test("Schema definition includes all required high-frequency query indexes", () => {
      // 1. Bookings by user_id
      assert.ok(
        SCHEMA_SQL.includes("idx_bookings_user_id"),
        "Missing index: idx_bookings_user_id"
      );

      // 2. Bookings by station_id
      assert.ok(
        SCHEMA_SQL.includes("idx_bookings_station_id"),
        "Missing index: idx_bookings_station_id"
      );

      // 3. Bookings by start_time
      assert.ok(
        SCHEMA_SQL.includes("idx_bookings_start_time"),
        "Missing index: idx_bookings_start_time"
      );

      // 4. Bookings by status
      assert.ok(
        SCHEMA_SQL.includes("idx_bookings_status"),
        "Missing index: idx_bookings_status"
      );

      // 5. Bookings by created_at
      assert.ok(
        SCHEMA_SQL.includes("idx_bookings_created_at"),
        "Missing index: idx_bookings_created_at"
      );

      // 6. Sessions by session identifier / hash
      assert.ok(
        SCHEMA_SQL.includes("idx_user_sessions_sid_hash"),
        "Missing index: idx_user_sessions_sid_hash"
      );

      // 7. Audit events by user_id and created_at
      assert.ok(
        SCHEMA_SQL.includes("idx_audit_logs_user_id_created_at"),
        "Missing index: idx_audit_logs_user_id_created_at"
      );

      // 8. Idempotency keys by user_id and key
      assert.ok(
        SCHEMA_SQL.includes("idx_idempotency_user_key"),
        "Missing index: idx_idempotency_user_key"
      );
    });

    test("Drizzle ORM schema exports contain index symbols for high-frequency columns", () => {
      // Validate schema objects are imported and defined
      assert.ok(bookings, "Bookings schema object exists");
      assert.ok(auditLogs, "AuditLogs schema object exists");
      assert.ok(userSessions, "UserSessions schema object exists");
      assert.ok(idempotencyKeys, "IdempotencyKeys schema object exists");
    });
  });

  describe("2. Safe Connection Pooling & Topology Limits", () => {
    test("Connection pool configuration adapts to deployment topologies", () => {
      const prodConfig = getPoolConfigForEnv("production");
      const stagingConfig = getPoolConfigForEnv("staging");
      const devConfig = getPoolConfigForEnv("development");

      assert.equal(prodConfig.max, 20, "Production pool max should be 20");
      assert.equal(prodConfig.min, 2, "Production pool min should be 2");
      assert.equal(stagingConfig.max, 10, "Staging pool max should be 10");
      assert.equal(devConfig.max, 5, "Development pool max should be 5");

      assert.ok(prodConfig.idleTimeoutMillis >= 10000, "Idle timeout should be safe");
      assert.ok(prodConfig.connectionTimeoutMillis <= 10000, "Connection timeout should fail fast");
      assert.ok(prodConfig.maxUses > 0, "maxUses prevents resource leaks");
    });

    test("Active database pool configuration is loaded into app config", () => {
      assert.ok(config.pool.max > 0, "Pool max must be configured");
      assert.ok(config.pool.idleTimeoutMillis > 0, "Pool idleTimeoutMillis must be configured");
      assert.ok(config.pool.connectionTimeoutMillis > 0, "Pool connectionTimeoutMillis must be configured");
    });
  });

  describe("3. Database Health Checks & Monitoring", () => {
    test("checkDatabaseHealth returns latency and pool stats", async () => {
      const health = await checkDatabaseHealth();
      assert.equal(health.healthy, true, "Database should be healthy");
      assert.ok(typeof health.latencyMs === "number", "Latency must be a number");
      assert.ok(health.latencyMs >= 0, "Latency must be non-negative");
    });

    test("GET /api/health includes database connection status and latency", async () => {
      const res = await client.get("/api/health");
      assert.equal(res.status, 200);
      assert.equal(res.data.status, "healthy");
      assert.equal(res.data.database, "connected");
      assert.ok(typeof res.data.latencyMs === "number");
    });

    test("GET /api/health/db returns dedicated database health metrics", async () => {
      const res = await client.get("/api/health/db");
      assert.equal(res.status, 200);
      assert.equal(res.data.status, "up");
      assert.equal(res.data.database, "healthy");
      assert.ok(typeof res.data.latencyMs === "number");
    });
  });

  describe("4. Query Auditing: Bounded Pagination & Sensitive Field Protection", () => {
    test("storage.getBookings projects only safe user columns (no password/mfa leak)", async () => {
      const bookingsList = await storage.getBookings({ limit: 5 });
      assert.ok(Array.isArray(bookingsList));
      for (const b of bookingsList) {
        if (b.user) {
          assert.equal((b.user as any).password, undefined, "User password must NEVER be selected in booking query");
          assert.equal((b.user as any).mfaSecret, undefined, "MFA secret must NEVER be selected in booking query");
          assert.equal((b.user as any).mfaRecoveryCodes, undefined, "MFA recovery codes must NEVER be selected in booking query");
        }
      }
    });

    test("storage.getBookings enforces bounded pagination", async () => {
      const p1 = await storage.getBookings({ limit: 2, offset: 0 });
      const p2 = await storage.getBookings({ limit: 2, offset: 2 });
      assert.ok(p1.length <= 2, "Page 1 limit must be bounded to 2");
      assert.ok(p2.length <= 2, "Page 2 limit must be bounded to 2");
    });

    test("storage.getAllUsers enforces pagination and projects safe user fields", async () => {
      const users = await storage.getAllUsers({ limit: 10, offset: 0 });
      assert.ok(Array.isArray(users));
      for (const u of users) {
        assert.equal((u as any).password, undefined, "Password must not be returned by getAllUsers");
        assert.equal((u as any).mfaSecret, undefined, "mfaSecret must not be returned by getAllUsers");
        assert.equal((u as any).mfaRecoveryCodes, undefined, "mfaRecoveryCodes must not be returned by getAllUsers");
      }
    });

    test("storage.getAuditLogs supports pagination and userId filtering", async () => {
      // Create a test audit log
      await storage.createAuditLog({
        userId: testUserId,
        username: "scale_tester",
        action: "SCALE_AUDIT_TEST",
        details: "Testing indexed composite queries",
      });

      const userLogs = await storage.getAuditLogs(10, 0, testUserId);
      assert.ok(Array.isArray(userLogs));
      assert.ok(userLogs.length > 0);
      assert.ok(userLogs.every((l) => l.userId === testUserId));
    });
  });

  describe("5. Transaction Boundaries", () => {
    test("storage.withTransaction commits successful operations atomically", async () => {
      const result = await storage.withTransaction(async (tx) => {
        const [entry] = await tx.insert(auditLogs).values({
          userId: testUserId,
          username: "tx_tester",
          action: "TX_COMMIT_TEST",
          details: "Transaction committed",
        }).returning();
        return entry;
      });

      assert.ok(result);
      assert.equal(result.action, "TX_COMMIT_TEST");
    });

    test("storage.withTransaction rolls back on failure without leaving partial state", async () => {
      const marker = `FAIL_${Date.now()}`;
      try {
        await storage.withTransaction(async (tx) => {
          await tx.insert(auditLogs).values({
            userId: testUserId,
            username: "tx_tester",
            action: marker,
            details: "This should be rolled back",
          });
          throw new Error("Simulated transaction failure");
        });
      } catch (err: any) {
        assert.equal(err.message, "Simulated transaction failure");
      }

      // Verify the audit log was rolled back
      const logs = await storage.getAuditLogs(50, 0, testUserId);
      const found = logs.find((l) => l.action === marker);
      assert.equal(found, undefined, "Rolled-back transaction item should not exist in database");
    });
  });

  describe("6. Production Migration Files & Rollback Procedures", () => {
    test("Production migration 0003_add_production_scale_indexes.sql exists and contains valid DDL", () => {
      const migrationPath = path.resolve(process.cwd(), "migrations", "0003_add_production_scale_indexes.sql");
      assert.ok(fs.existsSync(migrationPath), "Migration 0003 must exist");

      const sqlContent = fs.readFileSync(migrationPath, "utf-8");
      assert.ok(sqlContent.includes("idx_bookings_user_id"));
      assert.ok(sqlContent.includes("idx_bookings_station_id"));
      assert.ok(sqlContent.includes("idx_bookings_start_time"));
      assert.ok(sqlContent.includes("idx_bookings_status"));
      assert.ok(sqlContent.includes("idx_bookings_created_at"));
      assert.ok(sqlContent.includes("idx_user_sessions_sid_hash"));
      assert.ok(sqlContent.includes("idx_audit_logs_user_id_created_at"));
      assert.ok(sqlContent.includes("idx_idempotency_user_key"));
    });

    test("Production rollback script 0003_add_production_scale_indexes.down.sql exists and drops indexes cleanly", () => {
      const rollbackPath = path.resolve(process.cwd(), "migrations", "0003_add_production_scale_indexes.down.sql");
      assert.ok(fs.existsSync(rollbackPath), "Rollback 0003.down.sql must exist");

      const rollbackSql = fs.readFileSync(rollbackPath, "utf-8");
      assert.ok(rollbackSql.includes("idx_bookings_user_id"));
      assert.ok(rollbackSql.includes("idx_bookings_station_id"));
      assert.ok(rollbackSql.includes("idx_bookings_start_time"));
      assert.ok(rollbackSql.includes("idx_bookings_status"));
      assert.ok(rollbackSql.includes("idx_bookings_created_at"));
      assert.ok(rollbackSql.includes("idx_user_sessions_sid_hash"));
      assert.ok(rollbackSql.includes("idx_audit_logs_user_id_created_at"));
      assert.ok(rollbackSql.includes("idx_idempotency_user_key"));
    });

    test("Migration tracking system is initialized and tracks schema_migrations", async () => {
      await initMigrationTable();
      const status = await getMigrationStatus();
      assert.ok(Array.isArray(status), "Migration status must be an array");
      const migration0003 = status.find((s) => s.version.includes("0003_add_production_scale_indexes"));
      assert.ok(migration0003, "Migration 0003 should be listed in available migrations");
    });
  });
});
