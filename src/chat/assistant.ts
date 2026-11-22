import { getUpcomingFixturesPayload, type FixtureApiItem } from "../api/fixtures.js";
import { getCachedPick, todayPickDate } from "../picks/generate.js";
import { getLiveScoresPayload } from "../api/live-scores.js";
import { fetchMatchOdds, resolveLiveOddsFixture, matchParlaySelectionOptions, commonParlayQuotes } from "../api-football/match-odds.js";
import {
  fetchApiFootballMatchContext,
  fetchApiFootballMatchEvents,
  fetchApiFootballSelectedMatch,
  fetchApiFootballFixtureResearch,
  fetchApiFootballNextFixturesForTeam,
  fetchApiFootballRecentFixturesForTeam,
  fetchApiFootballTeamStanding,
} from "../api-football/client.js";

type ResponseItem = {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
};

type OpenAiResponse = {
  id?: string;
  output_text?: string;
  output?: ResponseItem[];
  error?: { message?: string };
};

export type ProposedParlay = {
  title: string;
  risk: "safe" | "balanced" | "go_big";
  legs: Array<{
    home: string;
    away: string;
    selection: string;
    kickoffAt: string;
    fixtureId?: string;
    homeLogo?: string;
    awayLogo?: string;
    odds?: { price: number; bookmaker: string; market: string; selection: string; retrievedAt: string; providerUpdatedAt?: string };
  }>;
};

