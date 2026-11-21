import { apiGet, fetchApiFootballLiveScores, fetchApiFootballSelectedMatch } from "./client.js";
import { getApiFootballConfig } from "./config.js";

type Price = { value?: string; odd?: string | number; handicap?: string | number | null; main?: boolean | null; suspended?: boolean };
type Bet = { name?: string; values?: Price[] };
type Row = { fixture?: { id?: number }; update?: string; status?: { blocked?: boolean; stopped?: boolean; finished?: boolean }; bets?: Bet[]; bookmakers?: Array<{ name?: string; bets?: Bet[] }> };
type OddsResult = { fixtureId: number; match: { home: string; away: string }; phase: "live" | "pre-match"; retrievedAt: string; providerUpdatedAt?: string; bookmaker?: string; markets: Array<{ market: string; selections: Array<{ selection: string; price: number }> }>; unavailable?: string };
const cache = new Map<string, { savedAt: number; result: OddsResult }>();
const pending = new Map<string, Promise<OddsResult>>();
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE"]);
const PRE = new Set(["NS", "TBD", "SCH"]);

function marketValues(bet: Bet): OddsResult["markets"][number] | null {
  if (!bet.name || !Array.isArray(bet.values)) return null;
  const values = bet.values.filter((v) => !v.suspended && typeof v.value === "string" && Number.isFinite(Number(v.odd)) && Number(v.odd) > 1);
  const selections = values.filter((v) => !values.some((other) => other !== v && other.value === v.value && other.handicap === v.handicap && other.main === true && v.main !== true))
    .slice(0, 12).map((v) => ({ selection: `${v.value}${v.handicap != null && String(v.handicap).trim() ? ` ${v.handicap}` : ""}`, price: Number(v.odd) }));
  return selections.length ? { market: bet.name, selections } : null;
}

/** Fetch only the correct kind of odds for this exact selected fixture. */
export async function fetchMatchOdds(fixtureId: number): Promise<OddsResult | { error: string }> {
  const selected = await fetchApiFootballSelectedMatch(fixtureId, { includeEvents: false });
  if ("error" in selected) return selected;
  const status = String(selected.match.status ?? "").toUpperCase();
  const phase = LIVE.has(status) ? "live" : PRE.has(status) ? "pre-match" : null;
  if (!phase) return { error: "Current betting odds are unavailable for this fixture's status; do not report old pre-match prices as live." };
  const key = `${fixtureId}:${phase}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.savedAt < (phase === "live" ? 15_000 : 180_000)) return cached.result;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = (async (): Promise<OddsResult> => {
    const rows = await apiGet<Row[]>(phase === "live" ? "/odds/live" : "/odds", { fixture: fixtureId }, 1);
    const row = (rows ?? []).find((item) => item.fixture?.id === fixtureId);
    const retrievedAt = new Date().toISOString();
    const result: OddsResult = { fixtureId, match: { home: String(selected.match.homeTeam ?? ""), away: String(selected.match.awayTeam ?? "") }, phase, retrievedAt, markets: [] };
    if (cache.size >= 500) cache.delete(cache.keys().next().value!);
    if (!row || (phase === "live" && (row.status?.blocked || row.status?.stopped || row.status?.finished))) {
      result.unavailable = !row ? "The provider returned no odds for this fixture." : "Live betting is currently blocked, stopped or finished.";
      cache.set(key, { savedAt: Date.now(), result });
      return result;
    }
    if (row.update && Number.isFinite(Date.parse(row.update))) result.providerUpdatedAt = row.update;
    if (phase === "live" && result.providerUpdatedAt && Date.now() - Date.parse(result.providerUpdatedAt) > 120_000) {
      result.unavailable = "The provider's latest in-play prices are over two minutes old, so they cannot be presented as current.";
      cache.set(key, { savedAt: Date.now(), result });
      return result;
    }
    let bets = row.bets ?? [];
    if (phase === "pre-match") {
      const books = row.bookmakers ?? [];
      const preferred = getApiFootballConfig().preferredBookmaker;
      const book = books.find((item) => item.name?.toLowerCase() === preferred) ?? books[0];
      if (book?.name) result.bookmaker = book.name;
      bets = book?.bets ?? [];
    }
    result.markets = bets.map(marketValues).filter((market): market is NonNullable<typeof market> => market !== null)
      .sort((a, b) => Number(!/^(match winner|fulltime result|1x2|match result)$/i.test(a.market)) - Number(!/^(match winner|fulltime result|1x2|match result)$/i.test(b.market))).slice(0, 8);
    if (!result.markets.length) result.unavailable = "No active, priced markets were returned by the provider.";
    cache.set(key, { savedAt: Date.now(), result });
    return result;
  })();
  pending.set(key, request);
  try { return await request; } finally { pending.delete(key); }
}

/** Resolve typed matchups only when exactly one live fixture matches. */
export async function resolveLiveOddsFixture(home: string, away: string): Promise<number | null> {
  const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const matches = (actual: string, wanted: string) => normalize(actual) === normalize(wanted) || (normalize(wanted).length >= 4 && normalize(actual).includes(normalize(wanted)));
  if (!home.trim() || !away.trim()) return null;
  const candidates = (await fetchApiFootballLiveScores()).filter((match) =>
    (matches(match.homeTeam, home) && matches(match.awayTeam, away)) || (matches(match.homeTeam, away) && matches(match.awayTeam, home)));
  return candidates.length === 1 ? candidates[0].fixtureId : null;
}
