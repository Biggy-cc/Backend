import "dotenv/config";
import { publishDailyCard } from "../src/picks/publish.js";
import { todayPickDate, getCachedPick } from "../src/picks/generate.js";

async function main() {
  const pickDate = todayPickDate();
  const t0 = Date.now();
  const r = await publishDailyCard(pickDate, { force: true });
  console.log(`publish: ${Date.now() - t0}ms`, r ? `v${r.version}` : "null");
  if (r) {
    const hit = await getCachedPick(pickDate, "hit");
    console.log("hit:", hit?.slice(0, 120));
  }
}

main().catch(console.error);
