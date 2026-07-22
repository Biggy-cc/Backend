import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
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

/**
 * Disk flush is OFF on D1/Railway by default. Sync JSON.stringify + volume
 * writes were freezing the event loop for minutes (API looked "offline").
 * Set API_FOOTBALL_CACHE_DISK=1 to re-enable best-effort async persistence.
 */
function diskCacheEnabled(): boolean {
  const flag = process.env.API_FOOTBALL_CACHE_DISK?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "on") return true;
  if (flag === "0" || flag === "false" || flag === "off") return false;
  // Default: memory-only when using Cloudflare D1 (typical Railway prod)
  return process.env.DATABASE_BACKEND?.trim().toLowerCase() !== "d1";
}

/** In-memory cache — avoid sync disk I/O on every odds line (blocks Node / Railway). */
let mem: CacheFile | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let flushing = false;
let diskDisabledLogged = false;

function readDisk(): CacheFile {
  if (!diskCacheEnabled()) return emptyCache();
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

/** Keep odds map small so accidental disk flush can't freeze Node. */
function pruneOdds(cache: CacheFile, keep = 80): void {
  const ids = Object.keys(cache.odds);
  if (ids.length <= keep) return;
  const ranked = ids
    .map((id) => ({ id, at: cache.odds[id]?.savedAt ?? 0 }))
    .sort((a, b) => b.at - a.at);
  for (const row of ranked.slice(keep)) {
    delete cache.odds[row.id];
  }
}

async function flushToDisk(): Promise<void> {
  if (!diskCacheEnabled() || !dirty || !mem || flushing) return;
  flushing = true;
  dirty = false;
  try {
    pruneOdds(mem);
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    // Move heavy stringify off the hot path of request handlers.
    const snapshot = await new Promise<string>((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(JSON.stringify(mem));
        } catch (err) {
          reject(err);
        }
      });
    });
    await Promise.race([
      writeFile(path, snapshot, "utf8"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cache disk write timeout")), 5_000)
      ),
    ]);
  } catch (err) {
    dirty = true;
    console.warn("[api-football] cache write failed:", err);
  } finally {
    flushing = false;
    if (dirty) scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (!diskCacheEnabled()) {
    if (!diskDisabledLogged) {
      diskDisabledLogged = true;
      console.log(
        "[api-football] disk cache off (memory-only) — set API_FOOTBALL_CACHE_DISK=1 to persist"
      );
    }
    return;
  }
  dirty = true;
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushToDisk();
  }, 5_000);
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
    pruneOdds(cache);
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
    pruneOdds(cache);
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
