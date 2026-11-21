import {
  fetchApiFootballLiveScores,
  fetchApiFootballScoresByDate,
} from "../api-football/client.js";
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
  country?: string;
};

export type TodayScoreApiItem = LiveScoreApiItem & {
  kickoffAt?: string;
  country?: string;
  phase: "scheduled" | "live" | "finished" | "other";
  scoreAvailable: boolean;
};

const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "AWD", "WO"]);
const SCHEDULED_STATUSES = new Set(["NS", "TBD"]);

function clockFor(status: string, elapsed?: number): string {
  if (status === "HT") return "HT";
  if (Number.isFinite(elapsed) && elapsed! > 0) return `${elapsed}′`;
  if (status === "1H") return "1st half";
  if (status === "2H") return "2nd half";
  if (status === "ET" || status === "BT") return "Extra time";
  if (status === "P") return "Penalties";
  return status;
}

export async function getLiveScoresPayload(): Promise<LiveScoreApiItem[]> {
  if (!isApiFootballConfigured()) throw new Error("Football provider is not configured");
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
      clock: clockFor(row.status.toUpperCase(), row.elapsed),
      competition: row.competition,
      homeLogo: row.homeLogo,
      awayLogo: row.awayLogo,
      country: row.competitionCountry,
    }));
}

export async function getTodayScoresPayload(date: string): Promise<TodayScoreApiItem[]> {
  if (!isApiFootballConfigured()) throw new Error("Football provider is not configured");
  const [scores, live] = await Promise.all([
    fetchApiFootballScoresByDate(date),
    fetchApiFootballLiveScores(),
  ]);
  const liveById = new Map(live.map((row) => [row.fixtureId, row]));
  return scores.map((row) => {
    row = liveById.get(row.fixtureId) ?? row;
    const status = row.status.toUpperCase();
    const phase = LIVE_STATUSES.has(status) && !liveById.has(row.fixtureId)
      ? "other"
      : LIVE_STATUSES.has(status)
      ? "live"
      : FINISHED_STATUSES.has(status)
        ? "finished"
        : SCHEDULED_STATUSES.has(status)
          ? "scheduled"
          : "other";
    return {
      id: String(row.fixtureId),
      home: row.homeTeam,
      away: row.awayTeam,
      homeScore: row.home,
      awayScore: row.away,
      status,
      clock: phase === "live" ? clockFor(status, row.elapsed) : phase === "finished" ? "FT" : status,
      competition: row.competition,
      homeLogo: row.homeLogo,
      awayLogo: row.awayLogo,
      kickoffAt: row.kickoffAt,
      country: row.competitionCountry,
      phase,
      scoreAvailable: row.scoreAvailable,
    };
  });
}
