import { formatMatchWithFlags } from "./flags.js";
import type { PickLeg } from "../picks/grading.js";
import type { PickTier } from "../picks/types.js";

function tierLabel(tier: PickTier): string {
  if (tier === "go_big") return "Go Big";
  if (tier === "aim") return "Aim";
  return "Hit";
}

export function formatDailyFreePick(leg: PickLeg): string {
  const match = formatMatchWithFlags(leg.match);
  return `Biggy free pick

${match}
→ ${leg.selection} @ ${leg.odds.toFixed(2)}

Hit card · Highest-confidence leg on today's slip`;
}

export function formatPickUpdate(version: number, changeNote: string): string {
  return `Biggy card updated (v${version})

${changeNote}

Odds moved — slip refreshed`;
}

export function formatLegWin(leg: PickLeg, tier: PickTier, scoreLine?: string): string {
  const match = formatMatchWithFlags(leg.match);
  const score = scoreLine ? ` · ${scoreLine}` : "";
  return `✅ Biggy called it

${match}${score}
→ ${leg.selection} @ ${leg.odds.toFixed(2)} ✅

${tierLabel(tier)} card · Settled on Biggy`;
}

export function formatNewsHook(match: string, summary: string): string {
  const trimmed =
    summary.length > 320 ? `${summary.slice(0, 317)}…` : summary.trim();
  return `${formatMatchWithFlags(match)}

${trimmed}

Already priced into today's Biggy card`;
}
