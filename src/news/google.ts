import Parser from "rss-parser";

const parser = new Parser({ timeout: 15_000 });

export type NewsArticle = {
  title: string;
  url: string;
};

const SKIP_DOMAINS = new Set([
  "youtube.com",
  "reddit.com",
  "vertexaisearch.cloud.google.com",
]);

export function prettifyDomain(domain: string): string {
  const base = domain.replace(/^www\./, "").split(".")[0];
  return base
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function isLowQualitySource(url: string, label: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (SKIP_DOMAINS.has(host)) return true;
    if (host.includes("vertexaisearch.cloud.google.com")) return false; // redirect OK
  } catch {
    /* ignore */
  }
  return SKIP_DOMAINS.has(label);
}

async function searchNews(query: string, limit: number): Promise<NewsArticle[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const feed = await parser.parseURL(url);
    return (feed.items ?? [])
      .slice(0, limit)
      .map((item) => ({
        title: item.title?.trim() ?? "",
        url: item.link?.trim() ?? "",
      }))
      .filter((a) => a.title && a.url);
  } catch {
    return [];
  }
}

/** Headlines + links for a fixture. */
export async function fetchMatchNews(
  teamA: string,
  teamB: string,
  limit = 6
): Promise<NewsArticle[]> {
  const queries = [
    `${teamA} ${teamB} World Cup football`,
    `${teamA} injury squad news`,
    `${teamB} injury squad news`,
    `${teamA} vs ${teamB} head to head`,
  ];

  const seen = new Set<string>();
  const articles: NewsArticle[] = [];

  for (const q of queries) {
    const batch = await searchNews(q, 3);
    for (const a of batch) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      articles.push(a);
      if (articles.length >= limit) return articles;
    }
  }

  return articles;
}
