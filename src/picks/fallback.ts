import { fixtureLabel, type TxlineFixture } from "../txline/client.js";
import type { TxlineOddsEntry } from "../txline/client.js";
import type { EnrichedMatch } from "./research.js";
import type { DailyPicksBundle } from "./validate.js";
import {
  parseWinner,
  productOdds,
  validateCorrelatedLegs,
  validateDuplicateLegs,
  validateLegsCompatible,
} from "./validate.js";
import type { PickTier } from "./types.js";

type Bundle = EnrichedMatch & { odds: TxlineOddsEntry[] };

function findOdd(
  odds: TxlineOddsEntry[],
  pred: (o: TxlineOddsEntry) => boolean
): TxlineOddsEntry | undefined {
  return odds.find(pred);
}

function favoriteWin(fixture: TxlineFixture, odds: TxlineOddsEntry[]) {
  const wins = odds.filter(
    (o) => o.MarketType === "1X2" && o.Selection.endsWith("to Win")
  );
  if (!wins.length) return undefined;
  return wins.reduce((a, b) => (a.StablePrice < b.StablePrice ? a : b));
}

function overGoals(odds: TxlineOddsEntry[], line: number) {
  return findOdd(
    odds,
    (o) =>
      o.MarketType === "Total Goals" &&
      o.Line === line &&
      o.Selection.toLowerCase().startsWith("over")
  );
}

function allOverGoals(odds: TxlineOddsEntry[]) {
  return odds
    .filter(
      (o) =>
        o.MarketType === "Total Goals" &&
        o.Selection.toLowerCase().startsWith("over") &&
        o.Line != null
    )
    .sort((a, b) => (a.Line ?? 0) - (b.Line ?? 0));
}

function drawOdds(odds: TxlineOddsEntry[]) {
  return findOdd(odds, (o) => o.MarketType === "1X2" && o.Selection === "Draw");
}

function leg(match: string, entry: TxlineOddsEntry) {
  return { match, selection: entry.Selection, odds: entry.StablePrice };
}

function pickBestHitLegs(bundle: Bundle): ReturnType<typeof leg>[] {
  const m = fixtureLabel(bundle.fixture);
  const markets = bundle.odds.filter(
    (o) => o.MarketType === "Total Goals" || o.MarketType === "1X2"
  );

  let best: ReturnType<typeof leg>[] | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const a = leg(m, markets[i]);
      const b = leg(m, markets[j]);
      if (validateLegsCompatible([a, b])) continue;
      if (validateCorrelatedLegs([a, b])) continue;
      const combined = productOdds([a, b]);
      if (combined > 2.05 || combined < 1.25) continue;
      const bothOvers =
        a.selection.toLowerCase().startsWith("over") &&
        b.selection.toLowerCase().startsWith("over");
      const score = Math.abs(combined - 1.95) - (bothOvers ? 0.1 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = [a, b];
      }
    }
  }

  if (best) return best;

  const pOver175 = overGoals(bundle.odds, 1.75) ?? overGoals(bundle.odds, 1.5);
  const under = bundle.odds
    .filter(
      (o) =>
        o.MarketType === "Total Goals" &&
        o.Selection.toLowerCase().startsWith("under")
    )
    .sort((a, b) => a.StablePrice - b.StablePrice)[0];
  if (pOver175 && under) {
    return [leg(m, pOver175), leg(m, under)];
  }

  throw new Error("Not enough odds to build Hit fallback");
}

function pickBestMultiMatchHit(withOdds: Bundle[]): ReturnType<typeof leg>[] {
  const overs: Array<{ bundle: Bundle; entry: TxlineOddsEntry }> = [];
  for (const bundle of withOdds) {
    for (const entry of allOverGoals(bundle.odds)) {
      if (entry.Line != null && entry.Line <= 2.5) {
        overs.push({ bundle, entry });
      }
    }
  }

  let best: ReturnType<typeof leg>[] | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < overs.length; i++) {
    for (let j = i + 1; j < overs.length; j++) {
      if (overs[i].bundle.fixture.FixtureId === overs[j].bundle.fixture.FixtureId) {
        continue;
      }
      const a = leg(fixtureLabel(overs[i].bundle.fixture), overs[i].entry);
      const b = leg(fixtureLabel(overs[j].bundle.fixture), overs[j].entry);
      const combined = productOdds([a, b]);
      if (combined > 2.05 || combined < 1.25) continue;
      const score = Math.abs(combined - 1.95);
      if (score < bestScore) {
        bestScore = score;
        best = [a, b];
      }
    }
  }

  if (best) return best;
  throw new Error("No valid multi-match hit");
}

