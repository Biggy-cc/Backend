import {
  fetchFixturesSnapshot,
  fixtureKickoffMs,
  getFootballDataProvider,
  isBettableFixture,
  isWorldCupFixture,
  type TxlineFixture,
} from "../providers/football.js";
import { getApiFootballConfig } from "../api-football/config.js";
import { teamToCountryCode } from "./teamCountryCodes.js";

export type FixtureApiTeam = {
  name: string;
  countryCode: string | null;
  logoUrl?: string;
};

export type FixtureApiItem = {
  id: string;
  home: FixtureApiTeam;
  away: FixtureApiTeam;
  kickoffAt: string;
  competition?: string;
};

export function selectDisplayFixtures(all: TxlineFixture[], max = 12, options?: { localDate?: string; timeZone: string; research?: boolean; query?: string }): TxlineFixture[] {
  const nowMs = Date.now();
  const horizonEnd = nowMs + 7 * 24 * 60 * 60 * 1000;
  const provider = getFootballDataProvider();
  const preferred = new Set(getApiFootballConfig().leagueIds);

  const upcoming = all
    .filter((f) => (provider === "api-football" ? true : isWorldCupFixture(f)))
    .filter((f) => isBettableFixture(f, nowMs))
    .filter((f) => {
      const kickoff = fixtureKickoffMs(f);
      return kickoff >= nowMs && kickoff < horizonEnd;
    })
    .filter((f) => !options?.localDate || new Date(fixtureKickoffMs(f)).toLocaleDateString("en-CA", { timeZone: options.timeZone }) === options.localDate);

  if (options?.research && provider === "api-football") {
    const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const query = ` ${normalize(options.query ?? "")} `;
    const requested = upcoming.filter((fixture) => [fixture.Participant1, fixture.Participant2].some((team) => { const name = normalize(team); return name.length >= 4 && query.includes(` ${name} `); }));
    const buckets = new Map<number, TxlineFixture[]>();
    for (const fixture of upcoming.sort((a, b) => fixtureKickoffMs(a) - fixtureKickoffMs(b))) {
      const bucket = buckets.get(fixture.CompetitionId) ?? [];
      bucket.push(fixture); buckets.set(fixture.CompetitionId, bucket);
    }
    const groups = [...buckets.entries()].sort(([a], [b]) => Number(preferred.has(b)) - Number(preferred.has(a))).map(([, items]) => items);
    const result = [...requested];
    const seen = new Set(result.map((fixture) => fixture.FixtureId));
    while (result.length < max && groups.some((group) => group.length)) {
      for (const group of groups) {
        const fixture = group.shift();
        if (fixture && !seen.has(fixture.FixtureId)) { result.push(fixture); seen.add(fixture.FixtureId); }
        if (result.length >= max) break;
      }
    }
    return result.slice(0, max);
  }

  // Soft-prefer UCL + top-5 on the FE strip; still fill with other leagues
  return upcoming
    .sort((a, b) => {
      if (provider === "api-football") {
        const ap = preferred.has(a.CompetitionId) ? 0 : 1;
        const bp = preferred.has(b.CompetitionId) ? 0 : 1;
        if (ap !== bp) return ap - bp;
      }
      return fixtureKickoffMs(a) - fixtureKickoffMs(b);
    })
    .slice(0, max);
}

export async function getUpcomingFixturesPayload(options?: { localDate?: string; timeZone: string; max?: number; research?: boolean; query?: string }): Promise<FixtureApiItem[]> {
  try {
    const all = await Promise.race([
      fetchFixturesSnapshot(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("fixtures snapshot timeout")), 40_000)
      ),
    ]);

    return selectDisplayFixtures(all, Math.min(options?.max ?? 12, 40), options).map((f) => ({
      id: String(f.FixtureId),
      home: {
        name: f.Participant1,
        countryCode: teamToCountryCode(f.Participant1),
        logoUrl: f.Participant1Logo,
      },
      away: {
        name: f.Participant2,
        countryCode: teamToCountryCode(f.Participant2),
        logoUrl: f.Participant2Logo,
      },
      kickoffAt: new Date(fixtureKickoffMs(f)).toISOString(),
      competition: f.Competition,
    }));
  } catch (err) {
    console.error("[api] fixtures payload failed:", err);
    return [];
  }
}
