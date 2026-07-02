import "dotenv/config";
import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  selectPicksFixtures,
} from "../src/txline/client.js";

async function main() {
  const upcoming = selectPicksFixtures(await fetchFixturesSnapshot());
  for (const f of upcoming.slice(0, 4)) {
    const odds = await fetchOddsForFixture(f.FixtureId, f);
    console.log(fixtureLabel(f), "odds:", odds.length, odds.map(o => o.Selection + "@" + o.StablePrice).join(", "));
  }
}

main();
