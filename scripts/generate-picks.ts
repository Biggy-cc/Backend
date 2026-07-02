import "dotenv/config";
import { generateDailyPicks, todayPickDate } from "../src/picks/generate.js";
import { runMigrations } from "../src/db/client.js";

async function main() {
  await runMigrations();
  const pickDate = todayPickDate();
  const force =
    process.argv.includes("--regenerate") || process.argv.includes("--force");
  console.log(`Generating picks for ${pickDate}${force ? " (forced)" : ""}…`);

  const result = await generateDailyPicks(pickDate, { force });
  console.log(
    `Done. v${result.version}${result.changeNote ? ` — ${result.changeNote}` : ""}`
  );
}

main().catch((err) => {
  console.error("FAIL:", err.response?.data ?? err.message ?? err);
  process.exit(1);
});
