import "dotenv/config";
import { runMigrations } from "../src/db/client.js";
import {
  enrichBundleWithGeminiAnalysis,
  enrichBundleWithHeadlines,
} from "../src/picks/analysis.js";
import {
  generateDailyPicks,
  todayPickDate,
} from "../src/picks/generate.js";
import {
  archiveCurrentPicks,
  loadStoredBatch,
  saveBatchSnapshot,
  savePickBatch,
} from "../src/picks/store.js";
import { formatPickSlip, type GeneratedPick } from "../src/picks/types.js";
import type { PickTier } from "../src/picks/types.js";
import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  selectPicksFixtures,
} from "../src/txline/client.js";
import { researchMatchesLight } from "../src/picks/research.js";

async function loadMatchBundles() {
  const upcoming = selectPicksFixtures(await fetchFixturesSnapshot());
  const enriched = await researchMatchesLight(upcoming);
  const bundles = [];
  for (const match of enriched) {
    const odds = await fetchOddsForFixture(match.fixture.FixtureId, match.fixture);
    if (odds.length > 0) bundles.push({ ...match, odds });
  }
  return bundles;
}

async function main() {
  await runMigrations();
  const pickDate = todayPickDate();
  const previous = await loadStoredBatch(pickDate);
  if (!previous) {
    console.log("No stored batch — run picks:generate first");
    process.exit(1);
  }

  const bundle = { dailyThesis: previous.thesis, picks: previous.picks };
  const matchBundles = await loadMatchBundles();
  console.log(`Refreshing analysis for ${matchBundles.length} matches with odds…`);

  let updated = bundle;
  try {
    updated = await enrichBundleWithGeminiAnalysis(matchBundles, bundle);
    console.log("Analysis via LLM chain");
  } catch (err) {
    console.warn("LLM analysis failed — headline fallback:", err);
    updated = enrichBundleWithHeadlines(matchBundles, bundle);
  }

  const version = previous.version + 1;
  const changeNote = "Full Biggy analysis refreshed.";
  await archiveCurrentPicks(pickDate, previous.version);

  const thesisJson = JSON.stringify(updated.dailyThesis);
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  for (const tier of tiers) {
    const pick: GeneratedPick = {
      tier,
      version,
      changeNote,
      ...updated.picks[tier],
    };
    await savePickBatch(
      pickDate,
      tier,
      formatPickSlip(pick),
      version,
      thesisJson,
      changeNote
    );
  }
  await saveBatchSnapshot(
    pickDate,
    version,
    updated.dailyThesis,
    updated.picks,
    changeNote
  );

  console.log(`Done — v${version}`);
  console.log("Aim breakdown preview:", updated.picks.aim.breakdown.slice(0, 200));
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  process.exit(1);
});
