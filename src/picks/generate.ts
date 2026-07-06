import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureKickoffMs,
  fixtureLabel,
  selectPicksFixtures,
  type TxlineOddsEntry,
} from "../txline/client.js";
import { generateJsonLlm } from "./llm.js";
import { researchMatches, researchMatchesLight, type EnrichedMatch } from "./research.js";
import {
  type GeneratedPick,
  type PickTier,
  formatPickSlip,
  stripSourcesFromSlipHtml,
} from "./types.js";
import {
  type DailyPicksBundle,
  TIER_TARGETS,
  normalizePickBundle,
  validateDailyBundle,
} from "./validate.js";
import {
  explainPickChanges,
  hasMeaningfulChange,
  type StoredPickBatch,
} from "./changelog.js";
import {
  archiveCurrentPicks,
  getCachedPickContent,
  getPickMeta,
  loadStoredBatch,
  saveBatchSnapshot,
  savePickBatch,
} from "./store.js";
import { runMigrations } from "../db/client.js";
import { picksStaleDueToKickoff, validateBundleBettable } from "./kickoff.js";
import { isQuotaError } from "./llm.js";
import { buildOddsFallbackBundle, repairBundleLegs } from "./fallback.js";
import {
  bundleHasThinBreakdowns,
  cachedHasBadGoBigLegs,
  cachedHasDefectiveSlips,
  cachedHasDuplicateLegs,
  cachedHasPlaceholderAnalysis,
  cachedHasThinBreakdowns,
  cleanSlipBreakdownHtml,
  enrichBundleWithGeminiAnalysis,
  enrichBundleWithHeadlines,
  parseBundleFromCachedSlips,
} from "./analysis.js";

type MatchBundle = EnrichedMatch & {
  odds: TxlineOddsEntry[];
};

export type GenerateResult = {
  picks: Record<PickTier, string>;
  version: number;
  updated: boolean;
  changeNote: string | null;
  /** Set when refresh came from odds-only path (no LLM regen). */
  refreshKind?: "odds" | "full";
};

let generationInFlight: Promise<GenerateResult> | null = null;
let generationKey: string | null = null;

export function isPickGenerationInFlight(): boolean {
  return generationInFlight != null;
}

export function pickGenerationDate(): string | null {
  return generationKey;
}

async function loadMatchBundles(): Promise<MatchBundle[]> {
  const all = await fetchFixturesSnapshot();
  const upcoming = selectPicksFixtures(all);

  if (upcoming.length === 0) return [];

  console.log(
    `[picks] ${upcoming.length} upcoming fixtures:`,
    upcoming
      .map(
        (f) =>
          `${fixtureLabel(f)} @ ${new Date(fixtureKickoffMs(f)).toISOString()}`
      )
      .join(" | ")
  );

  console.log(`[picks] Researching ${upcoming.length} matches (Google Search grounding)…`);
  let enriched: EnrichedMatch[];
  try {
    enriched = await researchMatches(upcoming);
  } catch (err) {
    if (isQuotaError(err)) {
      console.warn("[picks] Gemini research quota hit — using headlines-only research");
      enriched = await researchMatchesLight(upcoming);
    } else {
      throw err;
    }
  }

  const bundles: MatchBundle[] = [];
  for (const match of enriched) {
    const odds = await fetchOddsForFixture(match.fixture.FixtureId, match.fixture);
    if (odds.length > 0) {
      bundles.push({ ...match, odds });
    }
  }
  return bundles;
}

