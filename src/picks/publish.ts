import { runMigrations } from "../db/client.js";
import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureKickoffMs,
  fixtureLabel,
  getFootballDataProvider,
  isBettableFixture,
  selectPicksFixtures,
  warmOddsForFixtures,
  type TxlineOddsEntry,
} from "../providers/football.js";
import { getApiFootballConfig } from "../api-football/config.js";
import { enrichBundleWithHeadlines } from "./analysis.js";
import {
  persistPickBundle,
  tryCarryForwardPicks,
  tryPrunedCarryForward,
} from "./carry-forward.js";
import type { GenerateResult } from "./generate.js";
import { buildOddsFallbackBundle, buildMinimalOddsBundle } from "./fallback.js";
import { validateBundleBettable } from "./kickoff.js";
import type { EnrichedMatch } from "./research.js";
import { getCachedPickContent, getPickMeta, loadStoredBatch } from "./store.js";
import type { PickTier } from "./types.js";
import {
  normalizePickBundle,
  validateDailyBundle,
  type DailyPicksBundle,
} from "./validate.js";

/** When live odds are thin/missing, reuse the last bettable stored card. */
async function publishFromCarryForward(
  pickDate: string
): Promise<GenerateResult | null> {
  const full = await tryCarryForwardPicks(pickDate);
  if (full) {
    console.log(`[publish] Carried full card onto ${pickDate}`);
    return full;
  }
  const pruned = await tryPrunedCarryForward(pickDate);
  if (pruned) {
    console.log(`[publish] Carried pruned card onto ${pickDate}`);
    return pruned;
  }
  return null;
}

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

/** Fixtures + RSS headlines + odds. API-Football uses date-batch (1–2 calls). */
async function loadPublishBundles(): Promise<MatchBundle[]> {
  const all = await fetchFixturesSnapshot();
  if (!all.length) return [];

  const afCfg =
    getFootballDataProvider() === "api-football"
      ? getApiFootballConfig()
      : null;

  // Warm date-batch odds only (cheap), then pick best boards — don't
  // re-fetch per-id for every upcoming fixture on publish.
  if (afCfg) {
    const nowMs = Date.now();
    // Prefer kickoffs ≥90m out so the card stays bettable after slow jobs.
    const minKick = nowMs + 90 * 60 * 1000;
    const candidates = all
      .filter(
        (f) => isBettableFixture(f, nowMs) && fixtureKickoffMs(f) >= minKick
      )
      .slice(0, afCfg.quotaMode === "free" ? 24 : 40);
    await warmOddsForFixtures(candidates);
  }

  let upcoming = selectPicksFixtures(all);
  if (!upcoming.length) return [];

  if (afCfg) {
    const nowMs = Date.now();
    const minKick = nowMs + 90 * 60 * 1000;
    upcoming = upcoming.filter((f) => fixtureKickoffMs(f) >= minKick);
    const max =
      afCfg.quotaMode === "free"
        ? Math.min(8, Math.max(afCfg.maxOddsFetches, 4))
        : Math.max(afCfg.maxOddsFetches, upcoming.length);
    if (upcoming.length > max) upcoming = upcoming.slice(0, max);
  }

  console.log(
    `[publish] ${upcoming.length} fixtures:`,
    upcoming.map((f) => fixtureLabel(f)).join(", ")
  );

  // Never block publish on Google RSS — free or paid. Enrich adds color later.
  const enriched: EnrichedMatch[] = upcoming.map((fixture) => ({
    fixture,
    research: {
      match: fixtureLabel(fixture),
      injuriesAndSuspensions: [],
      headToHead: "See live lines",
      recentForm: [],
      keyNews: [],
      bettingAngle: "Pre-match lines on upcoming kickoff",
    },
    newsArticles: [],
    sources: [],
  }));

  const bundles: Array<MatchBundle | null> = await Promise.all(
    enriched.map(async (match) => {
      const odds = await fetchOddsForFixture(match.fixture.FixtureId, match.fixture);
      return odds.length > 0 ? { ...match, odds } : null;
    })
  );

  const withOdds = bundles.filter((b): b is MatchBundle => b != null);
  console.log(
    `[publish] ${withOdds.length}/${upcoming.length} fixtures have cached odds`
  );
  return withOdds;
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
    console.log("[publish] No fixtures with odds — trying carry-forward");
    return publishFromCarryForward(pickDate);
  }

  let bundle: DailyPicksBundle;
  try {
    bundle = normalizePickBundle(buildPublishBundle(bundles));
  } catch (err) {
    console.warn("[publish] Bundle build failed — trying carry-forward:", err);
    return publishFromCarryForward(pickDate);
  }

  // Never ship an empty Biggy Breakdown — LLM enrich upgrades this later.
  bundle = enrichBundleWithHeadlines(bundles, bundle);

  const allowedMatches = bundles.map((b) => fixtureLabel(b.fixture));

  const errors = validateDailyBundle(bundle, {
    allowedMatches,
    skipCrossTier: true,
    oddsFallback: true,
  });
  if (errors.length > 0) {
    console.warn(
      "[publish] Validation failed — trying carry-forward:",
      errors.join("; ")
    );
    return publishFromCarryForward(pickDate);
  }

  const bettableErr = await validateBundleBettable(bundle);
  if (bettableErr) {
    console.warn("[publish] Not bettable — trying carry-forward:", bettableErr);
    return publishFromCarryForward(pickDate);
  }

  const changeNote = "Today's card — live TxLINE lines.";
  console.log(`[publish] Saving ${pickDate} from ${allowedMatches.join(", ")}`);

  return persistPickBundle(pickDate, bundle, { version: 1, changeNote });
}

export async function hasPublishedCard(pickDate: string): Promise<boolean> {
  return (await cachedPicks(pickDate)) != null;
}

/** Upcoming WC fixtures that currently have TxLINE odds. */
export async function fixturesWithLiveOdds(): Promise<string[]> {
  const bundles = await loadPublishBundles();
  return bundles.map((b) => fixtureLabel(b.fixture));
}

/** True when today's stored card already includes every priced upcoming fixture. */
export async function cardCoversAvailableOdds(pickDate: string): Promise<boolean> {
  const available = await fixturesWithLiveOdds();
  if (!available.length) return true;

  const stored = await loadStoredBatch(pickDate);
  if (!stored) return false;

  const onCard = new Set<string>();
  for (const tier of TIERS) {
    for (const leg of stored.picks[tier].legs) {
      onCard.add(leg.match);
    }
  }

  return available.every((match) => onCard.has(match));
}
