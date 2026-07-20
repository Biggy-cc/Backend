const BASE_URL = "https://sports.highlightly.net";
const CACHE_TTL_MS = 90_000;
const DAILY_WARN_AT = 90;

export type HighlightlyMatch = {
  id: number;
  date: string;
  round?: string;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
  league?: { name: string; season?: number };
  state: {
    clock: number | null;
    description: string;
    score: {
      current: string | null;
      penalties: string | null;
    };
  };
};

type MatchesResponse = {
  data: HighlightlyMatch[];
  pagination?: { totalCount: number };
};

type CacheEntry = {
  fetchedAt: number;
  matches: HighlightlyMatch[];
};

const matchCache = new Map<string, CacheEntry>();
let dailyCallCount = 0;
let dailyCallDate = "";
/** Skip outbound calls until this time (Highlightly daily 429). */
let rateLimitedUntil = 0;

function getApiKey(): string | null {
  const key = process.env.HIGHLIGHTLY_API_KEY?.trim();
  return key || null;
}

function trackApiCall(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyCallDate !== today) {
    dailyCallDate = today;
    dailyCallCount = 0;
  }
  dailyCallCount++;
  if (dailyCallCount >= DAILY_WARN_AT) {
    console.warn(`[highlightly] ${dailyCallCount} API calls today (free tier: 100/day)`);
  }
}

function cacheKey(date: string, params: Record<string, string>): string {
  return `${date}:${Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&")}`;
}

function cacheTtlForDate(date: string): number {
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) return 24 * 60 * 60 * 1000;
  return CACHE_TTL_MS;
}

async function fetchMatchesRaw(
  date: string,
  params: Record<string, string> = {},
  options: { fresh?: boolean } = {}
): Promise<HighlightlyMatch[]> {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  const key = cacheKey(date, params);
  const cached = matchCache.get(key);
  const ttl = cacheTtlForDate(date);
  if (!options.fresh && cached && Date.now() - cached.fetchedAt < ttl) {
    return cached.matches;
  }

  if (Date.now() < rateLimitedUntil) {
    return cached?.matches ?? [];
  }

  const url = new URL(`${BASE_URL}/football/matches`);
  url.searchParams.set("date", date);
  url.searchParams.set("limit", "100");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  trackApiCall();
  const res = await fetch(url, {
    headers: { "x-rapidapi-key": apiKey },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) {
      // Free tier daily cap — cool off until ~next UTC midnight (+1h buffer).
      const now = new Date();
      const nextUtcMidnight = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        1,
        0,
        0
      );
      rateLimitedUntil = Math.max(rateLimitedUntil, nextUtcMidnight);
      console.warn(
        `[highlightly] daily limit hit (429) — pausing until ${new Date(rateLimitedUntil).toISOString()}`
      );
    } else {
      console.error("[highlightly] matches failed:", res.status, body.slice(0, 200));
    }
    return cached?.matches ?? [];
  }

  const body = (await res.json()) as MatchesResponse;
  const matches = body.data ?? [];
  matchCache.set(key, { fetchedAt: Date.now(), matches });
  return matches;
}

export function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function teamsMatch(a: string, b: string): boolean {
  const x = normalizeTeamName(a);
  const y = normalizeTeamName(b);
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;

  const aliases: Record<string, string[]> = {
    usa: ["united states", "usmnt", "u s a"],
    "bosnia and herzegovina": ["bosnia", "bosnia herzegovina"],
    "congo dr": ["dr congo", "democratic republic of congo", "congo"],
    "ivory coast": ["cote d ivoire", "côte d ivoire"],
    england: ["great britain"],
  };

  for (const [canonical, list] of Object.entries(aliases)) {
    const all = [canonical, ...list];
    if (all.includes(x) && all.includes(y)) return true;
    if (all.some((t) => x.includes(t) || t.includes(x)) && all.some((t) => y.includes(t) || t.includes(y))) {
      return true;
    }
  }

  return false;
}

function parseTeamsFromLabel(label: string): [string, string] | null {
  const parts = label.split(/\s+vs\s+/i);
  if (parts.length !== 2) return null;
  return [parts[0]!.trim(), parts[1]!.trim()];
}

export function findHighlightlyMatch(
  matchLabel: string,
  pool: HighlightlyMatch[]
): HighlightlyMatch | undefined {
  const teams = parseTeamsFromLabel(matchLabel);
  if (!teams) return undefined;
  const [a, b] = teams;

  return pool.find(
    (m) =>
      (teamsMatch(a, m.homeTeam.name) && teamsMatch(b, m.awayTeam.name)) ||
      (teamsMatch(a, m.awayTeam.name) && teamsMatch(b, m.homeTeam.name))
  );
}

