/** API-Football (api-sports.io) config */

export type ApiFootballQuotaMode = "free" | "paid";

export function getApiFootballConfig() {
  const apiKey = process.env.API_FOOTBALL_KEY?.trim() ?? "";
  const baseUrl = (
    process.env.API_FOOTBALL_BASE_URL?.trim() ||
    "https://v3.football.api-sports.io"
  ).replace(/\/$/, "");

  const quotaMode: ApiFootballQuotaMode =
    process.env.API_FOOTBALL_QUOTA_MODE?.trim().toLowerCase() === "paid"
      ? "paid"
      : "free";

  // Soft preference for daily card: UCL + top-5. Free mode still pulls all
  // fixtures by date; this list only ranks / prefers when building the pool.
  const defaultLeagues = ["2", "39", "140", "135", "78", "61"];

  const leaguesRaw = process.env.API_FOOTBALL_LEAGUES?.trim();
  const leagueIds = (leaguesRaw ? leaguesRaw.split(",") : defaultLeagues)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const nextPerLeague = Math.max(
    1,
    Number(
      process.env.API_FOOTBALL_NEXT_PER_LEAGUE ??
        (quotaMode === "free" ? "2" : "4")
    )
  );

  const preferredBookmaker =
    process.env.API_FOOTBALL_BOOKMAKER?.trim().toLowerCase() || "bet365";

  // Soft daily budget — stop outbound calls before hard 100/day wall
  const dailyBudget = Math.max(
    10,
    Number(
      process.env.API_FOOTBALL_DAILY_BUDGET ??
        (quotaMode === "free" ? "70" : "5000")
    )
  );

  const fixturesTtlHours = Math.max(
    1,
    Number(
      process.env.API_FOOTBALL_FIXTURES_TTL_HOURS ??
        (quotaMode === "free" ? "12" : "3")
    )
  );
  const oddsTtlHours = Math.max(
    1,
    Number(
      process.env.API_FOOTBALL_ODDS_TTL_HOURS ??
        (quotaMode === "free" ? "8" : "2")
    )
  );

  // Max fixtures we pull odds for per publish (free: keep tiny)
  const maxOddsFetches = Math.max(
    1,
    Number(
      process.env.API_FOOTBALL_MAX_ODDS_FETCHES ??
        (quotaMode === "free" ? "4" : "12")
    )
  );

  return {
    apiKey,
    baseUrl,
    leagueIds,
    nextPerLeague,
    preferredBookmaker,
    quotaMode,
    dailyBudget,
    fixturesTtlMs: fixturesTtlHours * 60 * 60 * 1000,
    oddsTtlMs: oddsTtlHours * 60 * 60 * 1000,
    maxOddsFetches,
  };
}

export function assertApiFootballConfigured(): void {
  if (!getApiFootballConfig().apiKey) {
    throw new Error(
      "API_FOOTBALL_KEY missing — get a key at https://dashboard.api-football.com/"
    );
  }
}

/** True when free-tier frugal mode is on (default for api-football). */
export function isApiFootballFreeQuotaMode(): boolean {
  return getApiFootballConfig().quotaMode === "free";
}
