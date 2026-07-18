import { formatMatchWithFlags } from "./flags.js";
import type { PickLeg } from "../picks/grading.js";
import type { PickTier } from "../picks/types.js";

const BOT_LINK = process.env.BIGGY_BOT_LINK ?? "t.me/BiggyCCBot";
const SITE_LINK = process.env.BIGGY_SITE_LINK ?? "biggy.cc";
const TXODDS_HANDLE = process.env.SOCIAL_TXODDS_HANDLE ?? "@TXODDSOfficial";

function worldCupOddsLine(): string {
  return `World Cup odds from ${TXODDS_HANDLE}`;
}

export function formatDailyFreePick(leg: PickLeg): string {
  const match = formatMatchWithFlags(leg.match);
  return `Biggy free pick for today

${match}
→ ${leg.selection} @ ${leg.odds.toFixed(2)}

${worldCupOddsLine()}
High-confidence leg from today's Hit card.
Full slips (Hit · Aim · Go Big) → ${BOT_LINK}`;
}

export function formatPickUpdate(version: number, changeNote: string): string {
  return `📋 Biggy card updated (v${version})

${changeNote}

${worldCupOddsLine()}
Fresh World Cup picks → ${BOT_LINK}`;
}

export function formatLegWin(leg: PickLeg, tier: PickTier, scoreLine?: string): string {
  const match = formatMatchWithFlags(leg.match);
  const score = scoreLine ? ` · ${scoreLine}` : "";
  const tierLabel = tier === "go_big" ? "Go Big" : tier === "aim" ? "Aim" : "Hit";
  return `✅ Biggy called it

${match}${score}
→ ${leg.selection} @ ${leg.odds.toFixed(2)} ✅

${worldCupOddsLine()}
${tierLabel} tier · Track record on ${SITE_LINK}
Get tomorrow's picks → ${BOT_LINK}`;
}

export function formatNewsHook(match: string, summary: string): string {
  const trimmed =
    summary.length > 320 ? `${summary.slice(0, 317)}…` : summary.trim();
  return `${formatMatchWithFlags(match)}

${trimmed}

Already on today's card → ${BOT_LINK}`;
}
