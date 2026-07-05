import {
  createTxlineClient,
  fixtureKickoffMs,
  fixtureLabel,
  isWorldCupFixture,
  normalizeOddsEntries,
  type RawTxlineOdds,
  type TxlineFixture,
  type TxlineOddsEntry,
} from "./client.js";
import { findOddsForSelection } from "../picks/odds-refresh.js";

export type TxlineScoreReplay = {
  home: number;
  away: number;
  finished: boolean;
};

type ScoreUpdateRow = {
  FixtureId?: number;
  Participant1Goals?: number;
  Participant2Goals?: number;
  IsFinished?: boolean;
  Stats?: Record<string, number>;
  Clock?: { Running?: boolean };
  StatusId?: number;
};

function normalizeMatchKey(match: string): string {
  return match.replace(/\s+/g, " ").trim();
}

const fixtureIndexCache = {
  at: 0,
  byLabel: new Map<string, TxlineFixture>(),
};

const FIXTURE_CACHE_MS = 5 * 60_000;
const oddsBatchCache = new Map<string, RawTxlineOdds[]>();
const scoreBatchCache = new Map<string, ScoreUpdateRow[]>();
const scoresByDateCache = new Map<string, Map<string, TxlineScoreReplay>>();
const oddsIndexByDateCache = new Map<string, Map<string, number>>();

async function authHeaders(): Promise<Record<string, string>> {
  const axios = (await import("axios")).default;
  const { getTxlineConfig } = await import("./config.js");
  const cfg = getTxlineConfig();
  const jwt = (await axios.post(`${cfg.apiOrigin}/auth/guest/start`)).data.token as string;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
  const apiToken = process.env.TXLINE_API_TOKEN;
  if (apiToken) headers["X-Api-Token"] = apiToken;
  return headers;
}

export function epochDayFromDate(isoDate: string): number {
  return Math.floor(new Date(`${isoDate}T12:00:00Z`).getTime() / 86_400_000);
}

export async function fetchOddsUpdates(
  epochDay: number,
  hour: number,
  interval = 0
): Promise<RawTxlineOdds[]> {
  const cacheKey = `odds:${epochDay}:${hour}:${interval}`;
  if (oddsBatchCache.has(cacheKey)) {
    return oddsBatchCache.get(cacheKey)!;
  }

  try {
    const client = createTxlineClient();
    const res = await client.get<RawTxlineOdds[]>(
      `/odds/updates/${epochDay}/${hour}/${interval}`,
      { headers: await authHeaders(), timeout: 45_000 }
    );
    const rows = res.data ?? [];
    oddsBatchCache.set(cacheKey, rows);
    return rows;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 404) return [];
    throw err;
  }
}

export async function fetchScoreUpdates(
  epochDay: number,
  hour: number,
  interval = 0
): Promise<ScoreUpdateRow[]> {
  const cacheKey = `scores:${epochDay}:${hour}:${interval}`;
  if (scoreBatchCache.has(cacheKey)) {
    return scoreBatchCache.get(cacheKey)!;
  }

  try {
    const client = createTxlineClient();
    const res = await client.get<ScoreUpdateRow[]>(
      `/scores/updates/${epochDay}/${hour}/${interval}`,
      { headers: await authHeaders(), timeout: 45_000 }
    );
    const rows = res.data ?? [];
    scoreBatchCache.set(cacheKey, rows);
    return rows;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 404) return [];
    throw err;
  }
}

export async function loadFixtureIndex(): Promise<Map<string, TxlineFixture>> {
  const now = Date.now();
  if (now - fixtureIndexCache.at < FIXTURE_CACHE_MS && fixtureIndexCache.byLabel.size > 0) {
    return fixtureIndexCache.byLabel;
  }

  const { fetchFixturesSnapshot } = await import("./client.js");
  const all = await fetchFixturesSnapshot();
  const wc = all.filter(isWorldCupFixture);
  const byLabel = new Map<string, TxlineFixture>();
  for (const f of wc) {
    byLabel.set(normalizeMatchKey(fixtureLabel(f)), f);
  }

  fixtureIndexCache.at = now;
  fixtureIndexCache.byLabel = byLabel;
  return byLabel;
}

function parseScoreRow(row: ScoreUpdateRow): TxlineScoreReplay | null {
  if (row.Participant1Goals != null && row.Participant2Goals != null) {
    return {
      home: row.Participant1Goals,
      away: row.Participant2Goals,
      finished: Boolean(row.IsFinished),
    };
  }

  const stats = row.Stats;
  if (stats && stats["7"] != null && stats["8"] != null) {
    return {
      home: stats["7"],
      away: stats["8"],
      finished: row.IsFinished === true || row.Clock?.Running === false,
    };
  }

  return null;
}

