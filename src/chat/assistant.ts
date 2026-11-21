import { getUpcomingFixturesPayload } from "../api/fixtures.js";
import { getCachedPick, todayPickDate } from "../picks/generate.js";

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

const TOOLS = [
  {
    type: "function",
    name: "get_upcoming_matches",
    description: "Get Biggy's verified upcoming football fixtures for the next seven days.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
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
  if (name === "get_upcoming_matches") {
    return { asOf: new Date().toISOString(), fixtures: await getUpcomingFixturesPayload() };
  }
  if (name === "get_daily_parlay") {
    const parsed = JSON.parse(rawArguments || "{}") as { risk?: string };
    const tier = parsed.risk === "safe" ? "hit" : parsed.risk === "go_big" ? "go_big" : "aim";
    const date = todayPickDate();
    return { date, risk: parsed.risk ?? "balanced", parlay: await getCachedPick(date, tier) };
  }
  return { error: "Unknown tool" };
}

export async function askBiggy(message: string): Promise<{ answer: string; model: string }> {
  const model = process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const base = {
    model,
    instructions: [
      "You are Biggy, a concise and friendly football assistant.",
      "Use the supplied tools whenever the user asks about current fixtures or a Biggy parlay.",
      "Never invent live scores, results, odds, injuries, fixtures, or statistics.",
      "The fixtures tool contains upcoming matches only; say clearly when live or historical data was not supplied.",
      "Parlays are informational, never guaranteed. Keep answers useful and under 250 words.",
    ].join(" "),
    tools: TOOLS,
    reasoning: { effort: process.env.OPENAI_REASONING_EFFORT ?? "none" },
    max_output_tokens: 700,
  };

  let response = await callOpenAi({ ...base, input: message });
  for (let round = 0; round < 3; round += 1) {
    const calls = (response.output ?? []).filter((item) => item.type === "function_call");
    if (calls.length === 0) {
      const answer = extractText(response);
      if (!answer) throw new Error("OpenAI returned an empty answer");
      return { answer, model };
    }

    const toolOutputs = await Promise.all(
      calls.map(async (call) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(await runTool(call.name ?? "", call.arguments)),
      }))
    );
    response = await callOpenAi({
      ...base,
      previous_response_id: response.id,
      input: toolOutputs,
    });
  }
  throw new Error("Biggy used too many tool rounds");
}
