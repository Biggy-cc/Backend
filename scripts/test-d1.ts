import "dotenv/config";
import { getD1Config, testD1Connection, d1Query } from "../src/db/d1-client.js";

async function main() {
  const config = getD1Config();
  if (!config) {
    console.error(
      "Missing Cloudflare credentials. Set in .env:\n" +
        "  CLOUDFLARE_ACCOUNT_ID=\n" +
        "  CLOUDFLARE_D1_DATABASE_ID=\n" +
        "  CLOUDFLARE_API_TOKEN="
    );
    process.exit(1);
  }

  const databaseId = await testD1Connection(config);
  console.log("D1 connection OK");
  console.log("  account:", config.accountId);
  console.log("  database:", databaseId);

  const tables = await d1Query<{ name: string }>(
    config,
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  );
  console.log("\nTables:", tables.map((t) => t.name).join(", ") || "(none)");

  for (const table of ["users", "daily_picks", "pending_payments"]) {
    const rows = await d1Query<{ n: number }>(
      config,
      `SELECT COUNT(*) as n FROM ${table}`
    ).catch(() => null);
    if (rows) {
      console.log(`  ${table}: ${rows[0]?.n ?? 0} rows`);
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  process.exit(1);
});
