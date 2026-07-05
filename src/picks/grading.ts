import { dbAll } from "../db/client.js";
import {
  isHighlightlyConfigured,
  isHighlightlyFinished,
  loadHighlightlyMatchesForLegs,
  scoreForPickLabel,
  type HighlightlyMatch,
} from "../highlightly/client.js";
import type { PickTier } from "./types.js";
import type { DailyPicksBundle } from "./validate.js";

export type PickLeg = { match: string; selection: string; odds: number };

/** Full-time scores (participant1 vs participant2 order in pick labels). */
export const SETTLED_RESULTS: Record<string, { home: number; away: number }> = {
  "Netherlands vs Morocco": { home: 1, away: 1 },
  "France vs Sweden": { home: 3, away: 0 },
  "Ivory Coast vs Norway": { home: 1, away: 2 },
  "Mexico vs Ecuador": { home: 2, away: 0 },
  "England vs Congo DR": { home: 2, away: 1 },
  "Belgium vs Senegal": { home: 3, away: 2 },
  "USA vs Bosnia & Herzegovina": { home: 2, away: 0 },
  "Spain vs Austria": { home: 3, away: 0 },
  "Portugal vs Croatia": { home: 2, away: 1 },
  "Switzerland vs Algeria": { home: 2, away: 0 },
  "Australia vs Egypt": { home: 1, away: 1 },
  "Argentina vs Cape Verde": { home: 3, away: 2 },
  "Colombia vs Ghana": { home: 1, away: 0 },
};

export type TrackRecordWin = {
  tier: PickTier;
  match: string;
  bet: string;
  odds: string;
  date: string;
};

export type TrackRecordPayload = {
  streak: {
    wins: number;
    total: number;
    label: string;
    tier: PickTier;
  };
  stats: {
    settledLegs: { wins: number; total: number };
    hitLegs: { wins: number; total: number };
  };
  recentWins: TrackRecordWin[];
  updatedAt: string;
};

export function normalizeMatchKey(match: string): string {
  return match.replace(/\s+/g, " ").trim();
}

function parseTeams(match: string): [string, string] | null {
  const parts = normalizeMatchKey(match).split(/\s+vs\s+/i);
  if (parts.length !== 2) return null;
  return [parts[0]!.trim(), parts[1]!.trim()];
}

export function matchScore(match: string): { home: number; away: number } | null {
  return SETTLED_RESULTS[normalizeMatchKey(match)] ?? null;
}

function totalGoals(match: string): number | null {
  const score = matchScore(match);
  if (!score) return null;
  return score.home + score.away;
}

function teamGoals(match: string, team: string): number | null {
  const teams = parseTeams(match);
  const score = matchScore(match);
  if (!teams || !score) return null;
  const t = team.toLowerCase();
  if (teams[0]!.toLowerCase().includes(t) || t.includes(teams[0]!.toLowerCase())) {
    return score.home;
  }
  if (teams[1]!.toLowerCase().includes(t) || t.includes(teams[1]!.toLowerCase())) {
    return score.away;
  }
  return null;
}

function winner(match: string): "home" | "away" | "draw" | null {
  const score = matchScore(match);
  if (!score) return null;
  if (score.home > score.away) return "home";
  if (score.away > score.home) return "away";
  return "draw";
}

function winnerFromScore(
  match: string,
  score: { home: number; away: number }
): "home" | "away" | "draw" {
  if (score.home > score.away) return "home";
  if (score.away > score.home) return "away";
  return "draw";
}

function teamGoalsFromScore(
  match: string,
  team: string,
  score: { home: number; away: number }
): number | null {
  const teams = parseTeams(match);
  if (!teams) return null;
  const t = team.toLowerCase();
  if (teams[0]!.toLowerCase().includes(t) || t.includes(teams[0]!.toLowerCase())) {
    return score.home;
  }
  if (teams[1]!.toLowerCase().includes(t) || t.includes(teams[1]!.toLowerCase())) {
    return score.away;
  }
  return null;
}

