import assert from "node:assert/strict";
import axios from "axios";
import Parser from "rss-parser";

process.env.API_FOOTBALL_KEY = "test-only";
process.env.API_FOOTBALL_QUOTA_MODE = "paid";
process.env.API_FOOTBALL_DAILY_BUDGET = "100";
process.env.DATABASE_BACKEND = "d1";
let requests = 0;
axios.defaults.adapter = async (config) => {
  requests++;
  if (requests === 1) throw new Error("provider unavailable");
  if (config.url === "/leagues") return { status: 200, statusText: "OK", headers: {}, config, data: { errors: [], response: [{ league: { id: 900 }, seasons: [{ current: true, coverage: { injuries: false } }] }] } };
  if (config.url === "/fixtures/lineups") return { status: 200, statusText: "OK", headers: {}, config, data: { errors: [], response: [{ team: { name: "Alpha" }, formation: "4-3-3", startXI: [{ player: { name: "Player A" } }] }] } };
  return { status: 200, statusText: "OK", headers: {}, config, data: { errors: [], response: [] } };
};
const { fetchFixtureInjuries, fetchFixtureLineups } = await import("../dist/api-football/client.js");
const failed = await fetchFixtureInjuries([101, 102]);
assert.equal(failed.get(101).status, "unavailable");
const retried = await fetchFixtureInjuries([101, 102]);
assert.equal(retried.get(101).status, "no_reports", "failures must not be cached as a healthy squad");
assert.equal(requests, 2);
await fetchFixtureInjuries([101, 102]);
assert.equal(requests, 2, "successful injury batch is cached");
assert.equal((await fetchFixtureLineups(101, new Date(Date.now() + 2 * 3600_000).toISOString())).status, "too_early");
assert.equal(requests, 2, "do not poll lineups well ahead of kickoff");
assert.equal((await fetchFixtureLineups(101, new Date(Date.now() + 30 * 60_000).toISOString())).teams[0].startingXI[0], "Player A");
await fetchFixtureLineups(101, new Date(Date.now() + 30 * 60_000).toISOString());
assert.equal(requests, 3, "lineups are cached");
assert.equal((await fetchFixtureInjuries([999], new Map([[999, 900]]))).get(999).status, "not_covered");
assert.equal(requests, 4, "known unsupported leagues must not trigger an injury lookup");

let newsRequests = 0;
Parser.prototype.parseURL = async () => {
  newsRequests++;
  return { items: [
    { title: "Alpha injury update - Verified Outlet", link: "https://example.test/recent", isoDate: new Date().toISOString() },
    { title: "Alpha old news - Outlet", link: "https://example.test/old", isoDate: new Date(Date.now() - 8 * 86400_000).toISOString() },
    { title: "Unrelated team news - Outlet", link: "https://example.test/other", isoDate: new Date().toISOString() },
  ] };
};
const { fetchResearchNews } = await import("../dist/news/google.js");
const news = await fetchResearchNews("Alpha", "Beta");
assert.equal(news.status, "reports_found");
assert.equal(news.articles.length, 1);
assert.equal(news.articles[0].source, "Verified Outlet");
await fetchResearchNews("Alpha", "Beta");
assert.equal(newsRequests, 1, "news lookups are shared and cached");
Parser.prototype.parseURL = async () => { throw new Error("offline"); };
assert.equal((await fetchResearchNews("Gamma", "Delta")).status, "unavailable");
console.log("Research source tests passed: batch, caching, freshness and failures");
