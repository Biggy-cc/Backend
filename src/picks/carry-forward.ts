import { dbAll } from "../db/client.js";
import { filterBettableLegs, validateBundleBettable } from "./kickoff.js";
import type { GenerateResult } from "./generate.js";
import { findLatestServableBatch } from "./servable.js";
import {
  loadStoredBatch,
  saveFullPickBundle,
  type StoredBatch,
} from "./store.js";
import { formatPickSlip, type GeneratedPick, type PickTier } from "./types.js";
import {
  productOdds,
  type DailyPicksBundle,
  type MatchThesis,
} from "./validate.js";

const TIERS: PickTier[] = ["hit", "aim", "go_big"];

export async function persistPickBundle(
  pickDate: string,
  bundle: DailyPicksBundle,
  options: {
    version?: number;
    changeNote?: string | null;
    thesis?: MatchThesis[];
  } = {}
): Promise<GenerateResult> {
  const version = options.version ?? 1;
  const changeNote = options.changeNote ?? null;
  const thesis = options.thesis ?? bundle.dailyThesis;
  const thesisJson = JSON.stringify(thesis);
  const output: Record<PickTier, string> = { hit: "", aim: "", go_big: "" };
  const tierContents: Array<{ tier: PickTier; content: string }> = [];

  for (const tier of TIERS) {
    const raw = bundle.picks[tier];
    const pick: GeneratedPick = {
      tier,
      version,
      changeNote,
      legs: raw.legs,
      combinedOdds: raw.combinedOdds,
      breakdown: raw.breakdown,
    };
    const content = formatPickSlip(pick);
    output[tier] = content;
    tierContents.push({ tier, content });
  }

  await saveFullPickBundle(
    pickDate,
    version,
    tierContents,
    thesis,
    bundle.picks,
    changeNote
  );

  return {
    picks: output,
    version,
    updated: true,
    changeNote,
  };
}

async function saveCarriedBatch(
  pickDate: string,
  batch: StoredBatch,
  changeNote: string
): Promise<GenerateResult> {
  return persistPickBundle(
    pickDate,
    { dailyThesis: batch.thesis, picks: batch.picks },
    { version: 1, changeNote, thesis: batch.thesis }
  );
}
/** Copy the latest bettable card onto a new date when today has no batch yet. */
export async function tryCarryForwardPicks(
  pickDate: string
): Promise<GenerateResult | null> {
  if (await loadStoredBatch(pickDate)) return null;

  const servable = await findLatestServableBatch();
  if (!servable || servable.pickDate === pickDate) return null;

  const changeNote = "Today's card — active lines carried forward from the latest Biggy slip.";
  console.log(`[picks] Carrying forward ${servable.pickDate} → ${pickDate}`);

  return saveCarriedBatch(pickDate, servable.batch, changeNote);
}

/** Copy bettable legs from the latest stored batch when the full card has started matches. */
export async function tryPrunedCarryForward(
  pickDate: string
): Promise<GenerateResult | null> {
  if (await loadStoredBatch(pickDate)) return null;

  const dates = await dbAll<{ pick_date: string }>(
    `SELECT DISTINCT pick_date FROM daily_pick_batches ORDER BY pick_date DESC LIMIT 1`
  );
  if (dates.length === 0) return null;

  const sourceDate = dates[0].pick_date;
  if (sourceDate === pickDate) return null;

  const batch = await loadStoredBatch(sourceDate);
  if (!batch) return null;

  const prunedPicks: DailyPicksBundle["picks"] = {
    hit: { legs: [], combinedOdds: 0, breakdown: "" },
    aim: { legs: [], combinedOdds: 0, breakdown: "" },
    go_big: { legs: [], combinedOdds: 0, breakdown: "" },
  };

  const usedMatches = new Set<string>();

  for (const tier of TIERS) {
    const bettable = await filterBettableLegs(batch.picks[tier].legs);
    if (bettable.length === 0) return null;
    prunedPicks[tier] = {
      legs: bettable,
      combinedOdds: productOdds(bettable),
      breakdown: batch.picks[tier].breakdown,
    };
    for (const leg of bettable) usedMatches.add(leg.match);
  }

  const prunedThesis = batch.thesis.filter((t) => usedMatches.has(t.match));
  const bundle: DailyPicksBundle = {
    dailyThesis: prunedThesis,
    picks: prunedPicks,
  };

  const err = await validateBundleBettable(bundle);
  if (err) {
    console.log(`[picks] Pruned carry-forward from ${sourceDate} not bettable: ${err}`);
    return null;
  }

  const changeNote =
    "Today's card — bettable legs carried forward; started matches removed.";
  console.log(`[picks] Pruned carry-forward ${sourceDate} → ${pickDate}`);

  return persistPickBundle(pickDate, bundle, {
    version: 1,
    changeNote,
    thesis: prunedThesis,
  });
}

/** Ensure today's stored batch is bettable; re-save under today if only an older date has legs. */
export async function ensureBettableCardForDate(
  pickDate: string
): Promise<GenerateResult | null> {
  const current = await loadStoredBatch(pickDate);
  if (current) {
    const err = await validateBundleBettable({
      dailyThesis: current.thesis,
      picks: current.picks,
    });
    if (!err) return null;
  }

  return tryCarryForwardPicks(pickDate);
}
