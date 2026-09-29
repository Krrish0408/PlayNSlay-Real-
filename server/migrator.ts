import fs from "fs";
import path from "path";
import { pool, pgliteClient } from "./db";

export interface MigrationRecord {
  id: number;
  version: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  version: string;
  applied: boolean;
  appliedAt?: Date;
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

async function executeSql(sql: string): Promise<any> {
  if (pool) {
    return await pool.query(sql);
  }
  if (pgliteClient) {
    return await pgliteClient.exec(sql);
  }
  throw new Error("No database connection available for migration execution.");
}

async function querySql(sql: string, params: any[] = []): Promise<any[]> {
  if (pool) {
    const res = await pool.query(sql, params);
    return res.rows;
  }
  if (pgliteClient) {
    // For PGlite, query via drizzle or formatted string
    const res: any = await pgliteClient.query(sql, params);
    return res.rows || [];
  }
  throw new Error("No database connection available for migration query.");
}

export async function initMigrationTable(): Promise<void> {
  await executeSql(`
    CREATE TABLE IF NOT EXISTS "schema_migrations" (
      "id" SERIAL PRIMARY KEY,
      "version" TEXT NOT NULL UNIQUE,
      "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function getAppliedMigrations(): Promise<MigrationRecord[]> {
  await initMigrationTable();
  const rows = await querySql(`SELECT "id", "version", "applied_at" as "appliedAt" FROM "schema_migrations" ORDER BY "id" ASC;`);
  return rows.map((r: any) => ({
    id: r.id,
    version: r.version,
    appliedAt: new Date(r.appliedAt),
  }));
}

export function getAvailableMigrationFiles(migrationsDir = DEFAULT_MIGRATIONS_DIR): string[] {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
    .sort();
}

export async function runMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR): Promise<{ applied: string[]; alreadyUpToDate: boolean }> {
  await initMigrationTable();

  const appliedRecords = await getAppliedMigrations();
  const appliedSet = new Set(appliedRecords.map((r) => r.version));
  const availableFiles = getAvailableMigrationFiles(migrationsDir);

  const pending = availableFiles.filter((f) => !appliedSet.has(f));
  if (pending.length === 0) {
    return { applied: [], alreadyUpToDate: true };
  }

  const applied: string[] = [];

  for (const filename of pending) {
    const filePath = path.join(migrationsDir, filename);
    const sqlContent = fs.readFileSync(filePath, "utf-8");

    console.log(`[Migrator] Applying versioned migration: ${filename}...`);

    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");
        await client.query(sqlContent);
        await client.query(
          `INSERT INTO "schema_migrations" ("version") VALUES ($1);`,
          [filename]
        );
        await client.query("COMMIT;");
        applied.push(filename);
      } catch (err) {
        await client.query("ROLLBACK;");
        console.error(`[Migrator] FAILED migration ${filename}:`, err);
        throw err;
      } finally {
        client.release();
      }
    } else if (pgliteClient) {
      try {
        await pgliteClient.exec("BEGIN;");
        await pgliteClient.exec(sqlContent);
        await pgliteClient.query(
          `INSERT INTO "schema_migrations" ("version") VALUES ($1);`,
          [filename]
        );
        await pgliteClient.exec("COMMIT;");
        applied.push(filename);
      } catch (err) {
        await pgliteClient.exec("ROLLBACK;");
        console.error(`[Migrator] FAILED migration ${filename}:`, err);
        throw err;
      }
    }
  }

  console.log(`[Migrator] Successfully applied ${applied.length} migration(s).`);
  return { applied, alreadyUpToDate: false };
}

export async function rollbackLastMigration(migrationsDir = DEFAULT_MIGRATIONS_DIR): Promise<{ rolledBack: string | null; message: string }> {
  await initMigrationTable();

  const appliedRecords = await getAppliedMigrations();
  if (appliedRecords.length === 0) {
    return { rolledBack: null, message: "No migrations have been applied." };
  }

  const lastApplied = appliedRecords[appliedRecords.length - 1];
  const baseName = lastApplied.version.replace(/\.sql$/, "");
  const downFileName = `${baseName}.down.sql`;
  const downFilePath = path.join(migrationsDir, downFileName);

  if (!fs.existsSync(downFilePath)) {
    throw new Error(`Rollback procedure failed: down migration file not found: ${downFileName}`);
  }

  const downSql = fs.readFileSync(downFilePath, "utf-8");
  console.log(`[Migrator] Rolling back migration: ${lastApplied.version} using ${downFileName}...`);

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN;");
      await client.query(downSql);
      await client.query(`DELETE FROM "schema_migrations" WHERE "version" = $1;`, [lastApplied.version]);
      await client.query("COMMIT;");
    } catch (err) {
      await client.query("ROLLBACK;");
      console.error(`[Migrator] Failed rollback for ${lastApplied.version}:`, err);
      throw err;
    } finally {
      client.release();
    }
  } else if (pgliteClient) {
    try {
      await pgliteClient.exec("BEGIN;");
      await pgliteClient.exec(downSql);
      await pgliteClient.query(`DELETE FROM "schema_migrations" WHERE "version" = $1;`, [lastApplied.version]);
      await pgliteClient.exec("COMMIT;");
    } catch (err) {
      await pgliteClient.exec("ROLLBACK;");
      console.error(`[Migrator] Failed rollback for ${lastApplied.version}:`, err);
      throw err;
    }
  }

  console.log(`[Migrator] Rolled back migration: ${lastApplied.version}`);
  return { rolledBack: lastApplied.version, message: `Successfully rolled back ${lastApplied.version}` };
}

function DEFAULTMIGRATIONS_DIR_RESOLVED(dir?: string): string {
  return dir || DEFAULT_MIGRATIONS_DIR;
}

export async function getMigrationStatus(migrationsDir = DEFAULT_MIGRATIONS_DIR): Promise<MigrationStatus[]> {
  await initMigrationTable();
  const appliedRecords = await getAppliedMigrations();
  const appliedMap = new Map<string, Date>();
  for (const r of appliedRecords) {
    appliedMap.set(r.version, r.appliedAt);
  }

  const availableFiles = getAvailableMigrationFiles(migrationsDir);
  return availableFiles.map((file) => ({
    version: file,
    applied: appliedMap.has(file),
    appliedAt: appliedMap.get(file),
  }));
}
