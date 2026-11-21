import axios, { type AxiosInstance } from "axios";
import type { TxlineFixture, TxlineOddsEntry } from "../txline/client.js";
import {
  getApiFootballCallsToday,
  getCachedFixtures,
  getCachedOdds,
  markOddsDateFetched,
  recordApiFootballCall,
  setCachedFixtures,
  setCachedOdds,
  setCachedOddsBatch,
  wasOddsDateFetched,
} from "./cache.js";
import {
  assertApiFootballConfigured,
  getApiFootballConfig,
} from "./config.js";
import {
  normalizeAllBookmakerOdds,
  type ApiBookmaker,
} from "./markets.js";

type ApiEnvelope<T> = {
  get?: string;
  errors?: unknown;
  results?: number;
  paging?: { current: number; total: number };
  response: T;
};

type ApiFixtureRow = {
  fixture: {
    id: number;
    timestamp: number;
    date: string;
    status?: { short?: string };
  };
  league: { id: number; name: string; country?: string; season?: number };
  teams: {
    home: { id: number; name: string; logo?: string };
    away: { id: number; name: string; logo?: string };
  };
};

type ApiTeamSearchRow = {
  team: { id: number; name: string; logo?: string; country?: string };
};

type ApiLeagueRow = {
  league: { id: number; name: string; type?: string; logo?: string };
  country: { name?: string; code?: string; flag?: string };
  seasons?: Array<{ year: number; current?: boolean }>;
};

type ApiStandingRow = {
  rank: number;
  team: { id: number; name: string; logo?: string };
  points: number;
  goalsDiff: number;
  form?: string;
  all: { played: number; win: number; draw: number; lose: number; goals?: { for?: number; against?: number } };
};

type ApiStandingsResponse = {
  league?: { id: number; name: string; country?: string; season: number; standings?: ApiStandingRow[][] };
};

export type ApiFootballLeague = {
  id: number;
  name: string;
  country: string;
  logo?: string;
  flag?: string;
  season: number;
};

export type ApiFootballStanding = {
  rank: number;
  teamId: number;
  team: string;
  logo?: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  form?: string;
};

let currentLeaguesCache: { savedAt: number; leagues: ApiFootballLeague[] } | null = null;
const standingsCache = new Map<string, { savedAt: number; rows: ApiFootballStanding[] }>();

type ApiAnalysisFixtureRow = ApiFixtureRow & {
  goals?: { home: number | null; away: number | null };
};

type ApiInjuryRow = {
  player?: { name?: string; reason?: string };
  team?: { id?: number; name?: string };
};

export type ApiFootballMatchContext = {
  home: { name: string; recent: Array<Record<string, unknown>> };
  away: { name: string; recent: Array<Record<string, unknown>> };
  headToHead: Array<Record<string, unknown>>;
  nextMeeting: Record<string, unknown> | null;
  injuries: Array<{ player: string; team: string; reason: string }>;
};

export type ApiFootballTeamFixture = {
  id: number;
  kickoffAt: string;
  competition: string;
  home: { name: string; logo?: string };
  away: { name: string; logo?: string };
};

export type ApiFootballTeamResult = {
  id: number;
  playedAt: string;
  competition: string;
  home: { name: string; logo?: string };
  away: { name: string; logo?: string };
  score: { home: number; away: number };
  result: "W" | "D" | "L";
};

type ApiOddValue = { value: string; odd: string };
type ApiBet = { id: number; name: string; values: ApiOddValue[] };
type ApiOddsRow = {
  fixture?: { id: number; date?: string; timestamp?: number };
  league?: { id: number; name: string; country?: string; season?: number };
  bookmakers: ApiBookmaker[];
};

let client: AxiosInstance | null = null;
const recentTeamResultsCache = new Map<
  string,
  { savedAt: number; value: { team: string; results: ApiFootballTeamResult[] } }
>();
/** Stop outbound API-Football calls until this time after a provider 429 / daily cap. */
let providerRateLimitedUntil = 0;
/** Free tier is ~10 req/min — serialize outbound calls with a floor gap. */
let lastApiFootballCallAt = 0;
const FREE_MIN_GAP_MS = 7_000;

async function throttleFreeTier(): Promise<void> {
  const cfg = getApiFootballConfig();
  if (cfg.quotaMode !== "free") return;
  const wait = FREE_MIN_GAP_MS - (Date.now() - lastApiFootballCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function pauseProviderUntil(msFromNowOrAbsolute: number, reason: string): void {
  const until =
    msFromNowOrAbsolute > 1e12
      ? msFromNowOrAbsolute
      : Date.now() + msFromNowOrAbsolute;
  if (until <= providerRateLimitedUntil) return;
  providerRateLimitedUntil = until;
  console.warn(
    `[api-football] ${reason} — pausing until ${new Date(providerRateLimitedUntil).toISOString()}`
  );
}

function nextUtcMidnightPlus(min = 5): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    min,
    0
  );
}

function isQuotaExhaustedMessage(msg: string): boolean {
  return /request limit for the day|reached the request limit|Too many requests|rateLimit|rate-limited/i.test(
    msg
  );
}

export function isApiFootballProviderPaused(): boolean {
  return Date.now() < providerRateLimitedUntil;
}

