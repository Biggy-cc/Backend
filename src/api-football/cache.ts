import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { TxlineFixture, TxlineOddsEntry } from "../txline/client.js";

type CacheFile = {
  day: string; // YYYY-MM-DD UTC
  calls: number;
  fixtures?: { savedAt: number; data: TxlineFixture[] };
  odds: Record<string, { savedAt: number; data: TxlineOddsEntry[] }>;
  /** UTC dates already batch-fetched via /odds?date= */
  oddsDates?: Record<string, number>;
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function cachePath(): string {
  const base = process.env.DATABASE_PATH
    ? dirname(process.env.DATABASE_PATH)
    : "./data";
  return join(base, "api-football-cache.json");
}

function emptyCache(): CacheFile {
  return { day: todayUtc(), calls: 0, odds: {}, oddsDates: {} };
}

function load(): CacheFile {
  try {
    const path = cachePath();
    if (!existsSync(path)) return emptyCache();
    const raw = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (raw.day !== todayUtc()) return emptyCache();
    return {
      day: raw.day,
      calls: Number(raw.calls) || 0,
      fixtures: raw.fixtures,
      odds: raw.odds ?? {},
      oddsDates: raw.oddsDates ?? {},
    };
  } catch {
    return emptyCache();
  }
}

function save(cache: CacheFile): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), "utf8");
  } catch (err) {
    console.warn("[api-football] cache write failed:", err);
  }
}

export function getApiFootballCallsToday(): number {
  return load().calls;
}

export function recordApiFootballCall(n = 1): void {
  const cache = load();
  cache.calls += n;
  save(cache);
}

export function getCachedFixtures(
  maxAgeMs: number
): TxlineFixture[] | null {
  const cache = load();
  if (!cache.fixtures) return null;
  if (Date.now() - cache.fixtures.savedAt > maxAgeMs) return null;
  return cache.fixtures.data;
}

export function setCachedFixtures(data: TxlineFixture[]): void {
  const cache = load();
  cache.fixtures = { savedAt: Date.now(), data };
  save(cache);
}

export function getCachedOdds(
  fixtureId: number,
  maxAgeMs: number
): TxlineOddsEntry[] | null {
  const cache = load();
  const row = cache.odds[String(fixtureId)];
  if (!row) return null;
  if (Date.now() - row.savedAt > maxAgeMs) return null;
  return row.data;
}

export function setCachedOdds(
  fixtureId: number,
  data: TxlineOddsEntry[]
): void {
  const cache = load();
  cache.odds[String(fixtureId)] = { savedAt: Date.now(), data };
  save(cache);
}

export function wasOddsDateFetched(date: string, maxAgeMs: number): boolean {
  const cache = load();
  const at = cache.oddsDates?.[date];
  if (at == null) return false;
  return Date.now() - at <= maxAgeMs;
}

export function markOddsDateFetched(date: string): void {
  const cache = load();
  cache.oddsDates = cache.oddsDates ?? {};
  cache.oddsDates[date] = Date.now();
  save(cache);
}
