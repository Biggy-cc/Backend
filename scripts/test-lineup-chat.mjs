import assert from "node:assert/strict";
import axios from "axios";

process.env.API_FOOTBALL_KEY = "test-only";
process.env.API_FOOTBALL_QUOTA_MODE = "paid";
process.env.API_FOOTBALL_DAILY_BUDGET = "100";
process.env.DATABASE_BACKEND = "d1";
process.env.OPENAI_API_KEY = "test-only";
let lineupMode = "available";
const requests = [];
axios.defaults.adapter = async (config) => {
  requests.push({ path: config.url, params: config.params });
  let response;
  if (config.url === "/teams") response = [{ team: { id: 33, name: "Manchester United" } }];
  else if (config.url === "/fixtures") response = config.params.date === "2026-11-24" ? [] : [{ fixture: { id: 1234, date: "2026-11-25T20:00:00Z", status: { short: "NS" } }, league: { name: "Champions League" }, teams: { home: { id: 33, name: "Manchester United" }, away: { id: 55, name: "Sporting CP" } } }];
  else if (config.url === "/fixtures/lineups") {
    if (lineupMode === "error") throw new Error("provider offline");
    response = lineupMode === "empty" ? [] : [{ team: { name: "Manchester United" }, formation: "4-3-3", startXI: [{ player: { name: "Player One" } }] }];
  } else throw new Error(`Unexpected endpoint ${config.url}`);
  return { status: 200, statusText: "OK", headers: {}, config, data: { errors: [], response } };
};

let calls = 0;
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body);
  calls++;
  if (calls === 1) {
    assert.equal(payload.tool_choice.name, "get_team_lineup");
    return new Response(JSON.stringify({ id: "one", output: [{ type: "function_call", call_id: "call1", name: "get_team_lineup", arguments: JSON.stringify({ team: "Manchester United", opponent: "Sporting CP", matchDate: "2026-11-25" }) }] }), { status: 200 });
  }
  const result = JSON.parse(payload.input[0].output);
  assert.equal(result.fixture.home, "Manchester United");
  assert.equal(result.lineup.status, "available");
  assert.equal(result.lineup.teams[0].startingXI[0], "Player One");
  return new Response(JSON.stringify({ output_text: "Manchester United: Player One." }), { status: 200 });
};
const { askBiggy } = await import("../dist/chat/assistant.js");
const { fetchTeamLineup, fetchFixtureLineups } = await import("../dist/api-football/client.js");
assert.match((await askBiggy("Manchester United lineup today", [], "Europe/Berlin")).answer, /Player One/);
assert.equal(requests.find((request) => request.path === "/fixtures").params.date, "2026-11-25");
assert.equal(requests.find((request) => request.path === "/fixtures/lineups").params.fixture, 1234);
assert.equal((await fetchTeamLineup("Manchester United", "2026-11-24", null, "Europe/Berlin")).status, "no_fixture");
lineupMode = "empty";
assert.equal((await fetchFixtureLineups(1235, "2026-11-25T20:00:00Z", { requestedByUser: true })).status, "no_lineups");
lineupMode = "error";
assert.equal((await fetchFixtureLineups(1236, "2026-11-25T20:00:00Z", { requestedByUser: true })).status, "unavailable");
console.log("Lineup chat checks passed: fixture resolution, requested date, provider empty and failure");