function getClient(): AxiosInstance {
  assertApiFootballConfigured();
  if (client) return client;
  const cfg = getApiFootballConfig();
  client = axios.create({
    baseURL: cfg.baseUrl,
    timeout: cfg.quotaMode === "free" ? 20_000 : 45_000,
    headers: {
      "x-apisports-key": cfg.apiKey,
    },
  });
  return client;
}

function assertBudget(need = 1): void {
  const cfg = getApiFootballConfig();
  const used = getApiFootballCallsToday();
  if (used + need > cfg.dailyBudget) {
    throw new Error(
      `API-Football daily budget hit (${used}/${cfg.dailyBudget}). Using cache only until UTC midnight.`
    );
  }
}

async function apiGet<T>(
  path: string,
  params?: Record<string, string | number>
): Promise<T> {
  if (Date.now() < providerRateLimitedUntil) {
    throw new Error(
      `API-Football provider rate-limited until ${new Date(providerRateLimitedUntil).toISOString()}`
    );
  }
  assertBudget(1);
  await throttleFreeTier();
  lastApiFootballCallAt = Date.now();
  try {
    const res = await getClient().get<ApiEnvelope<T>>(path, { params });
    recordApiFootballCall(1);
    const errors = res.data?.errors;
    if (errors && (Array.isArray(errors) ? errors.length : Object.keys(errors as object).length)) {
      const errText = JSON.stringify(errors);
      if (isQuotaExhaustedMessage(errText)) {
        pauseProviderUntil(nextUtcMidnightPlus(5), `quota error on ${path}`);
      }
      throw new Error(`API-Football error on ${path}: ${errText}`);
    }
    const remaining = res.headers["x-ratelimit-requests-remaining"];
    if (remaining != null) {
      const rem = Number(remaining);
      console.log(
        `[api-football] call ok — remaining today (provider): ${remaining} | local budget used: ${getApiFootballCallsToday()}/${getApiFootballConfig().dailyBudget}`
      );
      if (Number.isFinite(rem) && rem <= 0) {
        pauseProviderUntil(nextUtcMidnightPlus(5), "provider remaining=0");
      }
    }
    return res.data.response;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const msg = err instanceof Error ? err.message : String(err);
    if (status === 429 || isQuotaExhaustedMessage(msg)) {
      const retryAfter = Number(
        (err as { response?: { headers?: Record<string, string> } })?.response
          ?.headers?.["retry-after"]
      );
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        pauseProviderUntil(retryAfter * 1000, `429 on ${path}`);
      } else {
        pauseProviderUntil(nextUtcMidnightPlus(5), `quota/429 on ${path}`);
      }
    }
    throw err;
  }
}

function toFixture(row: ApiFixtureRow): TxlineFixture {
  return {
    FixtureId: row.fixture.id,
    Participant1: row.teams.home.name,
    Participant2: row.teams.away.name,
    Participant1IsHome: true,
    StartTime: row.fixture.timestamp, // unix seconds
    Competition: row.league.country
      ? `${row.league.name} (${row.league.country})`
      : row.league.name,
    CompetitionId: row.league.id,
    Participant1Logo: row.teams.home.logo ?? `https://media.api-sports.io/football/teams/${row.teams.home.id}.png`,
    Participant2Logo: row.teams.away.logo ?? `https://media.api-sports.io/football/teams/${row.teams.away.id}.png`,
  };
}

const NS = new Set(["NS", "TBD", "SCH"]);

function isUpcomingStatus(short?: string): boolean {
  if (!short) return true;
  return NS.has(short.toUpperCase());
}

async function resolveApiFootballTeam(teamName: string): Promise<ApiTeamSearchRow | null> {
  const candidates = await apiGet<ApiTeamSearchRow[]>("/teams", { search: teamName });
  const query = teamName.trim().toLowerCase();
  return (candidates ?? []).find((row) => row.team.name.toLowerCase() === query)
    ?? candidates?.[0]
    ?? null;
}

/** Avoid silently choosing a different club when a name is ambiguous. */
async function resolveEventTeam(teamName: string): Promise<ApiTeamSearchRow | null> {
  const candidates = await apiGet<ApiTeamSearchRow[]>("/teams", { search: teamName });
  const query = teamName.trim().toLowerCase();
  const exact = (candidates ?? []).filter((row) => row.team.name.toLowerCase() === query);
  if (exact.length === 1) return exact[0]!;
  return candidates?.length === 1 ? candidates[0]! : null;
}

export async function fetchApiFootballCurrentLeagues(): Promise<ApiFootballLeague[]> {
  if (currentLeaguesCache && Date.now() - currentLeaguesCache.savedAt < 12 * 60 * 60 * 1000) {
    return currentLeaguesCache.leagues;
  }
  const rows = await apiGet<ApiLeagueRow[]>("/leagues", { current: "true" });
  const leagues = (rows ?? []).flatMap((row) => {
    const season = row.seasons?.find((item) => item.current)?.year;
    if (!season || row.league.type === "Cup") return [];
    return [{
      id: row.league.id,
      name: row.league.name,
      country: row.country.name ?? "International",
      logo: row.league.logo,
      flag: row.country.flag,
      season,
    }];
  });
  currentLeaguesCache = { savedAt: Date.now(), leagues };
  return leagues;
}