function underdogWin(fixture: TxlineFixture, odds: TxlineOddsEntry[]) {
  const wins = odds.filter(
    (o) => o.MarketType === "1X2" && o.Selection.endsWith("to Win")
  );
  if (!wins.length) return undefined;
  return wins.reduce((a, b) => (a.StablePrice > b.StablePrice ? a : b));
}

function collectGoBigCandidates(
  bundle: Bundle,
  winnerLeanByMatch?: Map<string, string>
): ReturnType<typeof leg>[] {
  const m = fixtureLabel(bundle.fixture);
  const candidates: ReturnType<typeof leg>[] = [];
  const fav = favoriteWin(bundle.fixture, bundle.odds);
  const dog = underdogWin(bundle.fixture, bundle.odds);
  const draw = drawOdds(bundle.odds);
  const lean = winnerLeanByMatch?.get(m)?.toLowerCase();

  if (fav) {
    const favTeam = parseWinner(fav.Selection);
    if (!lean || favTeam === lean) candidates.push(leg(m, fav));
  }
  if (dog && !lean) {
    candidates.push(leg(m, dog));
  }
  for (const o of allOverGoals(bundle.odds)) {
    if (o.Line != null && o.Line >= 1.5 && o.Line <= 3.5) {
      candidates.push(leg(m, o));
    }
  }
  if (draw) candidates.push(leg(m, draw));

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.match}|${c.selection}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickBestGoBigLegs(
  withOdds: Bundle[],
  winnerLeanByMatch?: Map<string, string>
): ReturnType<typeof leg>[] {
  const pools = withOdds.map((b) => collectGoBigCandidates(b, winnerLeanByMatch));
  let best: ReturnType<typeof leg>[] | null = null;
  let bestScore = Infinity;

  function scoreCombo(legs: ReturnType<typeof leg>[]): number {
    const combined = productOdds(legs);
    const distinctMatches = new Set(legs.map((l) => l.match)).size;
    const target = 28;
    return (
      Math.abs(combined - target) -
      distinctMatches * 4 -
      (legs.length >= 3 && distinctMatches >= 2 ? 3 : 0)
    );
  }

  function tryCombo(legs: ReturnType<typeof leg>[]) {
    if (legs.length < 3 || legs.length > 4) return;
    if (validateDuplicateLegs(legs)) return;
    if (validateLegsCompatible(legs)) return;
    if (validateCorrelatedLegs(legs, "go_big")) return;
    const combined = productOdds(legs);
    if (combined < 9.5 || combined > 115) return;
    const s = scoreCombo(legs);
    if (s < bestScore) {
      bestScore = s;
      best = legs;
    }
  }

  // Pick one leg from each of 3 different matches when possible
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      for (let k = j + 1; k < pools.length; k++) {
        for (const a of pools[i]) {
          for (const b of pools[j]) {
            for (const c of pools[k]) {
              tryCombo([a, b, c]);
            }
          }
        }
      }
    }
  }

  // Two-match combos (max 2 legs per match)
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      for (const a of pools[i]) {
        for (const b of pools[i]) {
          if (a.selection === b.selection) continue;
          for (const c of pools[j]) {
            tryCombo([a, b, c]);
          }
        }
      }
      for (const a of pools[i]) {
        for (const b of pools[j]) {
          for (const c of pools[j]) {
            if (b.selection === c.selection) continue;
            tryCombo([a, b, c]);
          }
        }
      }
    }
  }

  if (best) return best;
  throw new Error("Not enough distinct markets for Go Big fallback");
}

