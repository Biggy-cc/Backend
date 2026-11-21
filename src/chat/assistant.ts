import { getUpcomingFixturesPayload } from "../api/fixtures.js";
import { getCachedPick, todayPickDate } from "../picks/generate.js";
import { getLiveScoresPayload } from "../api/live-scores.js";
import {
  fetchApiFootballMatchContext,
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
  }>;
};

const TOOLS = [
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
      required: ["title", "risk", "legs"],
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
  if (!response.ok) {
    throw new Error(body.error?.message ?? `OpenAI HTTP ${response.status}`);
  }
  return body;
}

async function runTool(name: string, rawArguments: string | undefined): Promise<unknown> {
  if (name === "get_live_scores") {
    return { asOf: new Date().toISOString(), matches: await getLiveScoresPayload() };
  }
  if (name === "get_upcoming_matches") {
    return { asOf: new Date().toISOString(), fixtures: await getUpcomingFixturesPayload() };
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
  timezone = "UTC"
): Promise<{ answer: string; model: string; parlay?: ProposedParlay }> {
  const model = process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const requiresRecentResults =
    /\b(?:last|previous|recent)\b/i.test(message) &&
    /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|match(?:es)?|game(?:s)?|result(?:s)?)\b/i.test(message);
  const recentParlayContext = history.slice(-6).some((item) => /\b(parlay|accumulator|acca)\b/i.test(item.content));
  const continuesParlayTask = recentParlayContext && /^(?:yes|yeah|yep|ok(?:ay)?|go ahead|do it|safe|balanced|go big)[.! ]*$/i.test(message.trim());
  const requiresParlayApproval = /\b(parlay|accumulator|acca)\b/i.test(message) || continuesParlayTask;
  let verifiedParlayContext = "";
  if (requiresParlayApproval) {
    const requestedRisk = /\b(?:safe|hit)\b/i.test(message) ? "safe" : /\b(?:go big|go_big)\b/i.test(message) ? "go_big" : "balanced";
    const tier = requestedRisk === "safe" ? "hit" : requestedRisk === "go_big" ? "go_big" : "aim";
    const date = todayPickDate();
    const saved = await getCachedPick(date, tier);
    if (saved) {
      verifiedParlayContext = `VERIFIED PARLAY CONTEXT: A saved ${requestedRisk} card exists for ${date}: ${JSON.stringify(saved).slice(0, 10_000)}`;
    } else {
      const fixtures = await getUpcomingFixturesPayload();
      verifiedParlayContext = `VERIFIED PARLAY CONTEXT: No saved ${requestedRisk} card exists for ${date}. Research and build a fresh ${requestedRisk} proposal from these verified upcoming fixtures: ${JSON.stringify(fixtures).slice(0, 12_000)}`;
    }
  }
  const base = {
    model,
    instructions: [
      "You are Biggy, a concise and friendly football assistant.",
      "Conversation context is binding. Interpret short follow-ups using the immediately preceding intent: if the user asks a table question and then says another club name, answer the same table question for that club; if they ask about a fixture and then name another club, answer the same fixture question for that club.",
      "In contextual follow-ups, change only the entity the user changed. Preserve the requested statistic, competition type, timeframe and comparison unless the user explicitly changes them.",
      "Resolve professional clubs to their primary domestic league. Never substitute a friendly, summer series, youth, reserve or exhibition competition for a domestic league table.",
      "If a short team name genuinely matches multiple professional clubs and the conversation does not disambiguate it, ask one concise clarification question instead of guessing.",
      "Use get_live_scores for anything happening now or live. Use get_upcoming_matches for future fixtures.",
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
      "Tell the user to review the proposal card and approve it before its matches are tracked.",
      "A request to build, create, research or suggest a parlay is already permission to research and propose one. Do not ask whether you should research after the user has requested a parlay.",
      "If get_daily_parlay has no saved card, immediately use get_upcoming_matches, choose suitable fixtures, call analyze_match for the candidate matchups, and then call propose_parlay_for_approval.",
      "Default to balanced risk when the user requests a parlay without a risk level. If the user later replies yes, safe, balanced or go big, continue the active parlay task using that answer; do not restart the conversation or repeat that no saved card exists.",
      "Never report the absence of a saved parlay more than once in the same task. The fallback is to research and build a fresh proposal, not to stop.",
      "When VERIFIED PARLAY CONTEXT is supplied in the input, do not call get_daily_parlay or get_upcoming_matches again. Use the supplied fixtures, analyze the candidate matchups, and proceed to the approval proposal.",
      `The user's timezone is ${timezone}. Convert every kickoff time to that timezone and label it; do not default to UTC unless the user's timezone is UTC.`,
    ].join(" "),
    tools: TOOLS,
    reasoning: { effort: process.env.OPENAI_REASONING_EFFORT ?? "none" },
    max_output_tokens: 700,
  };

  const input = [
    ...history.slice(-10).map((item) => ({ role: item.role, content: item.content.slice(0, 2_000) })),
    ...(verifiedParlayContext ? [{ role: "user" as const, content: verifiedParlayContext }] : []),
    { role: "user", content: message },
  ];
  let proposedParlay: ProposedParlay | undefined;
  let forcedProposal = false;
  let response = await callOpenAi({
    ...base,
    input,
    ...(requiresRecentResults
      ? { tool_choice: { type: "function", name: "get_team_results" } }
      : {}),
  });
  for (let round = 0; round < 5; round += 1) {
    const calls = (response.output ?? []).filter((item) => item.type === "function_call");
    if (calls.length === 0) {
      if (requiresParlayApproval && !proposedParlay && !forcedProposal) {
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
      return { answer, model, ...(proposedParlay ? { parlay: proposedParlay } : {}) };
    }

    const toolOutputs = await Promise.all(
      calls.map(async (call) => {
        if (call.name === "propose_parlay_for_approval") {
          proposedParlay = JSON.parse(call.arguments || "{}") as ProposedParlay;
          return {
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ status: "awaiting_user_approval" }),
          };
        }
        return {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(await runTool(call.name ?? "", call.arguments)),
        };
      })
    );
    response = await callOpenAi({
      ...base,
      previous_response_id: response.id,
      input: toolOutputs,
    });
  }
  throw new Error("Biggy used too many tool rounds");
}
