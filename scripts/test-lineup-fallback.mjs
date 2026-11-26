import assert from "node:assert/strict";
import axios from "axios";
process.env.API_FOOTBALL_KEY = "test-only";
process.env.API_FOOTBALL_QUOTA_MODE = "paid";
process.env.API_FOOTBALL_DAILY_BUDGET = "100";
process.env.DATABASE_BACKEND = "d1";
process.env.OPENAI_API_KEY = "test-only";
axios.defaults.adapter = async (config) => {
  const response = config.url === "/fixtures/lineups" ? [] : [{ fixture: { id: 1234, date: "2026-11-26T08:30:00Z", status: { short: "HT" } }, league: { name: "Liga 1", country: "Indonesia" }, teams: { home: { id: 1, name: "Borneo" }, away: { id: 2, name: "Persita" } }, goals: { home: 1, away: 1 } }];
  return { status: 200, statusText: "OK", headers: {}, config, data: { errors: [], response } };
};
let calls = 0;
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  calls++;
  if (calls === 1) return new Response(JSON.stringify({ id: "first", output: [{ type: "function_call", call_id: "lineup", name: "get_team_lineup", arguments: JSON.stringify({ team: "Borneo", opponent: "Persita", matchDate: null }) }] }), { status: 200 });
  if (calls === 2) {
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    assert.match(body.input, /Borneo vs Persita/);
    return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "Reported Borneo starter: Player A.", annotations: [{ type: "url_citation", url: "https://example.test/lineups", title: "Lineup report" }] }] }] }), { status: 200 });
  }
  const result = JSON.parse(body.input[0].output);
  assert.equal(result.lineup.status, "no_lineups");
  assert.equal(result.fallbackReport.status, "reported");
  return new Response(JSON.stringify({ output_text: "A report lists Player A for Borneo." }), { status: 200 });
};
const { askBiggy } = await import("../dist/chat/assistant.js");
const answer = await askBiggy("line up ful", [{ role: "user", content: "Borneo vs Persita" }], "Europe/Berlin", 1234);
assert.match(answer.answer, /https:\/\/example\.test\/lineups/);
assert.equal(calls, 3);
console.log("Lineup fallback test passed: exact fixture, source attribution and no primary data");