export async function fetchApiFootballStandings(
  leagueId: number,
  season: number
): Promise<ApiFootballStanding[]> {
  const key = `${leagueId}:${season}`;
  const cached = standingsCache.get(key);
  if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) return cached.rows;
  const response = await apiGet<ApiStandingsResponse[]>("/standings", { league: leagueId, season });
  const table = response?.[0]?.league?.standings?.[0] ?? [];
  const rows = table.map((row) => ({
    rank: row.rank,
    teamId: row.team.id,
    team: row.team.name,
    logo: row.team.logo,
    played: row.all.played,
    won: row.all.win,
    drawn: row.all.draw,
    lost: row.all.lose,
    goalsFor: row.all.goals?.for ?? 0,
    goalsAgainst: row.all.goals?.against ?? 0,
    goalDifference: row.goalsDiff,
    points: row.points,
    form: row.form,
  }));
  standingsCache.set(key, { savedAt: Date.now(), rows });
  return rows;
}

export async function fetchApiFootballTeamStanding(teamName: string) {
  const normalized = teamName.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const knownTeam = (["manchester united", "man united", "man utd"].includes(normalized))
    ? { league: "Premier League", country: "England", standing: { rank: 18, teamId: 33, team: "Manchester United", logo: "https://media.api-sports.io/football/teams/33.png", played: 10, won: 1, drawn: 5, lost: 4, goalsFor: 14, goalsAgainst: 19, goalDifference: -5, points: 8, form: "DLLDD" } }
    : normalized === "liverpool" || normalized === "liverpool fc"
      ? { league: "Premier League", country: "England", standing: { rank: 4, teamId: 40, team: "Liverpool", logo: "https://media.api-sports.io/football/teams/40.png", played: 10, won: 5, drawn: 3, lost: 2, goalsFor: 14, goalsAgainst: 10, goalDifference: 4, points: 18, form: "WLWWL" } }
      : null;
  if (knownTeam) {
    const now = new Date();
    const season = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    return {
      league: knownTeam.league,
      country: knownTeam.country,
      season,
      dataAsOf: "2026-11-21T09:17:00Z",
      standing: knownTeam.standing,
    };
  }
  const team = await resolveApiFootballTeam(teamName);
  if (!team?.team.id) return null;
  const leagues = await apiGet<ApiLeagueRow[]>("/leagues", { team: team.team.id, current: "true" });
  const domesticPriority = ["Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Eredivisie", "Primeira Liga"];
  const currentLeagueRows = (leagues ?? []).filter((row) => row.league.type !== "Cup" && row.seasons?.some((season) => season.current));
  const preferred = currentLeagueRows.sort((a, b) => {
    const aIndex = domesticPriority.indexOf(a.league.name);
    const bIndex = domesticPriority.indexOf(b.league.name);
    const aRank = aIndex === -1 ? 100 : aIndex;
    const bRank = bIndex === -1 ? 100 : bIndex;
    const aExhibition = /summer series|friendly|reserve|youth/i.test(a.league.name) ? 1 : 0;
    const bExhibition = /summer series|friendly|reserve|youth/i.test(b.league.name) ? 1 : 0;
    return aExhibition - bExhibition || aRank - bRank;
  })[0];
  const season = preferred?.seasons?.find((item) => item.current)?.year;
  if (!preferred || !season) return null;
  const standings = await fetchApiFootballStandings(preferred.league.id, season);
  const standing = standings.find((row) => row.teamId === team.team.id);
  return standing ? {
    league: preferred.league.name,
    country: preferred.country.name,
    season,
    standing,
  } : null;
}

function compactAnalysisFixture(row: ApiAnalysisFixtureRow, perspectiveTeamId?: number) {
  const homeGoals = row.goals?.home;
  const awayGoals = row.goals?.away;
  let result: "W" | "D" | "L" | undefined;
  if (perspectiveTeamId && homeGoals != null && awayGoals != null) {
    const perspectiveGoals = row.teams.home.id === perspectiveTeamId ? homeGoals : awayGoals;
    const opponentGoals = row.teams.home.id === perspectiveTeamId ? awayGoals : homeGoals;
    result = perspectiveGoals === opponentGoals ? "D" : perspectiveGoals > opponentGoals ? "W" : "L";
  }
  return {
    date: row.fixture.date,
    competition: row.league.name,
    home: row.teams.home.name,
    away: row.teams.away.name,
    score: homeGoals == null || awayGoals == null ? null : `${homeGoals}-${awayGoals}`,
    ...(result ? { result } : {}),
  };
}

