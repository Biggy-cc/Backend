import type { GeneratedPick, PickTier } from "./types.js";
import { TIER_LIMITS } from "./types.js";

export const TIER_TARGETS: Record<
  PickTier,
  { min: number; max: number; maximizeHint: string }
> = {
  hit: {
    min: 1.3,
    max: 2.0,
    maximizeHint: "prioritize highest win probability, then edge odds upward within range",
  },
  aim: {
    min: 3.0,
    max: 10.0,
    maximizeHint: "balance probability and price; avoid longshots unless needed for range",
  },
  go_big: {
    min: 10.0,
    max: 120.0,
    maximizeHint: "still prioritize coherent, bettable edges before chasing extreme price",
  },
};

export type MatchThesis = {
  match: string;
  summary: string;
  winnerLean: string;
  goalsLean: "low" | "high" | "medium";
  bttsLean: "yes" | "no" | "neutral";
};

export type DailyPicksBundle = {
  dailyThesis: MatchThesis[];
  picks: Record<PickTier, Omit<GeneratedPick, "tier" | "sources">>;
};

type Leg = GeneratedPick["legs"][number];

function parseTotals(
  selection: string
): { type: "over" | "under"; line: number } | null {
  const over = selection.match(/over\s*(\d+(?:\.\d+)?)/i);
  if (over) return { type: "over", line: parseFloat(over[1]) };
  const under = selection.match(/under\s*(\d+(?:\.\d+)?)/i);
  if (under) return { type: "under", line: parseFloat(under[1]) };
  return null;
}

export function parseWinner(selection: string): string | null {
  const s = selection.toLowerCase();
  if (/\bto win\b/.test(s) || /\bwin\b/.test(s)) {
    const m = selection.match(/^(.+?)\s+to\s+win/i);
    if (m) return m[1].trim().toLowerCase();
  }
  return null;
}

/** Same match cannot back different outright winners across tiers. */
export function validateCrossTierWinners(bundle: DailyPicksBundle): string | null {
  const winnersByMatch = new Map<string, Set<string>>();
  const tiers: PickTier[] = ["hit", "aim", "go_big"];

  for (const tier of tiers) {
    for (const leg of bundle.picks[tier].legs) {
      const winner = parseWinner(leg.selection);
      if (!winner) continue;
      if (!winnersByMatch.has(leg.match)) winnersByMatch.set(leg.match, new Set());
      winnersByMatch.get(leg.match)!.add(winner);
    }
  }

  for (const [match, winners] of winnersByMatch) {
    if (winners.size > 1) {
      return `Cross-tier conflict on ${match}: conflicting winner picks (${[...winners].join(" vs ")})`;
    }
  }

  return null;
}

function parseBtts(selection: string): "yes" | "no" | null {
  const s = selection.toLowerCase();
  if (s.includes("both teams to score") || s.includes("btts")) {
    if (/\bno\b/.test(s)) return "no";
    if (/\byes\b/.test(s)) return "yes";
  }
  return null;
}

/** Two legs on the same match must not contradict. */
export function legsConflictOnMatch(a: Leg, b: Leg): string | null {
  if (a.match !== b.match) return null;

  const totA = parseTotals(a.selection);
  const totB = parseTotals(b.selection);
  if (totA && totB) {
    if (totA.type === "over" && totB.type === "under" && totA.line >= totB.line) {
      return `Conflicting totals on ${a.match}: ${a.selection} vs ${b.selection}`;
    }
    if (totB.type === "over" && totA.type === "under" && totB.line >= totA.line) {
      return `Conflicting totals on ${a.match}: ${a.selection} vs ${b.selection}`;
    }
  }

  const winA = parseWinner(a.selection);
  const winB = parseWinner(b.selection);
  if (winA && winB && winA !== winB) {
    return `Conflicting winners on ${a.match}`;
  }

  const bttsA = parseBtts(a.selection);
  const bttsB = parseBtts(b.selection);
  if (bttsA && bttsB && bttsA !== bttsB) {
    return `Conflicting BTTS on ${a.match}`;
  }

  return null;
}

export function validateDuplicateLegs(legs: Leg[]): string | null {
  const seen = new Set<string>();
  for (const l of legs) {
    const key = `${l.match.toLowerCase()}|${l.selection.toLowerCase()}`;
    if (seen.has(key)) {
      return `Duplicate leg: ${l.selection} on ${l.match}`;
    }
    seen.add(key);
  }
  return null;
}

export function validateCorrelatedLegs(
  legs: Leg[],
  tier?: PickTier
): string | null {
  const byMatch = new Map<string, Leg[]>();
  for (const l of legs) {
    if (!byMatch.has(l.match)) byMatch.set(l.match, []);
    byMatch.get(l.match)!.push(l);
  }

  for (const [match, matchLegs] of byMatch) {
    let overCount = 0;
    for (const l of matchLegs) {
      const tot = parseTotals(l.selection);
      if (tot?.type === "over") overCount++;
    }
    if (overCount >= 2) {
      return `Redundant nested overs on ${match} — pick one total line per match`;
    }
  }

  if (tier === "go_big") {
    for (const [, matchLegs] of byMatch) {
      if (matchLegs.length > 2) {
        return `go_big: max 2 legs per match`;
      }
    }
  }

  return null;
}

export function validateLegsCompatible(legs: Leg[]): string | null {
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const conflict = legsConflictOnMatch(legs[i], legs[j]);
      if (conflict) return conflict;
    }
  }
  return null;
}

export function productOdds(legs: Leg[]): number {
  const raw = legs.reduce((acc, leg) => acc * leg.odds, 1);
  return Math.round(raw * 100) / 100;
}

