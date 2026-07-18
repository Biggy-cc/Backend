import Parser from "rss-parser";

const parser = new Parser({ timeout: 15_000 });

export type NewsArticle = {
  title: string;
  url: string;
  /** RSS description / content snippet when the feed provides one */
  snippet?: string;
};

const SKIP_DOMAINS = new Set([
  "youtube.com",
  "reddit.com",
  "vertexaisearch.cloud.google.com",
]);

/** Strip trailing " - Outlet Name" / " | Site" that Google News appends. */
export function stripNewsOutlet(title: string): string {
  return title
    .replace(/\s*[-–—|]\s*[A-Za-z0-9][A-Za-z0-9 .&'’-]{1,60}$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
    if (host.includes("vertexaisearch.cloud.google.com")) return false;
  } catch {
    /* ignore */
  }
  return SKIP_DOMAINS.has(label);
}

function itemSnippet(item: Parser.Item): string | undefined {
  const raw =
    item.contentSnippet?.trim() ||
    item.summary?.trim() ||
    (typeof item.content === "string" ? item.content.replace(/<[^>]+>/g, " ").trim() : "") ||
    "";
  if (!raw) return undefined;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length < 40) return undefined;
  return cleaned.slice(0, 600);
}

async function searchNews(query: string, limit: number): Promise<NewsArticle[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const feed = await parser.parseURL(url);
    return (feed.items ?? [])
      .slice(0, limit)
      .map((item) => ({
        title: stripNewsOutlet(item.title?.trim() ?? ""),
        url: item.link?.trim() ?? "",
        snippet: itemSnippet(item),
      }))
      .filter((a) => a.title && a.url);
  } catch {
    return [];
  }
}

/** True when the article clearly refers to at least one side of the fixture. */
export function articleMatchesFixture(
  article: NewsArticle,
  teamA: string,
  teamB: string
): boolean {
  const text = `${article.title} ${article.snippet ?? ""}`.toLowerCase();
  const a = teamA.toLowerCase();
  const b = teamB.toLowerCase();
  return text.includes(a) || text.includes(b);
}

/** Headlines + optional snippets for a fixture. */
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
      if (!articleMatchesFixture(a, teamA, teamB)) continue;
      articles.push(a);
      if (articles.length >= limit) return articles;
    }
  }

  return articles;
}
