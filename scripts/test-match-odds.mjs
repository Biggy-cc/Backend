import assert from "node:assert/strict";
import axios from "axios";

process.env.API_FOOTBALL_KEY = "test-only";
process.env.API_FOOTBALL_QUOTA_MODE = "paid";
process.env.API_FOOTBALL_DAILY_BUDGET = "100";
process.env.DATABASE_BACKEND = "d1";
process.env.OPENAI_API_KEY = "test-only";

const calls = [];
axios.defaults.adapter = async (config) => {
  calls.push({ path: config.url, params: config.params });
  const id = config.params?.id ?? config.params?.fixture;
  let response;
  if (config.url === "/fixtures") {
    response = [{ fixture: { id, date: "2026-11-21T17:00:00Z", timestamp: 1795280400, status: { short: id === 2 ? "NS" : id === 3 ? "FT" : "1H", elapsed: 32 } }, league: { name: "Serie A", country: "Italy" }, teams: { home: { id: 20, name: "Parma" }, away: { id: 21, name: "AS Roma" } }, goals: { home: id === 2 ? null : 0, away: id === 2 ? null : 0 } }];
  } else if (config.url === "/odds/live") {
    response = id === 4 ? [{ fixture: { id }, status: { blocked: true }, bets: [{ name: "Match Winner", values: [{ value: "Home", odd: "2.00" }] }] }] : [{ fixture: { id }, update: id === 5 ? new Date(Date.now() - 180_000).toISOString() : new Date().toISOString(), status: { blocked: false }, bets: [{ name: "Match Winner", values: [{ value: "Home", odd: "2.50" }, { value: "Draw", odd: "3.10" }, { value: "Away", odd: "2.90", suspended: true }] }] }];
  } else if (config.url === "/odds") {
    response = [{ fixture: { id }, bookmakers: [{ name: "Example Book", bets: [{ name: "Match Winner", values: [{ value: "Home", odd: "2.25" }] }] }] }];
  } else throw new Error(`Unexpected provider request ${config.url}`);
  return { status: 200, statusText: "OK", headers: {}, config, data: { errors: [], response } };
};

const { fetchMatchOdds } = await import("../dist/api-football/match-odds.js");
const [live, shared] = await Promise.all([fetchMatchOdds(1), fetchMatchOdds(1)]);
assert.equal(live.phase, "live");
assert.deepEqual(live.markets[0].selections.map((s) => s.selection), ["Home", "Draw"]);
assert.deepEqual(shared, live);
assert.equal(calls.filter((c) => c.path === "/odds/live").length, 1);
const pre = await fetchMatchOdds(2);
assert.equal(pre.phase, "pre-match");
assert.equal(pre.bookmaker, "Example Book");
assert.match((await fetchMatchOdds(3)).error, /unavailable/);
const blocked = await fetchMatchOdds(4);
assert.match(blocked.unavailable, /blocked/);
assert.deepEqual(blocked.markets, []);
const stale = await fetchMatchOdds(5);
assert.match(stale.unavailable, /over two minutes old/);
assert.deepEqual(stale.markets, []);

let modelCalls = 0;
globalThis.fetch = async (_url, options) => {
  modelCalls++;
  const payload = JSON.parse(options.body);
  const context = payload.input.find((item) => item.content?.startsWith("VERIFIED SELECTED FIXTURE ODDS: "));
  assert.ok(context, "odds follow-up must receive verified odds, not just the score");
  assert.equal(JSON.parse(context.content.slice("VERIFIED SELECTED FIXTURE ODDS: ".length)).fixtureId, 1);
  return new Response(JSON.stringify({ output_text: "Live odds: Parma 2.50; draw 3.10." }), { status: 200 });
};
const { askBiggy } = await import("../dist/chat/assistant.js");
const result = await askBiggy("have ods for this match?", [{ role: "user", content: "What is happening in Parma vs AS Roma?" }], "Europe/Berlin", 1);
assert.match(result.answer, /2\.50/);
assert.equal(modelCalls, 1);
console.log("Match odds tests passed: live, pre-match, suspended, blocked, cache, typo and context");