function buildUnifiedPrompt(bundles: MatchBundle[], retryErrors?: string[]): string {
  const matchData = bundles.map(({ fixture, odds, research, newsArticles }) => ({
    match: `${fixture.Participant1} vs ${fixture.Participant2}`,
    competition: fixture.Competition,
    kickoff: new Date(fixtureKickoffMs(fixture)).toISOString(),
    research: {
      injuries: research.injuriesAndSuspensions,
      headToHead: research.headToHead,
      form: research.recentForm,
      news: research.keyNews,
      angle: research.bettingAngle,
    },
    headlines: newsArticles.map((a) => ({ title: a.title, url: a.url })),
    markets: odds.slice(0, 35).map((o) => ({
      market: o.MarketType,
      period: o.MarketPeriod,
      selection: o.Selection,
      line: o.Line,
      odds: o.StablePrice,
    })),
  }));

  const tierRules = (["hit", "aim", "go_big"] as PickTier[])
    .map(
      (t) =>
        `- ${t}: combined odds ${TIER_TARGETS[t].min}–${TIER_TARGETS[t].max} (max ${TIER_TARGETS[t].max}), ${TIER_TARGETS[t].maximizeHint}`
    )
    .join("\n");

  const retryBlock = retryErrors?.length
    ? `\n\nFIX THESE ERRORS FROM LAST ATTEMPT:\n${retryErrors.map((e) => `- ${e}`).join("\n")}`
    : "";

  return `You are Biggy. Football picks, not generic sports tips.

Produce ONE locked daily card for ALL users. All tiers must share the same match theses — never contradict (no Under 3.5 on a match in one tier and Over 3.5 in another).

All matches in the data are UPCOMING pre-match only — never reference games that have kicked off.

STEP 1 — dailyThesis: one object per match with a single coherent view (winner, goals lean, BTTS lean).

STEP 2 — picks for hit, aim, go_big:
- 2–4 legs each; use REAL odds from the market data (decimal).
- Legs may be MULTI-MATCH (different games) OR SAME-GAME PARLAY (2 markets max on one match).
- go_big MUST spread across at least 2 matches when 2+ games are available — never stack Win + Over 2.5 + Over 3.5 on one game.
- Never put two Over/Under totals on the same match (nested overs are invalid).
- PRIMARY OBJECTIVE: maximize chance of winning for users (higher implied probability, stronger team/news edge, lower variance).
- SECONDARY OBJECTIVE: only increase combined odds when it does not materially reduce win probability.
- Every tier must align with dailyThesis for each match used.
- NEVER flip outright winner on the same match across tiers (if Aim backs Team A to win, Go Big cannot back Team B to win on that match).
- combinedOdds = product of leg odds (verify your math).
- Leave all breakdown fields as empty strings (analysis is written separately).

Tier bands:
${tierRules}

Return ONLY JSON:
{
  "dailyThesis": [
    {
      "match": "Team A vs Team B",
      "summary": "One sentence prediction",
      "winnerLean": "Team A",
      "goalsLean": "low|high|medium",
      "bttsLean": "yes|no|neutral"
    }
  ],
  "picks": {
    "hit": { "legs": [], "combinedOdds": 0, "breakdown": "" },
    "aim": { "legs": [], "combinedOdds": 0, "breakdown": "" },
    "go_big": { "legs": [], "combinedOdds": 0, "breakdown": "" }
  }
}

Match data:
${JSON.stringify(matchData, null, 2)}${retryBlock}`;
}

async function generateUnifiedBundle(
  bundles: MatchBundle[],
  retryErrors?: string[]
): Promise<DailyPicksBundle> {
  const { result } = await generateJsonLlm<DailyPicksBundle>(
    buildUnifiedPrompt(bundles, retryErrors)
  );
  return result;
}

async function cachedPicks(pickDate: string): Promise<Record<PickTier, string> | null> {
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  const entries = await Promise.all(
    tiers.map(async (t) => [t, await getCachedPickContent(pickDate, t)] as const)
  );
  const picks = Object.fromEntries(entries) as Record<PickTier, string | null>;
  if (tiers.every((t) => picks[t])) {
    return picks as Record<PickTier, string>;
  }
  return null;
}

export async function ensurePicksForToday(): Promise<void> {
  const pickDate = todayPickDate();
  const cached = await cachedPicks(pickDate);
  if (!cached) {
    await generateDailyPicks(pickDate);
    return;
  }
  const kickoffStale = await picksStaleDueToKickoff(pickDate);
  const needsRefresh = kickoffStale || (await cachedHasDefectiveSlips(pickDate));
  if (needsRefresh) {
    await generateDailyPicks(pickDate, { kickoffRefresh: kickoffStale });
  }
}

export async function generateDailyPicks(
  pickDate: string,
  options?: { force?: boolean; onlyIfChanged?: boolean; kickoffRefresh?: boolean }
): Promise<GenerateResult> {
  if (generationInFlight) {
    console.log("[picks] Generation already in progress — waiting for cache…");
    await generationInFlight.catch(() => undefined);
    const cached = await cachedPicks(pickDate);
    const meta = await getPickMeta(pickDate);
    if (cached) {
      return {
        picks: cached,
        version: meta?.version ?? 1,
        updated: false,
        changeNote: meta?.changeNote ?? null,
      };
    }
  }

  const task = generateDailyPicksInner(pickDate, options);
  generationInFlight = task;
  generationKey = pickDate;
  try {
    return await task;
  } finally {
    if (generationInFlight === task) {
      generationInFlight = null;
      generationKey = null;
    }
  }
}

