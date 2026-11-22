import assert from "node:assert/strict";
import axios from "axios";
import Parser from "rss-parser";

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
  { FixtureId: 43, Participant1: "Epsilon", Participant2: "Zeta", Participant1IsHome: true, StartTime: kickoff, Competition: "Premier League", CompetitionId: 39 },
]);
let researchCalls = 0;
let injuryCalls = 0;
let newsCalls = 0;
Parser.prototype.parseURL = async (url) => {
  newsCalls++;
  const names = decodeURIComponent(url).includes("Alpha") ? "Alpha" : "Gamma";
  return { items: [{ title: `${names} player doubtful - Test News`, link: `https://news.example/${names}`, isoDate: new Date().toISOString() }] };
};
axios.defaults.adapter = async (config) => {
  let response;
  if (config.url === "/predictions") {
    researchCalls++;
    response = [{ teams: { home: { last_5: { form: "WWDLW" } }, away: { last_5: { form: "DLWDL" } } } }];
  } else if (config.url === "/leagues") {
    response = [{ league: { id: 39, name: "Premier League" }, country: { name: "England" }, seasons: [{ year: 2026, current: true, coverage: { injuries: true } }] }];
  } else if (config.url === "/injuries") {
    injuryCalls++;
    response = [{ fixture: { id: 41 }, team: { name: "Alpha" }, player: { name: "Player A", type: "Questionable", reason: "Knee" } }];
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
  if (round === 1) {
    assert.deepEqual(payload.tools.map((tool) => tool.name).sort(), ["analyze_match", "propose_parlay_for_approval"], "parlay research must not fan out into unrelated provider tools");
    return new Response(JSON.stringify({ id: "r1", output: [call("a", "analyze_match", { home: "Alpha", away: "Beta" }), call("b", "analyze_match", { home: "Gamma", away: "Delta" })] }), { status: 200 });
  }
  if (round === 2) {
    assert.equal(payload.input.length, 2);
    assert.ok(payload.input.every((item) => JSON.parse(item.output).research));
    const first = JSON.parse(payload.input[0].output);
    const second = JSON.parse(payload.input[1].output);
    assert.equal(first.injuries.reports[0].type, "Questionable");
    assert.equal(second.injuries.status, "no_reports", "empty results are not confirmation of a healthy squad");
    assert.equal(first.news.articles[0].source, "Test News");
    assert.ok(first.news.articles[0].publishedAt);
    return new Response(JSON.stringify({ id: "r2", output: [call("p", "propose_parlay_for_approval", { title: "Balanced parlay", risk: "balanced", summary: "A proposal based on the researched match data.", legs: [
      { home: "Alpha", away: "Beta", selection: "Alpha win", kickoffAt: "wrong" },
      { home: "Gamma", away: "Delta", selection: "Over 1.5 goals", kickoffAt: "wrong" },
    ] })] }), { status: 200 });
  }
  assert.equal(JSON.parse(payload.input[0].output).status, "awaiting_user_approval");
  return new Response(JSON.stringify({ output_text: "Review this proposal before approving it." }), { status: 200 });
};
const { askBiggy } = await import("../dist/chat/assistant.js");
const answer = await askBiggy("Help me build a balanced, researched parlay", [], "Europe/Berlin", undefined, true, async () => true);
assert.equal(round, 2, "validated proposals should not need a third model round");
assert.equal(answer.answer, "A proposal based on the researched match data.");
assert.equal(answer.parlay?.legs.length, 2);
assert.equal(answer.parlay.legs[0].kickoffAt, new Date(kickoff * 1000).toISOString(), "kickoff must come from verified fixture");
assert.equal(answer.parlay.legs[0].fixtureId, "41", "fixture ID must come from verified data");
assert.equal(answer.parlay.legs[0].homeLogo, "https://example.test/alpha.png", "home crest must come from verified data");
assert.equal(answer.parlay.legs[0].awayLogo, "https://example.test/beta.png", "away crest must come from verified data");
assert.equal(answer.parlay.legs[0].odds?.price, 1.85, "proposal must contain a verified price");
assert.equal(researchCalls, 2, "each fixture uses one research request");
assert.equal(injuryCalls, 1, "concurrent fixtures share one injury request");
assert.equal(newsCalls, 2, "one news request per fixture");
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
let revisionRound = 0;
const original = answer.parlay;
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body);
  revisionRound++;
  if (revisionRound === 1) {
    assert.ok(payload.input.some((item) => item.content?.includes("ACTIVE USER PROPOSAL TO REVISE")));
    return new Response(JSON.stringify({ id: "revision-1", output: [call("a", "analyze_match", { home: "Alpha", away: "Beta" }), call("b", "analyze_match", { home: "Gamma", away: "Delta" }), call("c", "analyze_match", { home: "Epsilon", away: "Zeta" })] }), { status: 200 });
  }
  if (revisionRound === 2) return new Response(JSON.stringify({ id: "revision-2", output: [call("bad-revision", "propose_parlay_for_approval", { title: "Wrong replacement", risk: "balanced", legs: [original.legs[0], { home: "Epsilon", away: "Zeta", selection: "Epsilon win", kickoffAt: "x" }] })] }), { status: 200 });
  if (revisionRound === 3) {
    assert.match(JSON.parse(payload.input[0].output).error, /replace the requested match/i);
    return new Response(JSON.stringify({ id: "revision-3", output: [call("good-revision", "propose_parlay_for_approval", { title: "Revised", risk: "balanced", legs: [original.legs[1], { home: "Epsilon", away: "Zeta", selection: "Epsilon win", kickoffAt: "x" }] })] }), { status: 200 });
  }
  assert.equal(JSON.parse(payload.input[0].output).status, "awaiting_user_approval");
  return new Response(JSON.stringify({ output_text: "I replaced Alpha with Epsilon and kept your other selection." }), { status: 200 });
};
const revision = await askBiggy("Replace Alpha with another match", [], "Europe/Berlin", undefined, true, async () => true, original);
assert.deepEqual(revision.parlay.legs.map((leg) => leg.home), ["Gamma", "Epsilon"]);
assert.equal(revision.parlay.legs[0].selection, original.legs[1].selection);
const free = await askBiggy("Build a balanced parlay", [], "Europe/Berlin", undefined, false);
assert.match(free.answer, /requires an active Biggy Pro or Max/);
console.log("Parlay chat test passed: researched fixtures produce an approval-only proposal");
