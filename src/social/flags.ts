/** Common WC / international team → flag emoji (home team first in match label). */
const TEAM_FLAGS: Record<string, string> = {
  argentina: "🇦🇷",
  australia: "🇦🇺",
  algeria: "🇩🇿",
  austria: "🇦🇹",
  belgium: "🇧🇪",
  bosnia: "🇧🇦",
  "bosnia and herzegovina": "🇧🇦",
  brazil: "🇧🇷",
  "cape verde": "🇨🇻",
  colombia: "🇨🇴",
  congo: "🇨🇩",
  "congo dr": "🇨🇩",
  croatia: "🇭🇷",
  ecuador: "🇪🇨",
  egypt: "🇪🇬",
  england: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  france: "🇫🇷",
  germany: "🇩🇪",
  ghana: "🇬🇭",
  "ivory coast": "🇨🇮",
  mexico: "🇲🇽",
  morocco: "🇲🇦",
  netherlands: "🇳🇱",
  norway: "🇳🇴",
  portugal: "🇵🇹",
  senegal: "🇸🇳",
  spain: "🇪🇸",
  sweden: "🇸🇪",
  switzerland: "🇨🇭",
  usa: "🇺🇸",
  vietnam: "🇻🇳",
  myanmar: "🇲🇲",
};

function normalizeTeam(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export function flagForTeam(team: string): string {
  const key = normalizeTeam(team);
  if (TEAM_FLAGS[key]) return TEAM_FLAGS[key]!;
  for (const [k, flag] of Object.entries(TEAM_FLAGS)) {
    if (key.includes(k) || k.includes(key)) return flag;
  }
  return "⚽";
}

export function flagsForMatch(matchLabel: string): string {
  const parts = matchLabel.split(/\s+vs\s+/i);
  if (parts.length !== 2) return "⚽";
  return `${flagForTeam(parts[0]!)}${flagForTeam(parts[1]!)}`;
}
