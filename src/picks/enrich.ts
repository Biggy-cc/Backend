import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  selectPicksFixtures,
  type TxlineOddsEntry,
} from "../txline/client.js";
import { bundleHasThinBreakdowns, enrichBundleWithGeminiAnalysis } from "./analysis.js";
import type { GenerateResult } from "./generate.js";
import { researchMatches, type EnrichedMatch } from "./research.js";
import {
  archiveCurrentPicks,
  loadStoredBatch,
  saveFullPickBundle,
} from "./store.js";
import { formatPickSlip, type GeneratedPick, type PickTier } from "./types.js";
import type { DailyPicksBundle } from "./validate.js";

const TIERS: PickTier[] = ["hit", "aim", "go_big"];

type MatchBundle = EnrichedMatch & { odds: TxlineOddsEntry[] };

async function loadEnrichBundles(batch: DailyPicksBundle): Promise<MatchBundle[]> {
  const usedMatches = new Set<string>();
  for (const tier of TIERS) {
    for (const leg of batch.picks[tier].legs) usedMatches.add(leg.match);
  }

  const all = await fetchFixturesSnapshot();
  const upcoming = selectPicksFixtures(all).filter((f) =>
    usedMatches.has(fixtureLabel(f))
  );

  if (!upcoming.length) return [];

  console.log(`[enrich] Grounded research for ${upcoming.length} matches…`);
  const enriched = await researchMatches(upcoming);

  const bundles = await Promise.all(
    enriched.map(async (match) => {
      const odds = await fetchOddsForFixture(match.fixture.FixtureId, match.fixture);
      return odds.length > 0 ? { ...match, odds } : null;
    })
  );

  return bundles.filter((b): b is MatchBundle => b != null);
}

/**
 * Phase 2 — LLM analysis in background (~30–90s).
 * Legs stay locked; only breakdowns and thesis get upgraded.
 */
export async function enrichDailyCard(pickDate: string): Promise<GenerateResult | null> {
  const stored = await loadStoredBatch(pickDate);
  if (!stored) return null;

  const bundle: DailyPicksBundle = {
    dailyThesis: stored.thesis,
    picks: stored.picks,
  };

  if (!bundleHasThinBreakdowns(bundle)) {
    console.log(`[enrich] ${pickDate} v${stored.version} already has analysis`);
    return null;
  }

  const matchBundles = await loadEnrichBundles(bundle);
  if (!matchBundles.length) {
    console.warn("[enrich] No match bundles for analysis");
    return null;
  }

  let enriched: DailyPicksBundle;
  try {
    enriched = await enrichBundleWithGeminiAnalysis(matchBundles, bundle);
  } catch (err) {
    console.error("[enrich] LLM analysis failed:", err);
    return null;
  }

  const version = stored.version + 1;
  const changeNote = "Breakdown updated with match research.";
  await archiveCurrentPicks(pickDate, stored.version);

  const output: Record<PickTier, string> = { hit: "", aim: "", go_big: "" };
  const tierContents: Array<{ tier: PickTier; content: string }> = [];

  for (const tier of TIERS) {
    const raw = enriched.picks[tier];
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
    enriched.dailyThesis,
    enriched.picks,
    changeNote
  );

  console.log(`[enrich] ${pickDate} → v${version}`);
  return { picks: output, version, updated: true, changeNote };
}