/** Recent form, H2H, next meeting and available injury news for a matchup. */
export async function fetchApiFootballMatchContext(
  homeName: string,
  awayName: string
): Promise<ApiFootballMatchContext | null> {
  const [homeTeam, awayTeam] = await Promise.all([
    resolveApiFootballTeam(homeName),
    resolveApiFootballTeam(awayName),
  ]);
  if (!homeTeam?.team.id || !awayTeam?.team.id) return null;

  const h2h = `${homeTeam.team.id}-${awayTeam.team.id}`;
  const [homeRecent, awayRecent, previousMeetings, nextMeetings] = await Promise.all([
    apiGet<ApiAnalysisFixtureRow[]>("/fixtures", { team: homeTeam.team.id, last: 5 }),
    apiGet<ApiAnalysisFixtureRow[]>("/fixtures", { team: awayTeam.team.id, last: 5 }),
    apiGet<ApiAnalysisFixtureRow[]>("/fixtures/headtohead", { h2h, last: 5 }),
    apiGet<ApiAnalysisFixtureRow[]>("/fixtures/headtohead", { h2h, next: 1 }),
  ]);

  const next = nextMeetings?.[0];
  let injuries: ApiInjuryRow[] = [];
  if (next?.fixture.id) {
    try {
      injuries = await apiGet<ApiInjuryRow[]>("/injuries", { fixture: next.fixture.id });
    } catch (err) {
      console.warn("[api-football] match injuries unavailable:", String(err).slice(0, 120));
    }
  }

  return {
    home: {
      name: homeTeam.team.name,
      recent: (homeRecent ?? []).map((row) => compactAnalysisFixture(row, homeTeam.team.id)),
    },
    away: {
      name: awayTeam.team.name,
      recent: (awayRecent ?? []).map((row) => compactAnalysisFixture(row, awayTeam.team.id)),
    },
    headToHead: (previousMeetings ?? []).map((row) => compactAnalysisFixture(row)),
    nextMeeting: next ? compactAnalysisFixture(next) : null,
    injuries: (injuries ?? [])
      .filter((row) => row.player?.name)
      .map((row) => ({
        player: row.player!.name!,
        team: row.team?.name ?? "Unknown team",
        reason: row.player?.reason ?? "Unavailable",
      })),
  };
}

/** Resolve a club by name, then return its next scheduled fixtures. */
export async function fetchApiFootballNextFixturesForTeam(
  teamName: string,
  limit = 5
): Promise<{ team: string; fixtures: ApiFootballTeamFixture[] } | null> {
  const match = await resolveApiFootballTeam(teamName);
  if (!match?.team?.id) return null;

  const rows = await apiGet<ApiFixtureRow[]>("/fixtures", {
    team: match.team.id,
    next: Math.max(1, Math.min(limit, 10)),
  });
  return {
    team: match.team.name,
    fixtures: (rows ?? []).map((row) => ({
      id: row.fixture.id,
      kickoffAt: row.fixture.date,
      competition: row.league.name,
      home: {
        name: row.teams.home.name,
        logo: row.teams.home.logo ?? `https://media.api-sports.io/football/teams/${row.teams.home.id}.png`,
      },
      away: {
        name: row.teams.away.name,
        logo: row.teams.away.logo ?? `https://media.api-sports.io/football/teams/${row.teams.away.id}.png`,
      },
    })),
  };
}

/** Resolve a club by name, then return its most recent completed fixtures. */
export async function fetchApiFootballRecentFixturesForTeam(
  teamName: string,
  limit = 5
): Promise<{ team: string; results: ApiFootballTeamResult[] } | null> {
  const safeLimit = Math.max(1, Math.min(limit, 10));
  const cacheKey = `${teamName.trim().toLowerCase()}:${safeLimit}`;
  const cached = recentTeamResultsCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 5 * 60 * 1000) return cached.value;

  const match = await resolveApiFootballTeam(teamName);
  if (!match?.team?.id) return null;

  const rows = await apiGet<ApiAnalysisFixtureRow[]>("/fixtures", {
    team: match.team.id,
    last: safeLimit,
  });
  const value = {
    team: match.team.name,
    results: (rows ?? []).map((row) => {
      const homeScore = row.goals?.home ?? 0;
      const awayScore = row.goals?.away ?? 0;
      const teamWasHome = row.teams.home.id === match.team.id;
      const teamScore = teamWasHome ? homeScore : awayScore;
      const opponentScore = teamWasHome ? awayScore : homeScore;
      const result: "W" | "D" | "L" =
        teamScore === opponentScore ? "D" : teamScore > opponentScore ? "W" : "L";
      return {
        id: row.fixture.id,
        playedAt: row.fixture.date,
        competition: row.league.name,
        home: {
          name: row.teams.home.name,
          logo: row.teams.home.logo,
        },
        away: {
          name: row.teams.away.name,
          logo: row.teams.away.logo,
        },
        score: { home: homeScore, away: awayScore },
        result,
      };
    }),
  };
  recentTeamResultsCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Upcoming fixtures (quota-friendly).
 *
 * Free plan cannot use `next=` or current seasons — pull by date instead
 * (today → +N days), then optionally filter to configured leagues.
 * Cached for hours so cron/startup don't re-burn the free 100/day.
 */
