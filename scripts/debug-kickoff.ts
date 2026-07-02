import "dotenv/config";
import {
  fetchFixturesSnapshot,
  fixtureKickoffMs,
  fixtureLabel,
  isBettableFixture,
  isWorldCupFixture,
  selectPicksFixtures,
} from "../src/txline/client.js";
import { picksStaleDueToKickoff } from "../src/picks/kickoff.js";
import { todayPickDate } from "../src/picks/generate.js";
import { loadStoredBatch } from "../src/picks/store.js";

async function main() {
  const all = await fetchFixturesSnapshot();
  console.log("now:", new Date().toISOString());

  const wc = all.filter(isWorldCupFixture);
  console.log("\nAll WC fixtures:");
  for (const f of wc) {
    console.log(
      `  ${fixtureLabel(f)} | ${new Date(fixtureKickoffMs(f)).toISOString()} | bettable=${isBettableFixture(f)}`
    );
  }

  const ger = all.filter(
    (f) =>
      f.Participant1.toLowerCase().includes("germany") ||
      f.Participant2.toLowerCase().includes("germany")
  );
  console.log("\nGermany-related:");
  for (const f of ger) {
    console.log(
      `  ${fixtureLabel(f)} | wc=${isWorldCupFixture(f)} | ${new Date(fixtureKickoffMs(f)).toISOString()} | bettable=${isBettableFixture(f)}`
    );
  }

  console.log(
    "\nselectPicksFixtures:",
    selectPicksFixtures(all).map(fixtureLabel)
  );

  const date = todayPickDate();
  const batch = await loadStoredBatch(date);
  console.log("\npickDate:", date);
  if (batch) {
    console.log("go_big legs:", batch.picks.go_big.legs);
  } else {
    console.log("no stored batch");
  }

  console.log("staleDueToKickoff:", await picksStaleDueToKickoff(date));
}

main().catch(console.error);