/** One WC list call + optional team lookups for unmatched legs (cached). */
export async function loadHighlightlyMatchesForLegs(
  pickDate: string,
  matchLabels: string[],
  options: { fresh?: boolean } = {}
): Promise<Map<string, HighlightlyMatch>> {
  const out = new Map<string, HighlightlyMatch>();
  if (!getApiKey() || matchLabels.length === 0) return out;

  const fetchOpts = { fresh: options.fresh };
  const pool: HighlightlyMatch[] = [
    ...(await fetchMatchesRaw(pickDate, { leagueName: "World Cup" }, fetchOpts)),
    ...(await fetchMatchesRaw(pickDate, { leagueName: "Friendlies" }, fetchOpts)),
  ];

  for (const label of matchLabels) {
    const key = label.replace(/\s+/g, " ").trim();
    const found = findHighlightlyMatch(key, pool);
    if (found) out.set(key, found);
  }

  const normKey = (label: string) => label.replace(/\s+/g, " ").trim();
  const unmatched = matchLabels.filter((l) => !out.has(normKey(l)));
  const searchedTeams = new Set<string>();

  for (const label of unmatched) {
    const teams = parseTeamsFromLabel(label);
    if (!teams) continue;
    for (const team of teams) {
      const norm = normalizeTeamName(team);
      if (searchedTeams.has(norm)) continue;
      searchedTeams.add(norm);

      const extra = await fetchMatchesRaw(pickDate, { homeTeamName: team }, fetchOpts);
      pool.push(...extra);

      for (const leg of unmatched) {
        const legKey = leg.replace(/\s+/g, " ").trim();
        if (out.has(legKey)) continue;
        const hit = findHighlightlyMatch(leg, pool);
        if (hit) out.set(legKey, hit);
      }
    }
  }

  return out;
}

export function parseHighlightlyScore(
  scoreText: string | null | undefined
): { home: number; away: number } | null {
  if (!scoreText) return null;
  const m = scoreText.replace(/\s+/g, " ").trim().match(/^(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  return { home: parseInt(m[1]!, 10), away: parseInt(m[2]!, 10) };
}

/** Map Highlightly home/away score to pick label order (Team1 vs Team2). */
export function scoreForPickLabel(
  matchLabel: string,
  hl: HighlightlyMatch
): { home: number; away: number } | null {
  const raw = parseHighlightlyScore(hl.state.score.current);
  if (!raw) return null;

  const teams = parseTeamsFromLabel(matchLabel);
  if (!teams) return raw;

  const [t1, t2] = teams;
  if (teamsMatch(t1, hl.homeTeam.name) && teamsMatch(t2, hl.awayTeam.name)) {
    return raw;
  }
  if (teamsMatch(t1, hl.awayTeam.name) && teamsMatch(t2, hl.homeTeam.name)) {
    return { home: raw.away, away: raw.home };
  }
  return raw;
}

export type HighlightlyLiveState = {
  phase: "pre" | "live" | "ft";
  clock: string;
  score: { home: number; away: number } | null;
};

export function highlightlyLiveState(
  hl: HighlightlyMatch,
  nowMs: number = Date.now()
): HighlightlyLiveState {
  const desc = (hl.state.description ?? "").toLowerCase();
  const score = scoreForPickLabel(`${hl.homeTeam.name} vs ${hl.awayTeam.name}`, hl);

  if (desc.includes("finished") || desc.includes("full time") || desc === "ft") {
    return { phase: "ft", clock: "FT", score };
  }

  const liveHints = ["1st", "2nd", "half", "live", "extra", "penalt", "break"];
  const isLive = liveHints.some((h) => desc.includes(h)) || (hl.state.clock != null && hl.state.clock > 0 && !desc.includes("not started"));

  if (isLive) {
    const minute = hl.state.clock ?? "?";
    return { phase: "live", clock: `LIVE · ${minute}'`, score };
  }

  const kickoff = new Date(hl.date).getTime();
  if (Number.isFinite(kickoff) && nowMs < kickoff - 60_000) {
    const ms = kickoff - nowMs;
    const totalMin = Math.max(0, Math.ceil(ms / 60_000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const clock = h > 0 ? `Kickoff in ${h}h ${m}m` : `Kickoff in ${m}m`;
    return { phase: "pre", clock, score: null };
  }

  if (desc.includes("not started") || desc.includes("scheduled")) {
    return { phase: "pre", clock: "Kickoff soon", score: null };
  }

  if (score) {
    return { phase: "ft", clock: desc || "FT", score };
  }

  return { phase: "pre", clock: hl.state.description || "Scheduled", score: null };
}

export function isHighlightlyFinished(hl: HighlightlyMatch): boolean {
  const desc = (hl.state.description ?? "").toLowerCase();
  return desc.includes("finished") || desc.includes("full time") || desc === "ft";
}

export function isHighlightlyConfigured(): boolean {
  return Boolean(getApiKey());
}
