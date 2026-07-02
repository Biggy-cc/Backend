import axios, { type AxiosInstance } from "axios";
import { getTxlineConfig } from "./config.js";

export type TxlineFixture = {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  Participant1IsHome: boolean;
  StartTime: number;
  Competition: string;
  CompetitionId: number;
};

export type TxlineOddsEntry = {
  FixtureId: number;
  MarketType: string;
  MarketPeriod: string;
  Line?: number;
  StablePrice: number;
  Selection: string;
  Participant?: string;
};

let guestJwt: string | null = null;
let guestJwtFetchedAt = 0;
const JWT_TTL_MS = 25 * 24 * 60 * 60 * 1000;

async function getGuestJwt(): Promise<string> {
  const now = Date.now();
  if (guestJwt && now - guestJwtFetchedAt < JWT_TTL_MS) {
    return guestJwt;
  }
  const cfg = getTxlineConfig();
  const res = await axios.post(`${cfg.apiOrigin}/auth/guest/start`);
  guestJwt = res.data.token as string;
  guestJwtFetchedAt = now;
  return guestJwt;
}

async function authHeaders(): Promise<Record<string, string>> {
  const jwt = await getGuestJwt();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
  const apiToken = process.env.TXLINE_API_TOKEN;
  if (apiToken) {
    headers["X-Api-Token"] = apiToken;
  }
  return headers;
}

export function createTxlineClient(): AxiosInstance {
  const cfg = getTxlineConfig();
  return axios.create({
    baseURL: cfg.apiBaseUrl,
    timeout: 60_000,
  });
}

export type RawTxlineOdds = {
  FixtureId: number;
  SuperOddsType?: string;
  MarketType?: string;
  MarketPeriod?: string | null;
  MarketParameters?: string | null;
  PriceNames?: string[];
  Prices?: number[];
  Selection?: string;
  StablePrice?: number;
  Line?: number;
};

function decodePrice(raw: number): number {
  return Math.round((raw / 1000) * 100) / 100;
}

function parseMarketLine(params: string | null | undefined): number | undefined {
  if (!params) return undefined;
  const m = params.match(/line=([-\d.]+)/);
  return m ? parseFloat(m[1]) : undefined;
}

function formatSignedLine(line: number): string {
  return line > 0 ? `+${line}` : `${line}`;
}

function isFullMatchPeriod(period: string | null | undefined): boolean {
  return !period || period === "full" || period === "0";
}

function preferFullMatchRows(raw: RawTxlineOdds[]): RawTxlineOdds[] {
  const full = raw.filter((r) => isFullMatchPeriod(r.MarketPeriod));
  return full.length > 0 ? full : raw;
}

