import {
  fetchApiFootballCurrentLeagues,
  fetchApiFootballStandings,
} from "../api-football/client.js";

export async function getLeaguesPayload() {
  return fetchApiFootballCurrentLeagues();
}

export async function getStandingsPayload(leagueId: number, season: number) {
  return fetchApiFootballStandings(leagueId, season);
}
