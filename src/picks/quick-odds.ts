import { runMigrations } from "../db/client.js";
import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  selectPicksFixtures,
} from "../txline/client.js";
import { persistPickBundle } from "./carry-forward.js";
import type { GenerateResult } from "./generate.js";
import { buildOddsFallbackBundle } from "./fallback.js";
import { validateBundleBettable } from "./kickoff.js";
import { loadStoredBatch } from "./store.js";
import {
  normalizePickBundle,
  validateDailyBundle,
  type DailyPicksBundle,
} from "./validate.js";

/** Fast odds-only card — no LLM, for thin fixture days or when carry-forward fails. */
export async function tryQuickOddsCard(
  pickDate: string
): Promise<GenerateResult | null> {
  if (await loadStoredBatch(pickDate)) return null;

  await runMigrations();

  const all = await fetchFixturesSnapshot();
  const upcoming = selectPicksFixtures(all);
  if (upcoming.length === 0) {
    console.log("[picks] Quick odds: no bettable fixtures");
    return null;
  }

  const bundles = [];
  for (const fixture of upcoming) {
    const odds = await fetchOddsForFixture(fixture.FixtureId, fixture);
    if (odds.length > 0) bundles.push({ fixture, odds });
  }

  if (bundles.length === 0) {
    console.log("[picks] Quick odds: fixtures found but no odds");
    return null;
  }

  let bundle: DailyPicksBundle;
  try {
    bundle = buildOddsFallbackBundle(
      bundles.map((b) => ({
        fixture: b.fixture,
        odds: b.odds,
        research: {
          match: fixtureLabel(b.fixture),
          injuriesAndSuspensions: [],
          headToHead: "",
          recentForm: [],
          keyNews: [],
          bettingAngle: "",
        },
        newsArticles: [],
        sources: [],
      }))
    );
  } catch (err) {
    console.warn("[picks] Quick odds build failed:", (err as Error).message ?? err);
    return null;
  }

  bundle = normalizePickBundle(bundle);
  const allowedMatches = bundles.map((b) => fixtureLabel(b.fixture));
  const errors = validateDailyBundle(bundle, {
    allowedMatches,
    skipCrossTier: true,
    oddsFallback: true,
  });
  if (errors.length > 0) {
    console.warn("[picks] Quick odds validation failed:", errors.join("; "));
    return null;
  }

  const bettableErr = await validateBundleBettable(bundle);
  if (bettableErr) {
    console.warn("[picks] Quick odds not bettable:", bettableErr);
    return null;
  }

  const changeNote = "Today's card — built from live TxLINE odds.";
  console.log(`[picks] Quick odds card for ${pickDate} (${upcoming.map(fixtureLabel).join(", ")})`);

  return persistPickBundle(pickDate, bundle, {
    version: 1,
    changeNote,
  });
}
