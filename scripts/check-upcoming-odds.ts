import "dotenv/config";
import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  selectPicksFixtures,
} from "../src/txline/client.js";

async function main() {
  const all = await fetchFixturesSnapshot();
  for (const f of selectPicksFixtures(all)) {
    const odds = await fetchOddsForFixture(f.FixtureId, f);
    console.log(fixtureLabel(f), f.FixtureId, "odds:", odds.length);
  }
}

main().catch(console.error);
