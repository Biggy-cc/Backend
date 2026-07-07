import "dotenv/config";
import { tryQuickOddsCard } from "../src/picks/quick-odds.js";
import { todayPickDate, getCachedPick } from "../src/picks/generate.js";
import { findLatestServableBatch } from "../src/picks/servable.js";
import { tryCarryForwardPicks } from "../src/picks/carry-forward.js";

async function main() {
  const pickDate = todayPickDate();
  console.log("pickDate:", pickDate);
  console.log("findLatestServableBatch:", (await findLatestServableBatch())?.pickDate ?? "none");
  console.log("tryCarryForward:", (await tryCarryForwardPicks(pickDate)) ? "OK" : "null");
  const quick = await tryQuickOddsCard(pickDate);
  console.log("tryQuickOdds:", quick ? `v${quick.version}` : "null");
  if (quick) {
    const hit = await getCachedPick(pickDate, "hit");
    console.log("hit slip preview:", hit?.slice(0, 200));
  }
}

main().catch(console.error);
