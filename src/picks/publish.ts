import { runMigrations } from "../db/client.js";
import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  selectPicksFixtures,
  type TxlineOddsEntry,
} from "../txline/client.js";
import { persistPickBundle } from "./carry-forward.js";
import type { GenerateResult } from "./generate.js";
import { buildOddsFallbackBundle, buildMinimalOddsBundle } from "./fallback.js";
import { validateBundleBettable } from "./kickoff.js";
import { researchMatchesLight, type EnrichedMatch } from "./research.js";
import { getCachedPickContent, getPickMeta, loadStoredBatch } from "./store.js";
import type { PickTier } from "./types.js";
import {
  normalizePickBundle,
  validateDailyBundle,
  type DailyPicksBundle,
} from "./validate.js";

type MatchBundle = EnrichedMatch & { odds: TxlineOddsEntry[] };

const TIERS: PickTier[] = ["hit", "aim", "go_big"];

async function cachedPicks(pickDate: string): Promise<Record<PickTier, string> | null> {
  const entries = await Promise.all(
    TIERS.map(async (t) => [t, await getCachedPickContent(pickDate, t)] as const)
  );
  const picks = Object.fromEntries(entries) as Record<PickTier, string | null>;
  if (TIERS.every((t) => picks[t])) return picks as Record<PickTier, string>;
  return null;
}

/** Fixtures + RSS headlines + parallel odds. No LLM, no Google Search grounding. */
async function loadPublishBundles(): Promise<MatchBundle[]> {
  const all = await fetchFixturesSnapshot();
  const upcoming = selectPicksFixtures(all);
  if (!upcoming.length) return [];

  console.log(
    `[publish] ${upcoming.length} fixtures:`,
    upcoming.map((f) => fixtureLabel(f)).join(", ")
  );

  const enriched = await researchMatchesLight(upcoming);

  const bundles = await Promise.all(
    enriched.map(async (match) => {
      const odds = await fetchOddsForFixture(match.fixture.FixtureId, match.fixture);
      return odds.length > 0 ? { ...match, odds } : null;
    })
  );

  return bundles.filter((b): b is MatchBundle => b != null);
}

function buildPublishBundle(bundles: MatchBundle[]): DailyPicksBundle {
  const minimal = buildMinimalOddsBundle(bundles);
  if (minimal) return minimal;
  return buildOddsFallbackBundle(bundles);
}

/**
 * Phase 1 — publish a bettable card from TxLINE odds (~5s).
 * No LLM. Saves to D1 immediately so the bot can serve on read.
 */
export async function publishDailyCard(
  pickDate: string,
  options?: { force?: boolean }
): Promise<GenerateResult | null> {
  if (!options?.force) {
    const cached = await cachedPicks(pickDate);
    const stored = await loadStoredBatch(pickDate);
    if (cached && stored) {
      const bettableErr = await validateBundleBettable({
        dailyThesis: stored.thesis,
        picks: stored.picks,
      });
      if (!bettableErr) {
        const meta = await getPickMeta(pickDate);
        return {
          picks: cached,
          version: meta?.version ?? 1,
          updated: false,
          changeNote: meta?.changeNote ?? null,
        };
      }
    }
  }

  await runMigrations();
  const bundles = await loadPublishBundles();
  if (!bundles.length) {
    console.log("[publish] No fixtures with odds");
    return null;
  }

  const bundle = normalizePickBundle(buildPublishBundle(bundles));
  const allowedMatches = bundles.map((b) => fixtureLabel(b.fixture));

  const errors = validateDailyBundle(bundle, {
    allowedMatches,
    skipCrossTier: true,
    oddsFallback: true,
  });
  if (errors.length > 0) {
    console.warn("[publish] Validation failed:", errors.join("; "));
    return null;
  }

  const bettableErr = await validateBundleBettable(bundle);
  if (bettableErr) {
    console.warn("[publish] Not bettable:", bettableErr);
    return null;
  }

  const changeNote = "Today's card — live TxLINE lines.";
  console.log(`[publish] Saving ${pickDate} from ${allowedMatches.join(", ")}`);

  return persistPickBundle(pickDate, bundle, { version: 1, changeNote });
}

export async function hasPublishedCard(pickDate: string): Promise<boolean> {
  return (await cachedPicks(pickDate)) != null;
}
