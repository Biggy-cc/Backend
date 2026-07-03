import {
  fetchFixturesSnapshot,
  fixtureKickoffMs,
  isBettableFixture,
  isWorldCupFixture,
  type TxlineFixture,
} from "../txline/client.js";
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
};

function selectDisplayFixtures(all: TxlineFixture[], max = 12): TxlineFixture[] {
  const nowMs = Date.now();
  const horizonEnd = nowMs + 7 * 24 * 60 * 60 * 1000;

  return all
    .filter(isWorldCupFixture)
    .filter((f) => isBettableFixture(f, nowMs))
    .filter((f) => {
      const kickoff = fixtureKickoffMs(f);
      return kickoff >= nowMs && kickoff < horizonEnd;
    })
    .sort((a, b) => fixtureKickoffMs(a) - fixtureKickoffMs(b))
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
    kickoffAt: new Date(f.StartTime).toISOString(),
  }));
}
