import type { TxlineFixture, TxlineOddsEntry } from "../txline/client.js";

type ApiOddValue = { value: string; odd: string };
type ApiBet = { id: number; name: string; values: ApiOddValue[] };
export type ApiBookmaker = { id: number; name: string; bets: ApiBet[] };

function priceOf(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n) || n <= 1) return null;
  return Math.round(n * 100) / 100;
}

function parseLine(value: unknown): number | undefined {
  const m = String(value ?? "").match(/([+-]?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]!) : undefined;
}

function periodFromMarket(name: string): string {
  const n = name.toLowerCase();
  if (
    n.includes("first half") ||
    n.includes("1st half") ||
    n.includes("(1st half)") ||
    n.includes("1st half") ||
    /\b1h\b/.test(n) ||
    n.includes("first 10") ||
    n.includes("30 minutes")
  ) {
    return "1h";
  }
  if (
    n.includes("second half") ||
    n.includes("2nd half") ||
    n.includes("(2nd half)") ||
    n.includes("60 minutes")
  ) {
    return "2h";
  }
  return "full";
}

function teamFromSide(
  fixture: TxlineFixture,
  raw: unknown
): "home" | "away" | "draw" | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "home" || v === fixture.Participant1.toLowerCase()) return "home";
  if (v === "away" || v === fixture.Participant2.toLowerCase()) return "away";
  if (v === "draw") return "draw";
  if (v.startsWith("home")) return "home";
  if (v.startsWith("away")) return "away";
  return null;
}

function entry(
  fixture: TxlineFixture,
  marketType: string,
  period: string,
  selection: string,
  price: number,
  extra?: { line?: number; participant?: string }
): TxlineOddsEntry {
  return {
    FixtureId: fixture.FixtureId,
    MarketType: marketType,
    MarketPeriod: period,
    Line: extra?.line,
    StablePrice: price,
    Selection: selection,
    Participant: extra?.participant,
  };
}

function mapMatchWinner(
  fixture: TxlineFixture,
  values: ApiOddValue[],
  period: string,
  marketType: string,
  labelSuffix = ""
): TxlineOddsEntry[] {
  const out: TxlineOddsEntry[] = [];
  for (const v of values) {
    const price = priceOf(v.odd);
    if (price == null) continue;
    const side = teamFromSide(fixture, v.value);
    let selection: string;
    if (side === "home") selection = `${fixture.Participant1} to Win${labelSuffix}`;
    else if (side === "away") selection = `${fixture.Participant2} to Win${labelSuffix}`;
    else if (side === "draw") selection = `Draw${labelSuffix}`;
    else continue;
    out.push(entry(fixture, marketType, period, selection, price));
  }
  return out;
}

function mapHomeAwayDnb(
  fixture: TxlineFixture,
  values: ApiOddValue[],
  period: string
): TxlineOddsEntry[] {
  const out: TxlineOddsEntry[] = [];
  for (const v of values) {
    const price = priceOf(v.odd);
    if (price == null) continue;
    const side = teamFromSide(fixture, v.value);
    if (side === "home") {
      out.push(
        entry(fixture, "Draw No Bet", period, `${fixture.Participant1} DNB`, price, {
          participant: fixture.Participant1,
        })
      );
    } else if (side === "away") {
      out.push(
        entry(fixture, "Draw No Bet", period, `${fixture.Participant2} DNB`, price, {
          participant: fixture.Participant2,
        })
      );
    }
  }
  return out;
}

function mapTotals(
  fixture: TxlineFixture,
  values: ApiOddValue[],
  period: string,
  marketType: string,
  unit: string
): TxlineOddsEntry[] {
  const out: TxlineOddsEntry[] = [];
  for (const v of values) {
    const price = priceOf(v.odd);
    if (price == null) continue;
    const line = parseLine(v.value);
    if (line == null) continue;
    const lower = v.value.toLowerCase();
    const side = lower.includes("over")
      ? "Over"
      : lower.includes("under")
        ? "Under"
        : null;
    if (!side) continue;
    out.push(
      entry(
        fixture,
        marketType,
        period,
        `${side} ${line} ${unit}`,
        price,
        { line }
      )
    );
  }
  return out;
}

