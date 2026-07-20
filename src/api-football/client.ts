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
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
};

type ApiOddValue = { value: string; odd: string };
type ApiBet = { id: number; name: string; values: ApiOddValue[] };
type ApiOddsRow = {
  fixture?: { id: number; date?: string; timestamp?: number };
  league?: { id: number; name: string; country?: string; season?: number };
  bookmakers: ApiBookmaker[];
};

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  assertApiFootballConfigured();
  if (client) return client;
  const cfg = getApiFootballConfig();
  client = axios.create({
    baseURL: cfg.baseUrl,
    timeout: 45_000,
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
  assertBudget(1);
  const res = await getClient().get<ApiEnvelope<T>>(path, { params });
  recordApiFootballCall(1);
  const errors = res.data?.errors;
  if (errors && (Array.isArray(errors) ? errors.length : Object.keys(errors as object).length)) {
    throw new Error(`API-Football error on ${path}: ${JSON.stringify(errors)}`);
  }
  const remaining = res.headers["x-ratelimit-requests-remaining"];
  if (remaining != null) {
    console.log(
      `[api-football] call ok — remaining today (provider): ${remaining} | local budget used: ${getApiFootballCallsToday()}/${getApiFootballConfig().dailyBudget}`
    );
  }
  return res.data.response;
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
  };
}

const NS = new Set(["NS", "TBD", "SCH"]);

function isUpcomingStatus(short?: string): boolean {
  if (!short) return true;
  return NS.has(short.toUpperCase());
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
  if (fixtures.length) setCachedFixtures(fixtures);
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
  const missing = fixtures.filter((f) => {
    if (priced.has(f.FixtureId)) return false;
    if (options?.force) return true;
    const hit = getCachedOdds(f.FixtureId, cfg.oddsTtlMs);
    return !hit?.length;
  });

  let filled = 0;
  for (const fixture of missing) {
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
      console.warn(
        `[api-football] odds fixture=${fixture.FixtureId} failed:`,
        err
      );
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
    console.warn(
      `[api-football] odds fixture=${fixture.FixtureId} failed:`,
      err
    );
    return getCachedOdds(fixture.FixtureId, Number.POSITIVE_INFINITY) ?? [];
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
