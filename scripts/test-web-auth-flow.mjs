import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import axios from "axios";
import { Connection, Keypair } from "@solana/web3.js";

process.env.DATABASE_BACKEND = "sqlite";
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "biggy-web-auth-")), "test.db");
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.USDC_RECEIVER_WALLET = Keypair.generate().publicKey.toBase58();
process.env.USDC_MINT = Keypair.generate().publicKey.toBase58();
process.env.API_FOOTBALL_KEY = "test-only";
process.env.API_FOOTBALL_QUOTA_MODE = "paid";
process.env.FOOTBALL_DATA_PROVIDER = "api-football";
process.env.OPENAI_API_KEY = "test-only";
Connection.prototype.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 });
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(sub) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${encode({ alg: "RS256", kid: "test-key" })}.${encode({ iss: "https://accounts.google.com", aud: "test-client", sub, email: `${sub}@example.test`, email_verified: true, name: sub, iat: now, exp: now + 600 })}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
}
const call = (id, name, args) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
globalThis.fetch = async (url, options) => {
  if (String(url).includes("googleapis.com")) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  const payload = JSON.parse(options.body);
  const input = payload.input;
  if (Array.isArray(input) && input.some((x) => typeof x.content === "string" && x.content.startsWith("VERIFIED PARLAY CONTEXT"))) return new Response(JSON.stringify({ id: "p1", output: [call("a", "analyze_match", { home: "Alpha", away: "Beta" }), call("b", "analyze_match", { home: "Gamma", away: "Delta" })] }), { status: 200 });
  if (payload.previous_response_id === "p1") return new Response(JSON.stringify({ id: "p2", output: [call("p", "propose_parlay_for_approval", { title: "Balanced", risk: "balanced", legs: [
    { home: "Alpha", away: "Beta", selection: "Alpha win", kickoffAt: "ignored" },
    { home: "Gamma", away: "Delta", selection: "Over 1.5 goals", kickoffAt: "ignored" },
  ] })] }), { status: 200 });
  return new Response(JSON.stringify({ output_text: payload.previous_response_id === "p2" ? "Review this parlay." : "Hello!" }), { status: 200 });
};
axios.defaults.adapter = async (config) => {
  assert.equal(config.url, "/predictions");
  return { status: 200, statusText: "OK", headers: {}, config, data: { errors: [], response: [{ teams: { home: { last_5: { form: "WWDWW" } }, away: { last_5: { form: "DLLDW" } } } }] } };
};
const { runMigrations } = await import("../dist/db/client.js");
await runMigrations();
const { setCachedFixtures } = await import("../dist/api-football/cache.js");
const kickoff = Math.floor((Date.now() + 86_400_000) / 1000);
setCachedFixtures([
  { FixtureId: 41, Participant1: "Alpha", Participant2: "Beta", Participant1IsHome: true, StartTime: kickoff, Competition: "Premier League", CompetitionId: 39 },
  { FixtureId: 42, Participant1: "Gamma", Participant2: "Delta", Participant1IsHome: true, StartTime: kickoff, Competition: "Premier League", CompetitionId: 39 },
]);
const { startApiServer } = await import("../dist/api/server.js");
const server = startApiServer(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;
function request(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
      let raw = ""; res.on("data", (part) => { raw += part; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on("error", reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
try {
  const freeCredential = token("free-user");
  const paidCredential = token("paid-user");
  assert.equal((await request("/api/google/session", { credential: freeCredential })).body.tier, "free");
  assert.equal((await request("/api/google/session", { credential: paidCredential })).body.tier, "free");
  assert.equal((await request("/api/chat", { message: "build parlay", googleCredential: freeCredential })).status, 403);
  const guestId = "9d0a8a93-52f0-40a9-8fb2-c156e54d0034";
  assert.equal((await request("/api/chat", { message: "build parlay", guestId })).status, 403);
  assert.equal((await request("/api/chat", { message: "hello", guestId })).status, 200);
  assert.equal((await request("/api/chat", { message: "hello", guestId })).status, 200);
  assert.equal((await request("/api/chat", { message: "hello", guestId })).status, 403);
  assert.equal((await request("/api/checkout", { plan: "monthly", tier: "pro" })).status, 401);
  const checkout = await request("/api/checkout", { plan: "monthly", tier: "pro", googleCredential: paidCredential });
  assert.equal(checkout.status, 200);
  assert.equal(checkout.body.checkout.identityProvider, "google");
  assert.equal(checkout.body.checkout.fulfilled, false);
  const { fulfillGooglePayment } = await import("../dist/payments/google-usdc.js");
  await fulfillGooglePayment(checkout.body.checkout.paymentId, "mock-finalized-signature");
  assert.equal((await request("/api/access", { googleCredential: paidCredential })).body.access.tier, "pro");
  const job = await request("/api/chat", { message: "build a balanced parlay", googleCredential: paidCredential });
  assert.equal(job.status, 202);
  let result;
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await request(`/api/chat-job?id=${job.body.jobId}`);
    if (status.body.status === "complete") { result = status.body.result; break; }
    assert.notEqual(status.body.status, "failed");
  }
  assert.equal(result?.parlay?.legs.length, 2, "paid user receives a proposal that requires approval");
  console.log("Web auth integration passed: guest/free limits, Google checkout, paid access and approval-only parlay");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
