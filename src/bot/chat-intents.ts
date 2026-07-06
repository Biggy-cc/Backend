export type ChatIntent =
  | "start"
  | "greeting"
  | "status"
  | "picks"
  | "stop_live"
  | "start_live"
  | "unknown";

const START_RE = /^(?:start|begin)(?:[!.\s]|$)/i;
const STOP_LIVE_RE =
  /^(?:stop|pause|end)\s+(?:the\s+)?live(?:\s+feed)?(?:[!.\s]|$)|^stop\s+live\s+feed$/i;
const START_LIVE_RE =
  /^(?:start|resume)\s+(?:the\s+)?live(?:\s+feed)?(?:[!.\s]|$)|^start\s+live\s+feed$/i;

export function parseChatIntent(raw: string): ChatIntent {
  const text = raw.trim().toLowerCase();
  if (!text) return "unknown";

  if (START_LIVE_RE.test(text) || text === "start live feed") return "start_live";

  if (START_RE.test(text)) return "start";

  if (STOP_LIVE_RE.test(text) || text === "stop live feed") return "stop_live";

  if (["hi", "hello", "hey", "help me", "yo"].some((w) => text.includes(w))) {
    return "greeting";
  }

  if (text.includes("trial") || text.includes("status") || text.includes("subscri")) {
    return "status";
  }

  if (
    text.includes("pick") ||
    text.includes("slip") ||
    text.includes("odds") ||
    text.includes("hit") ||
    text.includes("aim") ||
    text.includes("go big")
  ) {
    return "picks";
  }

  return "unknown";
}
