import "dotenv/config";
import {
  fetchFixturesSnapshot,
  fixtureLabel,
  isWorldCupFixture,
  selectPicksFixtures,
} from "../src/txline/client.js";

async function main() {
  const all = await fetchFixturesSnapshot();
  const wc = all.filter(isWorldCupFixture).sort((a, b) => a.StartTime - b.StartTime);

  console.log("All WC / friendlies:");
  for (const f of wc) {
    console.log(`${fixtureLabel(f)} | ${new Date(f.StartTime).toISOString()}`);
  }

  console.log("\nNext 48h (bot card window):");
  for (const f of selectPicksFixtures(all, { max: 12 })) {
    console.log(`${fixtureLabel(f)} | ${new Date(f.StartTime).toISOString()}`);
  }
}

main().catch(console.error);
