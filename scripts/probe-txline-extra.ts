import "dotenv/config";
import axios from "axios";

async function authHeaders() {
  const origin = "https://txline.txodds.com";
  const jwt = (await axios.post(`${origin}/auth/guest/start`)).data.token;
  return {
    Authorization: `Bearer ${jwt}`,
    "X-Api-Token": process.env.TXLINE_API_TOKEN!,
  };
}

async function main() {
  const headers = await authHeaders();
  const base = "https://txline.txodds.com/api";
  const fixtureId = 17271370; // sample from docs

  for (const path of [
    `/scores/snapshot/${fixtureId}`,
    `/fixtures/snapshot`,
  ]) {
    try {
      const r = await axios.get(base + path, { headers, timeout: 30000 });
      const data = r.data;
      const preview = Array.isArray(data) ? data[0] : data;
      console.log("OK", path, JSON.stringify(preview).slice(0, 400));
    } catch (e: unknown) {
      const err = e as { response?: { status?: number } };
      console.log("FAIL", path, err.response?.status);
    }
  }
}

main();
