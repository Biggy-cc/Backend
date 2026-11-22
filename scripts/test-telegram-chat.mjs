import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_BACKEND = "sqlite";
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "biggy-telegram-test-")), "test.db");
process.env.OPENAI_API_KEY = "test-only";
let secondHadHistory = false;
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body);
  if (payload.input.some((item) => item.content === "first question")) secondHadHistory = true;
  return new Response(JSON.stringify({ output_text: "A football answer." }), { status: 200 });
};
const { runMigrations } = await import("../dist/db/client.js");
await runMigrations();
const { handleFreeformMessage } = await import("../dist/bot/chat.js");
const replies = [];
const ctx = { from: { id: 123, first_name: "Tester" }, chat: { id: 123, type: "private" }, reply: async (message) => replies.push(message), replyWithChatAction: async () => true };
await handleFreeformMessage(ctx, "first question");
await handleFreeformMessage(ctx, "follow-up");
assert.ok(secondHadHistory, "follow-up should include conversation context");
assert.deepEqual(replies, ["A football answer.", "A football answer."]);
for (let i = 0; i < 4; i++) await handleFreeformMessage(ctx, "hello");
assert.match(replies.at(-1), /daily chat limit/i, "Telegram must enforce its daily allowance");
const count = replies.length;
await handleFreeformMessage({ ...ctx, chat: { id: 456, type: "group" } }, "hello");
assert.equal(replies.length, count, "do not leak chat to a group");
console.log("Telegram chat tests passed: context, usage limit and private chats");
