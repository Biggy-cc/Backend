import assert from "node:assert/strict";
import { ProviderRequestQueue } from "../dist/api-football/request-queue.js";
const { providerGapMs } = await import("../dist/api-football/client.js");
assert.equal(providerGapMs("free", null), 7000);
assert.equal(providerGapMs("free", 100), 7000);
assert.equal(providerGapMs("free", 7500), 1000);
assert.equal(providerGapMs("paid", null), 1000);

let rejectNext = false;
const queue = new ProviderRequestQueue(() => 20, () => {
  if (rejectNext) { rejectNext = false; throw new Error("paused"); }
});
const order = [];
await queue.enter();
const first = queue.enter(0).then(() => order.push("research 1"));
const second = queue.enter(0).then(() => order.push("research 2"));
const scores = queue.enter(2).then(() => order.push("live scores"));
await Promise.all([first, second, scores]);
assert.deepEqual(order, ["live scores", "research 1", "research 2"]);
rejectNext = true;
await assert.rejects(queue.enter(), /paused/);
await queue.enter();
assert.equal(queue.depth, 0);
const blocker = queue.enter();
const expired = queue.enter(0, 1);
await assert.rejects(expired, /queue timed out/);
await blocker;
assert.equal(queue.depth, 0, "expired work must be removed rather than call the provider later");
console.log("Provider queue tests passed: score priority, FIFO and recovery after failure");
