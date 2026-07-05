import "dotenv/config";
import axios from "axios";
import { createTxlineClient, fetchFixturesSnapshot } from "../src/txline/client.js";
import { getTxlineConfig } from "../src/txline/config.js";

async function authHeaders() {
  const cfg = getTxlineConfig();
  const jwt = (await axios.post(`${cfg.apiOrigin}/auth/guest/start`)).data.token;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
  if (process.env.TXLINE_API_TOKEN) {
    headers["X-Api-Token"] = process.env.TXLINE_API_TOKEN;
  }
  return headers;
}

async function main() {
  const client = createTxlineClient();
  const headers = await authHeaders();
  const fixtures = await fetchFixturesSnapshot();
  const past = fixtures
    .filter((f) => f.StartTime * 1000 < Date.now() - 86_400_000)
    .slice(0, 3);
  const fid = past[0]?.FixtureId ?? fixtures[0]?.FixtureId;
  const epochDay = Math.floor(Date.now() / (86_400_000));
  const june29Day = Math.floor(new Date("2026-06-29T00:00:00Z").getTime() / 86_400_000);
  console.log("fixtureId", fid, "epochDay", epochDay, "june29", june29Day);

  const wc = fixtures.filter((f) => /world cup|fifa|friendlies/i.test(f.Competition));
  console.log(
    "wc fixtures",
    wc.slice(0, 6).map((f) => ({
      id: f.FixtureId,
      m: `${f.Participant1} vs ${f.Participant2}`,
      ko: new Date(f.StartTime * 1000).toISOString(),
    }))
  );

  for (const path of [
    `/odds/updates/${epochDay}/12/0`,
    `/odds/updates/${june29Day}/15/0`,
    `/scores/historical/${fid}`,
    `/scores/updates/${june29Day}/18/0`,
    `/scores/updates/${june29Day}/21/0`,
  ]) {
    try {
      const r = await client.get(path, { headers, timeout: 30_000 });
      const d = r.data;
      const preview = Array.isArray(d) ? { len: d.length, first: d[0] } : d;
      console.log("OK", path, JSON.stringify(preview).slice(0, 800));
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: unknown } };
      console.log("FAIL", path, err.response?.status, err.response?.data);
    }
  }
}

main();
