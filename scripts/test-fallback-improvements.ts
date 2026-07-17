import "dotenv/config";
import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  selectPicksFixtures,
  type TxlineOddsEntry,
  type TxlineFixture,
} from "../src/txline/client.js";
import {
  researchMatchesLight,
  type EnrichedMatch
} from "../src/picks/research.js";
import {
  validateLegsCompatible,
  validateCorrelatedLegs,
  validateDuplicateLegs,
  productOdds,
  parseWinner,
  type DailyPicksBundle
} from "../src/picks/validate.js";
import type { PickTier } from "../src/picks/types.js";

type Bundle = EnrichedMatch & { odds: TxlineOddsEntry[] };

function leg(match: string, entry: TxlineOddsEntry) {
  return { match, selection: entry.Selection, odds: entry.StablePrice };
}

function favoriteWin(fixture: TxlineFixture, odds: TxlineOddsEntry[]) {
  const wins = odds.filter(
    (o) => o.MarketType === "1X2" && o.Selection.endsWith("to Win")
  );
  if (!wins.length) return undefined;
  return wins.reduce((a, b) => (a.StablePrice < b.StablePrice ? a : b));
}

function overGoals(odds: TxlineOddsEntry[], line: number) {
  return odds.find(
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
  return odds.find((o) => o.MarketType === "1X2" && o.Selection === "Draw");
}

function underdogWin(fixture: TxlineFixture, odds: TxlineOddsEntry[]) {
  const wins = odds.filter(
    (o) => o.MarketType === "1X2" && o.Selection.endsWith("to Win")
  );
  if (!wins.length) return undefined;
  return wins.reduce((a, b) => (a.StablePrice > b.StablePrice ? a : b));
}

// Improved functions:
function pickBestHitLegsImproved(bundle: Bundle): ReturnType<typeof leg>[] {
  const m = fixtureLabel(bundle.fixture);
  const markets = bundle.odds.filter(
    (o) => o.MarketType === "Total Goals" || o.MarketType === "1X2" || o.MarketType === "Asian Handicap"
  );

  let best: ReturnType<typeof leg>[] | null = null;
  let bestScore = Infinity;

  // Try tight range first
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const a = leg(m, markets[i]);
      const b = leg(m, markets[j]);
      if (validateLegsCompatible([a, b])) continue;
      if (validateCorrelatedLegs([a, b])) continue;
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

  // Try wider range as fallback
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const a = leg(m, markets[i]);
      const b = leg(m, markets[j]);
      if (validateLegsCompatible([a, b])) continue;
      if (validateCorrelatedLegs([a, b])) continue;
      const combined = productOdds([a, b]);
      if (combined > 2.50 || combined < 1.10) continue;
      const score = Math.abs(combined - 1.95);
      if (score < bestScore) {
        bestScore = score;
        best = [a, b];
      }
    }
  }

  if (best) return best;

  throw new Error("Not enough odds to build Hit fallback");
}

function collectGoBigCandidatesImproved(
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
    if (o.Line != null && o.Line >= 1.5 && o.Line <= 4.5) { // increased to 4.5
      candidates.push(leg(m, o));
    }
  }
  if (draw) candidates.push(leg(m, draw));

  // Add Asian Handicap candidates to enable Go Big same-game parlay fallbacks
  for (const o of bundle.odds) {
    if (o.MarketType === "Asian Handicap") {
      candidates.push(leg(m, o));
    }
  }

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.match}|${c.selection}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickBestGoBigPairImproved(bundle: Bundle): ReturnType<typeof leg>[] {
  const candidates = collectGoBigCandidatesImproved(bundle);
  let best: ReturnType<typeof leg>[] | null = null;
  let bestCombined = 0;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const legs = [candidates[i], candidates[j]];
      if (validateDuplicateLegs(legs)) continue;
      if (validateLegsCompatible(legs)) continue;
      if (validateCorrelatedLegs(legs, "go_big")) continue;
      const combined = productOdds(legs);
      if (combined > bestCombined && combined >= 10.0 && combined <= 120.0) { // added go_big bounds check
        bestCombined = combined;
        best = legs;
      }
    }
  }

  if (best) return best;
  throw new Error("Not enough distinct markets for Go Big fallback");
}

function buildSingleMatchFallbackImproved(bundle: Bundle): DailyPicksBundle {
  const m = fixtureLabel(bundle.fixture);
  const pWin = favoriteWin(bundle.fixture, bundle.odds);
  const pOver25 = overGoals(bundle.odds, 2.5) ??
                  overGoals(bundle.odds, 2.25) ??
                  overGoals(bundle.odds, 2.0) ??
                  overGoals(bundle.odds, 1.75) ??
                  overGoals(bundle.odds, 1.5) ??
                  allOverGoals(bundle.odds)[0];

  if (!pWin || !pOver25) {
    throw new Error("Not enough odds to build fallback picks");
  }

  const hitLegs = pickBestHitLegsImproved(bundle);
  const aimLegs = [leg(m, pWin), leg(m, pOver25)];
  let goBigLegs: ReturnType<typeof leg>[];
  try {
    goBigLegs = pickBestGoBigPairImproved(bundle);
  } catch (err) {
    console.log("pickBestGoBigPairImproved failed:", err);
    throw err;
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
      hit: mk(hitLegs, "Fallback Hit"),
      aim: mk(aimLegs, "Fallback Aim"),
      go_big: mk(goBigLegs, "Fallback Go Big"),
    },
  };
}

async function main() {
  const all = await fetchFixturesSnapshot();
  const upcoming = selectPicksFixtures(all);
  const enriched = await researchMatchesLight(upcoming);
  const bundles = await Promise.all(
    enriched.map(async (match) => {
      const odds = await fetchOddsForFixture(match.fixture.FixtureId, match.fixture);
      return odds.length > 0 ? { ...match, odds } : null;
    })
  );

  const withOdds = bundles.filter(b => b != null) as Bundle[];
  console.log("withOdds count:", withOdds.length);
  if (withOdds.length >= 1) {
    const primary = withOdds.reduce((best, b) => {
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
    console.log("Testing on primary match:", fixtureLabel(primary.fixture));
    const res = buildSingleMatchFallbackImproved(primary);
    console.log("Result Hit:", res.picks.hit);
    console.log("Result Aim:", res.picks.aim);
    console.log("Result Go Big:", res.picks.go_big);
  } else {
    console.log("No matches with odds");
  }
}

main().catch(console.error);
