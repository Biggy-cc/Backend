import type { TxlineFixture } from "../txline/client.js";
import { fetchMatchNews, type NewsArticle } from "../news/google.js";
import {
  createGeminiClient,
  extractJson,
  generateGrounded,
} from "./gemini.js";
import { generateJsonLlm, isQuotaError } from "./llm.js";
import { mergeArticleAndGroundingSources } from "./sources.js";
import type { PickSource } from "./types.js";

export type MatchResearch = {
  match: string;
  injuriesAndSuspensions: string[];
  headToHead: string;
  recentForm: Array<{ team: string; lastFive: string }>;
  keyNews: string[];
  bettingAngle: string;
};

export type EnrichedMatch = {
  fixture: TxlineFixture;
  research: MatchResearch;
  newsArticles: NewsArticle[];
  sources: PickSource[];
};

function buildMatchList(fixtures: TxlineFixture[]): string {
  return fixtures
    .map(
      (f) =>
        `- ${f.Participant1} vs ${f.Participant2} (${f.Competition}, kickoff ${new Date(f.StartTime).toISOString()})`
    )
    .join("\n");
}

function researchJsonPrompt(matchList: string, headlineBlock?: string): string {
  const headlineSection = headlineBlock
    ? `\n\nRecent headlines (use these; do not invent facts beyond them):\n${headlineBlock}`
    : "";

  return `You are a football research analyst preparing data for a betting model.

Research EACH match below using the context provided.${headlineSection}

Matches:
${matchList}

Return ONLY a JSON array (no markdown). One object per match, same order as above:
[
  {
    "match": "Team A vs Team B",
    "injuriesAndSuspensions": ["Player X doubtful — outlet", "..."],
    "headToHead": "Last meetings and results in one sentence",
    "recentForm": [
      { "team": "Team A", "lastFive": "W W D L W — brief note" },
      { "team": "Team B", "lastFive": "..." }
    ],
    "keyNews": ["Tactical or lineup headline", "..."],
    "bettingAngle": "One sentence on what the data suggests for markets"
  }
]

Rules:
- Focus on injuries, suspensions, team news, head-to-head, and recent form.
- If nothing confirmed, use empty arrays or "No confirmed reports" — do not invent.
- Mention outlet or date in injury/news bullets when possible.`;
}

function headlinesBlock(
  fixtures: TxlineFixture[],
  newsByMatch: NewsArticle[][]
): string {
  return fixtures
    .map((f, i) => {
      const titles = (newsByMatch[i] ?? [])
        .slice(0, 5)
        .map((a) => `  - ${a.title}`)
        .join("\n");
      return `${f.Participant1} vs ${f.Participant2}:\n${titles || "  (no headlines)"}`;
    })
    .join("\n\n");
}

function mapEnriched(
  fixtures: TxlineFixture[],
  researchList: MatchResearch[],
  newsByMatch: NewsArticle[][],
  groundingSources: PickSource[]
): EnrichedMatch[] {
  return fixtures.map((fixture, i) => {
    const newsArticles = newsByMatch[i] ?? [];
    return {
      fixture,
      research: researchList[i] ?? {
        match: `${fixture.Participant1} vs ${fixture.Participant2}`,
        injuriesAndSuspensions: [],
        headToHead: "No confirmed reports",
        recentForm: [],
        keyNews: newsArticles.map((a) => a.title).slice(0, 4),
        bettingAngle: "",
      },
      newsArticles,
      sources: mergeArticleAndGroundingSources(newsArticles, groundingSources),
    };
  });
}

export async function researchMatches(
  fixtures: TxlineFixture[]
): Promise<EnrichedMatch[]> {
  if (fixtures.length === 0) return [];

  const matchList = buildMatchList(fixtures);
  const newsByMatch = await Promise.all(
    fixtures.map((f) => fetchMatchNews(f.Participant1, f.Participant2))
  );

  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = createGeminiClient();
      const grounded = await generateGrounded(
        ai,
        researchJsonPrompt(matchList)
      );
      const researchList = extractJson<MatchResearch[]>(grounded.text);
      return mapEnriched(fixtures, researchList, newsByMatch, grounded.sources);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      console.warn("[research] Gemini grounded quota — trying OpenRouter/Groq");
    }
  }

  try {
    const headlineBlock = headlinesBlock(fixtures, newsByMatch);
    const { result } = await generateJsonLlm<MatchResearch[]>(
      researchJsonPrompt(matchList, headlineBlock)
    );
    return mapEnriched(fixtures, result, newsByMatch, []);
  } catch (err) {
    console.warn("[research] LLM research failed — headlines only:", err);
    return mapEnriched(
      fixtures,
      fixtures.map((f, i) => ({
        match: `${f.Participant1} vs ${f.Participant2}`,
        injuriesAndSuspensions: [],
        headToHead: "See latest headlines below",
        recentForm: [],
        keyNews: (newsByMatch[i] ?? []).map((a) => a.title).slice(0, 4),
        bettingAngle: "Pre-match lines on upcoming kickoff",
      })),
      newsByMatch,
      []
    );
  }
}

/** RSS headlines only — no LLM (for kickoff refresh when quota is tight). */
export async function researchMatchesLight(
  fixtures: TxlineFixture[]
): Promise<EnrichedMatch[]> {
  if (fixtures.length === 0) return [];

  const newsByMatch = await Promise.all(
    fixtures.map((f) => fetchMatchNews(f.Participant1, f.Participant2))
  );

  return fixtures.map((fixture, i) => {
    const newsArticles = newsByMatch[i] ?? [];
    return {
      fixture,
      research: {
        match: `${fixture.Participant1} vs ${fixture.Participant2}`,
        injuriesAndSuspensions: [],
        headToHead: "See latest headlines below",
        recentForm: [],
        keyNews: newsArticles.map((a) => a.title).slice(0, 4),
        bettingAngle: "Pre-match lines on upcoming kickoff",
      },
      newsArticles,
      sources: mergeArticleAndGroundingSources(newsArticles, []),
    };
  });
}
