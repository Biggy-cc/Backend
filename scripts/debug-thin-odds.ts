import "dotenv/config";
import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  selectPicksFixtures,
} from "../src/txline/client.js";
import { buildOddsFallbackBundle } from "../src/picks/fallback.js";

async function main() {
  const all = await fetchFixturesSnapshot();
  const bundles = [];
  for (const fixture of selectPicksFixtures(all)) {
    const odds = await fetchOddsForFixture(fixture.FixtureId, fixture);
    console.log("\n", fixtureLabel(fixture), "odds:", odds.length);
    for (const o of odds) {
      console.log(" ", o.MarketType, o.Selection, o.Line, o.StablePrice);
    }
    if (odds.length > 0) {
      bundles.push({
        fixture,
        odds,
        research: {
          match: fixtureLabel(fixture),
          injuriesAndSuspensions: [],
          headToHead: "",
          recentForm: [],
          keyNews: [],
          bettingAngle: "",
        },
        newsArticles: [],
        sources: [],
      });
    }
  }

  try {
    const bundle = buildOddsFallbackBundle(bundles);
    console.log("\nBuilt OK:", Object.keys(bundle.picks));
    for (const tier of ["hit", "aim", "go_big"] as const) {
      console.log(tier, bundle.picks[tier].combinedOdds, bundle.picks[tier].legs);
    }
  } catch (err) {
    console.error("Build failed:", (err as Error).message);
  }
}

main().catch(console.error);
