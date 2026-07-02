import {
  GoogleGenAI,
  type GenerateContentResponse,
} from "@google/genai";
import type { PickSource } from "./types.js";

const MODEL = "gemini-2.5-flash";

export function createGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");
  return new GoogleGenAI({ apiKey });
}

export function extractJson<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(body) as T;
}

function labelFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return url;
  }
}

function isBareDomain(label: string): boolean {
  return /^[\w.-]+\.[a-z]{2,}$/i.test(label.trim());
}

export function extractSources(response: GenerateContentResponse): PickSource[] {
  const meta = response.candidates?.[0]?.groundingMetadata;
  if (!meta?.groundingChunks?.length) return [];

  const seen = new Set<string>();
  const sources: PickSource[] = [];

  for (const chunk of meta.groundingChunks) {
    const web = chunk.web;
    if (!web?.uri) continue;
    if (seen.has(web.uri)) continue;
    seen.add(web.uri);

    let label = web.title?.trim() || "";
    const looksLikeHeadline = label.includes(" ") && label.length > 20;
    if (!looksLikeHeadline && (!label || isBareDomain(label) || label === web.domain)) {
      label = labelFromUrl(web.uri);
    }

    sources.push({ label, url: web.uri });
    if (sources.length >= 5) break;
  }

  return sources;
}

/** Grounded web research (injuries, H2H, form). */
export async function generateGrounded(
  ai: GoogleGenAI,
  prompt: string
): Promise<{ text: string; sources: PickSource[] }> {
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL ?? MODEL,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
    },
  });

  return {
    text: response.text ?? "",
    sources: extractSources(response),
  };
}

/** Structured JSON output (parlays) — no search, odds already in prompt. */
export async function geminiGenerateJson<T>(
  ai: GoogleGenAI,
  prompt: string
): Promise<T> {
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
    },
  });

  return extractJson<T>(response.text ?? "");
}

/** @deprecated Use generateJsonLlm from llm.ts */
export async function generateJson<T>(
  ai: GoogleGenAI,
  prompt: string
): Promise<T> {
  return geminiGenerateJson<T>(ai, prompt);
}
