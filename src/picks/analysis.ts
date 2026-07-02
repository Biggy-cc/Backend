import { fixtureKickoffMs, fixtureLabel } from "../txline/client.js";
import type { EnrichedMatch } from "./research.js";
import { generateJsonLlm } from "./llm.js";
import type { DailyPicksBundle } from "./validate.js";
import { validateCorrelatedLegs, validateDuplicateLegs, hasMetaTierProse, stripMetaTierProse } from "./validate.js";
import type { PickTier } from "./types.js";
import type { TxlineOddsEntry } from "../txline/client.js";
import { getCachedPickContent } from "./store.js";
import { slipHtmlToPlain } from "./types.js";

type MatchBundle = EnrichedMatch & { odds: TxlineOddsEntry[] };

const PLACEHOLDER_MARKERS = [
  "stacking winner and goal markets from live odds",
  "built from live lines —",
  "Pre-match lines on upcoming kickoff",
  "Same-game value on the next kickoff",
  "Low-risk overs on two separate matches using current pre-match lines",
  "Next bettable match —",
  "Higher combined price from stacking correlated winner and goals markets",
  "Locked legs:",
  "Lines and team news support these markets before kickoff.",
];

export function isThinBreakdown(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length < 160) return true;
  const sentences = t.split(/[.!?]+/).filter((s) => s.trim().length > 12);
  return sentences.length < 2;
}

export function bundleHasThinBreakdowns(bundle: DailyPicksBundle): boolean {
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  return tiers.some((t) => isThinBreakdown(bundle.picks[t].breakdown));
}

export async function cachedHasThinBreakdowns(pickDate: string): Promise<boolean> {
  const bundle = await parseBundleFromCachedSlips(pickDate);
  if (!bundle) return false;
  return bundleHasThinBreakdowns(bundle);
}

export function isPlaceholderBreakdown(text: string): boolean {
  if (isThinBreakdown(text)) return true;
  if (hasMetaTierProse(text)) return true;
  return PLACEHOLDER_MARKERS.some((m) => text.includes(m));
}

export function cleanSlipBreakdownHtml(html: string): string {
  const htmlMarker = /🧠 <b>Biggy Breakdown<\/b>\n/;
  const m = html.match(htmlMarker);
  if (!m || m.index === undefined) return html;

  const htmlStart = m.index + m[0].length;
  const htmlSources = html.indexOf("\n\n📰 <b>Sources</b>", htmlStart);
  const htmlEnd = htmlSources > htmlStart ? htmlSources : html.length;

  const plain = slipHtmlToPlain(html.slice(htmlStart, htmlEnd)).trim();
  const cleaned = stripMetaTierProse(plain);
  if (cleaned === plain) return html;

  const escape = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  return html.slice(0, htmlStart) + escape(cleaned) + html.slice(htmlEnd);
}

export async function parseBundleFromCachedSlips(
  pickDate: string
): Promise<DailyPicksBundle | null> {
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  const picks = {} as DailyPicksBundle["picks"];
  const matches = new Set<string>();

  for (const tier of tiers) {
    const content = await getCachedPickContent(pickDate, tier);
    if (!content) return null;

    const plain = slipHtmlToPlain(content);
    const legs: Array<{ match: string; selection: string; odds: number }> = [];
    const lines = plain.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(/^(\d+)\.\s+(.+)$/);
      if (!head) continue;
      const detail = lines[i + 1]?.match(/^\s*→\s+(.+?)\s+@\s+([\d.]+)/);
      if (!detail) continue;
      legs.push({
        match: head[2].trim(),
        selection: detail[1].trim(),
        odds: parseFloat(detail[2]),
      });
      matches.add(head[2].trim());
    }

    const combinedMatch = plain.match(/Combined @ ([\d.]+)/);
    const breakdownIdx = plain.indexOf("Biggy Breakdown");
    const sourcesIdx = plain.indexOf("📰 Sources");
    const breakdown =
      breakdownIdx >= 0
        ? plain
            .slice(
              breakdownIdx + "Biggy Breakdown".length,
              sourcesIdx > breakdownIdx ? sourcesIdx : undefined
            )
            .trim()
        : "";

    if (legs.length < 2) return null;

    picks[tier] = {
      legs,
      combinedOdds: combinedMatch ? parseFloat(combinedMatch[1]) : productOdds(legs),
      breakdown,
    };
  }

  const dailyThesis = [...matches].map((match) => ({
    match,
    summary: `Pre-match focus on ${match}`,
    winnerLean: match.split(" vs ")[0] ?? match,
    goalsLean: "medium" as const,
    bttsLean: "neutral" as const,
  }));

  return { dailyThesis, picks };
}

function productOdds(legs: Array<{ odds: number }>): number {
  return legs.reduce((acc, leg) => acc * leg.odds, 1);
}

export async function cachedHasDuplicateLegs(pickDate: string): Promise<boolean> {
  const bundle = await parseBundleFromCachedSlips(pickDate);
  if (!bundle) return false;
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  return tiers.some((tier) => Boolean(validateDuplicateLegs(bundle.picks[tier].legs)));
}

export async function cachedHasBadGoBigLegs(pickDate: string): Promise<boolean> {
  const bundle = await parseBundleFromCachedSlips(pickDate);
  if (!bundle) return false;
  const legs = bundle.picks.go_big.legs;
  if (validateDuplicateLegs(legs)) return true;
  if (validateCorrelatedLegs(legs, "go_big")) return true;
  return false;
}

