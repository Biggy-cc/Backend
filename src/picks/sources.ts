import type { PickSource } from "./types.js";
import { prettifyDomain, isLowQualitySource, type NewsArticle } from "../news/google.js";

export function articlesToSources(articles: NewsArticle[]): PickSource[] {
  return articles.map((a) => ({
    label: a.title.length > 80 ? `${a.title.slice(0, 77)}…` : a.title,
    url: a.url,
  }));
}

export function groundingToSources(
  chunks: Array<{ web?: { uri?: string; title?: string; domain?: string } }>
): PickSource[] {
  const seen = new Set<string>();
  const sources: PickSource[] = [];

  for (const chunk of chunks) {
    const web = chunk.web;
    if (!web?.uri) continue;
    if (seen.has(web.uri)) continue;

    const domain = web.title?.trim() || web.domain || "";
    if (domain && isLowQualitySource(web.uri, domain)) continue;

    const label = domain.includes(".") ? prettifyDomain(domain) : domain || "Source";
    seen.add(web.uri);
    sources.push({ label, url: web.uri });
    if (sources.length >= 5) break;
  }

  return sources;
}

export function mergeArticleAndGroundingSources(
  articles: NewsArticle[],
  grounding: PickSource[]
): PickSource[] {
  const fromNews = articlesToSources(articles);
  const seen = new Set(fromNews.map((s) => s.url));
  const merged = [...fromNews];

  for (const g of grounding) {
    if (seen.has(g.url)) continue;
    if (isLowQualitySource(g.url, g.label)) continue;
    seen.add(g.url);
    merged.push(g);
    if (merged.length >= 5) break;
  }

  return merged.slice(0, 5);
}
