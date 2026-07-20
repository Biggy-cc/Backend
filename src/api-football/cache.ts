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

/** In-memory cache — avoid sync disk I/O on every odds line (blocks Node / Railway). */
let mem: CacheFile | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function readDisk(): CacheFile {
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

function ensureMem(): CacheFile {
  if (!mem || mem.day !== todayUtc()) {
    mem = readDisk();
  }
  return mem;
}

function flushToDisk(): void {
  if (!dirty || !mem) return;
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(mem), "utf8");
    dirty = false;
  } catch (err) {
    console.warn("[api-football] cache write failed:", err);
  }
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToDisk();
  }, 1500);
}

function mutate(fn: (cache: CacheFile) => void): void {
  const cache = ensureMem();
  fn(cache);
  scheduleFlush();
}

export function getApiFootballCallsToday(): number {
  return ensureMem().calls;
}

export function recordApiFootballCall(n = 1): void {
  mutate((cache) => {
    cache.calls += n;
  });
}

export function getCachedFixtures(maxAgeMs: number): TxlineFixture[] | null {
  const cache = ensureMem();
  if (!cache.fixtures) return null;
  if (Date.now() - cache.fixtures.savedAt > maxAgeMs) return null;
  return cache.fixtures.data;
}

export function setCachedFixtures(data: TxlineFixture[]): void {
  mutate((cache) => {
    cache.fixtures = { savedAt: Date.now(), data };
  });
}

export function getCachedOdds(
  fixtureId: number,
  maxAgeMs: number
): TxlineOddsEntry[] | null {
  const cache = ensureMem();
  const row = cache.odds[String(fixtureId)];
  if (!row) return null;
  if (Date.now() - row.savedAt > maxAgeMs) return null;
  return row.data;
}

export function setCachedOdds(
  fixtureId: number,
  data: TxlineOddsEntry[]
): void {
  mutate((cache) => {
    cache.odds[String(fixtureId)] = { savedAt: Date.now(), data };
  });
}

/** Write many fixtures' odds in one memory update (one delayed disk flush). */
export function setCachedOddsBatch(
  entries: Array<{ fixtureId: number; data: TxlineOddsEntry[] }>
): void {
  if (!entries.length) return;
  mutate((cache) => {
    const now = Date.now();
    for (const { fixtureId, data } of entries) {
      cache.odds[String(fixtureId)] = { savedAt: now, data };
    }
  });
}

export function wasOddsDateFetched(date: string, maxAgeMs: number): boolean {
  const cache = ensureMem();
  const at = cache.oddsDates?.[date];
  if (at == null) return false;
  return Date.now() - at <= maxAgeMs;
}

export function markOddsDateFetched(date: string): void {
  mutate((cache) => {
    cache.oddsDates = cache.oddsDates ?? {};
    cache.oddsDates[date] = Date.now();
  });
}
