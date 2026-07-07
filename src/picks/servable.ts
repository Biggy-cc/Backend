import { dbAll } from "../db/client.js";
import { validateBundleBettable } from "./kickoff.js";
import { loadStoredBatch, type StoredBatch } from "./store.js";
import type { PickTier } from "./types.js";

const TIERS: PickTier[] = ["hit", "aim", "go_big"];

export function batchLegMatches(batch: StoredBatch): Set<string> {
  const used = new Set<string>();
  for (const tier of TIERS) {
    for (const leg of batch.picks[tier].legs) {
      used.add(leg.match.replace(/\s+/g, " ").trim().toLowerCase());
    }
  }
  return used;
}

/** Latest stored card whose legs are all still pre-kickoff on TxLINE. */
export async function findLatestServableBatch(): Promise<{
  pickDate: string;
  batch: StoredBatch;
} | null> {
  const dates = await dbAll<{ pick_date: string }>(
    `SELECT DISTINCT pick_date FROM daily_pick_batches ORDER BY pick_date DESC`
  );

  for (const { pick_date } of dates) {
    const batch = await loadStoredBatch(pick_date);
    if (!batch) continue;

    const err = await validateBundleBettable({
      dailyThesis: batch.thesis,
      picks: batch.picks,
    });
    if (!err) return { pickDate: pick_date, batch };
  }

  return null;
}
