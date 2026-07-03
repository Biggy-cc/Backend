export type ChatIntent =
  | "start"
  | "greeting"
  | "status"
  | "picks"
  | "unknown";

const START_RE = /^(?:start|begin)(?:[!.\s]|$)/i;

export function parseChatIntent(raw: string): ChatIntent {
  const text = raw.trim().toLowerCase();
  if (!text) return "unknown";

  if (START_RE.test(text)) return "start";

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
