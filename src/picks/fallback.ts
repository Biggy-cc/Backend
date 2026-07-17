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

function hasTotalGoals(odds: TxlineOddsEntry[]) {
  return odds.some((o) => o.MarketType === "Total Goals");
}

function drawOdds(odds: TxlineOddsEntry[]) {
  return findOdd(odds, (o) => o.MarketType === "1X2" && o.Selection === "Draw");
}

/** Favorite Asian Handicap when Total Goals isn't on the feed (common on WC free tier). */
function favoriteHandicap(fixture: TxlineFixture, odds: TxlineOddsEntry[]) {
  const fav = favoriteWin(fixture, odds);
  const favTeam = fav ? parseWinner(fav.Selection) : null;
  const ahs = odds.filter((o) => {
    if (o.MarketType !== "Asian Handicap") return false;
    if (favTeam && o.Participant) {
      return o.Participant.toLowerCase() === favTeam;
    }
    return (o.Line ?? 0) <= 0;
  });
  if (!ahs.length) return undefined;
  const preferred = [-0.25, -0.5, 0, -0.75, -1];
  for (const line of preferred) {
    const hit = ahs.find((o) => o.Line === line);
    if (hit) return hit;
  }
  return ahs.reduce((a, b) => (a.StablePrice < b.StablePrice ? a : b));
}

/** Prefer Over 2.5; fall back to any Over line, then favorite AH. */
function secondaryMarket(fixture: TxlineFixture, odds: TxlineOddsEntry[]) {
  return (
    overGoals(odds, 2.5) ??
    overGoals(odds, 2.25) ??
    overGoals(odds, 3.0) ??
    allOverGoals(odds)[0] ??
    favoriteHandicap(fixture, odds)
  );
}

function isThinOddsBoard(bundles: Bundle[]): boolean {
  if (!bundles.length) return true;
  if (bundles.every((b) => !hasTotalGoals(b.odds))) return true;
  // Free-tier boards often publish Over 1.0 before Over 2.5 — still too thin for classic Hit.
  return bundles.every(
    (b) => !overGoals(b.odds, 2.5) && !overGoals(b.odds, 2.25) && !overGoals(b.odds, 2.0)
  );
}

/** Best available "favorite" signal — 1X2 first, else favorite-side AH. */
function favoriteLean(fixture: TxlineFixture, odds: TxlineOddsEntry[]) {
  return favoriteWin(fixture, odds) ?? favoriteHandicap(fixture, odds);
}

function leg(match: string, entry: TxlineOddsEntry) {
  return { match, selection: entry.Selection, odds: entry.StablePrice };
}