export function normalizeOddsEntries(
  raw: RawTxlineOdds[],
  fixture: TxlineFixture
): TxlineOddsEntry[] {
  const out: TxlineOddsEntry[] = [];

  for (const row of raw) {
    if (row.MarketType && row.StablePrice != null && row.Selection) {
      out.push({
        FixtureId: row.FixtureId,
        MarketType: row.MarketType,
        MarketPeriod: row.MarketPeriod ?? "full",
        Line: row.Line,
        StablePrice: row.StablePrice,
        Selection: row.Selection,
      });
      continue;
    }

    const type = row.SuperOddsType;
    const prices = row.Prices ?? [];
    const names = row.PriceNames ?? [];
    const period = row.MarketPeriod ?? "full";
    const line = parseMarketLine(row.MarketParameters);

    if (type === "1X2_PARTICIPANT_RESULT") {
      for (let i = 0; i < names.length; i++) {
        const sel =
          names[i] === "part1"
            ? `${fixture.Participant1} to Win`
            : names[i] === "part2"
              ? `${fixture.Participant2} to Win`
              : "Draw";
        out.push({
          FixtureId: fixture.FixtureId,
          MarketType: "1X2",
          MarketPeriod: period,
          StablePrice: decodePrice(prices[i]),
          Selection: sel,
        });
      }
      continue;
    }

    if (type === "OVERUNDER_PARTICIPANT_GOALS" && line != null) {
      for (let i = 0; i < names.length; i++) {
        const side = names[i].toLowerCase();
        out.push({
          FixtureId: fixture.FixtureId,
          MarketType: "Total Goals",
          MarketPeriod: period,
          Line: line,
          StablePrice: decodePrice(prices[i]),
          Selection: `${side === "over" ? "Over" : "Under"} ${line} Goals`,
        });
      }
      continue;
    }

    if (type === "ASIANHANDICAP_PARTICIPANT_GOALS" && line != null) {
      for (let i = 0; i < names.length; i++) {
        const side = names[i]?.toLowerCase();
        if (side !== "part1" && side !== "part2") continue;
        const participant = side === "part1" ? fixture.Participant1 : fixture.Participant2;
        const participantLine = side === "part1" ? line : -line;
        out.push({
          FixtureId: fixture.FixtureId,
          MarketType: "Asian Handicap",
          MarketPeriod: period,
          Line: participantLine,
          StablePrice: decodePrice(prices[i]),
          Selection: `${participant} ${formatSignedLine(participantLine)} AH`,
          Participant: participant,
        });
      }
    }
  }

  return out;
}

export async function fetchFixturesSnapshot(): Promise<TxlineFixture[]> {
  const client = createTxlineClient();
  const res = await client.get<TxlineFixture[]>("/fixtures/snapshot", {
    headers: await authHeaders(),
  });
  return res.data;
}

export async function fetchOddsForFixture(
  fixtureId: number,
  fixture: TxlineFixture
): Promise<TxlineOddsEntry[]> {
  const client = createTxlineClient();
  const res = await client.get<RawTxlineOdds[]>(`/odds/snapshot/${fixtureId}`, {
    headers: await authHeaders(),
  });
  return normalizeOddsEntries(preferFullMatchRows(res.data), fixture);
}

export function fixtureKickoffMs(f: TxlineFixture): number {
  const t = f.StartTime;
  return t < 1e12 ? t * 1000 : t;
}

/** Pre-match only — exclude fixtures at or past kickoff (5 min buffer). */
const KICKOFF_BUFFER_MS = 5 * 60 * 1000;

export function isBettableFixture(
  f: TxlineFixture,
  nowMs: number = Date.now()
): boolean {
  return fixtureKickoffMs(f) > nowMs + KICKOFF_BUFFER_MS;
}

export function fixturesForToday(fixtures: TxlineFixture[]): TxlineFixture[] {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return fixtures.filter((f) => {
    const kickoff = fixtureKickoffMs(f);
    return kickoff >= start.getTime() && kickoff < end.getTime();
  });
}

/** Upcoming WC/friendly fixtures for picks — skips started games, looks ~48h ahead. */
export function selectPicksFixtures(
  all: TxlineFixture[],
  options?: { max?: number; now?: Date }
): TxlineFixture[] {
  const max = options?.max ?? 8;
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const horizonEnd = new Date(now);
  horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 2);

  return all
    .filter(isWorldCupFixture)
    .filter((f) => isBettableFixture(f, nowMs))
    .filter((f) => {
      const k = fixtureKickoffMs(f);
      return k >= nowMs && k < horizonEnd.getTime();
    })
    .sort((a, b) => fixtureKickoffMs(a) - fixtureKickoffMs(b))
    .slice(0, max);
}

export function fixtureLabel(f: TxlineFixture): string {
  return `${f.Participant1} vs ${f.Participant2}`;
}

export function isWorldCupFixture(f: TxlineFixture): boolean {
  const name = f.Competition.toLowerCase();
  return (
    name.includes("world cup") ||
    name.includes("fifa") ||
    name.includes("international friendlies")
  );
}
