import "dotenv/config";
import {
  fetchFixturesSnapshot,
  fixturesForToday,
  isWorldCupFixture,
} from "../src/txline/client.js";

async function main() {
  const all = await fetchFixturesSnapshot();
  const wc = all.filter(isWorldCupFixture);
  const today = fixturesForToday(wc);

  console.log("PASS: TxLINE API connected");
  console.log("Total fixtures:", all.length);
  console.log("World Cup / friendlies:", wc.length);
  console.log("Today's WC/friendlies:", today.length);

  if (today.length > 0) {
    const f = today[0];
    console.log("Sample:", `${f.Participant1} vs ${f.Participant2} (${f.Competition})`);
  }
}

main().catch((err: unknown) => {
  const e = err as { response?: { status?: number; data?: unknown }; message?: string };
  console.error("FAIL:", e.response?.status, e.response?.data ?? e.message ?? err);
  process.exit(1);
});
