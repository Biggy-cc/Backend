import assert from "node:assert/strict";
import axios from "axios";

process.env.API_FOOTBALL_KEY = "test-only";
process.env.API_FOOTBALL_QUOTA_MODE = "paid";
process.env.API_FOOTBALL_DAILY_BUDGET = "100";
process.env.DATABASE_BACKEND = "d1";

let calls = 0;
axios.defaults.adapter = async (config) => {
  calls++;
  return {
    data: calls === 1
      ? { errors: { rateLimit: "Too many requests. You have exceeded the limit of requests per minute of your subscription." }, response: [] }
      : { errors: [], response: [] },
    status: 200, statusText: "OK", headers: {}, config,
  };
};

const realNow = Date.now;
let now = realNow();
Date.now = () => now;
try {
  const { classifyApiFootballLimit, fetchApiFootballLiveScores } = await import("../dist/api-football/client.js");
  assert.equal(classifyApiFootballLimit('You have reached the request limit for the day.'), "daily");
  assert.equal(classifyApiFootballLimit('Too many requests per minute'), "minute");
  assert.equal(classifyApiFootballLimit('HTTP error', 429), "minute");
  assert.equal(classifyApiFootballLimit('Invalid API key'), null);
  await assert.rejects(fetchApiFootballLiveScores(), /per minute/);
  await assert.rejects(fetchApiFootballLiveScores(), /rate-limited until/);
  assert.equal(calls, 1, "cooldown must prevent another provider request");
  now += 65_001;
  assert.deepEqual(await fetchApiFootballLiveScores(), []);
  assert.equal(calls, 2, "the feed must recover after the short cooldown");
  console.log("Provider rate-limit tests passed: correct classification, cooldown and recovery");
} finally {
  Date.now = realNow;
}
