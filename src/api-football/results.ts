/**
 * Full-time scores from API-Football /fixtures?date= — primary grader for
 * track record + win posts (Highlightly is optional fallback).
 */
import {
  fetchApiFootballScoresByDate,
  type ApiFootballScore,
} from "./client.js";
import { getApiFootballConfig } from "./config.js";

export type ApiFootballLegScore = { home: number; away: number };

function normalizeMatchKey(match: string): string {
  return match.replace(/\s+/g, " ").trim();
}

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function teamsMatch(a: string, b: string): boolean {
  const x = normalizeTeamName(a);
  const y = normalizeTeamName(b);
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  return false;
}

function parseTeams(label: string): [string, string] | null {
  const parts = normalizeMatchKey(label).split(/\s+vs\s+/i);
  if (parts.length !== 2) return null;
  return [parts[0]!.trim(), parts[1]!.trim()];
}

/** Map API-Football goals into pick-label home/away order. */
export function scoreForPickLabel(
  matchLabel: string,
  row: ApiFootballScore
): ApiFootballLegScore | null {
  const teams = parseTeams(matchLabel);
  if (!teams) return null;
  const [a, b] = teams;
  if (teamsMatch(a, row.homeTeam) && teamsMatch(b, row.awayTeam)) {
    return { home: row.home, away: row.away };
  }
  if (teamsMatch(a, row.awayTeam) && teamsMatch(b, row.homeTeam)) {
    return { home: row.away, away: row.home };
  }
  return null;
}

export function isApiFootballConfigured(): boolean {
  return Boolean(getApiFootballConfig().apiKey);
}

/** True when pick date is within the last N UTC days (budget guard). */
export function isRecentPickDate(date: string, days = 21): boolean {
  const t = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= days * 86_400_000 && t <= Date.now() + 86_400_000;
}

/**
 * Match pick labels to finished FT scores for a date.
 * One /fixtures?date= call (cached) — free-tier friendly.
 */
export async function loadApiFootballScoresForLegs(
  pickDate: string,
  matchLabels: string[]
): Promise<Map<string, ApiFootballLegScore>> {
  const out = new Map<string, ApiFootballLegScore>();
  if (!isApiFootballConfigured() || matchLabels.length === 0) return out;

  let pool: ApiFootballScore[] = [];
  try {
    pool = await fetchApiFootballScoresByDate(pickDate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[api-football] scores ${pickDate}:`, msg.slice(0, 160));
    return out;
  }

  const finished = pool.filter((r) => r.finished);
  if (finished.length === 0) return out;

  for (const label of matchLabels) {
    const key = normalizeMatchKey(label);
    for (const row of finished) {
      const score = scoreForPickLabel(key, row);
      if (score) {
        out.set(key, score);
        break;
      }
    }
  }

  if (out.size > 0) {
    console.log(
      `[api-football] graded scores ${pickDate}: ${out.size}/${matchLabels.length} legs matched (${finished.length} FT fixtures)`
    );
  }
  return out;
}

export type ApiFootballLiveLeg = {
  home: number;
  away: number;
  phase: "pre" | "live" | "ft";
  clock: string;
  status: string;
};

const PRE_STATUS = new Set(["NS", "TBD", "PST", "CANC", "ABD"]);

function phaseFromStatus(status: string): "pre" | "live" | "ft" {
  const s = status.toUpperCase();
  if (["FT", "AET", "PEN", "AWD", "WO"].includes(s)) return "ft";
  if (PRE_STATUS.has(s) || !s) return "pre";
  return "live";
}

function clockFromStatus(status: string, phase: "pre" | "live" | "ft"): string {
  if (phase === "ft") return "FT";
  if (phase === "pre") return "Scheduled";
  const s = status.toUpperCase();
  if (s === "HT") return "HT";
  if (s === "1H") return "1H";
  if (s === "2H") return "2H";
  if (s === "ET" || s === "BT") return "ET";
  if (s === "P" || s === "PEN") return "Pens";
  return s || "Live";
}

/** Live + FT rows for Telegram live feed — same /fixtures?date= cache as grading. */
export async function loadApiFootballLiveForLegs(
  pickDate: string,
  matchLabels: string[]
): Promise<Map<string, ApiFootballLiveLeg>> {
  const out = new Map<string, ApiFootballLiveLeg>();
  if (!isApiFootballConfigured() || matchLabels.length === 0) return out;

  let pool: ApiFootballScore[] = [];
  try {
    pool = await fetchApiFootballScoresByDate(pickDate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[api-football] live ${pickDate}:`, msg.slice(0, 160));
    return out;
  }

  for (const label of matchLabels) {
    const key = normalizeMatchKey(label);
    for (const row of pool) {
      const score = scoreForPickLabel(key, row);
      if (!score) continue;
      const phase = row.finished ? "ft" : phaseFromStatus(row.status);
      out.set(key, {
        home: score.home,
        away: score.away,
        phase,
        clock: clockFromStatus(row.status, phase),
        status: row.status,
      });
      break;
    }
  }
  return out;
}