function pickBestGoBigPair(bundle: Bundle): ReturnType<typeof leg>[] {
  const candidates = collectGoBigCandidates(bundle);
  let best: ReturnType<typeof leg>[] | null = null;
  let bestCombined = 0;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const legs = [candidates[i], candidates[j]];
      if (validateDuplicateLegs(legs)) continue;
      if (validateLegsCompatible(legs)) continue;
      if (validateCorrelatedLegs(legs, "go_big")) continue;
      const combined = productOdds(legs);
      if (combined > bestCombined) {
        bestCombined = combined;
        best = legs;
      }
    }
  }

  if (best) return best;
  throw new Error("Not enough distinct markets for Go Big fallback");
}

function pickPrimaryBundle(withOdds: Bundle[]): Bundle {
  return withOdds.reduce((best, b) => {
    const score =
      (favoriteWin(b.fixture, b.odds) ? 10 : 0) +
      (overGoals(b.odds, 2.5) ? 5 : 0) +
      b.odds.length;
    const bestScore =
      (favoriteWin(best.fixture, best.odds) ? 10 : 0) +
      (overGoals(best.odds, 2.5) ? 5 : 0) +
      best.odds.length;
    return score > bestScore ? b : best;
  });
}

function buildSingleMatchFallback(bundle: Bundle): DailyPicksBundle {
  const m = fixtureLabel(bundle.fixture);
  const pWin = favoriteWin(bundle.fixture, bundle.odds);
  const pOver25 = overGoals(bundle.odds, 2.5) ?? overGoals(bundle.odds, 2.25);
  console.log("[fallback-debug] buildSingleMatchFallback for:", m, "pWin:", pWin?.Selection, "pOver25:", pOver25?.Selection, "raw odds:", JSON.stringify(bundle.odds));

  if (!pWin || !pOver25) {
    throw new Error("Not enough odds to build fallback picks");
  }

  const hitLegs = pickBestHitLegs(bundle);

  const aimLegs = [leg(m, pWin), leg(m, pOver25)];
  let goBigLegs: ReturnType<typeof leg>[];
  try {
    goBigLegs = pickBestGoBigLegs([bundle]);
  } catch {
    goBigLegs = pickBestGoBigPair(bundle);
  }

  const thesis = [
    {
      match: m,
      summary: `Pre-match focus on ${m}`,
      winnerLean: bundle.fixture.Participant1,
      goalsLean: "medium" as const,
      bttsLean: "neutral" as const,
    },
  ];

  const mk = (legs: ReturnType<typeof leg>[], breakdown: string) => ({
    legs,
    combinedOdds: productOdds(legs),
    breakdown,
  });

  return {
    dailyThesis: thesis,
    picks: {
      hit: mk(hitLegs, ""),
      aim: mk(aimLegs, ""),
      go_big: mk(goBigLegs, ""),
    },
  };
}

export function repairBundleLegs(
  bundle: DailyPicksBundle,
  bundles: Bundle[]
): DailyPicksBundle {
  const repaired: DailyPicksBundle = {
    dailyThesis: bundle.dailyThesis,
    picks: { hit: { ...bundle.picks.hit }, aim: { ...bundle.picks.aim }, go_big: { ...bundle.picks.go_big } },
  };

  for (const tier of ["hit", "aim", "go_big"] as const) {
    const pick = repaired.picks[tier];
    if (!validateDuplicateLegs(pick.legs)) continue;

    const matchName = pick.legs[0]?.match;
    const matchBundle = bundles.find((b) => fixtureLabel(b.fixture) === matchName);
    if (!matchBundle) continue;

    if (tier === "go_big") {
      try {
        const fixedLegs = pickBestGoBigLegs(bundles);
        repaired.picks[tier] = {
          ...pick,
          legs: fixedLegs,
          combinedOdds: productOdds(fixedLegs),
        };
        continue;
      } catch {
        // fall through to per-leg repair
      }
    }

    const seen = new Set<string>();
    const newLegs = pick.legs.map((l) => {
      const key = `${l.match.toLowerCase()}|${l.selection.toLowerCase()}`;
      seen.add(key);
      return l;
    });

    for (let i = newLegs.length - 1; i >= 0; i--) {
      const l = newLegs[i];
      const key = `${l.match.toLowerCase()}|${l.selection.toLowerCase()}`;
      const earlier = newLegs.findIndex(
        (x, idx) =>
          idx < i &&
          `${x.match.toLowerCase()}|${x.selection.toLowerCase()}` === key
      );
      if (earlier < 0) continue;

      const replacement =
        allOverGoals(matchBundle.odds).find(
          (o) =>
            !newLegs.some(
              (x) =>
                x.match === l.match &&
                x.selection.toLowerCase() === o.Selection.toLowerCase()
            )
        ) ?? drawOdds(matchBundle.odds);

      if (replacement) {
        newLegs[i] = leg(l.match, replacement);
      }
    }

    repaired.picks[tier] = {
      ...pick,
      legs: newLegs,
      combinedOdds: productOdds(newLegs),
    };
  }

  return repaired;
}