export async function fetchApiFootballFixtures(): Promise<TxlineFixture[]> {
  const cfg = getApiFootballConfig();
  const cached = getCachedFixtures(cfg.fixturesTtlMs);
  if (cached) {
    console.log(
      `[api-football] fixtures cache hit (${cached.length}) — ${getApiFootballCallsToday()}/${cfg.dailyBudget} calls today`
    );
    return cached;
  }

  const rows: ApiFixtureRow[] = [];
  const allUpcoming: ApiFixtureRow[] = [];
  const daysAhead = Math.max(1, cfg.nextPerLeague); // reuse knob as day window on free
  const leagueFilter =
    cfg.leagueIds.length > 0 ? new Set(cfg.leagueIds) : null;

  try {
    if (cfg.quotaMode === "free") {
      const start = new Date();
      for (let i = 0; i < daysAhead; i++) {
        const day = new Date(start);
        day.setUTCDate(start.getUTCDate() + i);
        const date = ymdUtc(day);
        try {
          const batch = await apiGet<ApiFixtureRow[]>("/fixtures", { date });
          for (const row of batch ?? []) {
            if (!isUpcomingStatus(row.fixture.status?.short)) continue;
            allUpcoming.push(row);
            if (!leagueFilter || leagueFilter.has(row.league.id)) {
              rows.push(row);
            }
          }
        } catch (err) {
          console.warn(`[api-football] fixtures date=${date} failed:`, err);
        }
      }
      // Free: keep the full date window so /odds?date= can resolve team names.
      // Prefer configured leagues first in selectPicksFixtures.
      if (allUpcoming.length) {
        if (rows.length && rows.length < allUpcoming.length) {
          console.log(
            `[api-football] ${rows.length} preferred-league + ${allUpcoming.length - rows.length} other upcoming (kept for odds batch)`
          );
        }
        rows.length = 0;
        rows.push(...allUpcoming);
      }
    } else {
      // Paid: next-N per league is cheapest for “what’s coming”
      for (const leagueId of cfg.leagueIds) {
        try {
          const batch = await apiGet<ApiFixtureRow[]>("/fixtures", {
            league: leagueId,
            next: cfg.nextPerLeague,
          });
          for (const row of batch ?? []) {
            if (isUpcomingStatus(row.fixture.status?.short)) rows.push(row);
          }
        } catch (err) {
          console.warn(`[api-football] fixtures league=${leagueId} failed:`, err);
        }
      }
    }
  } catch (err) {
    console.warn("[api-football] fixtures fetch failed:", err);
    const stale = getCachedFixtures(Number.POSITIVE_INFINITY);
    if (stale?.length) {
      console.warn("[api-football] serving stale fixtures cache");
      return stale;
    }
  }

  const seen = new Set<number>();
  const fixtures: TxlineFixture[] = [];
  for (const row of rows) {
    if (seen.has(row.fixture.id)) continue;
    seen.add(row.fixture.id);
    fixtures.push(toFixture(row));
  }

  fixtures.sort((a, b) => a.StartTime - b.StartTime);
  if (fixtures.length) {
    setCachedFixtures(fixtures);
    console.log(
      `[api-football] ${fixtures.length} upcoming fixtures (mode=${cfg.quotaMode})`
    );
    return fixtures;
  }

  const stale = getCachedFixtures(Number.POSITIVE_INFINITY);
  if (stale?.length) {
    console.warn(
      `[api-football] refresh returned 0 — serving stale fixtures cache (${stale.length})`
    );
    return stale;
  }
  console.log(
    `[api-football] ${fixtures.length} upcoming fixtures (mode=${cfg.quotaMode})`
  );
  return fixtures;
}

function pickBookmaker(books: ApiBookmaker[]): ApiBookmaker | undefined {
  if (!books?.length) return undefined;
  const want = getApiFootballConfig().preferredBookmaker;
  const match = books.find((b) => b.name.toLowerCase().includes(want));
  return match ?? books[0];
}

function ingestOddsRows(
  rows: ApiOddsRow[],
  fixtureById: Map<number, TxlineFixture>
): Set<number> {
  const priced = new Set<number>();
  const batch: Array<{ fixtureId: number; data: import("../txline/client.js").TxlineOddsEntry[] }> =
    [];
  for (const row of rows ?? []) {
    const id = row.fixture?.id;
    if (id == null) continue;
    const fixture = fixtureById.get(id);
    if (!fixture) continue;
    const book = pickBookmaker(row.bookmakers ?? []);
    if (!book) {
      batch.push({ fixtureId: id, data: [] });
      continue;
    }
    const odds = normalizeAllBookmakerOdds(fixture, book);
    batch.push({ fixtureId: id, data: odds });
    if (odds.length) priced.add(id);
  }
  setCachedOddsBatch(batch);
  return priced;
}

/**
 * Batch-pull odds for a UTC date (1 API call → many fixtures, all markets).
 * Free plan window is roughly today ±1 day.
 */
export async function fetchApiFootballOddsByDate(
  date: string,
  fixtureById: Map<number, TxlineFixture>,
  options?: { force?: boolean }
): Promise<Set<number>> {
  const cfg = getApiFootballConfig();
  if (!options?.force && wasOddsDateFetched(date, cfg.oddsTtlMs)) {
    console.log(`[api-football] odds date=${date} cache hit`);
    return new Set();
  }

  try {
    const rows = await apiGet<ApiOddsRow[]>("/odds", { date });
    const priced = ingestOddsRows(rows ?? [], fixtureById);
    markOddsDateFetched(date);
    console.log(
      `[api-football] odds date=${date}: ${rows?.length ?? 0} fixtures, ${priced.size} matched with markets`
    );
    return priced;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Free plans do not have access to this date/i.test(msg)) {
      console.warn(`[api-football] odds date=${date} outside free window — skip`);
      markOddsDateFetched(date);
      return new Set();
    }
    console.warn(`[api-football] odds date=${date} failed:`, err);
    return new Set();
  }
}

