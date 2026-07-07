import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getD1Config, d1Batch, d1Exec, d1Query } from "./d1-client.js";
import { BASE_SCHEMA, SQLITE_ALTER_STATEMENTS } from "./schema.js";

export type DbBackend = "sqlite" | "d1";

let sqliteDb: SqliteDatabase | null = null;
let d1Config = getD1Config();

export function getDbBackend(): DbBackend {
  return process.env.DATABASE_BACKEND?.trim().toLowerCase() === "d1"
    ? "d1"
    : "sqlite";
}

function sqlite(): SqliteDatabase {
  if (!sqliteDb) {
    const dbPath = process.env.DATABASE_PATH ?? "./data/biggy.db";
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    sqliteDb = new Database(dbPath);
    sqliteDb.pragma("journal_mode = WAL");
  }
  return sqliteDb;
}

/** @deprecated Use dbRun/dbGet/dbAll — kept for scripts that import `db` directly. */
export const db: SqliteDatabase = new Proxy({} as SqliteDatabase, {
  get(_target, prop) {
    return Reflect.get(sqlite(), prop);
  },
});

export async function dbBatch(
  statements: Array<{ sql: string; params?: unknown[] }>
): Promise<void> {
  if (getDbBackend() === "d1") {
    if (!d1Config) d1Config = getD1Config();
    if (!d1Config) throw new Error("D1 not configured");
    await d1Batch(d1Config, statements);
    return;
  }
  const database = sqlite();
  const run = database.transaction((stmts: typeof statements) => {
    for (const { sql, params = [] } of stmts) {
      database.prepare(sql).run(...params);
    }
  });
  run(statements);
}

export async function dbRun(sql: string, ...params: unknown[]): Promise<void> {
  if (getDbBackend() === "d1") {
    if (!d1Config) d1Config = getD1Config();
    if (!d1Config) throw new Error("D1 not configured");
    await d1Exec(d1Config, sql, params);
    return;
  }
  sqlite().prepare(sql).run(...params);
}

export async function dbGet<T>(
  sql: string,
  ...params: unknown[]
): Promise<T | undefined> {
  if (getDbBackend() === "d1") {
    if (!d1Config) d1Config = getD1Config();
    if (!d1Config) throw new Error("D1 not configured");
    const rows = await d1Query<T>(d1Config, sql, params);
    return rows[0];
  }
  return sqlite().prepare(sql).get(...params) as T | undefined;
}

export async function dbAll<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  if (getDbBackend() === "d1") {
    if (!d1Config) d1Config = getD1Config();
    if (!d1Config) throw new Error("D1 not configured");
    return d1Query<T>(d1Config, sql, params);
  }
  return sqlite().prepare(sql).all(...params) as T[];
}

export async function dbExec(sql: string): Promise<void> {
  if (getDbBackend() === "d1") {
    if (!d1Config) d1Config = getD1Config();
    if (!d1Config) throw new Error("D1 not configured");
    await d1Exec(d1Config, sql);
    return;
  }
  sqlite().exec(sql);
}

async function migrateLegacyColumns(): Promise<void> {
  for (const sql of SQLITE_ALTER_STATEMENTS) {
    try {
      if (getDbBackend() === "d1") {
        if (!d1Config) d1Config = getD1Config();
        if (!d1Config) throw new Error("D1 not configured");
        await d1Exec(d1Config, sql);
      } else {
        sqlite().exec(sql);
      }
    } catch {
      // column may already exist
    }
  }
}

export async function runMigrations(): Promise<void> {
  if (getDbBackend() === "d1") {
    if (!d1Config) d1Config = getD1Config();
    if (!d1Config) {
      throw new Error(
        "DATABASE_BACKEND=d1 but missing CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, or CLOUDFLARE_API_TOKEN"
      );
    }
    await d1Exec(d1Config, BASE_SCHEMA);
    await migrateLegacyColumns();
    return;
  }

  sqlite().exec(BASE_SCHEMA);
  await migrateLegacyColumns();
}
