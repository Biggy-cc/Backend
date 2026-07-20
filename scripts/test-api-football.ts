import "dotenv/config";
import { pingApiFootball } from "../src/api-football/client.js";
import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  getFootballDataProvider,
  selectPicksFixtures,
  warmOddsForFixtures,
} from "../src/providers/football.js";

async function main() {
  process.env.FOOTBALL_DATA_PROVIDER = "api-football";

  console.log("Provider:", getFootballDataProvider());
  const status = await pingApiFootball();
  console.log("Status OK:", status.ok, "| remaining today:", status.remaining, "/", status.limit);

  const all = await fetchFixturesSnapshot();
  console.log(`Fixtures loaded: ${all.length}`);
  const picks = selectPicksFixtures(all, { max: 5 });

  console.log("\nWarming odds by date (today + nearest)…");
  await warmOddsForFixtures(picks, { force: true });

  console.log("\nNext pick window:");
  for (const f of picks) {
    const odds = await fetchOddsForFixture(f.FixtureId, f);
    const byType = new Map<string, number>();
    for (const o of odds) {
      byType.set(o.MarketType, (byType.get(o.MarketType) ?? 0) + 1);
    }
    console.log(
      `- ${fixtureLabel(f)} | ${new Date(f.StartTime * 1000).toISOString()} | ${f.Competition} | lines:${odds.length}`
    );
    console.log(
      "  markets:",
      [...byType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}(${n})`)
        .join(", ")
    );
    const highlight = odds.filter((o) =>
      ["1X2", "BTTS", "Double Chance", "Total Goals", "Asian Handicap", "Draw No Bet"].includes(
        o.MarketType
      )
    );
    console.log(
      "  core:",
      highlight
        .slice(0, 10)
        .map((o) => `${o.Selection}@${o.StablePrice}`)
        .join(", ")
    );
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  process.exit(1);
});