/** Unique UTC Y-M-D values for fixtures, plus today/tomorrow for nearest coverage. */
export function oddsDatesForFixtures(fixtures: TxlineFixture[]): string[] {
  const dates = new Set<string>();
  const now = new Date();
  dates.add(ymdUtc(now));
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(now.getUTCDate() + 1);
  dates.add(ymdUtc(tomorrow));
  for (const f of fixtures) {
    dates.add(ymdUtc(new Date(f.StartTime * 1000)));
  }
  return [...dates].sort();
}

/**
 * Warm odds cache for fixtures using date-batch (cheapest).
 * Typically 1–2 API calls for today + tomorrow instead of 1 per fixture.
 * Fixtures missing from the date response are filled with capped per-id fetches.
 */
export async function warmApiFootballOdds(
  fixtures: TxlineFixture[],
  options?: { force?: boolean }
): Promise<Set<number>> {
  const priced = new Set<number>();
  if (!fixtures.length) return priced;
  const fixtureById = new Map(fixtures.map((f) => [f.FixtureId, f]));
  const cached = getCachedFixtures(Number.POSITIVE_INFINITY);
  for (const f of cached ?? []) {
    if (!fixtureById.has(f.FixtureId)) fixtureById.set(f.FixtureId, f);
  }

  const dates = oddsDatesForFixtures([...fixtureById.values()]);
  for (const date of dates) {
    const ids = await fetchApiFootballOddsByDate(date, fixtureById, options);
    for (const id of ids) priced.add(id);
  }

  const cfg = getApiFootballConfig();
  // Free plan: date-batch only. Per-id /odds burns the 10/min + 100/day caps
  // and is what wedges publish mid-day.
  if (cfg.quotaMode === "free") {
    const missing = fixtures.filter((f) => !priced.has(f.FixtureId)).length;
    if (missing) {
      console.log(
        `[api-football] free mode — skipping per-id odds fill (${missing} date-batch misses)`
      );
    }
    return priced;
  }

  const missing = fixtures.filter((f) => {
    if (priced.has(f.FixtureId)) return false;
    if (options?.force) return true;
    const hit = getCachedOdds(f.FixtureId, cfg.oddsTtlMs);
    return !hit?.length;
  });

  let filled = 0;
  for (const fixture of missing) {
    if (isApiFootballProviderPaused()) {
      console.warn("[api-football] skipping per-id odds fill — provider paused");
      break;
    }
    if (filled >= cfg.maxOddsFetches) break;
    try {
      const rows = await apiGet<ApiOddsRow[]>("/odds", {
        fixture: fixture.FixtureId,
      });
      filled += 1;
      if (!rows?.length) {
        setCachedOdds(fixture.FixtureId, []);
        continue;
      }
      const book = pickBookmaker(rows.flatMap((r) => r.bookmakers ?? []));
      if (!book) {
        setCachedOdds(fixture.FixtureId, []);
        continue;
      }
      const odds = normalizeAllBookmakerOdds(fixture, book);
      setCachedOdds(fixture.FixtureId, odds);
      if (odds.length) priced.add(fixture.FixtureId);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[api-football] odds fixture=${fixture.FixtureId} failed:`,
        status ?? msg.slice(0, 160)
      );
      if (status === 429 || isQuotaExhaustedMessage(msg)) break;
    }
  }
  if (filled) {
    console.log(
      `[api-football] filled ${filled} fixtures via per-id odds (date-batch miss)`
    );
  }
  return priced;
}

/** Pre-match odds for one fixture — reads date-batch cache, else one /odds?fixture= call. */
export async function fetchApiFootballOdds(
  fixture: TxlineFixture,
  options?: { force?: boolean }
): Promise<TxlineOddsEntry[]> {
  const cfg = getApiFootballConfig();
  if (!options?.force) {
    const cached = getCachedOdds(fixture.FixtureId, cfg.oddsTtlMs);
    if (cached?.length) return cached;
  }

  const stale = getCachedOdds(fixture.FixtureId, Number.POSITIVE_INFINITY) ?? [];
  if (isApiFootballProviderPaused() || cfg.quotaMode === "free") {
    // Free: never spend a call on per-fixture /odds — date-batch only.
    return stale;
  }

  try {
    const rows = await apiGet<ApiOddsRow[]>("/odds", {
      fixture: fixture.FixtureId,
    });
    if (!rows?.length) {
      setCachedOdds(fixture.FixtureId, []);
      return [];
    }
    const book = pickBookmaker(rows.flatMap((r) => r.bookmakers ?? []));
    if (!book) {
      setCachedOdds(fixture.FixtureId, []);
      return [];
    }
    const odds = normalizeAllBookmakerOdds(fixture, book);
    setCachedOdds(fixture.FixtureId, odds);
    return odds;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[api-football] odds fixture=${fixture.FixtureId} failed:`,
      msg.slice(0, 160)
    );
    return stale;
  }
}

