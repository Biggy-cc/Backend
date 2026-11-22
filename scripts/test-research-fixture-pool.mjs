import assert from "node:assert/strict";
process.env.FOOTBALL_DATA_PROVIDER = "api-football";
const { selectDisplayFixtures } = await import("../dist/api/fixtures.js");
const start = Math.floor(Date.now() / 1000) + 3600;
const fixture = (id, competition, league, home, away) => ({ FixtureId: id, CompetitionId: league, Competition: competition, Participant1: home, Participant2: away, Participant1IsHome: true, StartTime: start + id });
const fixtures = [
  ...Array.from({ length: 25 }, (_, i) => fixture(i + 1, "Premier League", 39, `Club ${i}`, `Away ${i}`)),
  fixture(50, "Other division", 900, "Other United", "Rivals"),
  fixture(51, "Another division", 901, "Local City", "Visitors"),
];
const pool = selectDisplayFixtures(fixtures, 10, { timeZone: "UTC", research: true });
assert.ok(pool.some((item) => item.CompetitionId === 900), "research pool should include non-preferred competitions even when major leagues fill the limit");
assert.ok(pool.some((item) => item.CompetitionId === 901));
assert.equal(selectDisplayFixtures(fixtures, 2, { timeZone: "UTC", research: true, query: "Please include Local City" })[0].Participant1, "Local City");
console.log("Research fixture pool tests passed");
