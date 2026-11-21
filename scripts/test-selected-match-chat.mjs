import assert from "node:assert/strict";
import axios from "axios";

process.env.API_FOOTBALL_KEY = "test-only";
process.env.API_FOOTBALL_QUOTA_MODE = "paid";
process.env.DATABASE_BACKEND = "d1";
process.env.OPENAI_API_KEY = "test-only";
const requests = [];
axios.defaults.adapter = async (config) => {
  requests.push({ path: config.url, params: config.params });
  assert.equal(config.url, "/fixtures");
  assert.equal(config.params.id, 1234);
  return { status: 200, statusText: "OK", headers: {}, config, data: { errors: [], response: [{
    fixture: { id: 1234, date: "2026-11-21T16:00:00Z", timestamp: 1795276800, status: { short: "NS" } },
    league: { id: 39, name: "Premier League", country: "England" },
    teams: { home: { id: 1, name: "Aston Villa" }, away: { id: 2, name: "Sunderland" } },
    goals: { home: null, away: null },
  }] } };
};
let openAiCalls = 0;
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body);
  openAiCalls++;
  if (openAiCalls === 1) return new Response(JSON.stringify({ id: "response-1", output: [{ type: "function_call", call_id: "call-1", name: "get_match_events", arguments: JSON.stringify({ home: "ambiguous", away: "names", matchDate: null }) }] }), { status: 200 });
  const result = JSON.parse(payload.input[0].output);
  assert.equal(result.match.fixtureId, 1234);
  assert.equal(result.match.status, "NS");
  assert.equal(result.match.selection, "selected_fixture");
  return new Response(JSON.stringify({ output_text: "Aston Villa host Sunderland at 17:00 Berlin time." }), { status: 200 });
};
const { askBiggy } = await import("../dist/chat/assistant.js");
const answer = await askBiggy("Tell me about Aston Villa vs Sunderland", [], "Europe/Berlin", 1234);
assert.match(answer.answer, /Aston Villa/);
assert.equal(requests.length, 1, "an upcoming selected fixture needs no team search or events call");
console.log("Selected match chat test passed: exact fixture ID reaches the football tool");