export async function cachedHasDefectiveSlips(pickDate: string): Promise<boolean> {
  return (
    (await cachedHasPlaceholderAnalysis(pickDate)) ||
    (await cachedHasThinBreakdowns(pickDate)) ||
    (await cachedHasDuplicateLegs(pickDate)) ||
    (await cachedHasBadGoBigLegs(pickDate))
  );
}

export async function cachedHasPlaceholderAnalysis(pickDate: string): Promise<boolean> {
  const tiers: PickTier[] = ["hit", "aim", "go_big"];
  for (const tier of tiers) {
    const content = await getCachedPickContent(pickDate, tier);
    if (!content) continue;
    const plain = slipHtmlToPlain(content);
    const idx = plain.indexOf("Biggy Breakdown");
    if (idx < 0) continue;
    if (isPlaceholderBreakdown(plain.slice(idx))) return true;
  }
  return false;
}

export function enrichBundleWithHeadlines(
  bundles: MatchBundle[],
  bundle: DailyPicksBundle
): DailyPicksBundle {
  const thesis = bundles.map((b) => {
    const match = fixtureLabel(b.fixture);
    const topHeadline = b.newsArticles[0]?.title;
    return {
      match,
      summary: topHeadline ?? `Pre-match lines on ${match}`,
      winnerLean: b.fixture.Participant1,
      goalsLean: "medium" as const,
      bttsLean: "neutral" as const,
    };
  });

  function breakdownFor(tier: PickTier): string {
    const legs = bundle.picks[tier].legs;
    const involved = new Set(legs.map((l) => l.match));
    const notes = bundles
      .filter((b) => involved.has(fixtureLabel(b.fixture)))
      .map((b) => {
        const match = fixtureLabel(b.fixture);
        const headlines = b.newsArticles
          .slice(0, 2)
          .map((a) => a.title.replace(/\s+/g, " ").trim())
          .join(" ");
        const form = b.research.recentForm
          .map((f) => `${f.team} ${f.lastFive}`)
          .join("; ");
        return { match, headlines, form, angle: b.research.bettingAngle };
      });

    const legPhrase = legs
      .map((l) => `${l.selection} (${l.odds.toFixed(2)}) on ${l.match}`)
      .join(", ");

    const newsLines = notes
      .map((n) => {
        const bits = [n.headlines, n.form, n.angle].filter(Boolean).join(" ");
        if (!bits) return "";
        const cleaned = bits.replace(new RegExp(`^${n.match}[:\\s-]+`, "i"), "").trim();
        return `${n.match}: ${cleaned || bits}`;
      })
      .filter(Boolean)
      .join(" ");

    return (
      newsLines ||
      `${legPhrase}. Lines and team news support these markets before kickoff.`
    ).trim();
  }

  return {
    dailyThesis: thesis,
    picks: {
      hit: { ...bundle.picks.hit, breakdown: breakdownFor("hit") },
      aim: { ...bundle.picks.aim, breakdown: breakdownFor("aim") },
      go_big: { ...bundle.picks.go_big, breakdown: breakdownFor("go_big") },
    },
  };
}

export async function enrichBundleWithGeminiAnalysis(
  bundles: MatchBundle[],
  bundle: DailyPicksBundle
): Promise<DailyPicksBundle> {
  const context = bundles.map((b) => ({
    match: fixtureLabel(b.fixture),
    competition: b.fixture.Competition,
    kickoff: new Date(fixtureKickoffMs(b.fixture)).toISOString(),
    headlines: b.newsArticles.slice(0, 5).map((a) => a.title),
    research: b.research,
  }));

  const locked = (["hit", "aim", "go_big"] as PickTier[]).map((tier) => ({
    tier,
    legs: bundle.picks[tier].legs,
    combinedOdds: bundle.picks[tier].combinedOdds,
  }));

  const prompt = `You are Biggy, a data-driven football parlay analyst.

The parlay legs below are LOCKED — do not change matches, selections, or odds values.

Write rich pre-match analysis using the match context (headlines, research, form, injuries, H2H).
Each breakdown MUST be 3–5 full sentences (at least 200 characters). Cite specific players, injuries, recent form, or headlines by name where available.

FORBIDDEN in breakdowns:
- Do NOT name the tier (Hit, Aim, Go Big) or say "this tier", "risk profile", "higher payout", "elevates risk", etc.
- Do NOT describe what the tier is for — users already see that on the slip.
- Write ONLY match-by-match analysis explaining why the locked legs make football sense.

Return ONLY JSON:
{
  "dailyThesis": [
    {
      "match": "Team A vs Team B",
      "summary": "One sentence thesis",
      "winnerLean": "team name",
      "goalsLean": "low|high|medium",
      "bttsLean": "yes|no|neutral"
    }
  ],
  "breakdowns": {
    "hit": "analysis for hit tier",
    "aim": "analysis for aim tier",
    "go_big": "analysis for go_big tier"
  }
}

Match context:
${JSON.stringify(context, null, 2)}

Locked picks (do not modify legs):
${JSON.stringify(locked, null, 2)}`;

  const { result } = await generateJsonLlm<{
    dailyThesis: DailyPicksBundle["dailyThesis"];
    breakdowns: Record<PickTier, string>;
  }>(prompt);

  return {
    dailyThesis: result.dailyThesis,
    picks: {
      hit: {
        ...bundle.picks.hit,
        breakdown: stripMetaTierProse(result.breakdowns.hit),
      },
      aim: {
        ...bundle.picks.aim,
        breakdown: stripMetaTierProse(result.breakdowns.aim),
      },
      go_big: {
        ...bundle.picks.go_big,
        breakdown: stripMetaTierProse(result.breakdowns.go_big),
      },
    },
  };
}