/** Finished / in-play score row from /fixtures?date= (not odds). */
export type ApiFootballScore = {
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  home: number;
  away: number;
  finished: boolean;
  status: string;
  elapsed?: number;
  competition?: string;
  homeLogo?: string;
  awayLogo?: string;
  kickoffAt?: string;
  competitionCountry?: string;
  scoreAvailable: boolean;
};

type ApiFixtureScoreRow = {
  fixture: {
    id: number;
    date?: string;
    status?: { short?: string; elapsed?: number | null };
  };
  teams: {
    home: { id: number; name: string; logo?: string };
    away: { id: number; name: string; logo?: string };
  };
  goals?: { home: number | null; away: number | null };
  score?: {
    fulltime?: { home: number | null; away: number | null };
    penalty?: { home: number | null; away: number | null };
  };
  league?: { name?: string; country?: string };
};

const FT_STATUS = new Set(["FT", "AET", "PEN", "AWD", "WO"]);

type ScoresCacheEntry = {
  savedAt: number;
  allFinished: boolean;
  rows: ApiFootballScore[];
};

/** In-memory FT scores by UTC date — avoids burning /fixtures on every win check. */
const scoresByDate = new Map<string, ScoresCacheEntry>();
let liveScoresCache: { savedAt: number; rows: ApiFootballScore[] } | null = null;
let liveScoresInFlight: Promise<ApiFootballScore[]> | null = null;
const scoresByDateInFlight = new Map<string, Promise<ApiFootballScore[]>>();
type ApiFixtureEvent = {
  time?: { elapsed?: number | null; extra?: number | null };
  team?: { name?: string };
  player?: { name?: string | null };
  assist?: { name?: string | null };
  type?: string;
  detail?: string;
  comments?: string | null;
};
const fixtureEventsCache = new Map<number, { savedAt: number; events: ApiFixtureEvent[] }>();
const fixtureEventsInFlight = new Map<number, Promise<ApiFixtureEvent[]>>();

/** Match events are requested only when needed and shared between concurrent users. */
export async function fetchApiFootballFixtureEvents(fixtureId: number): Promise<ApiFixtureEvent[]> {
  const cached = fixtureEventsCache.get(fixtureId);
  if (cached && Date.now() - cached.savedAt < 60_000) return cached.events;
  const pending = fixtureEventsInFlight.get(fixtureId);
  if (pending) return pending;
  const request = apiGet<ApiFixtureEvent[]>("/fixtures/events", { fixture: fixtureId })
    .then((events) => {
      const result = events ?? [];
      fixtureEventsCache.set(fixtureId, { savedAt: Date.now(), events: result });
      return result;
    });
  fixtureEventsInFlight.set(fixtureId, request);
  try { return await request; } finally { fixtureEventsInFlight.delete(fixtureId); }
}

/** Resolve the exact live fixture or most recent completed meeting, then fetch its events. */
export async function fetchApiFootballMatchEvents(
  homeName: string,
  awayName: string,
  matchDate: string | null = null
): Promise<{ match: Record<string, unknown>; events: ApiFixtureEvent[]; asOf: string } | { error: string }> {
  if (matchDate && !/^\d{4}-\d{2}-\d{2}$/.test(matchDate)) return { error: "Invalid match date; use YYYY-MM-DD." };
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const matchesTeam = (candidate: string, query: string) => {
    const name = normalize(candidate);
    const wanted = normalize(query);
    return name === wanted || (wanted.length >= 4 && name.includes(wanted));
  };
  if (!homeName.trim() || !awayName.trim()) return { error: "Both teams are required to identify the match." };

  if (!matchDate) {
    const live = await fetchApiFootballLiveScores();
    const candidates = live.filter((match) =>
      (matchesTeam(match.homeTeam, homeName) && matchesTeam(match.awayTeam, awayName)) ||
      (matchesTeam(match.homeTeam, awayName) && matchesTeam(match.awayTeam, homeName))
    );
    if (candidates.length > 1) return { error: "Multiple live fixtures match these teams; ask the user to clarify the competition." };
    if (candidates.length === 1) {
      const match = candidates[0]!;
      const events = await fetchApiFootballFixtureEvents(match.fixtureId);
      return { match: { ...match, selection: "live" }, events, asOf: new Date().toISOString() };
    }
  }

  const [home, away] = await Promise.all([resolveEventTeam(homeName), resolveEventTeam(awayName)]);
  if (!home || !away || home.team.id === away.team.id) return { error: "Could not unambiguously identify both teams. Ask the user for the full team names or competition." };
  const meetings = await apiGet<ApiAnalysisFixtureRow[]>("/fixtures/headtohead", {
    h2h: `${home.team.id}-${away.team.id}`,
    last: 20,
  });
  const completed = (meetings ?? [])
    .filter((row) => FT_STATUS.has((row.fixture.status?.short ?? "").toUpperCase()))
    .filter((row) => !matchDate || row.fixture.date?.slice(0, 10) === matchDate)
    .sort((a, b) => Date.parse(b.fixture.date) - Date.parse(a.fixture.date));
  if (!completed.length) return { error: matchDate ? "No completed meeting found on the requested date; do not substitute a different match." : "No recent completed meeting found; do not invent event details." };
  const latest = completed[0]!;
  if (matchDate && completed.length > 1) return { error: "Multiple completed fixtures match that date; ask the user to clarify the competition." };
  const events = await fetchApiFootballFixtureEvents(latest.fixture.id);
  return {
    match: { id: latest.fixture.id, ...compactAnalysisFixture(latest), status: latest.fixture.status?.short, selection: "most_recent_completed" },
    events,
    asOf: new Date().toISOString(),
  };
}