async function generateDailyPicksInner(
  pickDate: string,
  options?: { force?: boolean; onlyIfChanged?: boolean; kickoffRefresh?: boolean }
): Promise<GenerateResult> {
  await runMigrations();
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  const previous = await loadStoredBatch(pickDate);
  const kickoffStale =
    options?.kickoffRefresh || (await picksStaleDueToKickoff(pickDate));
  const placeholderAnalysis = await cachedHasPlaceholderAnalysis(pickDate);
  const duplicateLegs = await cachedHasDuplicateLegs(pickDate);
  const badGoBig = await cachedHasBadGoBigLegs(pickDate);
  const thinBreakdowns = await cachedHasThinBreakdowns(pickDate);
  const defectiveSlips =
    placeholderAnalysis || duplicateLegs || badGoBig || thinBreakdowns;

  if (
    !options?.force &&
    !options?.onlyIfChanged &&
    !kickoffStale &&
    !defectiveSlips &&
    process.env.FORCE_PICKS !== "1"
  ) {
    const cached = await cachedPicks(pickDate);
    if (cached) {
      const meta = await getPickMeta(pickDate);
      console.log(`[picks] Cached v${meta?.version ?? 1} for ${pickDate} — skipping`);
      return {
        picks: cached,
        version: meta?.version ?? 1,
        updated: false,
        changeNote: meta?.changeNote ?? null,
      };
    }
  }

  if (kickoffStale) {
    console.log(`[picks] Started matches on card — refreshing with next upcoming fixtures`);
  }
  if (placeholderAnalysis) {
    console.log(`[picks] Cached card has placeholder analysis — regenerating with Gemini`);
  }

  if (duplicateLegs) {
    console.log("[picks] Cached card has duplicate legs — rebuilding slips");
  }
  if (badGoBig) {
    console.log("[picks] Cached Go Big has correlated same-game legs — rebuilding");
  }
  if (thinBreakdowns) {
    console.log("[picks] Cached breakdowns are too thin — rewriting with full analysis");
  }
  if ((placeholderAnalysis || thinBreakdowns) && !kickoffStale && !duplicateLegs && !badGoBig) {
    const existing = previous
      ? { dailyThesis: previous.thesis, picks: previous.picks }
      : await parseBundleFromCachedSlips(pickDate);
    if (existing) {
      console.log("[picks] Refreshing analysis only — keeping current legs");
      const matchBundles = await loadMatchBundles();
      let bundle = existing;
      try {
        bundle = await enrichBundleWithGeminiAnalysis(matchBundles, bundle);
      } catch (err) {
        console.warn("[picks] LLM analysis unavailable — using headline-based breakdown");
        bundle = enrichBundleWithHeadlines(matchBundles, bundle);
      }
      const version = previous ? previous.version + 1 : 1;
      const changeNote = "Breakdown updated.";
      if (previous && version > 1) {
        await archiveCurrentPicks(pickDate, previous.version);
      }
      const thesisJson = JSON.stringify(bundle.dailyThesis);
      const output: Record<PickTier, string> = { hit: "", aim: "", go_big: "" };
      for (const tier of tiers) {
        const raw = bundle.picks[tier];
        const pick: GeneratedPick = {
          tier,
          version,
          changeNote: version > 1 ? changeNote : null,
          ...raw,
        };
        const content = formatPickSlip(pick);
        output[tier] = content;
        await savePickBatch(
          pickDate,
          tier,
          content,
          version,
          thesisJson,
          version > 1 ? changeNote : null
        );
      }
      await saveBatchSnapshot(
        pickDate,
        version,
        bundle.dailyThesis,
        bundle.picks,
        version > 1 ? changeNote : null
      );
      return {
        picks: output,
        version,
        updated: true,
        changeNote: version > 1 ? changeNote : null,
      };
    }
  }

  const matchBundles = await loadMatchBundles();
  if (matchBundles.length === 0) {
    throw new Error(
      "No upcoming fixtures with live odds — waiting for TxLINE to publish lines for the next kickoffs"
    );
  }

  const allowedMatches = matchBundles.map((b) => fixtureLabel(b.fixture));
  const validationOpts = {
    allowedMatches,
    skipCrossTier: false as boolean,
    oddsFallback: false as boolean,
  };

  let bundle: DailyPicksBundle | null = null;
  let errors: string[] = [];
  let usedOddsFallback = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[picks] Generating unified daily card (attempt ${attempt})…`);
      bundle = await generateUnifiedBundle(
        matchBundles,
        attempt > 1 ? errors : undefined
      );
      errors = validateDailyBundle(bundle, {
        ...validationOpts,
        oddsFallback: false,
      });
      if (errors.length === 0) break;
      console.warn("[picks] Validation failed:", errors.join("; "));
    } catch (err) {
      console.warn(
        `[picks] Attempt ${attempt} failed:`,
        (err as { message?: string })?.message ?? err
      );
      if (isQuotaError(err)) {
        break;
      }
    }
  }

  if (usedOddsFallback && bundle) {
    errors = validateDailyBundle(bundle, {
      ...validationOpts,
      oddsFallback: true,
    });
  }

  if ((!bundle || errors.length > 0) && !usedOddsFallback) {
    console.warn("[picks] Using odds-only fallback card");
    try {
      bundle = buildOddsFallbackBundle(matchBundles);
      errors = validateDailyBundle(bundle, {
        ...validationOpts,
        oddsFallback: true,
      });
      usedOddsFallback = true;
    } catch (fallbackErr) {
      if (kickoffStale) {
        throw new Error(
          `Kickoff refresh failed — not enough live odds for upcoming matches (${fallbackErr})`
        );
      }
      const existing = await parseBundleFromCachedSlips(pickDate);
      if (existing) {
        bundle = repairBundleLegs(existing, matchBundles);
        errors = validateDailyBundle(bundle, {
          ...validationOpts,
          oddsFallback: true,
        });
        usedOddsFallback = true;
      } else {
        bundle = null;
        throw new Error(
          `Odds fallback failed and no valid cache (${fallbackErr})`
        );
      }
    }
  }

  if (!bundle) {
    throw new Error("Pick generation failed — no bundle produced");
  }

  try {
    console.log("[picks] Writing full Biggy analysis for locked legs…");
    bundle = await enrichBundleWithGeminiAnalysis(matchBundles, bundle);
  } catch (err) {
    console.warn("[picks] LLM analysis unavailable — using headline-based breakdown");
    if (bundleHasThinBreakdowns(bundle)) {
      bundle = enrichBundleWithHeadlines(matchBundles, bundle);
    }
  }

  errors = validateDailyBundle(bundle, {
    ...validationOpts,
    oddsFallback: usedOddsFallback,
  });
  if (errors.length > 0) {
    throw new Error(`Pick validation failed: ${errors.join("; ")}`);
  }

  const bettableErr = await validateBundleBettable(bundle);
  if (bettableErr) {
    throw new Error(`Cannot publish picks: ${bettableErr}`);
  }

  bundle = normalizePickBundle(bundle);

  if (
    previous &&
    options?.onlyIfChanged &&
    !kickoffStale &&
    !hasMeaningfulChange(previous as StoredPickBatch, bundle)
  ) {
    console.log(`[picks] No meaningful data change for ${pickDate} — keeping v${previous.version}`);
    const cached = await cachedPicks(pickDate);
    if (cached) {
      return {
        picks: cached,
        version: previous.version,
        updated: false,
        changeNote: previous.changeNote,
      };
    }
  }

  const version = previous ? previous.version + 1 : 1;
  let changeNote: string | null = null;

  if (previous && version > 1) {
    if (kickoffStale || usedOddsFallback) {
      changeNote =
        "Earlier matches have kicked off. Picks updated with the next upcoming games.";
    } else {
      changeNote = await explainPickChanges(previous as StoredPickBatch, bundle);
    }
    await archiveCurrentPicks(pickDate, previous.version);
    console.log(`[picks] v${version} update:`, changeNote);
  }

  const thesisJson = JSON.stringify(bundle.dailyThesis);
  const output: Record<PickTier, string> = { hit: "", aim: "", go_big: "" };

  for (const tier of tiers) {
    const raw = bundle.picks[tier];
    const pick: GeneratedPick = {
      tier,
      version,
      changeNote,
      ...raw,
    };
    const content = formatPickSlip(pick);
    output[tier] = content;
    await savePickBatch(pickDate, tier, content, version, thesisJson, changeNote);
  }

  await saveBatchSnapshot(pickDate, version, bundle.dailyThesis, bundle.picks, changeNote);

  console.log(
    "[picks] Thesis:",
    bundle.dailyThesis.map((t) => `${t.match}: ${t.summary}`).join(" | ")
  );

  return {
    picks: output,
    version,
    updated: version > 1 || !previous,
    changeNote,
  };
}

export async function getCachedPick(
  pickDate: string,
  tier: PickTier
): Promise<string | null> {
  const content = await getCachedPickContent(pickDate, tier);
  if (!content) return null;
  return stripSourcesFromSlipHtml(cleanSlipBreakdownHtml(content));
}

export function todayPickDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export { getPickMeta };