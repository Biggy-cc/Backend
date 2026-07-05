import "dotenv/config";
import { computeTrackRecord, gradeLegAtFullTime } from "../src/picks/grading.js";
import { dbAll } from "../src/db/client.js";
import type { PickTier } from "../src/picks/types.js";
import type { DailyPicksBundle } from "../src/picks/validate.js";

async function main() {
  const batches = await dbAll<{
    pick_date: string;
    version: number;
    picks_json: string;
  }>(
    `SELECT pick_date, version, picks_json FROM daily_pick_batches ORDER BY pick_date, version`
  );

  const latestByDate = new Map<string, (typeof batches)[number]>();
  for (const b of batches) {
    const prev = latestByDate.get(b.pick_date);
    if (!prev || b.version > prev.version) latestByDate.set(b.pick_date, b);
  }

  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  let slipWins = 0;
  let slipLosses = 0;
  let slipPending = 0;

  console.log("Biggy pick accuracy (latest card per day, settled legs only)\n");

  for (const [date, batch] of [...latestByDate.entries()].sort()) {
    const picks = JSON.parse(batch.picks_json) as DailyPicksBundle["picks"];
    console.log(`— ${date} (v${batch.version})`);

    for (const tier of tiers) {
      const slip = picks[tier];
      if (!slip?.legs?.length) continue;

      const grades = slip.legs.map((leg) => gradeLegAtFullTime(leg));
      const settled = grades.filter((g) => g !== null);
      const pending = grades.filter((g) => g === null).length;

      if (pending === slip.legs.length) {
        console.log(`  ${tier}: pending (no results yet)`);
        slipPending++;
        continue;
      }

      const allWin = settled.length === slip.legs.length && settled.every(Boolean);
      if (allWin) slipWins++;
      else if (settled.some((g) => g === false)) slipLosses++;
      else slipPending++;

      const w = settled.filter(Boolean).length;
      const l = settled.filter((g) => g === false).length;
      console.log(
        `  ${tier}: ${w}/${settled.length} legs won${pending ? ` (+${pending} pending)` : ""} · slip ${allWin ? "WON" : l ? "LOST" : "partial/pending"}`
      );
    }
  }

  const record = await computeTrackRecord();
  const { settledLegs, hitLegs } = record.stats;

  console.log("\n" + "=".repeat(50));
  console.log(
    `Settled legs: ${settledLegs.wins}/${settledLegs.total} won (${pct(settledLegs.wins, settledLegs.total)})`
  );
  console.log(`Hit tier legs: ${hitLegs.wins}/${hitLegs.total} (${record.streak.label})`);
  console.log(`Full slips: ${slipWins} won · ${slipLosses} lost · ${slipPending} pending/unsettled`);
  console.log(`\nSite banner streak: ${record.streak.label} (Hit tier)`);

  console.log("\nRecent winning legs on site:");
  for (const row of record.recentWins.slice(0, 12)) {
    console.log(`  · ${row.match} — ${row.bet} (${row.tier}, ${row.date})`);
  }
}

function pct(w: number, t: number): string {
  if (t === 0) return "n/a";
  return `${Math.round((w / t) * 100)}%`;
}

main().catch(console.error);