type SimpleLeg = ReturnType<typeof leg>;

function collectCandidateLegs(bundle: Bundle): SimpleLeg[] {
  const m = fixtureLabel(bundle.fixture);
  const out: SimpleLeg[] = [];
  const seen = new Set<string>();

  const add = (entry?: TxlineOddsEntry) => {
    if (!entry) return;
    const key = `${m}|${entry.Selection.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(leg(m, entry));
  };

  add(favoriteWin(bundle.fixture, bundle.odds));
  add(underdogWin(bundle.fixture, bundle.odds));
  add(drawOdds(bundle.odds));
  for (const o of allOverGoals(bundle.odds)) add(o);
  for (const o of bundle.odds.filter(
    (x) =>
      x.MarketType === "Total Goals" &&
      x.Selection.toLowerCase().startsWith("under")
  )) {
    add(o);
  }
  for (const o of bundle.odds.filter((x) => x.MarketType === "Asian Handicap")) {
    add(o);
  }

  return out;
}

function comboValid(legs: SimpleLeg[]): boolean {
  if (validateDuplicateLegs(legs)) return false;
  return validateLegsCompatible(legs) == null;
}

function findTierCombo(
  pools: SimpleLeg[][],
  legMin: number,
  legMax: number,
  combinedMin: number,
  combinedMax: number,
  tier?: PickTier
): SimpleLeg[] | null {
  const legs = pools.flat();
  if (legs.length < legMin) return null;

  let best: SimpleLeg[] | null = null;
  let bestScore = Infinity;
  const distinctMatchesAvailable = pools.length;

  function* choose(k: number, start: number, picked: SimpleLeg[]): Generator<SimpleLeg[]> {
    if (picked.length === k) {
      yield picked;
      return;
    }
    for (let i = start; i < legs.length; i++) {
      yield* choose(k, i + 1, [...picked, legs[i]]);
    }
  }

  for (let k = legMin; k <= Math.min(legMax, legs.length); k++) {
    for (const combo of choose(k, 0, [])) {
      if (!comboValid(combo)) continue;
      if (tier && validateCorrelatedLegs(combo, tier)) continue;

      const distinctMatches = new Set(combo.map((l) => l.match)).size;
      if (k >= 2 && distinctMatchesAvailable >= 2 && distinctMatches < 2) continue;
      if (tier === "go_big" && distinctMatchesAvailable >= 2 && distinctMatches < 2) continue;

      const combined = productOdds(combo);
      if (combined < combinedMin || combined > combinedMax) continue;

      const mid = (combinedMin + combinedMax) / 2;
      const score = Math.abs(combined - mid) - distinctMatches * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = combo;
      }
    }
  }

  return best;
}

/** Build a card from whatever markets TxLINE has — works with thin partial odds. */
export function buildMinimalOddsBundle(bundles: Bundle[]): DailyPicksBundle | null {
  const withOdds = bundles.filter((b) => b.odds.length > 0);
  if (!withOdds.length) return null;

  const pools = withOdds.map(collectCandidateLegs).filter((p) => p.length > 0);
  if (!pools.length) return null;

  const hitLegs = findTierCombo(pools, 2, 2, 1.3, 2.05, "hit");
  const aimLegs = findTierCombo(pools, 2, 3, 3.0, 10.0, "aim");
  const goBigLegs = findTierCombo(pools, 3, 4, 10.0, 120.0, "go_big");

  if (!hitLegs || !aimLegs || !goBigLegs) return null;

  const matches = [...new Set([...hitLegs, ...aimLegs, ...goBigLegs].map((l) => l.match))];

  return {
    dailyThesis: matches.map((match) => ({
      match,
      summary: `Pre-match lines from TxLINE for ${match}.`,
      winnerLean: match.split(" vs ")[0]?.trim() ?? match,
      goalsLean: "medium" as const,
      bttsLean: "neutral" as const,
    })),
    picks: {
      hit: { legs: hitLegs, combinedOdds: productOdds(hitLegs), breakdown: "" },
      aim: { legs: aimLegs, combinedOdds: productOdds(aimLegs), breakdown: "" },
      go_big: { legs: goBigLegs, combinedOdds: productOdds(goBigLegs), breakdown: "" },
    },
  };
}

export function buildOddsFallbackBundle(bundles: Bundle[]): DailyPicksBundle {
  const withOdds = bundles.filter((b) => b.odds.length > 0);
  console.log("[fallback-debug] withOdds count:", withOdds.length, "fixtures:", withOdds.map(b => `${fixtureLabel(b.fixture)} (odds: ${b.odds.length})`));
  if (withOdds.length === 0) {
    throw new Error("Not enough odds to build fallback picks");
  }

  const minimal = buildMinimalOddsBundle(withOdds);
  if (minimal) return minimal;

  if (withOdds.length === 1) {
    return buildSingleMatchFallback(withOdds[0]);
  }

  const primary = pickPrimaryBundle(withOdds);
  const m1 = fixtureLabel(primary.fixture);

  const pOver25 = overGoals(primary.odds, 2.5) ?? overGoals(primary.odds, 2.25);
  const pWin = favoriteWin(primary.fixture, primary.odds);

  const secondary = withOdds.find((b) => b.fixture.FixtureId !== primary.fixture.FixtureId);
  if (!secondary) {
    return buildSingleMatchFallback(primary);
  }

  if (!pWin || !pOver25) {
    return buildSingleMatchFallback(primary);
  }

  let hitLegs: ReturnType<typeof leg>[];
  try {
    hitLegs = pickBestMultiMatchHit(withOdds);
  } catch {
    hitLegs = pickBestHitLegs(primary);
  }
  const aimLegs = [leg(m1, pWin), leg(m1, pOver25)];
  const winnerLeanByMatch = new Map<string, string>();
  for (const l of aimLegs) {
    const w = parseWinner(l.selection);
    if (w) winnerLeanByMatch.set(l.match, w);
  }
  const goBigLegs = pickBestGoBigLegs(withOdds, winnerLeanByMatch);

  const hit = {
    legs: hitLegs,
    combinedOdds: productOdds(hitLegs),
    breakdown:
      "Earlier games kicked off. Refreshed with the next upcoming fixtures. Low-risk overs on two separate matches.",
  };
  const aim = {
    legs: aimLegs,
    combinedOdds: productOdds(aimLegs),
    breakdown:
      "Same-game value on the next kickoff: favorite to win paired with goals over the main total line.",
  };
  const goBig = {
    legs: goBigLegs,
    combinedOdds: productOdds(goBigLegs),
    breakdown: "",
  };

  return {
    dailyThesis: [primary, secondary].map((b) => ({
      match: fixtureLabel(b.fixture),
      summary: `Next bettable match. ${fixtureLabel(b.fixture)}`,
      winnerLean:
        b.fixture.FixtureId === primary.fixture.FixtureId
          ? pWin.Selection.replace(/\s+to\s+win$/i, "").trim()
          : favoriteWin(b.fixture, b.odds)?.Selection.replace(/\s+to\s+win$/i, "").trim() ??
            b.fixture.Participant1,
      goalsLean: "medium" as const,
      bttsLean: "neutral" as const,
    })),
    picks: { hit, aim, go_big: goBig },
  };
}

export { isQuotaError as isGeminiQuotaError } from "./llm.js";