/** Grade a leg when full-time score is known. */
export function gradeLegWithScore(
  leg: PickLeg,
  score: { home: number; away: number }
): boolean {
  const match = normalizeMatchKey(leg.match);
  const sel = leg.selection.trim();
  const goals = score.home + score.away;

  const over = sel.match(/^Over\s+([\d.]+)\s+Goals?/i);
  if (over) return goals > parseFloat(over[1]!);

  const under = sel.match(/^Under\s+([\d.]+)\s+Goals?/i);
  if (under) return goals < parseFloat(under[1]!);

  if (/^Draw$/i.test(sel)) return winnerFromScore(match, score) === "draw";

  const win = sel.match(/^(.+?)\s+to\s+Win$/i);
  if (win) {
    const w = winnerFromScore(match, score);
    const team = win[1]!.trim();
    const teams = parseTeams(match)!;
    const isHome =
      teams[0]!.toLowerCase().includes(team.toLowerCase()) ||
      team.toLowerCase().includes(teams[0]!.toLowerCase());
    if (w === "draw") return false;
    if (w === "home") return isHome;
    return !isHome;
  }

  const ah = sel.match(/^(.+?)\s+([+-][\d.]+)\s+AH$/i);
  if (ah) {
    const team = ah[1]!.trim();
    const line = parseFloat(ah[2]!);
    const scored = teamGoalsFromScore(match, team, score);
    if (scored == null) return false;
    const teams = parseTeams(match)!;
    const isHome =
      teams[0]!.toLowerCase().includes(team.toLowerCase()) ||
      team.toLowerCase().includes(teams[0]!.toLowerCase());
    const opp = isHome ? score.away : score.home;
    const adjusted = scored + line - opp;
    if (Math.abs(adjusted) < 0.001) return true;
    return adjusted > 0;
  }

  return false;
}

/** Grade a leg at full time. null = no result yet. */
export function gradeLegAtFullTime(leg: PickLeg): boolean | null {
  const score = matchScore(leg.match);
  if (!score) return null;
  return gradeLegWithScore(leg, score);
}

function gradeLegForRecord(
  leg: PickLeg,
  pickDate: string,
  hlByDate: Map<string, Map<string, HighlightlyMatch>>
): boolean | null {
  const hl = hlByDate.get(pickDate)?.get(normalizeMatchKey(leg.match));
  if (hl && isHighlightlyFinished(hl)) {
    const score = scoreForPickLabel(leg.match, hl);
    if (score) return gradeLegWithScore(leg, score);
  }
  return gradeLegAtFullTime(leg);
}

export type LegLiveProgress = {
  state: "won" | "lost" | "winning" | "losing" | "pending" | "unknown";
  message: string;
};

/** In-play or FT tracking copy for a single leg when score is known. */
export function evaluateLegProgress(
  leg: PickLeg,
  score: { home: number; away: number },
  phase: "live" | "ft"
): LegLiveProgress {
  const goals = score.home + score.away;
  const sel = leg.selection.trim();

  const over = sel.match(/^Over\s+([\d.]+)\s+Goals?/i);
  if (over) {
    const line = parseFloat(over[1]!);
    if (goals > line) {
      return { state: phase === "ft" ? "won" : "winning", message: `${goals} goals — cleared` };
    }
    const need = line - goals + 0.01;
    return {
      state: phase === "ft" ? "lost" : "losing",
      message:
        phase === "ft"
          ? `Finished ${goals} goals — needed ${line}+`
          : `${goals} goals — needs ${Math.ceil(need)} more`,
    };
  }

  const under = sel.match(/^Under\s+([\d.]+)\s+Goals?/i);
  if (under) {
    const line = parseFloat(under[1]!);
    if (goals >= line) {
      return { state: phase === "ft" ? "lost" : "losing", message: `${goals} goals — line busted` };
    }
    return {
      state: phase === "ft" ? "won" : "winning",
      message: `${goals} goals — under ${line} holding`,
    };
  }

  if (/^Draw$/i.test(sel)) {
    const isDraw = score.home === score.away;
    if (phase === "ft") {
      return isDraw
        ? { state: "won", message: "Draw landed" }
        : { state: "lost", message: `Finished ${score.home}-${score.away}` };
    }
    return isDraw
      ? { state: "winning", message: "Level — draw on track" }
      : { state: "losing", message: `${score.home}-${score.away} — needs a leveler` };
  }

  const win = sel.match(/^(.+?)\s+to\s+Win$/i);
  if (win) {
    const team = win[1]!.trim();
    const tg = teamGoalsFromScore(leg.match, team, score);
    const teams = parseTeams(leg.match);
    if (tg == null || !teams) return { state: "unknown", message: sel };
    const isHome =
      teams[0]!.toLowerCase().includes(team.toLowerCase()) ||
      team.toLowerCase().includes(teams[0]!.toLowerCase());
    const teamScore = tg;
    const oppScore = isHome ? score.away : score.home;
    if (teamScore > oppScore) {
      return {
        state: phase === "ft" ? "won" : "winning",
        message: `${team} leading ${teamScore}-${oppScore}`,
      };
    }
    if (teamScore < oppScore) {
      return {
        state: phase === "ft" ? "lost" : "losing",
        message: `${team} trailing ${teamScore}-${oppScore}`,
      };
    }
    return { state: "pending", message: `${teamScore}-${oppScore} — level` };
  }

  const ft = gradeLegWithScore(leg, score);
  if (phase === "ft") {
    return ft
      ? { state: "won", message: "Bet won at full time" }
      : { state: "lost", message: "Bet lost at full time" };
  }

  return { state: "unknown", message: sel };
}

