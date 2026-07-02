import { createGeminiClient, extractJson, geminiGenerateJson } from "./gemini.js";

export type LlmProvider = "gemini" | "openrouter" | "groq";

export function configuredLlmProviders(): LlmProvider[] {
  const out: LlmProvider[] = [];
  if (process.env.GEMINI_API_KEY) out.push("gemini");
  if (process.env.OPENROUTER_API_KEY?.trim()) out.push("openrouter");
  if (process.env.GROQ_API_KEY) out.push("groq");
  return out;
}

export function isQuotaError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return (
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("UNAVAILABLE") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("quota") ||
    msg.includes("Insufficient Balance") ||
    msg.includes("insufficient_quota") ||
    msg.includes("402") ||
    msg.includes("Payment Required") ||
    msg.includes("Too Many Requests") ||
    msg.includes("Rate limit reached") ||
    msg.includes("high demand")
  );
}

function quotaRetryMs(err: unknown): number {
  const msg = String((err as { message?: string })?.message ?? err);
  const sec = msg.match(/try again in ([\d.]+)s/i)?.[1];
  if (sec) return Math.ceil(parseFloat(sec) * 1000) + 500;
  return 5000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type OpenAiChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

async function openAiCompatibleChat(
  url: string,
  apiKey: string,
  model: string,
  prompt: string,
  jsonMode: boolean,
  extraHeaders?: Record<string, string>
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      temperature: 0.4,
    }),
  });

  const body = (await res.json()) as OpenAiChatResponse;
  if (!res.ok) {
    throw new Error(
      body.error?.message ?? `LLM HTTP ${res.status}: ${JSON.stringify(body)}`
    );
  }

  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM returned empty response");
  return text;
}

async function groqChat(prompt: string, jsonMode: boolean): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY missing");
  const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
  return openAiCompatibleChat(
    "https://api.groq.com/openai/v1/chat/completions",
    apiKey,
    model,
    prompt,
    jsonMode
  );
}

async function openrouterChat(prompt: string, jsonMode: boolean): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const model =
    process.env.OPENROUTER_MODEL ?? "google/gemma-4-26b-a4b-it:free";
  return openAiCompatibleChat(
    "https://openrouter.ai/api/v1/chat/completions",
    apiKey,
    model,
    prompt,
    jsonMode,
    {
      "HTTP-Referer":
        process.env.OPENROUTER_HTTP_REFERER ?? "https://t.me/BiggyCCBot",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Biggy",
    }
  );
}

async function geminiText(prompt: string): Promise<string> {
  const ai = createGeminiClient();
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
  });
  const text = response.text?.trim();
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

type ProviderAttempt = { provider: LlmProvider; run: () => Promise<string> };

function providerAttempts(prompt: string, jsonMode: boolean): ProviderAttempt[] {
  const attempts: ProviderAttempt[] = [];

  if (process.env.GEMINI_API_KEY) {
    attempts.push({
      provider: "gemini",
      run: jsonMode
        ? async () => {
            const ai = createGeminiClient();
            const result = await geminiGenerateJson<unknown>(ai, prompt);
            return JSON.stringify(result);
          }
        : () => geminiText(prompt),
    });
  }

  if (process.env.OPENROUTER_API_KEY?.trim()) {
    attempts.push({
      provider: "openrouter",
      run: () => openrouterChat(prompt, jsonMode),
    });
  }

  if (process.env.GROQ_API_KEY) {
    attempts.push({
      provider: "groq",
      run: () => groqChat(prompt, jsonMode),
    });
  }

  return attempts;
}

async function runWithProviderFallback(
  prompt: string,
  jsonMode: boolean,
  label: "JSON" | "Text"
): Promise<{ raw: string; provider: LlmProvider }> {
  const attempts = providerAttempts(prompt, jsonMode);
  if (attempts.length === 0) {
    throw new Error(
      "No LLM configured — set GEMINI_API_KEY, OPENROUTER_API_KEY, and/or GROQ_API_KEY"
    );
  }

  let lastError: unknown;

  for (const attempt of attempts) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        const raw = await attempt.run();
        if (jsonMode) {
          try {
            extractJson(raw);
          } catch (parseErr) {
            console.warn(
              `[llm] ${attempt.provider} returned invalid JSON — trying next`
            );
            lastError = parseErr;
            break;
          }
        }
        console.log(`[llm] ${label} via ${attempt.provider}`);
        return { raw, provider: attempt.provider };
      } catch (err) {
        if (isQuotaError(err) && retry < 2) {
          const wait = quotaRetryMs(err);
          console.warn(
            `[llm] ${attempt.provider} rate limit — retry in ${Math.round(wait / 1000)}s`
          );
          await sleep(wait);
          continue;
        }
        if (isQuotaError(err)) {
          console.warn(
            `[llm] ${attempt.provider} quota/rate limit — trying next`
          );
          lastError = err;
          break;
        }
        throw err;
      }
    }
  }

  throw lastError ?? new Error("All LLM providers failed");
}

export async function generateJsonLlm<T>(
  prompt: string
): Promise<{ result: T; provider: LlmProvider }> {
  const { raw, provider } = await runWithProviderFallback(prompt, true, "JSON");
  const parsed = extractJson<T>(raw);
  return { result: parsed, provider };
}

export async function generateTextLlm(
  prompt: string
): Promise<{ text: string; provider: LlmProvider }> {
  const { raw, provider } = await runWithProviderFallback(prompt, false, "Text");
  return { text: raw, provider };
}
