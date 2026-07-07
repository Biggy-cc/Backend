import {
  fetchFixturesSnapshot,
  fixtureLabel,
  isBettableFixture,
  isWorldCupFixture,
  selectPicksFixtures,
  type TxlineFixture,
} from "../txline/client.js";
import { getCachedPickContent, loadStoredBatch } from "./store.js";
import { slipHtmlToPlain } from "./types.js";
import type { PickTier } from "./types.js";
import type { DailyPicksBundle } from "./validate.js";

const TIERS: PickTier[] = ["hit", "aim", "go_big"];

function normalizeMatchName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchesFromSlipHtml(html: string): string[] {
  const plain = slipHtmlToPlain(html);
  const matches: string[] = [];
  for (const line of plain.split("\n")) {
    const m = line.match(/^\d+\.\s+(.+)$/);
    if (m) matches.push(normalizeMatchName(m[1]));
  }
  return matches;
}

async function collectUsedMatches(pickDate: string): Promise<Set<string>> {
  const used = new Set<string>();
  const batch = await loadStoredBatch(pickDate);

  if (batch) {
    for (const tier of TIERS) {
      for (const leg of batch.picks[tier].legs) {
        used.add(normalizeMatchName(leg.match));
      }
    }
    return used;
  }

  for (const tier of TIERS) {
    const content = await getCachedPickContent(pickDate, tier);
    if (!content) continue;
    for (const match of matchesFromSlipHtml(content)) {
      used.add(match);
    }
  }

  return used;
}

function findFixture(matchName: string, fixtures: TxlineFixture[]) {
  return fixtures.find(
    (f) => normalizeMatchName(fixtureLabel(f)) === matchName
  );
}

export async function isLegBettable(matchName: string): Promise<boolean> {
  const all = await fetchFixturesSnapshot();
  const wc = all.filter(isWorldCupFixture);
  const fixture = findFixture(normalizeMatchName(matchName), wc);
  if (!fixture) return false;
  return isBettableFixture(fixture);
}

export async function filterBettableLegs<T extends { match: string }>(
  legs: T[]
): Promise<T[]> {
  const out: T[] = [];
  for (const leg of legs) {
    if (await isLegBettable(leg.match)) out.push(leg);
  }
  return out;
}

export async function validateBundleBettable(
  bundle: DailyPicksBundle
): Promise<string | null> {
  const all = await fetchFixturesSnapshot();
  const wc = all.filter(isWorldCupFixture);
  const now = Date.now();

  for (const tier of TIERS) {
    for (const leg of bundle.picks[tier].legs) {
      const fixture = findFixture(normalizeMatchName(leg.match), wc);
      if (!fixture) {
        return `Leg references unknown match: ${leg.match}`;
      }
      if (!isBettableFixture(fixture, now)) {
        return `Leg on started match: ${leg.match}`;
      }
    }
  }

  return null;
}

export async function picksStaleDueToKickoff(pickDate: string): Promise<boolean> {
  let usedMatches = await collectUsedMatches(pickDate);
  if (usedMatches.size === 0) {
    const { findLatestServableBatch, batchLegMatches } = await import("./servable.js");
    const latest = await findLatestServableBatch();
    if (!latest) return false;
    usedMatches = batchLegMatches(latest.batch);
  }

  const all = await fetchFixturesSnapshot();
  const wc = all.filter(isWorldCupFixture);
  const now = Date.now();

  for (const matchName of usedMatches) {
    const fixture = findFixture(matchName, wc);
    if (fixture && !isBettableFixture(fixture, now)) {
      return true;
    }
  }

  return false;
}

/** Human-readable list of next bettable kickoffs (for bot copy). */
export async function upcomingBettableSummary(max = 3): Promise<string> {
  const all = await fetchFixturesSnapshot();
  const upcoming = selectPicksFixtures(all).slice(0, max);
  if (upcoming.length === 0) return "the next World Cup kickoffs";
  return upcoming.map((f) => fixtureLabel(f)).join(", ");
}

export async function isPickContentStale(html: string): Promise<boolean> {
  const used = new Set(matchesFromSlipHtml(html));
  if (used.size === 0) return false;

  const all = await fetchFixturesSnapshot();
  const wc = all.filter(isWorldCupFixture);
  const now = Date.now();

  for (const matchName of used) {
    const fixture = findFixture(matchName, wc);
    if (fixture && !isBettableFixture(fixture, now)) {
      return true;
    }
  }

  return false;
}
