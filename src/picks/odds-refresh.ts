import {
  fetchFixturesSnapshot,
  fetchOddsForFixture,
  fixtureLabel,
  getFootballDataProvider,
  isBettableFixture,
  isWorldCupFixture,
  warmOddsForFixtures,
  type TxlineFixture,
  type TxlineOddsEntry,
} from "../providers/football.js";
import { summarizeOddsMoves } from "./changelog.js";
import type { GenerateResult } from "./generate.js";
import { getCachedPickContent } from "./store.js";
import { validateBundleBettable } from "./kickoff.js";
import {
  archiveCurrentPicks,
  loadStoredBatch,
  saveBatchSnapshot,
  savePickBatch,
} from "./store.js";
import { formatPickSlip, type GeneratedPick, type PickTier } from "./types.js";
import { productOdds } from "./validate.js";

const TIERS: PickTier[] = ["hit", "aim", "go_big"];

const DEFAULT_THRESHOLD = 0.03;

function oddsMoveThreshold(): number {
  const raw = process.env.ODDS_MOVE_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD;
}

function normalizeMatchName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function findFixture(matchName: string, fixtures: TxlineFixture[]): TxlineFixture | undefined {
  return fixtures.find(
    (f) => normalizeMatchName(fixtureLabel(f)) === normalizeMatchName(matchName)
  );
}

function poolFixtures(all: TxlineFixture[]): TxlineFixture[] {
  if (getFootballDataProvider() === "api-football") return all;
  return all.filter(isWorldCupFixture);
}

/** Match a stored leg selection to a live TxLINE odds row. */
export function findOddsForSelection(
  odds: TxlineOddsEntry[],
  selection: string
): TxlineOddsEntry | undefined {
  const want = selection.trim().toLowerCase();
  const exact = odds.find((o) => o.Selection.trim().toLowerCase() === want);
  if (exact) return exact;

  const ah = selection.match(/^(.+?)\s+([+-][\d.]+)\s+AH$/i);
  if (ah) {
    const team = ah[1]!.trim().toLowerCase();
    const line = parseFloat(ah[2]!);
    return odds.find((o) => {
      if (o.MarketType !== "Asian Handicap") return false;
      const selTeam = o.Selection.split(/\s+[+-]/)[0]?.trim().toLowerCase();
      return selTeam === team && o.Line != null && Math.abs(o.Line - line) < 0.01;
    });
  }

  const totals = selection.match(/^(Over|Under)\s+([\d.]+)\s+Goals?/i);
  if (totals) {
    const side = totals[1]!.toLowerCase();
    const line = parseFloat(totals[2]!);
    return odds.find(
      (o) =>
        o.MarketType === "Total Goals" &&
        o.Line === line &&
        o.Selection.toLowerCase().startsWith(side)
    );
  }

  const win = selection.match(/^(.+?)\s+to\s+Win$/i);
  if (win) {
    const team = win[1]!.trim().toLowerCase();
    return odds.find(
      (o) =>
        o.MarketType === "1X2" &&
        o.Selection.toLowerCase().endsWith("to win") &&
        o.Selection.toLowerCase().startsWith(team)
    );
  }

  if (/^draw$/i.test(selection)) {
    return odds.find((o) => o.MarketType === "1X2" && o.Selection === "Draw");
  }

  return undefined;
}

function oddsMoved(from: number, to: number): boolean {
  return Math.abs(to - from) >= oddsMoveThreshold();
}

type OddsMove = {
  match: string;
  selection: string;
  from: number;
  to: number;
};

/**
 * Re-pull odds for locked legs. Bump version when any line moves materially.
 * Keeps selections and analysis — only price/combined updates.
 * @param options.force — bypass short API cache (use on scheduled watches)
 */
