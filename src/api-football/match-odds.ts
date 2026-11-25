import { apiGet, fetchApiFootballLiveScores, fetchApiFootballSelectedMatch } from "./client.js";

type Price = { value?: string; odd?: string | number; handicap?: string | number | null; main?: boolean | null; suspended?: boolean };
type Bet = { name?: string; values?: Price[] };
type Row = { fixture?: { id?: number }; update?: string; status?: { blocked?: boolean; stopped?: boolean; finished?: boolean }; bets?: Bet[]; bookmakers?: Array<{ name?: string; bets?: Bet[] }> };
export type OddsResult = { fixtureId: number; match: { home: string; away: string }; phase: "live" | "pre-match"; retrievedAt: string; providerUpdatedAt?: string; bookmaker?: string; markets: Array<{ market: string; selections: Array<{ selection: string; price: number }> }>; books?: Array<{ name: string; markets: OddsResult["markets"] }>; unavailable?: string };
const cache = new Map<string, { savedAt: number; result: OddsResult }>();
const pending = new Map<string, Promise<OddsResult>>();
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE"]);
const PRE = new Set(["NS", "TBD", "SCH"]);

function marketValues(bet: Bet): OddsResult["markets"][number] | null {
  if (!bet.name || !Array.isArray(bet.values)) return null;
  const values = bet.values.filter((v) => !v.suspended && typeof v.value === "string" && Number.isFinite(Number(v.odd)) && Number(v.odd) > 1);
  const selections = values.filter((v) => !values.some((other) => other !== v && other.value === v.value && other.handicap === v.handicap && other.main === true && v.main !== true))
    // Keep the provider's priced selections for matching. Truncating to the first
    // twelve silently discarded valid goal lines and made priced legs look unavailable.
    .map((v) => ({ selection: `${v.value}${v.handicap != null && String(v.handicap).trim() ? ` ${v.handicap}` : ""}`, price: Number(v.odd) }));
  return selections.length ? { market: bet.name, selections } : null;
}

/** Fetch only the correct kind of odds for this exact selected fixture. */
export async function fetchMatchOdds(fixtureId: number, verifiedUpcoming?: { home: string; away: string; kickoffAt: string }): Promise<OddsResult | { error: string }> {
  const selected = verifiedUpcoming && Date.parse(verifiedUpcoming.kickoffAt) > Date.now()
    ? { match: { status: "NS", homeTeam: verifiedUpcoming.home, awayTeam: verifiedUpcoming.away } }
    : await fetchApiFootballSelectedMatch(fixtureId, { includeEvents: false });
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
      result.books = books.filter((book) => !!book.name).map((book) => ({ name: book.name!, markets: (book.bets ?? []).map(marketValues).filter((market): market is NonNullable<typeof market> => market !== null) })).filter((book) => book.markets.length > 0);
      const book = books.find((item) => item.name && item.bets?.some((bet) => marketValues(bet)));
      if (book?.name) result.bookmaker = book.name;
      bets = book?.bets ?? [];
    }
    result.markets = bets.map(marketValues).filter((market): market is NonNullable<typeof market> => market !== null)
      .sort((a, b) => Number(!/^(match winner|fulltime result|1x2|match result)$/i.test(a.market)) - Number(!/^(match winner|fulltime result|1x2|match result)$/i.test(b.market)));
    if (!result.markets.length) result.unavailable = "No active, priced markets were returned by the provider.";
    cache.set(key, { savedAt: Date.now(), result });
    return result;
  })();
  pending.set(key, request);
  try { return await request; } finally { pending.delete(key); }
}

/** Match only unambiguous full-time markets; never infer a price from a similar market. */
export function matchParlaySelection(odds: OddsResult, selection: string, home: string, away: string): { price: number; bookmaker: string; market: string; selection: string; retrievedAt: string; providerUpdatedAt?: string } | null {
  return matchParlaySelectionOptions(odds, selection, home, away)[0] ?? null;
}

export function matchParlaySelectionOptions(odds: OddsResult, selection: string, home: string, away: string): Array<{ price: number; bookmaker: string; market: string; selection: string; retrievedAt: string; providerUpdatedAt?: string }> {
  if (odds.phase !== "pre-match" || odds.unavailable) return [];
  const norm = (v: string) => v.toLowerCase().replace(/[–—]/g, "-").replace(/[^a-z0-9.]+/g, " ").trim().replace(/\s+/g, " ");
  const input = norm(selection);
  const homeName = norm(home), awayName = norm(away);
  let marketPattern: RegExp | undefined;
  let outcomes: string[] = [];
  const total = input.match(/^(over|under) (\d+(?:\.\d+)?) (?:total )?goals?$/) ?? input.match(/^(over|under) (\d+(?:\.\d+)?)$/);
  if (total) { marketPattern = /^(goals over under|over under|total goals)$/; outcomes = [`${total[1]} ${total[2]}`]; }
  else if (/^(both teams to score|btts)( yes)?$/.test(input)) { marketPattern = /^(both teams score|both teams to score)$/; outcomes = ["yes"]; }
  else if (/^(both teams to score|btts) no$/.test(input)) { marketPattern = /^(both teams score|both teams to score)$/; outcomes = ["no"]; }
  else if ([`${homeName} win`, `${homeName} to win`, `win ${homeName}`, homeName, "home win"].includes(input)) { marketPattern = /^(match winner|fulltime result|1x2|match result)$/; outcomes = ["home", "1"]; }
  else if ([`${awayName} win`, `${awayName} to win`, `win ${awayName}`, awayName, "away win"].includes(input)) { marketPattern = /^(match winner|fulltime result|1x2|match result)$/; outcomes = ["away", "2"]; }
  else if (["draw", "match draw"].includes(input)) { marketPattern = /^(match winner|fulltime result|1x2|match result)$/; outcomes = ["draw", "x"]; }
  else if ([`${homeName} or draw`, `${homeName} or draw double chance`, "home or draw", "1x"].includes(input)) { marketPattern = /^double chance$/; outcomes = ["home draw", "1x"]; }
  else if ([`${awayName} or draw`, `${awayName} or draw double chance`, "away or draw", "x2"].includes(input)) { marketPattern = /^double chance$/; outcomes = ["draw away", "away draw", "x2"]; }
  else if (["home or away", "12"].includes(input)) { marketPattern = /^double chance$/; outcomes = ["home away", "12"]; }
  if (!marketPattern) return [];
  const matches: ReturnType<typeof matchParlaySelectionOptions> = [];
  const books = odds.books ?? (odds.bookmaker ? [{ name: odds.bookmaker, markets: odds.markets }] : []);
  for (const book of books) for (const market of book.markets) {
    if (!marketPattern.test(norm(market.market))) continue;
    const found = market.selections.find((item) => outcomes.includes(norm(item.selection)) && Number.isFinite(item.price) && item.price > 1);
    if (found) matches.push({ price: found.price, bookmaker: book.name, market: market.market, selection: found.selection, retrievedAt: odds.retrievedAt, ...(odds.providerUpdatedAt ? { providerUpdatedAt: odds.providerUpdatedAt } : {}) });
  }
  return matches.sort((a, b) => b.price - a.price);
}

/** Select the best verified price for each leg, even when sources differ. */
export function bestParlayQuotes(options: Array<ReturnType<typeof matchParlaySelectionOptions>>): ReturnType<typeof matchParlaySelectionOptions> | null {
  if (!options.length || options.some((leg) => !leg.length)) return null;
  return options.map((leg) => leg.reduce((best, quote) => quote.price > best.price ? quote : best));
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