function mapAsianHandicap(
  fixture: TxlineFixture,
  values: ApiOddValue[],
  period: string,
  marketType: string
): TxlineOddsEntry[] {
  const out: TxlineOddsEntry[] = [];
  for (const v of values) {
    const price = priceOf(v.odd);
    if (price == null) continue;
    const line = parseLine(v.value);
    if (line == null) continue;
    const lower = v.value.toLowerCase();
    let participant: string | null = null;
    if (
      lower.includes("home") ||
      lower.startsWith(fixture.Participant1.toLowerCase())
    ) {
      participant = fixture.Participant1;
    } else if (
      lower.includes("away") ||
      lower.startsWith(fixture.Participant2.toLowerCase())
    ) {
      participant = fixture.Participant2;
    }
    if (!participant) continue;
    const signed = line > 0 ? `+${line}` : `${line}`;
    const suffix = marketType === "Asian Handicap" ? "AH" : "HCP";
    out.push(
      entry(
        fixture,
        marketType,
        period,
        `${participant} ${signed} ${suffix}`,
        price,
        { line, participant }
      )
    );
  }
  return out;
}

function mapBtts(
  fixture: TxlineFixture,
  values: ApiOddValue[],
  period: string,
  marketType: string
): TxlineOddsEntry[] {
  const out: TxlineOddsEntry[] = [];
  for (const v of values) {
    const price = priceOf(v.odd);
    if (price == null) continue;
    const raw = v.value.trim().toLowerCase();
    if (raw === "yes") {
      out.push(entry(fixture, marketType, period, "BTTS Yes", price));
    } else if (raw === "no") {
      out.push(entry(fixture, marketType, period, "BTTS No", price));
    }
  }
  return out;
}

function mapDoubleChance(
  fixture: TxlineFixture,
  values: ApiOddValue[],
  period: string
): TxlineOddsEntry[] {
  const out: TxlineOddsEntry[] = [];
  const home = fixture.Participant1;
  const away = fixture.Participant2;
  for (const v of values) {
    const price = priceOf(v.odd);
    if (price == null) continue;
    const raw = v.value.trim().toLowerCase().replace(/\s+/g, "");
    let selection: string | null = null;
    if (raw === "home/draw" || raw === "1x") selection = `${home} or Draw`;
    else if (raw === "home/away" || raw === "12") selection = `${home} or ${away}`;
    else if (raw === "draw/away" || raw === "x2") selection = `Draw or ${away}`;
    if (!selection) continue;
    out.push(entry(fixture, "Double Chance", period, selection, price));
  }
  return out;
}

function mapOddEven(
  fixture: TxlineFixture,
  values: ApiOddValue[],
  period: string,
  marketType: string
): TxlineOddsEntry[] {
  const out: TxlineOddsEntry[] = [];
  for (const v of values) {
    const price = priceOf(v.odd);
    if (price == null) continue;
    const raw = v.value.trim().toLowerCase();
    if (raw === "odd" || raw === "even") {
      out.push(
        entry(fixture, marketType, period, `${raw[0]!.toUpperCase()}${raw.slice(1)} Goals`, price)
      );
    }
  }
  return out;
}

/** Resolve Home/Away/Draw tokens in free-text values to team names. */
function humanizeValue(fixture: TxlineFixture, value: unknown): string {
  let s = String(value ?? "").trim();
  if (!s) return "";
  const home = fixture.Participant1;
  const away = fixture.Participant2;
  s = s.replace(/\bHome\/Draw\b/gi, `${home}/Draw`);
  s = s.replace(/\bHome\/Away\b/gi, `${home}/${away}`);
  s = s.replace(/\bDraw\/Away\b/gi, `Draw/${away}`);
  s = s.replace(/\bHome\b/gi, home);
  s = s.replace(/\bAway\b/gi, away);
  return s;
}

