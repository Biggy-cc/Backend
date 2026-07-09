import "dotenv/config";
import { getD1Config, d1Query } from "../src/db/d1-client.js";
import { todayPickDate } from "../src/picks/generate.js";

async function main() {
  const config = getD1Config();
  if (!config) {
    console.error("Missing D1 credentials");
    process.exit(1);
  }
  const date = todayPickDate();
  console.log(`Checking stored D1 picks for ${date}...`);
  const rows = await d1Query<{ tier: string, version: number }>(
    config,
    `SELECT tier, version FROM daily_picks WHERE pick_date = ?`,
    [date]
  );
  console.log(`Found ${rows.length} rows:`, rows);
}

main().catch(console.error);