export async function refreshStoredOdds(
  pickDate: string,
  options?: { force?: boolean }
): Promise<GenerateResult | null> {
  const previous = await loadStoredBatch(pickDate);
  if (!previous) return null;

  const all = await fetchFixturesSnapshot();
  const pool = poolFixtures(all);
  const now = Date.now();
  const oddsCache = new Map<number, TxlineOddsEntry[]>();
  const moves: OddsMove[] = [];

  // One/two date calls instead of per-leg
  const legsFixtures = new Map<number, TxlineFixture>();
  for (const tier of TIERS) {
    for (const leg of previous.picks[tier].legs) {
      const fixture = findFixture(leg.match, pool);
      if (fixture && isBettableFixture(fixture, now)) {
        legsFixtures.set(fixture.FixtureId, fixture);
      }
    }
  }
  if (legsFixtures.size) {
    await warmOddsForFixtures([...legsFixtures.values()], {
      force: options?.force,
    });
  }

  const bundle = {
    dailyThesis: previous.thesis,
    picks: {
      hit: { ...previous.picks.hit, legs: previous.picks.hit.legs.map((l) => ({ ...l })) },
      aim: { ...previous.picks.aim, legs: previous.picks.aim.legs.map((l) => ({ ...l })) },
      go_big: { ...previous.picks.go_big, legs: previous.picks.go_big.legs.map((l) => ({ ...l })) },
    },
  };

  for (const tier of TIERS) {
    for (const leg of bundle.picks[tier].legs) {
      const fixture = findFixture(leg.match, pool);
      if (!fixture || !isBettableFixture(fixture, now)) continue;

      let odds = oddsCache.get(fixture.FixtureId);
      if (!odds) {
        odds = await fetchOddsForFixture(fixture.FixtureId, fixture, {
          force: options?.force,
        });
        oddsCache.set(fixture.FixtureId, odds);
      }

      const row = findOddsForSelection(odds, leg.selection);
      if (!row) {
        console.warn(`[odds-refresh] Selection gone from book: ${leg.match} — ${leg.selection}`);
        continue;
      }

      if (oddsMoved(leg.odds, row.StablePrice)) {
        moves.push({
          match: leg.match,
          selection: leg.selection,
          from: leg.odds,
          to: row.StablePrice,
        });
        leg.odds = row.StablePrice;
      }
    }

    bundle.picks[tier].combinedOdds = productOdds(bundle.picks[tier].legs);
  }

  if (moves.length === 0) {
    console.log(`[odds-refresh] No material line moves for ${pickDate}`);
    const cachedEntries = await Promise.all(
      TIERS.map(async (t) => [t, await getCachedPickContent(pickDate, t)] as const)
    );
    const picks = Object.fromEntries(cachedEntries) as Record<PickTier, string | null>;
    if (!TIERS.every((t) => picks[t])) return null;
    return {
      picks: picks as Record<PickTier, string>,
      version: previous.version,
      updated: false,
      changeNote: previous.changeNote,
      refreshKind: "odds",
    };
  }

  const bettableErr = await validateBundleBettable(bundle);
  if (bettableErr) {
    console.warn(`[odds-refresh] Skipping update — ${bettableErr}`);
    return null;
  }

  const version = previous.version + 1;
  const changeNote = summarizeOddsMoves(moves);
  console.log(`[odds-refresh] v${version}:`, changeNote);

  await archiveCurrentPicks(pickDate, previous.version);

  const thesisJson = JSON.stringify(bundle.dailyThesis);
  const output: Record<PickTier, string> = { hit: "", aim: "", go_big: "" };

  for (const tier of TIERS) {
    const raw = bundle.picks[tier];
    const pick: GeneratedPick = {
      tier,
      version,
      changeNote,
      ...raw,
    };
    const content = formatPickSlip(pick);
    output[tier] = content;
    await savePickBatch(pickDate, tier, content, version, thesisJson, changeNote);
  }

  await saveBatchSnapshot(
    pickDate,
    version,
    bundle.dailyThesis,
    bundle.picks,
    changeNote
  );

  return {
    picks: output,
    version,
    updated: true,
    changeNote,
    refreshKind: "odds",
  };
}