/** Batch-load finished scores for WC fixtures on a pick date (UTC replay windows). */
export async function loadTxlineScoresForDate(
  isoDate: string
): Promise<Map<string, TxlineScoreReplay>> {
  const cacheKey = `scores-date:${isoDate}`;
  if (scoresByDateCache.has(cacheKey)) {
    return scoresByDateCache.get(cacheKey)!;
  }

  const index = await loadFixtureIndex();
  const epochDay = epochDayFromDate(isoDate);
  const byFixture = new Map<number, TxlineScoreReplay>();

  for (let hour = 14; hour <= 23; hour++) {
    for (let interval = 0; interval < 12; interval++) {
      const rows = await fetchScoreUpdates(epochDay, hour, interval);
      for (const row of rows) {
        if (!row.FixtureId) continue;
        const parsed = parseScoreRow(row);
        if (!parsed) continue;
        const prev = byFixture.get(row.FixtureId);
        if (!prev || parsed.finished || (parsed.home + parsed.away) >= (prev.home + prev.away)) {
          byFixture.set(row.FixtureId, parsed);
        }
      }
    }
  }

  const byLabel = new Map<string, TxlineScoreReplay>();
  for (const [label, fixture] of index) {
    const score = byFixture.get(fixture.FixtureId);
    if (score?.finished) byLabel.set(label, score);
  }

  scoresByDateCache.set(cacheKey, byLabel);
  return byLabel;
}

export async function loadTxlineScoreForMatch(
  matchLabel: string,
  isoDate: string
): Promise<TxlineScoreReplay | null> {
  const map = await loadTxlineScoresForDate(isoDate);
  return map.get(normalizeMatchKey(matchLabel)) ?? null;
}

function legOddsKey(matchLabel: string, selection: string): string {
  return `${normalizeMatchKey(matchLabel)}|${selection.trim().toLowerCase()}`;
}

/** Latest replayed odds per leg for a pick date (cron windows + pre-kickoff). */
export async function loadOddsReplayIndexForDate(
  isoDate: string
): Promise<Map<string, number>> {
  const cacheKey = `odds-date:${isoDate}`;
  if (oddsIndexByDateCache.has(cacheKey)) {
    return oddsIndexByDateCache.get(cacheKey)!;
  }

  const index = await loadFixtureIndex();
  const epochDay = epochDayFromDate(isoDate);
  const latest = new Map<string, { odds: number; ts: number }>();

  for (let hour = 6; hour <= 22; hour++) {
    for (const interval of [0, 6, 11]) {
      const raw = await fetchOddsUpdates(epochDay, hour, interval);
      for (const row of raw) {
        if (!row.FixtureId) continue;
        const fixture = [...index.values()].find((f) => f.FixtureId === row.FixtureId);
        if (!fixture) continue;
        const entries = normalizeOddsEntries([row], fixture);
        for (const entry of entries) {
          const key = legOddsKey(fixtureLabel(fixture), entry.Selection);
          const ts = row.Ts ?? 0;
          const prev = latest.get(key);
          if (!prev || ts >= prev.ts) {
            latest.set(key, { odds: entry.StablePrice, ts });
          }
        }
      }
    }
  }

  const out = new Map<string, number>();
  for (const [key, val] of latest) {
    out.set(key, val.odds);
  }

  oddsIndexByDateCache.set(cacheKey, out);
  return out;
}

export async function findReplayOddsForLeg(
  matchLabel: string,
  selection: string,
  isoDate: string
): Promise<{ odds: number; source: "txline-replay" } | null> {
  const index = await loadOddsReplayIndexForDate(isoDate);
  const price = index.get(legOddsKey(matchLabel, selection));
  return price != null ? { odds: price, source: "txline-replay" } : null;
}

export function oddsWithinTolerance(slip: number, replay: number, tol = 0.06): boolean {
  return Math.abs(slip - replay) <= tol;
}

export function resolveFixture(
  matchLabel: string,
  index: Map<string, TxlineFixture>
): TxlineFixture | undefined {
  return index.get(normalizeMatchKey(matchLabel));
}

export function fixtureKickoffHour(fixture: TxlineFixture): number {
  return new Date(fixtureKickoffMs(fixture)).getUTCHours();
}
