import "dotenv/config";
import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  selectPicksFixtures,
} from "../src/txline/client.js";

async function main() {
  const f = selectPicksFixtures(await fetchFixturesSnapshot())[0];
  console.log("match", fixtureLabel(f));
  const odds = await fetchOddsForFixture(f.FixtureId, f);
  console.log("normalized sample", odds.slice(0, 8));
}

main();
