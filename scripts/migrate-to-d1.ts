import "dotenv/config";
import Database from "better-sqlite3";
import path from "node:path";
import { BASE_SCHEMA } from "../src/db/schema.js";
import { d1Exec, d1Query, getD1Config } from "../src/db/d1-client.js";

type TableSpec = {
  name: string;
  columns: string[];
  insertSql: string;
};

const TABLES: TableSpec[] = [
  {
    name: "users",
    columns: [
      "telegram_id",
      "username",
      "trial_started_at",
      "subscribed_until",
      "early_bird",
      "trial_picks_used",
      "created_at",
    ],
    insertSql: `INSERT OR REPLACE INTO users (telegram_id, username, trial_started_at, subscribed_until, early_bird, trial_picks_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: "pending_payments",
    columns: [
      "id",
      "telegram_id",
      "plan",
      "amount_usdc",
      "reference",
      "created_at",
      "fulfilled_at",
    ],
    insertSql: `INSERT OR REPLACE INTO pending_payments (id, telegram_id, plan, amount_usdc, reference, created_at, fulfilled_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: "daily_picks",
    columns: [
      "pick_date",
      "tier",
      "content",
      "version",
      "thesis_json",
      "change_note",
      "created_at",
    ],
    insertSql: `INSERT OR REPLACE INTO daily_picks (pick_date, tier, content, version, thesis_json, change_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: "daily_picks_history",
    columns: [
      "pick_date",
      "tier",
      "version",
      "content",
      "thesis_json",
      "change_note",
      "created_at",
    ],
    insertSql: `INSERT OR REPLACE INTO daily_picks_history (pick_date, tier, version, content, thesis_json, change_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: "daily_pick_batches",
    columns: [
      "pick_date",
      "version",
      "thesis_json",
      "picks_json",
      "change_note",
      "created_at",
    ],
    insertSql: `INSERT OR REPLACE INTO daily_pick_batches (pick_date, version, thesis_json, picks_json, change_note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  },
];

const BATCH_SIZE = 25;

async function copyRows(
  config: ReturnType<typeof getD1Config> & {},
  table: TableSpec,
  rows: Record<string, unknown>[]
): Promise<void> {
  for (const row of rows) {
    await d1Exec(
      config,
      table.insertSql,
      table.columns.map((col) => row[col] ?? null)
    );
  }
}

async function main() {
  const config = getD1Config();
  if (!config) {
    console.error(
      "Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN in .env"
    );
    process.exit(1);
  }

  const sqlitePath = path.resolve(
    process.env.DATABASE_PATH ?? "./data/biggy.db"
  );
  console.log("Source SQLite:", sqlitePath);
  console.log("Target D1:", config.databaseId);

  const sqlite = new Database(sqlitePath, { readonly: true });

  console.log("\nApplying schema to D1…");
  await d1Exec(config, BASE_SCHEMA);

  for (const table of TABLES) {
    let rows: Record<string, unknown>[];
    try {
      rows = sqlite
        .prepare(`SELECT ${table.columns.join(", ")} FROM ${table.name}`)
        .all() as Record<string, unknown>[];
    } catch {
      console.log(`  ${table.name}: skipped (table missing in SQLite)`);
      continue;
    }

    if (rows.length === 0) {
      console.log(`  ${table.name}: 0 rows`);
      continue;
    }

    console.log(`  ${table.name}: copying ${rows.length} rows…`);
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      await copyRows(config, table, chunk);
    }
  }

  sqlite.close();

  console.log("\nD1 row counts after migration:");
  for (const table of TABLES) {
    const count = await d1Query<{ n: number }>(
      config,
      `SELECT COUNT(*) as n FROM ${table.name}`
    ).catch(() => null);
    if (count) {
      console.log(`  ${table.name}: ${count[0]?.n ?? 0}`);
    }
  }

  console.log(
    "\nDone. To run the bot on D1, set DATABASE_BACKEND=d1 in .env and restart."
  );
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  process.exit(1);
});
