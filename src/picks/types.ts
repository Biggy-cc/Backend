export type PickTier = "hit" | "aim" | "go_big";

export const TIER_LIMITS: Record<PickTier, number> = {
  hit: 2.0,
  aim: 10.0,
  go_big: 120.0,
};

export const TIER_LABELS: Record<PickTier, string> = {
  hit: "Hit",
  aim: "Aim",
  go_big: "Go Big",
};

/** Telegram text/buttons only — SVG icons cannot render inline in bot messages. */
export const TIER_EMOJI: Record<PickTier, string> = {
  hit: "🎯",
  aim: "🏹",
  go_big: "🔥",
};

export function formatTierLabel(tier: PickTier): string {
  return `${TIER_EMOJI[tier]} ${TIER_LABELS[tier]}`;
}

export type PickSource = {
  label: string;
  url: string;
};

export type GeneratedPick = {
  tier: PickTier;
  version?: number;
  changeNote?: string | null;
  legs: Array<{
    match: string;
    selection: string;
    odds: number;
  }>;
  combinedOdds: number;
  breakdown: string;
  sources?: PickSource[];
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function stripSourcesFromSlipHtml(html: string): string {
  const marker = "\n\n📰 <b>Sources</b>";
  const idx = html.indexOf(marker);
  if (idx < 0) return html;
  return html.slice(0, idx);
}

export function formatPickSlip(pick: GeneratedPick): string {
  const updateBanner =
    pick.version && pick.version > 1 && pick.changeNote
      ? `📋 <b>Updated (v${pick.version})</b>\n${escapeHtml(pick.changeNote)}\n\n`
      : "";

  const legs = pick.legs
    .map(
      (leg, i) =>
        `${i + 1}. ${escapeHtml(leg.match)}\n   → ${escapeHtml(leg.selection)} @ ${leg.odds.toFixed(2)}`
    )
    .join("\n\n");

  return `${updateBanner}${escapeHtml(formatTierLabel(pick.tier))} · Combined @ ${pick.combinedOdds.toFixed(2)}

${legs}

<b>Biggy Breakdown</b>
${escapeHtml(pick.breakdown)}`;
}

export const PICK_PARSE_MODE = "HTML" as const;

/** Plain-text slip for inline share (no HTML, no long source URLs). */
export function formatShareText(html: string): string {
  let plain = slipHtmlToPlain(html);
  const sourcesIdx = plain.indexOf("📰 Sources");
  if (sourcesIdx > 0) {
    plain = plain.slice(0, sourcesIdx).trim();
  }
  return `${plain}\n\n⚽ Football picks: t.me/BiggyCCBot`;
}

export function parseShareTier(query: string): PickTier | null {
  const q = query.trim().toLowerCase().replace(/^share:/, "");
  if (q === "hit" || q === "aim" || q === "go_big") return q;
  return null;
}

/** Plain text (strips HTML from cached slips). */
export function slipHtmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<b>(.*?)<\/b>/gi, "$1")
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/gi, "$2 ($1)")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function mergeSources(sources: PickSource[][]): PickSource[] {
  const seen = new Set<string>();
  const merged: PickSource[] = [];
  for (const list of sources) {
    for (const s of list) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      merged.push(s);
    }
  }
  return merged.slice(0, 5);
}