export function sanitizeBreakdown(text: string): string {
  return text.replace(/\d+\.\d{3,}/g, (n) => {
    const v = parseFloat(n);
    return Number.isFinite(v) ? v.toFixed(2) : n;
  });
}

const META_TIER_SENTENCE =
  /^(the\s+)?['"]?(hit|aim|go\s*big)['"]?\s+tier\b|^this\s+['"]?(hit|aim|go\s*big)['"]?\s+tier\b|\btier\s+(elevates|is designed|is characterized|presents|steps up)\b|\btargeting a (higher|substantial) payout\b|\brisk profile\b|\bwhile still leaning on favorites\b|\bconservative pre-match card\b|\bvalue-focused combo\b|\bhigher-odds parlay\b|\bcombined odds of [\d.]+\s+reflect\b|\bleaning on favorites with strong form\b/i;

export function hasMetaTierProse(text: string): boolean {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 8);
  return sentences.some((s) => META_TIER_SENTENCE.test(s.trim()));
}

/** Drop generic tier-label intros; keep match-specific analysis. */
export function stripMetaTierProse(text: string): string {
  let cleaned = sanitizeBreakdown(text.trim());
  if (!cleaned) return cleaned;

  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.filter((s) => !META_TIER_SENTENCE.test(s.trim()));

  if (kept.length === 0) return cleaned;
  return kept.join(" ").trim();
}

export function normalizePickBundle(bundle: DailyPicksBundle): DailyPicksBundle {
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  const picks = {} as DailyPicksBundle["picks"];
  for (const tier of tiers) {
    const pick = bundle.picks[tier];
    picks[tier] = {
      ...pick,
      combinedOdds: productOdds(pick.legs),
      breakdown: stripMetaTierProse(pick.breakdown),
    };
  }
  return { dailyThesis: bundle.dailyThesis, picks };
}

export function validatePick(
  pick: Omit<GeneratedPick, "tier" | "sources">,
  tier: PickTier
): string | null {
  const target = TIER_TARGETS[tier];
  const cap = TIER_LIMITS[tier];

  if (pick.legs.length < 2 || pick.legs.length > 4) {
    return `${tier}: need 2–4 legs, got ${pick.legs.length}`;
  }

  const legConflict = validateLegsCompatible(pick.legs);
  if (legConflict) return `${tier}: ${legConflict}`;

  const dupe = validateDuplicateLegs(pick.legs);
  if (dupe) return `${tier}: ${dupe}`;

  const correlated = validateCorrelatedLegs(pick.legs, tier);
  if (correlated) return `${tier}: ${correlated}`;

  const computed = productOdds(pick.legs);
  if (computed > cap + 0.05) {
    return `${tier}: combined ${computed.toFixed(2)} exceeds cap ${cap}`;
  }
  if (computed < target.min - 0.1) {
    return `${tier}: combined ${computed.toFixed(2)} below tier minimum ${target.min}`;
  }

  if (Math.abs(computed - pick.combinedOdds) > 0.15) {
    return `${tier}: stated odds ${pick.combinedOdds} don't match legs (${computed.toFixed(2)})`;
  }

  return null;
}

export function validateLegsFromPool(
  bundle: DailyPicksBundle,
  allowedMatches: Iterable<string>
): string[] {
  const errors: string[] = [];
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  const allowed = new Set(
    [...allowedMatches].map((m) => m.toLowerCase().replace(/\s+/g, " ").trim())
  );

  for (const tier of tiers) {
    for (const leg of bundle.picks[tier].legs) {
      const key = leg.match.toLowerCase().replace(/\s+/g, " ").trim();
      if (!allowed.has(key)) {
        errors.push(`${tier}: leg on ${leg.match} not in current odds pool`);
      }
    }
  }

  return errors;
}

export function validateDailyBundle(
  bundle: DailyPicksBundle,
  options?: {
    skipCrossTier?: boolean;
    oddsFallback?: boolean;
    allowedMatches?: Iterable<string>;
  }
): string[] {
  const errors: string[] = [];
  const tiers: PickTier[] = ["hit", "aim", "go_big"];

  if (!bundle.dailyThesis?.length) {
    errors.push("missing dailyThesis");
  }

  if (options?.allowedMatches) {
    errors.push(...validateLegsFromPool(bundle, options.allowedMatches));
  }

  for (const tier of tiers) {
    const pick = bundle.picks[tier];
    if (!pick) {
      errors.push(`${tier}: missing`);
      continue;
    }
    const err = validatePick(pick, tier);
    if (err) {
      if (options?.oddsFallback && err.includes("below tier minimum")) {
        continue;
      }
      errors.push(err);
    }
  }

  if (!options?.skipCrossTier) {
    const winnerConflict = validateCrossTierWinners(bundle);
    if (winnerConflict) errors.push(winnerConflict);
  }

  // Cross-tier: same match must not flip goals lean (under vs over 3.5 style)
  if (!options?.skipCrossTier) {
    const goalsByMatch = new Map<string, Set<"low" | "high">>();
    for (const tier of tiers) {
      const pick = bundle.picks[tier];
      if (!pick) continue;
      for (const leg of pick.legs) {
        const tot = parseTotals(leg.selection);
        if (!tot) continue;
        const lean =
          tot.type === "under" && tot.line <= 3.5
            ? "low"
            : tot.type === "over" && tot.line >= 2.5
              ? "high"
              : null;
        if (!lean) continue;
        if (!goalsByMatch.has(leg.match)) goalsByMatch.set(leg.match, new Set());
        goalsByMatch.get(leg.match)!.add(lean);
      }
    }
    for (const [match, leans] of goalsByMatch) {
      if (leans.has("low") && leans.has("high")) {
        errors.push(`Cross-tier conflict on ${match}: low-scoring vs high-scoring picks`);
      }
    }
  }

  return errors;
}
