import assert from "node:assert/strict";
import axios from "axios";

process.env.API_FOOTBALL_KEY = "test-only";
process.env.API_FOOTBALL_QUOTA_MODE = "paid";
process.env.API_FOOTBALL_DAILY_BUDGET = "100";
process.env.DATABASE_BACKEND = "d1";

let eventRequests = 0;
const fixture = (id, home, away, status, date, homeGoals, awayGoals) => ({
  fixture: { id, date, timestamp: Date.parse(date) / 1000, status: { short: status, elapsed: 70 } },
  league: { id: 39, name: "Premier League", country: "England" },
  teams: { home: { id: 50, name: home }, away: { id: 36, name: away } },
  goals: { home: homeGoals, away: awayGoals },
});
axios.defaults.adapter = async (config) => {
  const params = config.params ?? {};
  let response;
  if (config.url === "/fixtures" && params.live) {
    response = [fixture(1, "Chelsea", "Leeds", "2H", "2026-11-21T16:00:00Z", 1, 1)];
  } else if (config.url === "/teams") {
    response = params.search === "City" ? [
      { team: { id: 50, name: "Manchester City" } },
      { team: { id: 999, name: "Another City" } },
    ] : [{ team: { id: params.search === "Manchester City" ? 50 : 36, name: params.search } }];
  } else if (config.url === "/fixtures/headtohead") {
    response = [
      fixture(2, "Manchester City", "Fulham", "FT", "2026-11-21T12:30:00Z", 2, 1),
      fixture(3, "Fulham", "Manchester City", "FT", "2026-05-10T14:00:00Z", 0, 0),
    ];
  } else if (config.url === "/fixtures/events") {
    eventRequests += 1;
    response = params.fixture === 3 ? [] : [{ type: "Goal", team: { name: "Manchester City" }, player: { name: "Test scorer" }, time: { elapsed: 20 }, detail: "Normal Goal" }];
  } else throw new Error(`Unexpected provider call: ${config.url}`);
  return { data: { response, errors: [] }, status: 200, statusText: "OK", headers: {}, config };
};

const { fetchApiFootballMatchEvents } = await import("../dist/api-football/client.js");
const live = await fetchApiFootballMatchEvents("Chelsea", "Leeds");
assert.equal(live.match.id ?? live.match.fixtureId, 1);
assert.equal(live.match.selection, "live");

const finished = await fetchApiFootballMatchEvents("Manchester City", "Fulham");
assert.equal(finished.match.id, 2);
assert.equal(finished.match.selection, "most_recent_completed");
assert.equal(finished.events[0].player.name, "Test scorer");
const requestsBeforeCacheHit = eventRequests;
await fetchApiFootballMatchEvents("Manchester City", "Fulham");
assert.equal(eventRequests, requestsBeforeCacheHit, "fixture events should be cached");

const older = await fetchApiFootballMatchEvents("Manchester City", "Fulham", "2026-05-10");
assert.equal(older.match.id, 3);
assert.deepEqual(older.events, [], "empty coverage must not invent events");
assert.match((await fetchApiFootballMatchEvents("Manchester City", "Fulham", "2024-01-01")).error, /requested date/);
assert.match((await fetchApiFootballMatchEvents("City", "Fulham", "2026-11-21")).error, /unambiguously/);
console.log("Match event tests passed: live, finished, date, empty events, ambiguity and caching");