const PROGRESS_EMOJI: Record<LegLiveProgress["state"], string> = {
  won: "✅",
  lost: "❌",
  winning: "🟢",
  losing: "🔴",
  pending: "⚪",
  unknown: "⚽",
};

export function progressEmoji(state: LegLiveProgress["state"]): string {
  return PROGRESS_EMOJI[state];
}

export async function computeTrackRecord(): Promise<TrackRecordPayload> {
  const batches = await dbAll<{
    pick_date: string;
    version: number;
    picks_json: string;
  }>(
    `SELECT pick_date, version, picks_json FROM daily_pick_batches ORDER BY pick_date, version`
  );

  const latestByDate = new Map<string, (typeof batches)[number]>();
  for (const b of batches) {
    const prev = latestByDate.get(b.pick_date);
    if (!prev || b.version > prev.version) latestByDate.set(b.pick_date, b);
  }

  const hlByDate = new Map<string, Map<string, HighlightlyMatch>>();
  if (isHighlightlyConfigured()) {
    for (const [date, batch] of latestByDate) {
      const picks = JSON.parse(batch.picks_json) as DailyPicksBundle["picks"];
      const labels = new Set<string>();
      for (const tier of ["hit", "aim", "go_big"] as PickTier[]) {
        for (const leg of picks[tier]?.legs ?? []) {
          labels.add(leg.match);
        }
      }
      if (labels.size === 0) continue;
      const matches = await loadHighlightlyMatchesForLegs(date, [...labels]);
      hlByDate.set(date, matches);
    }
  }

  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  let legWins = 0;
  let legLosses = 0;
  let hitWins = 0;
  let hitLosses = 0;
  const wonLegs: Array<{ date: string; tier: PickTier; leg: PickLeg }> = [];

  for (const [date, batch] of [...latestByDate.entries()].sort()) {
    const picks = JSON.parse(batch.picks_json) as DailyPicksBundle["picks"];

    for (const tier of tiers) {
      const slip = picks[tier];
      if (!slip?.legs?.length) continue;

      for (const leg of slip.legs) {
        const grade = gradeLegForRecord(leg, date, hlByDate);
        if (grade === null) continue;
        if (grade) {
          legWins++;
          wonLegs.push({ date, tier, leg });
          if (tier === "hit") hitWins++;
        } else {
          legLosses++;
          if (tier === "hit") hitLosses++;
        }
      }
    }
  }

  const hitTotal = hitWins + hitLosses;
  const settledTotal = legWins + legLosses;

  const recentWins: TrackRecordWin[] = wonLegs.slice(-16).map(({ date, tier, leg }) => ({
    tier,
    match: leg.match,
    bet: leg.selection,
    odds: leg.odds.toFixed(2),
    date,
  }));

  return {
    streak: {
      wins: hitWins,
      total: hitTotal,
      label: hitTotal > 0 ? `${hitWins}/${hitTotal}` : "—",
      tier: "hit",
    },
    stats: {
      settledLegs: { wins: legWins, total: settledTotal },
      hitLegs: { wins: hitWins, total: hitTotal },
    },
    recentWins: recentWins.reverse(),
    updatedAt: new Date().toISOString(),
  };
}
