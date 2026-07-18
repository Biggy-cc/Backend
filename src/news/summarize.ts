import { generateTextLlm } from "../picks/llm.js";
import type { NewsArticle } from "./google.js";
import { stripNewsOutlet } from "./google.js";

/**
 * Turn raw RSS titles/snippets into a short user-facing news blurb.
 * No outlet names, no links — just what happened.
 */
export async function summarizeMatchNews(
  match: string,
  articles: NewsArticle[]
): Promise<string> {
  const pool = articles.slice(0, 4);
  if (!pool.length) {
    return `Team news is moving on ${match}. Check today's card for how Biggy priced it.`;
  }

  const bulletBlock = pool
    .map((a, i) => {
      const title = stripNewsOutlet(a.title);
      const snip = a.snippet ? `\n   context: ${a.snippet.slice(0, 280)}` : "";
      return `${i + 1}. ${title}${snip}`;
    })
    .join("\n");

  const prompt = `You are Biggy. Write match news for casual football bettors in Telegram.

Match: ${match}

Source material (titles + snippets — do NOT name outlets, sites, or publishers):
${bulletBlock}

Rules:
- Write 2 short sentences (max ~220 characters total).
- Say what actually matters: injury, lineup, suspension, fitness, manager quote — the substance, not a headline rewrite.
- No outlet names (no "Yahoo", "ESPN", "Evening Standard", etc.).
- No URLs, hashtags, or "according to reports" filler.
- No odds or betting advice.
- Plain text only.

Return ONLY the two sentences.`;

  try {
    const { text } = await generateTextLlm(prompt);
    const cleaned = text
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 40) {
      return cleaned.length > 320 ? `${cleaned.slice(0, 317)}…` : cleaned;
    }
  } catch (err) {
    console.warn("[news] Summary LLM failed — using cleaned title:", err);
  }

  // Fallback: cleaned primary title, still no outlet name
  const fallback = stripNewsOutlet(pool[0].title);
  if (pool[0].snippet && pool[0].snippet.length > 60) {
    const snip = pool[0].snippet.slice(0, 180).replace(/\s+\S*$/, "");
    return `${fallback}. ${snip}${pool[0].snippet.length > 180 ? "…" : ""}`;
  }
  return fallback;
}