function pickBestHitLegs(bundle: Bundle): ReturnType<typeof leg>[] {
  const m = fixtureLabel(bundle.fixture);
  const thin = isThinOddsBoard([bundle]);
  const maxCombined = thin ? 2.85 : 2.05;
  const markets = bundle.odds.filter(
    (o) =>
      o.MarketType === "Total Goals" ||
      o.MarketType === "1X2" ||
      o.MarketType === "Asian Handicap"
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
      if (combined > maxCombined || combined < 1.25) continue;
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

  // Thin / partial WC board: single short price is better than no Hit tier.
  const short =
    allOverGoals(bundle.odds).find((o) => o.StablePrice <= 2.0) ??
    favoriteHandicap(bundle.fixture, bundle.odds) ??
    favoriteWin(bundle.fixture, bundle.odds);
  if (short && short.StablePrice >= 1.25 && short.StablePrice <= 2.05) {
    return [leg(m, short)];
  }

  throw new Error("Not enough odds to build Hit fallback");
}

function pickBestMultiMatchHit(withOdds: Bundle[]): ReturnType<typeof leg>[] {
  const thin = isThinOddsBoard(withOdds);
  const maxCombined = thin ? 2.85 : 2.05;

  const candidates: Array<{ bundle: Bundle; entry: TxlineOddsEntry }> = [];
  for (const bundle of withOdds) {
    for (const entry of allOverGoals(bundle.odds)) {
      if (entry.Line != null && entry.Line <= 2.5) {
        candidates.push({ bundle, entry });
      }
    }
    if (thin) {
      const lean = favoriteLean(bundle.fixture, bundle.odds);
      if (lean) candidates.push({ bundle, entry: lean });
    }
  }

  let best: ReturnType<typeof leg>[] | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[i].bundle.fixture.FixtureId === candidates[j].bundle.fixture.FixtureId) {
        continue;
      }
      const a = leg(fixtureLabel(candidates[i].bundle.fixture), candidates[i].entry);
      const b = leg(fixtureLabel(candidates[j].bundle.fixture), candidates[j].entry);
      if (validateLegsCompatible([a, b])) continue;
      const combined = productOdds([a, b]);
      if (combined > maxCombined || combined < 1.25) continue;
      const score = Math.abs(combined - 1.95);
      if (score < bestScore) {
        bestScore = score;
        best = [a, b];
      }
    }
  }

  if (best) return best;

  // Prefer the shortest single Over / favorite when two-leg Hit can't clear the cap.
  const shorts = withOdds
    .map((b) => {
      const entry =
        allOverGoals(b.odds).find((o) => o.StablePrice <= 2.0) ??
        favoriteLean(b.fixture, b.odds);
      return entry ? { bundle: b, entry } : null;
    })
    .filter((x): x is { bundle: Bundle; entry: TxlineOddsEntry } => x != null)
    .sort((a, b) => a.entry.StablePrice - b.entry.StablePrice);

  if (shorts.length >= 2) {
    const a = leg(fixtureLabel(shorts[0].bundle.fixture), shorts[0].entry);
    const b = leg(fixtureLabel(shorts[1].bundle.fixture), shorts[1].entry);
    if (!validateLegsCompatible([a, b]) && productOdds([a, b]) <= 3.2) {
      return [a, b];
    }
  }
  if (shorts[0] && shorts[0].entry.StablePrice <= 2.05) {
    return [leg(fixtureLabel(shorts[0].bundle.fixture), shorts[0].entry)];
  }

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
  for (const o of bundle.odds.filter((x) => x.MarketType === "Asian Handicap")) {
    // Skip heavily chalked favorite handicaps for Go Big variety
    if ((o.StablePrice ?? 0) >= 1.45) candidates.push(leg(m, o));
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
      // Thin board: 2-leg cross-match when 3-leg can't clear 9.5
      for (const a of pools[i]) {
        for (const b of pools[j]) {
          const legs = [a, b];
          if (validateDuplicateLegs(legs)) continue;
          if (validateLegsCompatible(legs)) continue;
          if (validateCorrelatedLegs(legs, "go_big")) continue;
          const combined = productOdds(legs);
          if (combined < 9.5 || combined > 115) continue;
          const s = scoreCombo(legs);
          if (s < bestScore) {
            bestScore = s;
            best = legs;
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
  const pWin = favoriteLean(bundle.fixture, bundle.odds);
  const pSecond =
    secondaryMarket(bundle.fixture, bundle.odds) ??
    underdogWin(bundle.fixture, bundle.odds) ??
    drawOdds(bundle.odds);

  if (!pWin) {
    throw new Error("Not enough odds to build fallback picks");
  }

  const hitLegs = pickBestHitLegs(bundle);

  let aimLegs: ReturnType<typeof leg>[];
  if (pSecond && pWin.Selection !== pSecond.Selection) {
    aimLegs = [leg(m, pWin), leg(m, pSecond)];
    if (validateLegsCompatible(aimLegs) || validateCorrelatedLegs(aimLegs, "aim")) {
      aimLegs = [leg(m, pWin)];
    }
  } else {
    aimLegs = [leg(m, pWin)];
  }

  let goBigLegs: ReturnType<typeof leg>[];
  try {
    goBigLegs = pickBestGoBigLegs([bundle]);
  } catch {
    try {
      goBigLegs = pickBestGoBigPair(bundle);
    } catch {
      // Last resort on extremely thin single-match boards
      const dog = underdogWin(bundle.fixture, bundle.odds);
      const draw = drawOdds(bundle.odds);
      const extras = [pSecond, dog, draw].filter(
        (e): e is TxlineOddsEntry => Boolean(e) && e!.Selection !== pWin.Selection
      );
      if (!extras.length) {
        throw new Error("Not enough odds to build fallback picks");
      }
      goBigLegs = [leg(m, pWin), leg(m, extras[0])];
    }
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

  const thin = isThinOddsBoard(withOdds);
  const pools = withOdds.map(collectCandidateLegs).filter((p) => p.length > 0);
  if (!pools.length) return null;

  const hitMax = thin ? 2.85 : 2.05;
  // Prefer a single short Hit when two-leg products can't stay under 2.0 (common without totals).
  let hitLegs = thin
    ? findTierCombo(pools, 1, 1, 1.3, 2.0, "hit")
    : null;
  if (!hitLegs) {
    hitLegs = findTierCombo(pools, 2, 2, 1.3, hitMax, "hit");
  }
  if (!hitLegs && thin) {
    hitLegs = findTierCombo(pools, 1, 1, 1.3, 2.05, "hit");
  }
  let aimLegs = findTierCombo(pools, 2, 3, 3.0, 10.0, "aim");
  if (!aimLegs && thin) {
    aimLegs = findTierCombo(pools, 1, 2, 1.5, 10.0, "aim");
  }
  let goBigLegs = findTierCombo(pools, 3, 4, 10.0, 120.0, "go_big");
  if (!goBigLegs) {
    goBigLegs = findTierCombo(pools, 2, 2, 9.5, 120.0, "go_big");
  }

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

  const pSecond = secondaryMarket(primary.fixture, primary.odds);
  const pWin = favoriteLean(primary.fixture, primary.odds);

  const secondary = withOdds.find((b) => b.fixture.FixtureId !== primary.fixture.FixtureId);
  if (!secondary) {
    return buildSingleMatchFallback(primary);
  }

  if (!pWin) {
    return buildSingleMatchFallback(primary);
  }

  let hitLegs: ReturnType<typeof leg>[];
  try {
    hitLegs = pickBestMultiMatchHit(withOdds);
  } catch {
    hitLegs = pickBestHitLegs(primary);
  }

  const secondaryWin = favoriteLean(secondary.fixture, secondary.odds);
  let aimLegs: ReturnType<typeof leg>[];
  if (isThinOddsBoard(withOdds) && secondaryWin) {
    // Thin / partial feed — Aim stacks the best lean from each priced fixture.
    aimLegs = [leg(m1, pWin), leg(fixtureLabel(secondary.fixture), secondaryWin)];
  } else if (pSecond) {
    aimLegs = [leg(m1, pWin), leg(m1, pSecond)];
    if (validateLegsCompatible(aimLegs) || validateCorrelatedLegs(aimLegs, "aim")) {
      aimLegs = secondaryWin
        ? [leg(m1, pWin), leg(fixtureLabel(secondary.fixture), secondaryWin)]
        : [leg(m1, pWin)];
    }
  } else if (secondaryWin) {
    aimLegs = [leg(m1, pWin), leg(fixtureLabel(secondary.fixture), secondaryWin)];
  } else {
    aimLegs = [leg(m1, pWin)];
  }

  const winnerLeanByMatch = new Map<string, string>();
  for (const l of aimLegs) {
    const w = parseWinner(l.selection) ?? parseAsianHandicapTeamFromSel(l.selection);
    if (w) winnerLeanByMatch.set(l.match, w);
  }
  let goBigLegs: ReturnType<typeof leg>[];
  try {
    goBigLegs = pickBestGoBigLegs(withOdds, winnerLeanByMatch);
  } catch {
    return buildSingleMatchFallback(primary);
  }

  const hit = {
    legs: hitLegs,
    combinedOdds: productOdds(hitLegs),
    breakdown:
      "Earlier games kicked off. Refreshed with the next upcoming fixtures. Low-risk overs on two separate matches.",
  };
  const aim = {
    legs: aimLegs,
    combinedOdds: productOdds(aimLegs),
    breakdown: hasTotalGoals(primary.odds)
      ? "Same-game value on the next kickoff: favorite to win paired with goals over the main total line."
      : "Both semis priced — favorites stacked from live 1X2 / AH lines (full totals not on the free feed yet).",
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
          ? pWin.Selection.replace(/\s+to\s+win$/i, "").replace(/\s+[+-]?\d+(?:\.\d+)?\s*AH$/i, "").trim()
          : favoriteLean(b.fixture, b.odds)?.Selection.replace(/\s+to\s+win$/i, "").replace(/\s+[+-]?\d+(?:\.\d+)?\s*AH$/i, "").trim() ??
            b.fixture.Participant1,
      goalsLean: "medium" as const,
      bttsLean: "neutral" as const,
    })),
    picks: { hit, aim, go_big: goBig },
  };
}

function parseAsianHandicapTeamFromSel(selection: string): string | null {
  const m = selection.match(/^(.+?)\s+[+-]?\d+(?:\.\d+)?\s*AH$/i);
  return m ? m[1].trim().toLowerCase() : null;
}

export { isQuotaError as isGeminiQuotaError } from "./llm.js";
