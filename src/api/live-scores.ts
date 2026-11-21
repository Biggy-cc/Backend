import { fetchApiFootballLiveScores } from "../api-football/client.js";
import { isApiFootballConfigured } from "../api-football/results.js";

const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);

export type LiveScoreApiItem = {
  id: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  status: string;
  clock: string;
  competition?: string;
  homeLogo?: string;
  awayLogo?: string;
};

function clockFor(status: string): string {
  if (status === "HT") return "HT";
  if (status === "1H") return "1st half";
  if (status === "2H") return "2nd half";
  if (status === "ET" || status === "BT") return "Extra time";
  if (status === "P") return "Penalties";
  return status;
}

export async function getLiveScoresPayload(): Promise<LiveScoreApiItem[]> {
  if (!isApiFootballConfigured()) return [];
  const scores = await fetchApiFootballLiveScores();
  return scores
    .filter((row) => LIVE_STATUSES.has(row.status.toUpperCase()))
    .map((row) => ({
      id: String(row.fixtureId),
      home: row.homeTeam,
      away: row.awayTeam,
      homeScore: row.home,
      awayScore: row.away,
      status: row.status,
      clock: clockFor(row.status.toUpperCase()),
      competition: row.competition,
      homeLogo: row.homeLogo,
      awayLogo: row.awayLogo,
    }));
}
