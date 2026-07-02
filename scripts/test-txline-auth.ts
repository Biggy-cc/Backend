import "dotenv/config";
import axios from "axios";

async function main() {
  const origin = "https://txline.txodds.com";
  const jwt = (await axios.post(`${origin}/auth/guest/start`)).data.token;
  const api = process.env.TXLINE_API_TOKEN;

  const attempts = [
    { label: "jwt + X-Api-Token", headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": api } },
    { label: "api token only", headers: { Authorization: `Bearer ${api}` } },
    { label: "jwt only", headers: { Authorization: `Bearer ${jwt}` } },
  ];

  for (const a of attempts) {
    try {
      const r = await axios.get(`${origin}/api/fixtures/snapshot`, {
        headers: a.headers as Record<string, string>,
        timeout: 30_000,
      });
      console.log("OK", a.label, "count:", r.data.length);
    } catch (e: unknown) {
      const err = e as { response?: { status?: number } };
      console.log("FAIL", a.label, err.response?.status);
    }
  }
}

main();
