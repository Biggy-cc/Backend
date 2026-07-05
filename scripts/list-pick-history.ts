import "dotenv/config";
import { dbAll } from "../src/db/client.js";
import type { PickTier } from "../src/picks/types.js";
import type { DailyPicksBundle } from "../src/picks/validate.js";

async function main() {
  const batches = await dbAll<{
    pick_date: string;
    version: number;
    created_at: string;
    picks_json: string;
  }>(
    `SELECT pick_date, version, created_at, picks_json
     FROM daily_pick_batches ORDER BY pick_date ASC, version ASC`
  );

  console.log(`Pick batches in DB: ${batches.length}\n`);

  if (batches.length === 0) {
    const rows = await dbAll<{ pick_date: string; tier: string; created_at: string }>(
      `SELECT pick_date, tier, created_at FROM daily_picks ORDER BY pick_date ASC`
    );
    console.log(`daily_picks rows: ${rows.length}`);
    for (const r of rows) {
      console.log(`  ${r.pick_date} ${r.tier} ${r.created_at}`);
    }
    return;
  }

  const tiers: PickTier[] = ["hit", "aim", "go_big"];

  for (const b of batches) {
    const picks = JSON.parse(b.picks_json) as DailyPicksBundle["picks"];
    console.log("—".repeat(50));
    console.log(`${b.pick_date} v${b.version} (${b.created_at})`);
    for (const tier of tiers) {
      const p = picks[tier];
      if (!p?.legs?.length) continue;
      console.log(`  ${tier}: ${p.combinedOdds}x · ${p.legs.length} legs`);
      for (const leg of p.legs) {
        console.log(`    · ${leg.match} — ${leg.selection} @ ${leg.odds}`);
      }
    }
  }
}

main().catch(console.error);