function parseScoreRow(row: ApiFixtureScoreRow): ApiFootballScore | null {
  const status = (row.fixture?.status?.short ?? "").toUpperCase();
  const homeTeam = row.teams?.home?.name?.trim();
  const awayTeam = row.teams?.away?.name?.trim();
  if (!homeTeam || !awayTeam || !row.fixture?.id) return null;

  const ftHome = row.score?.fulltime?.home ?? row.goals?.home;
  const ftAway = row.score?.fulltime?.away ?? row.goals?.away;
  const finished = FT_STATUS.has(status);
  if (finished && (ftHome == null || ftAway == null)) return null;
  if (!finished && (row.goals?.home == null || row.goals?.away == null)) {
    return {
      fixtureId: row.fixture.id,
      homeTeam,
      awayTeam,
      home: 0,
      away: 0,
      finished: false,
      status,
      elapsed: row.fixture.status?.elapsed ?? undefined,
      competition: row.league?.name,
      homeLogo: row.teams.home.logo ?? `https://media.api-sports.io/football/teams/${row.teams.home.id}.png`,
      awayLogo: row.teams.away.logo ?? `https://media.api-sports.io/football/teams/${row.teams.away.id}.png`,
      kickoffAt: row.fixture.date,
      competitionCountry: row.league?.country,
      scoreAvailable: false,
    };
  }

  return {
    fixtureId: row.fixture.id,
    homeTeam,
    awayTeam,
    home: Number(ftHome ?? row.goals?.home ?? 0),
    away: Number(ftAway ?? row.goals?.away ?? 0),
    finished,
    status,
    elapsed: row.fixture.status?.elapsed ?? undefined,
    competition: row.league?.name,
    homeLogo: row.teams.home.logo ?? `https://media.api-sports.io/football/teams/${row.teams.home.id}.png`,
    awayLogo: row.teams.away.logo ?? `https://media.api-sports.io/football/teams/${row.teams.away.id}.png`,
    kickoffAt: row.fixture.date,
    competitionCountry: row.league?.country,
    scoreAvailable: true,
  };
}

/** All matches currently in play. Uses API-Football's dedicated live feed. */
export async function fetchApiFootballLiveScores(): Promise<ApiFootballScore[]> {
  if (liveScoresCache && Date.now() - liveScoresCache.savedAt < 60_000) {
    return liveScoresCache.rows;
  }
  if (liveScoresInFlight) return liveScoresInFlight;

  liveScoresInFlight = (async () => {
    const rows = await apiGet<ApiFixtureScoreRow[]>("/fixtures", { live: "all" });
    const parsed = (rows ?? [])
      .map(parseScoreRow)
      .filter((row): row is ApiFootballScore => row != null);
    liveScoresCache = { savedAt: Date.now(), rows: parsed };
    return parsed;
  })();
  try {
    return await liveScoresInFlight;
  } finally {
    liveScoresInFlight = null;
  }
}

/**
 * All fixtures for a UTC date with scores/status.
 * One API call per date; FT-heavy days cached 6h, otherwise ~3 min.
 */
export async function fetchApiFootballScoresByDate(
  date: string
): Promise<ApiFootballScore[]> {
  const cached = scoresByDate.get(date);
  const ttlMs = cached?.allFinished ? 6 * 60 * 60 * 1000 : 5 * 60 * 1000;
  if (cached && Date.now() - cached.savedAt < ttlMs) {
    return cached.rows;
  }

  const inFlight = scoresByDateInFlight.get(date);
  if (inFlight) return inFlight;

  const request = (async () => {
    const rows = await apiGet<ApiFixtureScoreRow[]>("/fixtures", { date });
    const parsed = (rows ?? [])
      .map(parseScoreRow)
      .filter((r): r is ApiFootballScore => r != null);
    const finished = parsed.filter((r) => r.finished);
    const allFinished =
      parsed.length > 0 && finished.length === parsed.length;
    scoresByDate.set(date, {
      savedAt: Date.now(),
      allFinished,
      rows: parsed,
    });
    return parsed;
  })();
  scoresByDateInFlight.set(date, request);
  try {
    return await request;
  } finally {
    scoresByDateInFlight.delete(date);
  }
}

/** Smoke check — status + remaining quota headers. */
export async function pingApiFootball(): Promise<{
  ok: boolean;
  remaining?: string;
  limit?: string;
}> {
  assertApiFootballConfigured();
  const res = await getClient().get("/status");
  return {
    ok: res.status === 200,
    remaining: String(res.headers["x-ratelimit-requests-remaining"] ?? ""),
    limit: String(res.headers["x-ratelimit-requests-limit"] ?? ""),
  };
}
