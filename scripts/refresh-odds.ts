import "dotenv/config";
import { refreshStoredOdds } from "../src/picks/odds-refresh.js";
import { todayPickDate } from "../src/picks/generate.js";

async function main() {
  const pickDate = process.argv[2] ?? todayPickDate();
  console.log(`Checking odds refresh for ${pickDate}…`);
  const result = await refreshStoredOdds(pickDate);
  if (!result) {
    console.log("No stored batch for that date.");
    return;
  }
  console.log(
    result.updated
      ? `Updated to v${result.version}: ${result.changeNote}`
      : `No material moves (still v${result.version})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
