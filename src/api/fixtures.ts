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
};

export type FixtureApiItem = {
  id: string;
  home: FixtureApiTeam;
  away: FixtureApiTeam;
  kickoffAt: string;
  competition?: string;
};

function selectDisplayFixtures(all: TxlineFixture[], max = 12): TxlineFixture[] {
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
    });

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

export async function getUpcomingFixturesPayload(): Promise<FixtureApiItem[]> {
  const all = await fetchFixturesSnapshot();

  return selectDisplayFixtures(all).map((f) => ({
    id: String(f.FixtureId),
    home: {
      name: f.Participant1,
      countryCode: teamToCountryCode(f.Participant1),
    },
    away: {
      name: f.Participant2,
      countryCode: teamToCountryCode(f.Participant2),
    },
    kickoffAt: new Date(fixtureKickoffMs(f)).toISOString(),
    competition: f.Competition,
  }));
}
