import { validateBundleBettable } from "./kickoff.js";
import type { GenerateResult } from "./generate.js";
import { findLatestServableBatch } from "./servable.js";
import {
  loadStoredBatch,
  saveBatchSnapshot,
  savePickBatch,
  type StoredBatch,
} from "./store.js";
import { formatPickSlip, type GeneratedPick, type PickTier } from "./types.js";

const TIERS: PickTier[] = ["hit", "aim", "go_big"];

async function saveCarriedBatch(
  pickDate: string,
  batch: StoredBatch,
  changeNote: string
): Promise<GenerateResult> {
  const version = 1;
  const thesisJson = JSON.stringify(batch.thesis);
  const output: Record<PickTier, string> = { hit: "", aim: "", go_big: "" };

  for (const tier of TIERS) {
    const raw = batch.picks[tier];
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
    await savePickBatch(pickDate, tier, content, version, thesisJson, changeNote);
  }

  await saveBatchSnapshot(pickDate, version, batch.thesis, batch.picks, changeNote);

  return {
    picks: output,
    version,
    updated: true,
    changeNote,
  };
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