const TOOLS = [
  {
    type: "function",
    name: "get_match_odds",
    description: "Get available in-play or pre-match betting odds for the exact football match. Use both teams from the current conversation; never invent prices.",
    parameters: {
      type: "object",
      properties: { home: { type: "string" }, away: { type: "string" } },
      required: ["home", "away"], additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_live_scores",
    description: "Get every football match currently in play with verified scores and match status.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "get_upcoming_matches",
    description: "Get Biggy's verified upcoming football fixtures for the next seven days.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "get_match_events",
    description: "Get the score, goalscorers, assists, minutes, cards and other events for a live match or the most recent completed meeting. Use both teams and any specific date from the conversation.",
    parameters: {
      type: "object",
      properties: {
        home: { type: "string", description: "Home team in the match being discussed." },
        away: { type: "string", description: "Away team in the match being discussed." },
        matchDate: { type: ["string", "null"], description: "Requested match date in YYYY-MM-DD, or null if unspecified." },
      },
      required: ["home", "away", "matchDate"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_team_schedule",
    description: "Find a football club by name and get its next five scheduled fixtures.",
    parameters: {
      type: "object",
      properties: {
        team: { type: "string", description: "Full or common club name, for example Manchester United." },
      },
      required: ["team"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_team_results",
    description: "Get a named football club's most recent completed matches with dates, competitions, opponents, scores and win/draw/loss results.",
    parameters: {
      type: "object",
      properties: {
        team: { type: "string", description: "Full or common club name, for example Arsenal." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Number of recent completed matches requested." },
      },
      required: ["team", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_team_standing",
    description: "Get a named club's current primary domestic league position, points, record, goal difference and recent form. Never use friendly, summer-series, youth, reserve or exhibition tables.",
    parameters: {
      type: "object",
      properties: { team: { type: "string" } },
      required: ["team"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "analyze_match",
    description: "Research a matchup using both teams' last five results, recent head-to-head meetings, next meeting, and available injury news. Must be used before any match prediction.",
    parameters: {
      type: "object",
      properties: {
        home: { type: "string", description: "Home team name." },
        away: { type: "string", description: "Away team name." },
      },
      required: ["home", "away"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_daily_parlay",
    description: "Get today's saved Biggy parlay for a requested risk level, if one is available.",
    parameters: {
      type: "object",
      properties: {
        risk: {
          type: "string",
          enum: ["safe", "balanced", "go_big"],
          description: "The user's desired risk level.",
        },
      },
      required: ["risk"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "propose_parlay_for_approval",
    description: "Present a researched parlay proposal to the user for explicit approval. Calling this does not create or track the parlay.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        risk: { type: "string", enum: ["safe", "balanced", "go_big"] },
        summary: { type: "string", description: "A concise user-facing explanation grounded in the research. Do not discuss odds, which are fetched separately." },
        legs: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              home: { type: "string" },
              away: { type: "string" },
              selection: { type: "string" },
              kickoffAt: { type: "string", description: "ISO 8601 kickoff time." },
            },
            required: ["home", "away", "selection", "kickoffAt"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "risk", "summary", "legs"],
      additionalProperties: false,
    },
    strict: true,
  },
] as const;

function extractText(body: OpenAiResponse): string {
  if (body.output_text?.trim()) return body.output_text.trim();
  return (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

async function callOpenAi(payload: Record<string, unknown>): Promise<OpenAiResponse> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const startedAt = Date.now();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(22_000),
  });
  const body = (await response.json()) as OpenAiResponse;
  console.log(`[chat-timing] model_ms=${Date.now() - startedAt} status=${response.status}`);
  if (!response.ok) {
    throw new Error(body.error?.message ?? `OpenAI HTTP ${response.status}`);
  }
  return body;
}

function nameKey(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function teamMentioned(message: string, team: string): boolean {
  const text = nameKey(message), name = nameKey(team);
  if (name.length >= 4 && ` ${text} `.includes(` ${name} `)) return true;
  const words = name.split(" ").filter((word) => word.length >= 6);
  return text.split(" ").some((word) => word.length >= 5 && words.some((candidate) => {
    if (Math.abs(word.length - candidate.length) > 2) return false;
    const previous = Array.from({ length: candidate.length + 1 }, (_, i) => i);
    for (let i = 1; i <= word.length; i++) {
      let diagonal = previous[0]; previous[0] = i;
      for (let j = 1; j <= candidate.length; j++) {
        const above = previous[j];
        previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + Number(word[i - 1] !== candidate[j - 1]));
        diagonal = above;
      }
    }
    return previous[candidate.length] <= 2;
  }));
}

export function isParlayRevision(message: string, activeParlay?: ProposedParlay): boolean {
  return !!activeParlay && /\b(?:replace|swap|change|adjust|another|different|instead|remove|switch|alternative|alternatives|other|not|rather)\b/i.test(message);
}

async function runTool(name: string, rawArguments: string | undefined, selectedFixtureId?: number, parlayFixtures?: FixtureApiItem[], researched?: Set<string>): Promise<unknown> {
  if (name === "get_match_odds") {
    const parsed = JSON.parse(rawArguments || "{}") as { home?: string; away?: string };
    try {
      const id = selectedFixtureId ?? await resolveLiveOddsFixture(parsed.home ?? "", parsed.away ?? "");
      return id ? await fetchMatchOdds(id) : { error: "Could not unambiguously identify the live fixture. Ask the user to select the match or specify both teams." };
    } catch { return { error: "The odds provider is temporarily unavailable; do not invent prices." }; }
  }
  if (name === "get_live_scores") {
    return { asOf: new Date().toISOString(), matches: await getLiveScoresPayload() };
  }
  if (name === "get_upcoming_matches") {
    return { asOf: new Date().toISOString(), fixtures: await getUpcomingFixturesPayload() };
  }
  if (name === "get_match_events") {
    if (selectedFixtureId) return fetchApiFootballSelectedMatch(selectedFixtureId);
    const parsed = JSON.parse(rawArguments || "{}") as { home?: string; away?: string; matchDate?: string | null };
    if (!parsed.home?.trim() || !parsed.away?.trim()) return { error: "Both teams are required to identify the match." };
    return await fetchApiFootballMatchEvents(parsed.home.trim(), parsed.away.trim(), parsed.matchDate ?? null);
  }
  if (name === "get_team_schedule") {
    const parsed = JSON.parse(rawArguments || "{}") as { team?: string };
    if (!parsed.team?.trim()) return { error: "Team name is required" };
    return await fetchApiFootballNextFixturesForTeam(parsed.team.trim(), 5)
      ?? { error: `No team found for ${parsed.team}` };
  }
  if (name === "get_team_results") {
    const parsed = JSON.parse(rawArguments || "{}") as { team?: string; limit?: number };
    if (!parsed.team?.trim()) return { error: "Team name is required" };
    const limit = Number.isInteger(parsed.limit) ? Math.max(1, Math.min(parsed.limit!, 10)) : 5;
    return await fetchApiFootballRecentFixturesForTeam(parsed.team.trim(), limit)
      ?? { error: `No team found for ${parsed.team}` };
  }
  if (name === "get_team_standing") {
    const parsed = JSON.parse(rawArguments || "{}") as { team?: string };
    if (!parsed.team?.trim()) return { error: "Team name is required" };
    return await fetchApiFootballTeamStanding(parsed.team.trim())
      ?? { error: `No current league standing found for ${parsed.team}` };
  }
  if (name === "analyze_match") {
    const parsed = JSON.parse(rawArguments || "{}") as { home?: string; away?: string };
    if (!parsed.home?.trim() || !parsed.away?.trim()) return { error: "Both teams are required" };
    if (parlayFixtures) {
      const fixture = parlayFixtures.find((item) => nameKey(item.home.name) === nameKey(parsed.home!) && nameKey(item.away.name) === nameKey(parsed.away!));
      if (!fixture) return { error: "This fixture is not in the verified upcoming list." };
      const researchStart = Date.now();
      try {
        const research = await fetchApiFootballFixtureResearch(Number(fixture.id));
        console.log(`[chat-timing] fixture_research_ms=${Date.now() - researchStart} available=${!!research}`);
        if (!research) return { error: "Provider has no research for this fixture; choose another or explain the limitation." };
        researched?.add(fixture.id);
        return { fixture, research, note: "Provider research is informational and is not a guarantee. Odds are not included." };
      } catch {
        console.log(`[chat-timing] fixture_research_ms=${Date.now() - researchStart} available=false`);
        return { error: "Provider research is temporarily unavailable for this fixture." };
      }
    }
    return await fetchApiFootballMatchContext(parsed.home.trim(), parsed.away.trim())
      ?? { error: "Could not resolve one or both teams" };
  }
  if (name === "get_daily_parlay") {
    const parsed = JSON.parse(rawArguments || "{}") as { risk?: string };
    const tier = parsed.risk === "safe" ? "hit" : parsed.risk === "go_big" ? "go_big" : "aim";
    const date = todayPickDate();
    return { date, risk: parsed.risk ?? "balanced", parlay: await getCachedPick(date, tier) };
  }
  return { error: "Unknown tool" };
}

export type BiggyChatMessage = { role: "user" | "assistant"; content: string };

export async function askBiggy(
  message: string,
  history: BiggyChatMessage[] = [],
  timezone = "UTC",
  selectedFixtureId?: number,
  allowParlay = false,
  authorizeProposal?: () => Promise<boolean>,
  activeParlay?: ProposedParlay
): Promise<{ answer: string; model: string; parlay?: ProposedParlay }> {
  const model = process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const requiresRecentResults =
    /\b(?:last|previous|recent)\b/i.test(message) &&
    /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|match(?:es)?|game(?:s)?|result(?:s)?)\b/i.test(message);
  const requiresMatchEvents = /\b(?:who\s+(?:has\s+)?scored|who(?:'s|\s+is)\s+scored|goalscorers?|goal\s*scorers?|who\s+got\s+the\s+goals?|match\s+events|red\s+cards?)\b/i.test(message);
  const asksMatchOdds = /\b(?:odds|ods|betting prices?|bookmaker prices?)\b/i.test(message);
  const asksMatchSummary = /\b(?:tell me about|what(?:'s| is) happening|what happened|match summary)\b/i.test(message) && /\b(?:vs\.?|versus)\b/i.test(message);
  const recentParlayContext = history.slice(-6).some((item) => /\b(?:parlays?|parleys?|parly|accumulators?|accas?)\b/i.test(item.content));
  const continuesParlayTask = recentParlayContext && /^(?:yes|yeah|yep|ok(?:ay)?|go ahead|do it|safe|balanced|go big)[.! ]*$/i.test(message.trim());
  const revisingParlay = isParlayRevision(message, activeParlay);
  const replaceWholeParlay = revisingParlay && /\b(?:another|different|new|fresh)\s+(?:(?:safe|balanced|big)\s+)?(?:parlay|parley|accumulator|acca)\b/i.test(message);
  const requiresParlayApproval = /\b(?:parlays?|parleys?|parly|accumulators?|accas?)\b/i.test(message) || continuesParlayTask || revisingParlay;
  if (requiresParlayApproval && !allowParlay) return { answer: "Parlay research requires an active Biggy Pro or Max subscription.", model };
  // Card clicks already specify the fixture: fetch it before the first model call
  // to avoid an additional model/tool round trip for the common summary path.
  const selectedMatchContext = selectedFixtureId && !asksMatchOdds && (asksMatchSummary || requiresMatchEvents)
    ? await fetchApiFootballSelectedMatch(selectedFixtureId)
    : null;
  let selectedOddsContext: unknown = null;
  if (selectedFixtureId && asksMatchOdds) {
    try { selectedOddsContext = await fetchMatchOdds(selectedFixtureId); }
    catch { selectedOddsContext = { error: "The odds provider is temporarily unavailable; do not invent prices." }; }
  }
  let verifiedParlayContext = "";
  let parlayFixtures: FixtureApiItem[] | undefined;
  let requestedParlayRisk: ProposedParlay["risk"] = "balanced";
  const researchedFixtures = new Set<string>();
  if (requiresParlayApproval) {
    const riskText = `${history.filter((item) => item.role === "user").slice(-3).map((item) => item.content).join(" ")} ${message}`;
    const lastRisk = [...riskText.matchAll(/\b(?:safe|hit|balanced|go big|go_big)\b/gi)].at(-1)?.[0].toLowerCase();
    requestedParlayRisk = lastRisk === "safe" || lastRisk === "hit" ? "safe" : lastRisk === "go big" || lastRisk === "go_big" ? "go_big" : lastRisk === "balanced" ? "balanced" : revisingParlay ? activeParlay!.risk : "balanced";
    const timeframe = [...riskText.matchAll(/\b(?:today|tonight|tomorrow)\b/gi)].at(-1)?.[0].toLowerCase();
    let localDate = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
    if (timeframe === "tomorrow") {
      const nextDay = new Date(`${localDate}T12:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      localDate = nextDay.toISOString().slice(0, 10);
    }
    const fixtureStart = Date.now();
    parlayFixtures = await getUpcomingFixturesPayload({ ...(timeframe ? { localDate } : {}), timeZone: timezone, max: revisingParlay ? 40 : 20 });
    console.log(`[chat-timing] fixture_pool_ms=${Date.now() - fixtureStart} count=${parlayFixtures.length} revision=${revisingParlay}`);
    if (parlayFixtures.length < 2) return { answer: "I can’t verify enough upcoming fixtures for that parlay right now. Please try again later or choose a different day.", model };
    verifiedParlayContext = `VERIFIED PARLAY CONTEXT: Research and propose a ${requestedParlayRisk} parlay using only these fixtures: ${JSON.stringify(parlayFixtures).slice(0, 30_000)}${revisingParlay ? `\nACTIVE USER PROPOSAL TO REVISE: ${JSON.stringify(activeParlay)}` : ""}`;
  }
  const base = {
    model,
    instructions: [
      "You are Biggy, a concise and friendly football assistant.",
      ...(!allowParlay ? ["This account does not have parlay access. Do not create, recommend, or draft a multi-leg bet, including when asked with indirect wording. Explain that a paid plan is required; ordinary football questions are allowed."] : []),
      "Conversation context is binding. Interpret short follow-ups using the immediately preceding intent: if the user asks a table question and then says another club name, answer the same table question for that club; if they ask about a fixture and then name another club, answer the same fixture question for that club.",
      "In contextual follow-ups, change only the entity the user changed. Preserve the requested statistic, competition type, timeframe and comparison unless the user explicitly changes them.",
      "Resolve professional clubs to their primary domestic league. Never substitute a friendly, summer series, youth, reserve or exhibition competition for a domestic league table.",
      "If a short team name genuinely matches multiple professional clubs and the conversation does not disambiguate it, ask one concise clarification question instead of guessing.",
      "Use get_live_scores for anything happening now or live. Use get_upcoming_matches for future fixtures.",
      "When the user asks for odds, including misspellings like 'ods' or a correction such as 'I mean match odds', answer the odds request in the context of the match they were discussing. Use get_match_odds unless verified odds data is supplied. Never substitute the score for the odds. Clearly label live versus pre-match, report only active prices without displaying bookmaker names, and state the retrieval or provider-update time in the user's timezone. If prices are missing, suspended or the provider failed, say so without inventing prices or treating pre-match prices as live.",
      ...(selectedOddsContext ? ["Verified selected-fixture odds data is supplied with the conversation. Use that data directly for this odds request; do not call get_match_odds again."] : []),
      "Use get_match_events for goalscorers, assists, cards and match events, including short contextual follow-ups such as 'who scored?'. Resolve both teams from the conversation. If the matchup is unclear, ask for clarification. Distinguish own goals, penalties, disallowed goals and missing event coverage; never invent scorers or claim live scores alone contain them.",
      "For a match summary, use get_match_events to identify whether the match is live or the most recent completed meeting and include available goalscorers and minutes. If the user requests a specific past date, pass it as matchDate; never replace it with a different fixture. If event coverage is empty or unavailable, say so without guessing.",
      "For a verified 0–0 match, do not add a warning about unavailable goalscorers: the score already establishes that no goals were scored. If asked about cards or other events and event data is unavailable, say so.",
      ...(selectedFixtureId ? ["The user selected a specific match card. The match-events tool returns that exact fixture, including upcoming matches; use it rather than asking the user to identify it again. For upcoming matches give the kickoff in the user's timezone, and never present missing events as a completed match."] : []),
      ...(selectedMatchContext ? ["Verified selected-fixture data is supplied with the conversation. Use it directly for this match summary or event question instead of calling get_match_events again. If it says the fixture or events are unavailable, say so rather than inventing details."] : []),
      "Use get_team_schedule whenever the user asks when a named club plays, its next game, or its upcoming schedule.",
      "Use get_team_results whenever the user asks for a club's last, previous, recent or completed matches. If the user asks for the last five, return five completed results with opponent, score, competition and local date. Never answer a results request with upcoming fixtures.",
      "Use get_team_standing whenever the user asks for a club's league position, rank, points, table record, or current standing.",
      "You MUST use analyze_match before giving a prediction, betting lean, score estimate, form comparison, or matchup analysis.",
      "Base any prediction on the returned recent form, head-to-head and injury data. State the evidence briefly; never give a naked guess or generic disclaimer.",
      "Use the supplied tools whenever the user asks about current fixtures, scores, or a Biggy parlay.",
      "Never invent live scores, results, odds, injuries, fixtures, or statistics.",
      "Never substitute upcoming fixtures for live matches or completed results.",
      "Parlays are informational, never guaranteed. Keep answers useful and under 250 words.",
      "When you recommend a specific multi-leg parlay, you MUST call propose_parlay_for_approval. A proposal is never approved or tracked automatically.",
      "Put your concise evidence-based explanation in the proposal's summary. Prices are fetched separately, so do not claim odds are missing or give prices in the summary.",
      "Tell the user to review the proposal card and approve it before its matches are tracked.",
      "A request to build, create, research or suggest a parlay is already permission to research and propose one. Do not ask whether you should research after the user has requested a parlay.",
      "If get_daily_parlay has no saved card, immediately use get_upcoming_matches, choose suitable fixtures, call analyze_match for the candidate matchups, and then call propose_parlay_for_approval.",
      "Default to balanced risk when the user requests a parlay without a risk level. If the user later replies yes, safe, balanced or go big, continue the active parlay task using that answer; do not restart the conversation or repeat that no saved card exists.",
      "Never report the absence of a saved parlay more than once in the same task. The fallback is to research and build a fresh proposal, not to stop.",
      "When VERIFIED PARLAY CONTEXT is supplied in the input, do not call get_daily_parlay or get_upcoming_matches again. Use the supplied fixtures, analyze the candidate matchups, and proceed to the approval proposal.",
      "For a parlay, use analyze_match on every fixture before proposing it. Use 2 or 3 distinct fixtures. If provider research is unavailable, explain the limitation instead of fabricating a parlay. Do not invent bookmaker odds or prices.",
      "Do not mention saved cards, internal caches, tool calls, or implementation details. For a parlay, start with a concise explanation of the proposed selections and the verified evidence. Do not claim injuries, form, head-to-head results, or odds that the research did not supply. Call analyze_match for candidate fixtures in parallel where possible.",
      ...(revisingParlay ? [replaceWholeParlay ? "The user requested a different parlay. Use different matches from the active proposal and research every match in the new card." : "The user is revising the active proposal. Preserve all unaffected matches and selections, replace only the requested leg with a different verified match, and research every match in the revised card. If the target is unclear ask a clarifying question rather than changing unrelated legs."] : []),
      `The user's timezone is ${timezone}. Convert every kickoff time to that timezone and label it; do not default to UTC unless the user's timezone is UTC.`,
    ].join(" "),
    tools: requiresParlayApproval ? TOOLS.filter((tool) => tool.name === "analyze_match" || tool.name === "propose_parlay_for_approval") : allowParlay ? TOOLS : TOOLS.filter((tool) => tool.name !== "get_daily_parlay" && tool.name !== "propose_parlay_for_approval"),
    reasoning: { effort: process.env.OPENAI_REASONING_EFFORT ?? "none" },
    max_output_tokens: 700,
  };

  const input = [
    ...history.slice(-10).map((item) => ({ role: item.role, content: item.content.slice(0, 2_000) })),
    ...(verifiedParlayContext ? [{ role: "user" as const, content: verifiedParlayContext }] : []),
    ...(selectedMatchContext ? [{ role: "user" as const, content: `VERIFIED SELECTED FIXTURE DATA: ${JSON.stringify(selectedMatchContext)}` }] : []),
    ...(selectedOddsContext ? [{ role: "user" as const, content: `VERIFIED SELECTED FIXTURE ODDS: ${JSON.stringify(selectedOddsContext)}` }] : []),
    { role: "user", content: message },
  ];
  let proposedParlay: ProposedParlay | undefined;
  let proposalSummary: string | undefined;
  let forcedProposal = false;
  let researchRequests = 0;
  let priceAttempts = 0;
  let response = await callOpenAi({
    ...base,
    input,
    ...(!requiresParlayApproval && !selectedOddsContext && asksMatchOdds
      ? { tool_choice: { type: "function", name: "get_match_odds" } }
      : !requiresParlayApproval && !selectedMatchContext && (asksMatchSummary || requiresMatchEvents) && (history.length > 0 || /\b(?:vs\.?|versus)\b/i.test(message))
      ? { tool_choice: { type: "function", name: "get_match_events" } }
      : !requiresParlayApproval && requiresRecentResults
      ? { tool_choice: { type: "function", name: "get_team_results" } }
      : {}),
  });
  for (let round = 0; round < 5; round += 1) {
    const calls = (response.output ?? []).filter((item) => item.type === "function_call");
    if (calls.length === 0) {
      if (requiresParlayApproval && !proposedParlay && !forcedProposal && researchedFixtures.size >= 2) {
        forcedProposal = true;
        response = await callOpenAi({
          ...base,
          previous_response_id: response.id,
          input: "Now convert your researched recommendation into the required approval proposal. Call propose_parlay_for_approval; do not answer with prose only.",
          tool_choice: { type: "function", name: "propose_parlay_for_approval" },
        });
        continue;
      }
      const answer = extractText(response);
      if (!answer) throw new Error("OpenAI returned an empty answer");
      if (requiresParlayApproval && !proposedParlay) return { answer: "I couldn’t verify enough suitable matches to build a parlay right now. Please try another day or ask me to research specific matches.", model };
      return { answer, model, ...(proposedParlay ? { parlay: proposedParlay } : {}) };
    }

    const toolOutputs = await Promise.all(
      calls.map(async (call) => {
        if (requiresParlayApproval && call.name !== "analyze_match" && call.name !== "propose_parlay_for_approval") return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "Use the verified fixtures and analyze_match for this parlay." }) };
        if (requiresParlayApproval && call.name === "analyze_match" && ++researchRequests > 4) return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "Research limit reached. Use the already researched fixtures or explain that data is unavailable." }) };
        if (!allowParlay && (call.name === "get_daily_parlay" || call.name === "propose_parlay_for_approval")) return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "Parlays require an active paid subscription." }) };
        if (call.name === "get_daily_parlay" && (!authorizeProposal || !(await authorizeProposal()))) return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "Daily parlay limit reached. Do not provide a parlay." }) };
        if (call.name === "propose_parlay_for_approval") {
          if (!allowParlay) return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "Parlays require an active paid subscription." }) };
          const candidate = JSON.parse(call.arguments || "{}") as ProposedParlay & { summary?: unknown };
          const legs = Array.isArray(candidate.legs) ? candidate.legs : [];
          const matching = legs.map((leg) => parlayFixtures?.find((fixture) => nameKey(fixture.home.name) === nameKey(leg.home ?? "") && nameKey(fixture.away.name) === nameKey(leg.away ?? "")));
          const valid = legs.length >= 2 && legs.length <= 8 && matching.every((fixture, index) => fixture && researchedFixtures.has(fixture.id) && Date.parse(fixture.kickoffAt) > Date.now() && typeof legs[index].selection === "string" && legs[index].selection.trim().length > 0) && new Set(matching.map((fixture) => fixture?.id)).size === legs.length;
          const preserved = revisingParlay ? legs.filter((leg) => activeParlay!.legs.some((old) => nameKey(old.home) === nameKey(leg.home ?? "") && nameKey(old.away) === nameKey(leg.away ?? "") && nameKey(old.selection) === nameKey(leg.selection ?? ""))).length : 0;
          const namedTargets = revisingParlay ? activeParlay!.legs.filter((old) => [old.home, old.away].some((team) => teamMentioned(message, team))) : [];
          const targetRemoved = namedTargets.length !== 1 || !legs.some((leg) => nameKey(leg.home ?? "") === nameKey(namedTargets[0].home) && nameKey(leg.away ?? "") === nameKey(namedTargets[0].away));
          const hasOldFixture = revisingParlay && legs.some((leg) => activeParlay!.legs.some((old) => nameKey(old.home) === nameKey(leg.home ?? "") && nameKey(old.away) === nameKey(leg.away ?? "")));
          const validRevision = !revisingParlay || (replaceWholeParlay ? !hasOldFixture : legs.length === activeParlay!.legs.length && preserved === legs.length - 1 && targetRemoved);
          if (!valid || !validRevision || candidate.risk !== requestedParlayRisk) {
            return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "Every leg must be a distinct, verified upcoming fixture with successful research. For a revision, replace the requested match only and preserve the other selections. Correct the proposal or explain what is unavailable." }) };
          }
          if (++priceAttempts > 2) return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "Unable to verify a complete set of current prices. Do not propose this parlay." }) };
          const options = await Promise.all(legs.map(async (leg, i) => {
            const fixture = matching[i]!;
            try {
              const data = await fetchMatchOdds(Number(fixture.id), { home: fixture.home.name, away: fixture.away.name, kickoffAt: fixture.kickoffAt });
              return "error" in data ? [] : matchParlaySelectionOptions(data, leg.selection, fixture.home.name, fixture.away.name);
            } catch { return []; }
          }));
          const quotes = commonParlayQuotes(options);
          if (!quotes) return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "These selections do not have a complete verified set of prices from one source. Choose different researched fixtures or markets and propose again; do not invent prices.", unpricedMatches: legs.filter((_, i) => !options[i].length).map((leg) => `${leg.home} vs ${leg.away}`) }) };
          if (!authorizeProposal || !(await authorizeProposal())) return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "Daily parlay limit reached. Do not propose a parlay." }) };
          proposedParlay = { title: String(candidate.title ?? "Parlay proposal").slice(0, 120), risk: candidate.risk, legs: legs.map((leg, i) => ({ home: matching[i]!.home.name, away: matching[i]!.away.name, selection: leg.selection, kickoffAt: matching[i]!.kickoffAt, fixtureId: matching[i]!.id, homeLogo: matching[i]!.home.logoUrl, awayLogo: matching[i]!.away.logoUrl, odds: quotes[i] })) };
          if (typeof candidate.summary === "string" && candidate.summary.trim()) proposalSummary = candidate.summary.trim().slice(0, 1500);
          return {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ status: "awaiting_user_approval" }),
          };
        }
        try { return {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(await runTool(call.name ?? "", call.arguments, selectedFixtureId, parlayFixtures, researchedFixtures)),
        }; } catch (error) {
          console.error(`[chat] ${call.name ?? "unknown tool"} failed:`, error instanceof Error ? error.message : "unknown error");
          return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "Football data is temporarily unavailable for this request." }) };
        }
      })
    );
    if (proposedParlay && proposalSummary) return { answer: proposalSummary, model, parlay: proposedParlay };
    response = await callOpenAi({
      ...base,
      previous_response_id: response.id,
      input: toolOutputs,
    });
  }
  if (requiresParlayApproval) return { answer: "I couldn’t verify current prices for a complete researched parlay. Please try again or ask for different matches.", model };
  throw new Error("Biggy used too many tool rounds");
}