function mapGeneric(
  fixture: TxlineFixture,
  betName: string,
  values: ApiOddValue[],
  period: string
): TxlineOddsEntry[] {
  const out: TxlineOddsEntry[] = [];
  for (const v of values) {
    const price = priceOf(String(v.odd));
    if (price == null) continue;
    const label = humanizeValue(fixture, v.value);
    if (!label) continue;
    const line = parseLine(label);
    out.push(
      entry(fixture, betName, period, `${betName}: ${label}`, price, {
        line,
      })
    );
  }
  return out;
}

/**
 * Map every bookmaker bet into Biggy's odds shape.
 * Core markets get clean selections; everything else is kept as Market: Value.
 */
export function normalizeAllBookmakerOdds(
  fixture: TxlineFixture,
  book: ApiBookmaker
): TxlineOddsEntry[] {
  const out: TxlineOddsEntry[] = [];
  const seen = new Set<string>();

  const push = (rows: TxlineOddsEntry[]) => {
    for (const row of rows) {
      const key = `${row.MarketType}|${row.MarketPeriod}|${row.Selection}|${row.Line ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  };

  for (const bet of book.bets ?? []) {
    try {
      const name = bet.name.trim();
      const lower = name.toLowerCase();
      const period = periodFromMarket(name);
      const values = bet.values ?? [];

      if (lower === "match winner" || lower === "1x2") {
        push(mapMatchWinner(fixture, values, period, "1X2"));
        continue;
      }
      if (lower.includes("first half winner") || lower === "1x2 - first half") {
        push(mapMatchWinner(fixture, values, "1h", "1X2", " (1H)"));
        continue;
      }
      if (lower.includes("second half winner")) {
        push(mapMatchWinner(fixture, values, "2h", "1X2", " (2H)"));
        continue;
      }
      if (lower.startsWith("1x2 -") || lower.includes("minutes")) {
        push(mapMatchWinner(fixture, values, period, name));
        continue;
      }
      if (lower === "home/away") {
        push(mapHomeAwayDnb(fixture, values, period));
        continue;
      }
      if (lower.includes("draw no bet")) {
        push(mapHomeAwayDnb(fixture, values, period));
        continue;
      }
      if (
        lower === "goals over/under" ||
        lower === "over/under" ||
        lower === "total goals"
      ) {
        push(mapTotals(fixture, values, period, "Total Goals", "Goals"));
        continue;
      }
      if (lower.includes("goals over/under first half")) {
        push(mapTotals(fixture, values, "1h", "Total Goals", "Goals (1H)"));
        continue;
      }
      if (lower.includes("goals over/under") && lower.includes("second half")) {
        push(mapTotals(fixture, values, "2h", "Total Goals", "Goals (2H)"));
        continue;
      }
      if (lower.includes("corners over under") || lower === "corners over/under") {
        push(mapTotals(fixture, values, period, "Total Corners", "Corners"));
        continue;
      }
      if (lower.includes("total corners")) {
        push(mapGeneric(fixture, name, values, period));
        continue;
      }
      if (lower === "asian handicap" || lower.startsWith("asian handicap ")) {
        push(mapAsianHandicap(fixture, values, period, "Asian Handicap"));
        continue;
      }
      if (lower.includes("handicap result")) {
        push(mapAsianHandicap(fixture, values, period, "European Handicap"));
        continue;
      }
      if (lower === "both teams score" || lower === "both teams to score") {
        push(mapBtts(fixture, values, period, "BTTS"));
        continue;
      }
      if (lower.includes("both teams score") || lower.includes("both teams to score")) {
        push(mapBtts(fixture, values, period, name));
        continue;
      }
      if (lower === "double chance") {
        push(mapDoubleChance(fixture, values, period));
        continue;
      }
      if (lower === "odd/even" || lower.startsWith("odd/even")) {
        push(mapOddEven(fixture, values, period, "Odd/Even"));
        continue;
      }
      if (lower === "win to nil") {
        push(mapGeneric(fixture, name, values, period));
        continue;
      }

      // Keep everything else (exact score, HT/FT, team totals, corners, …)
      push(mapGeneric(fixture, name, values, period));
    } catch (err) {
      console.warn(
        `[api-football] skip market "${bet.name}" fixture=${fixture.FixtureId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return out;
}
