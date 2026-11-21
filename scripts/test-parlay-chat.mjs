import assert from "node:assert/strict";
import axios from "axios";

process.env.API_FOOTBALL_KEY = "test-only";
process.env.API_FOOTBALL_QUOTA_MODE = "paid";
process.env.API_FOOTBALL_DAILY_BUDGET = "100";
process.env.FOOTBALL_DATA_PROVIDER = "api-football";
process.env.DATABASE_BACKEND = "d1";
process.env.OPENAI_API_KEY = "test-only";

const kickoff = Math.floor((Date.now() + 86_400_000) / 1000);
const { setCachedFixtures } = await import("../dist/api-football/cache.js");
setCachedFixtures([
  { FixtureId: 41, Participant1: "Alpha", Participant2: "Beta", Participant1Logo: "https://example.test/alpha.png", Participant2Logo: "https://example.test/beta.png", Participant1IsHome: true, StartTime: kickoff, Competition: "Premier League", CompetitionId: 39 },
  { FixtureId: 42, Participant1: "Gamma", Participant2: "Delta", Participant1IsHome: true, StartTime: kickoff, Competition: "Premier League", CompetitionId: 39 },
]);
let researchCalls = 0;
axios.defaults.adapter = async (config) => {
  let response;
  if (config.url === "/predictions") {
    researchCalls++;
    response = [{ teams: { home: { last_5: { form: "WWDLW" } }, away: { last_5: { form: "DLWDL" } } } }];
  } else if (config.url === "/fixtures") {
    const id = config.params.id;
    response = [{ fixture: { id, timestamp: kickoff, date: new Date(kickoff * 1000).toISOString(), status: { short: "NS" } }, league: { name: "Premier League", country: "England" }, teams: { home: { id: 1, name: id === 41 ? "Alpha" : "Gamma" }, away: { id: 2, name: id === 41 ? "Beta" : "Delta" } }, goals: { home: null, away: null } }];
  } else if (config.url === "/odds") {
    response = [{ fixture: { id: config.params.fixture }, bookmakers: [{ name: "Test Book", bets: [{ name: "Match Winner", values: [{ value: "Home", odd: "1.85" }] }, { name: "Goals Over/Under", values: [{ value: "Over 1.5", odd: "1.45" }] }] }] }];
  } else throw new Error(`Unexpected request ${config.url}`);
  return { status: 200, statusText: "OK", headers: {}, config, data: { errors: [], response } };
};
const call = (id, name, args) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
let round = 0;
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body);
  round++;
  if (round === 1) return new Response(JSON.stringify({ id: "r1", output: [call("a", "analyze_match", { home: "Alpha", away: "Beta" }), call("b", "analyze_match", { home: "Gamma", away: "Delta" })] }), { status: 200 });
  if (round === 2) {
    assert.equal(payload.input.length, 2);
    assert.ok(payload.input.every((item) => JSON.parse(item.output).research));
    return new Response(JSON.stringify({ id: "r2", output: [call("p", "propose_parlay_for_approval", { title: "Balanced parlay", risk: "balanced", legs: [
      { home: "Alpha", away: "Beta", selection: "Alpha win", kickoffAt: "wrong" },
      { home: "Gamma", away: "Delta", selection: "Over 1.5 goals", kickoffAt: "wrong" },
    ] })] }), { status: 200 });
  }
  assert.equal(JSON.parse(payload.input[0].output).status, "awaiting_user_approval");
  return new Response(JSON.stringify({ output_text: "Review this proposal before approving it." }), { status: 200 });
};
const { askBiggy } = await import("../dist/chat/assistant.js");
const answer = await askBiggy("Help me build a balanced, researched parlay", [], "Europe/Berlin", undefined, true, async () => true);
assert.equal(answer.parlay?.legs.length, 2);
assert.equal(answer.parlay.legs[0].kickoffAt, new Date(kickoff * 1000).toISOString(), "kickoff must come from verified fixture");
assert.equal(answer.parlay.legs[0].fixtureId, "41", "fixture ID must come from verified data");
assert.equal(answer.parlay.legs[0].homeLogo, "https://example.test/alpha.png", "home crest must come from verified data");
assert.equal(answer.parlay.legs[0].awayLogo, "https://example.test/beta.png", "away crest must come from verified data");
assert.equal(answer.parlay.legs[0].odds?.price, 1.85, "price must come from the exact provider market");
assert.equal(answer.parlay.legs[1].odds?.price, 1.45, "total goals must match the exact line");
assert.equal(researchCalls, 2, "each fixture uses one research request");
let invalidRound = 0;
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body);
  invalidRound++;
  if (invalidRound === 1) return new Response(JSON.stringify({ id: "bad-1", output: [call("bad", "propose_parlay_for_approval", { title: "Unverified", risk: "balanced", legs: [
    { home: "Alpha", away: "Beta", selection: "Win", kickoffAt: "x" },
    { home: "Gamma", away: "Delta", selection: "Win", kickoffAt: "x" },
  ] })] }), { status: 200 });
  assert.match(JSON.parse(payload.input[0].output).error, /successful research/);
  return new Response(JSON.stringify({ output_text: "I cannot verify the research yet." }), { status: 200 });
};
const unverified = await askBiggy("Build a balanced parlay", [], "Europe/Berlin", undefined, true, async () => true);
assert.equal(unverified.parlay, undefined, "unresearched proposals must not become approval cards");
let duplicateRound = 0;
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body);
  duplicateRound++;
  if (duplicateRound === 1) return new Response(JSON.stringify({ id: "duplicate-1", output: [call("a", "analyze_match", { home: "Alpha", away: "Beta" }), call("b", "analyze_match", { home: "Gamma", away: "Delta" })] }), { status: 200 });
  if (duplicateRound === 2) return new Response(JSON.stringify({ id: "duplicate-2", output: [call("p", "propose_parlay_for_approval", { title: "Duplicate", risk: "balanced", legs: [
    { home: "Alpha", away: "Beta", selection: "Alpha win", kickoffAt: "x" },
    { home: "Alpha", away: "Beta", selection: "Over 1.5 goals", kickoffAt: "x" },
  ] })] }), { status: 200 });
  if (duplicateRound === 4) return new Response(JSON.stringify({ id: "duplicate-4", output: [call("p2", "propose_parlay_for_approval", { title: "Duplicate", risk: "balanced", legs: [
    { home: "Alpha", away: "Beta", selection: "Alpha win", kickoffAt: "x" },
    { home: "Alpha", away: "Beta", selection: "Over 1.5 goals", kickoffAt: "x" },
  ] })] }), { status: 200 });
  assert.match(JSON.parse(payload.input[0].output).error, /distinct/);
  return new Response(JSON.stringify({ output_text: "I suggest both selections on Alpha." }), { status: 200 });
};
const duplicate = await askBiggy("Build a balanced parlay", [], "Europe/Berlin", undefined, true, async () => true);
assert.equal(duplicate.parlay, undefined, "duplicate fixtures must not become approval cards");
assert.doesNotMatch(duplicate.answer, /I suggest both/, "invalid selections must not leak in prose");
const free = await askBiggy("Build a balanced parlay", [], "Europe/Berlin", undefined, false);
assert.match(free.answer, /requires an active Biggy Pro or Max/);
console.log("Parlay chat test passed: researched fixtures produce an approval-only proposal");
