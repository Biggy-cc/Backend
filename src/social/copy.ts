import { flagsForMatch } from "./flags.js";
import type { PickLeg } from "../picks/grading.js";
import type { PickTier } from "../picks/types.js";

const BOT_LINK = process.env.BIGGY_BOT_LINK ?? "t.me/BiggyCCBot";
const SITE_LINK = process.env.BIGGY_SITE_LINK ?? "biggy.cc";

export function formatDailyFreePick(leg: PickLeg): string {
  const flags = flagsForMatch(leg.match);
  return `${flags} Biggy free pick for today

${leg.match}
→ ${leg.selection} @ ${leg.odds.toFixed(2)}

High-confidence leg from today's Hit card.
Full slips (Hit · Aim · Go Big) → ${BOT_LINK}`;
}

export function formatPickUpdate(version: number, changeNote: string): string {
  return `📋 Biggy card updated (v${version})

${changeNote}

Fresh lines on today's World Cup picks → ${BOT_LINK}`;
}

export function formatLegWin(leg: PickLeg, tier: PickTier, scoreLine?: string): string {
  const flags = flagsForMatch(leg.match);
  const score = scoreLine ? ` ${scoreLine}` : "";
  const tierLabel = tier === "go_big" ? "Go Big" : tier === "aim" ? "Aim" : "Hit";
  return `✅ Biggy called it

${flags} ${leg.match}${score}
→ ${leg.selection} @ ${leg.odds.toFixed(2)} ✅

${tierLabel} tier · Track record on ${SITE_LINK}
Get tomorrow's picks → ${BOT_LINK}`;
}

export function formatNewsHook(match: string, headline: string): string {
  const flags = flagsForMatch(match);
  const trimmed = headline.length > 100 ? `${headline.slice(0, 97)}…` : headline;
  return `${flags} ${match}

${trimmed}

Biggy already priced this into today's card → ${BOT_LINK}`;
}
