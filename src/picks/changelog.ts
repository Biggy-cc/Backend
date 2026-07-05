import type { PickTier } from "./types.js";
import type { DailyPicksBundle, MatchThesis } from "./validate.js";
import { generateTextLlm } from "./llm.js";

import type { StoredBatch } from "./store.js";

export type StoredPickBatch = StoredBatch;

function thesisFingerprint(thesis: MatchThesis[]): string {
  return JSON.stringify(
    thesis.map((t) => ({
      match: t.match,
      summary: t.summary,
      winnerLean: t.winnerLean,
      goalsLean: t.goalsLean,
      bttsLean: t.bttsLean,
    }))
  );
}

function picksFingerprint(picks: DailyPicksBundle["picks"]): string {
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  return JSON.stringify(
    tiers.map((t) => ({
      tier: t,
      legs: picks[t].legs.map((l) => ({
        match: l.match,
        selection: l.selection,
        odds: Math.round(l.odds * 100) / 100,
      })),
      combined: Math.round(picks[t].combinedOdds * 100) / 100,
    }))
  );
}

export function hasMeaningfulChange(
  previous: StoredPickBatch,
  next: DailyPicksBundle
): boolean {
  if (thesisFingerprint(previous.thesis) !== thesisFingerprint(next.dailyThesis)) {
    return true;
  }
  return picksFingerprint(previous.picks) !== picksFingerprint(next.picks);
}

export function summarizePickChanges(
  previous: StoredPickBatch,
  next: DailyPicksBundle
): string {
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  const prevMatches = new Set<string>();
  const nextMatches = new Set<string>();

  for (const tier of tiers) {
    for (const leg of previous.picks[tier].legs) {
      prevMatches.add(leg.match);
    }
    for (const leg of next.picks[tier].legs) {
      nextMatches.add(leg.match);
    }
  }

  const dropped = [...prevMatches].filter((m) => !nextMatches.has(m));
  const added = [...nextMatches].filter((m) => !prevMatches.has(m));

  if (dropped.length > 0 && added.length > 0) {
    return `Matches updated. Rolled off ${dropped.slice(0, 2).join(", ")}${dropped.length > 2 ? "…" : ""} and onto ${added.slice(0, 2).join(", ")}${added.length > 2 ? "…" : ""}.`;
  }
  if (added.length > 0) {
    return `Picks now include ${added.slice(0, 3).join(", ")}${added.length > 3 ? "…" : ""}.`;
  }
  if (dropped.length > 0) {
    return `Earlier kickoffs removed. Card focuses on ${[...nextMatches].slice(0, 3).join(", ")}.`;
  }
  return "Today's football picks are refreshed.";
}

export function summarizeOddsMoves(
  moves: Array<{ match: string; selection: string; from: number; to: number }>
): string {
  if (moves.length === 0) return "Lines refreshed.";
  const shortTeam = (match: string) => match.split(/\s+vs\s+/i)[0]?.trim() ?? match;
  if (moves.length === 1) {
    const m = moves[0]!;
    return `${shortTeam(m.match)} line moved (${m.from.toFixed(2)} → ${m.to.toFixed(2)}).`;
  }
  const parts = moves
    .slice(0, 3)
    .map((m) => `${shortTeam(m.match)} (${m.from.toFixed(2)} → ${m.to.toFixed(2)})`);
  return `${moves.length} lines moved — ${parts.join("; ")}.`;
}

export async function explainPickChanges(
  previous: StoredPickBatch,
  next: DailyPicksBundle
): Promise<string> {
  if (process.env.BIGGY_LLM_CHANGELOG !== "1") {
    return summarizePickChanges(previous, next);
  }

  const allowedMatches = [
    ...new Set(
      (["hit", "aim", "go_big"] as PickTier[]).flatMap((t) =>
        next.picks[t].legs.map((l) => l.match)
      )
    ),
  ];

  const prompt = `You are Biggy. Picks were updated because live data changed.

Allowed matches (ONLY reference these — never mention any other game):
${allowedMatches.join(", ")}

Previous picks summary:
${JSON.stringify(
  (["hit", "aim", "go_big"] as PickTier[]).map((t) => ({
    tier: t,
    legs: previous.picks[t].legs,
    combinedOdds: previous.picks[t].combinedOdds,
  })),
  null,
  2
)}

New picks summary:
${JSON.stringify(
  (["hit", "aim", "go_big"] as PickTier[]).map((t) => ({
    tier: t,
    legs: next.picks[t].legs,
    combinedOdds: next.picks[t].combinedOdds,
  })),
  null,
  2
)}

Write 2 short sentences for Telegram explaining WHAT changed in the legs and WHY (injuries, line move, news).
Plain text only — no markdown. Only mention matches from the allowed list.`;

  const { text } = await generateTextLlm(prompt);
  return text || summarizePickChanges(previous, next);
}
