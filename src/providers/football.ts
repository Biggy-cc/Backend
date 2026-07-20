/**
 * Football data provider switchboard.
 * FOOTBALL_DATA_PROVIDER=api-football | txline (default)
 *
 * API-Football fixtures/odds are normalized to the same shapes TxLINE uses,
 * so publish / enrich / fallback keep working unchanged.
 */
import {
  fetchApiFootballFixtures,
  fetchApiFootballOdds,
  warmApiFootballOdds,
} from "../api-football/client.js";
import {
  getCachedOdds,
} from "../api-football/cache.js";
import { getApiFootballConfig } from "../api-football/config.js";
import {
  fetchFixturesSnapshot as fetchTxlineFixtures,
  fetchOddsForFixture as fetchTxlineOdds,
  fixtureKickoffMs,
  fixtureLabel,
  fixturesForToday,
  isBettableFixture,
  isWorldCupFixture,
  selectPicksFixtures as selectTxlinePicksFixtures,
  type TxlineFixture,
  type TxlineOddsEntry,
} from "../txline/client.js";

export type {
  TxlineFixture,
  TxlineOddsEntry,
  TxlineFixture as FootballFixture,
  TxlineOddsEntry as FootballOddsEntry,
};

export {
  fixtureKickoffMs,
  fixtureLabel,
  fixturesForToday,
  isBettableFixture,
  isWorldCupFixture,
};

export type FootballDataProvider = "txline" | "api-football";

export function getFootballDataProvider(): FootballDataProvider {
  const raw = process.env.FOOTBALL_DATA_PROVIDER?.trim().toLowerCase();
  if (raw === "api-football" || raw === "apifootball" || raw === "api_football") {
    return "api-football";
  }
  return "txline";
}

export async function fetchFixturesSnapshot(): Promise<TxlineFixture[]> {
  if (getFootballDataProvider() === "api-football") {
    return fetchApiFootballFixtures();
  }
  return fetchTxlineFixtures();
}

/**
 * Batch-warm odds for many fixtures (API-Football: 1–2 date calls).
 * No-op for TxLINE.
 */
export async function warmOddsForFixtures(
  fixtures: TxlineFixture[],
  options?: { force?: boolean }
): Promise<void> {
  if (getFootballDataProvider() !== "api-football") return;
  await warmApiFootballOdds(fixtures, options);
}

export async function fetchOddsForFixture(
  fixtureId: number,
  fixture: TxlineFixture,
  options?: { force?: boolean }
): Promise<TxlineOddsEntry[]> {
  if (getFootballDataProvider() === "api-football") {
    return fetchApiFootballOdds(fixture, options);
  }
  return fetchTxlineOdds(fixtureId, fixture);
}

const CORE_MARKETS = new Set([
  "1X2",
  "BTTS",
  "Double Chance",
  "Total Goals",
  "Asian Handicap",
  "Draw No Bet",
]);

function fixturePickScore(fixture: TxlineFixture, preferred: Set<number>): number {
  const odds = getCachedOdds(fixture.FixtureId, Number.POSITIVE_INFINITY) ?? [];
  const core = odds.filter((o) => CORE_MARKETS.has(o.MarketType)).length;
  // Market quality dominates; preferred leagues are a small tie-breaker only
  const leagueBoost = preferred.has(fixture.CompetitionId) ? 8 : 0;
  const kickoffSoonBoost = Math.max(
    0,
    4 - Math.abs(fixtureKickoffMs(fixture) - Date.now()) / (6 * 60 * 60 * 1000)
  );
  return core * 3 + Math.min(odds.length, 80) * 0.05 + leagueBoost + kickoffSoonBoost;
}

/** Upcoming bettable fixtures for the daily card. */
export function selectPicksFixtures(
  all: TxlineFixture[],
  options?: { max?: number; now?: Date }
): TxlineFixture[] {
  if (getFootballDataProvider() === "api-football") {
    // Wider pool so best markets can win even outside top leagues
    const max = options?.max ?? 12;
    const nowMs = (options?.now ?? new Date()).getTime();
    const preferred = new Set(getApiFootballConfig().leagueIds);

    const bettable = all
      .filter((f) => isBettableFixture(f, nowMs))
      .filter((f) => fixtureKickoffMs(f) >= nowMs);

    const withOdds = bettable.filter(
      (f) => (getCachedOdds(f.FixtureId, Number.POSITIVE_INFINITY) ?? []).length > 0
    );
    const pool = withOdds.length ? withOdds : bettable;

    // Soft prefer UCL/top-5, but rank primarily by available market quality
    return [...pool]
      .sort((a, b) => {
        const scoreDiff = fixturePickScore(b, preferred) - fixturePickScore(a, preferred);
        if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
        return fixtureKickoffMs(a) - fixtureKickoffMs(b);
      })
      .slice(0, max);
  }
  return selectTxlinePicksFixtures(all, options);
}
