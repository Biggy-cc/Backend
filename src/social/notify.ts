import type { Bot } from "grammy";
import type { SocialPostKind } from "./store.js";

/** manual = Telegram draft to admin | auto = post via X API when configured */
export function isSocialAutoMode(): boolean {
  return process.env.SOCIAL_MODE?.trim().toLowerCase() === "auto";
}

/** Who gets copy-paste X drafts (defaults to Dracklyn). Set 0 to disable. */
export function socialNotifyTelegramId(): number | null {
  const raw =
    process.env.SOCIAL_NOTIFY_TELEGRAM_ID ??
    process.env.SUBSCRIPTION_NOTIFY_TELEGRAM_ID ??
    "5309840190";
  if (raw.trim() === "" || raw.trim() === "0") return null;

  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

const KIND_LABELS: Record<SocialPostKind, string> = {
  daily_free: "📣 <b>Post on @Biggy</b> — daily free pick",
  pick_update: "📣 <b>Post on @Biggy</b> — card update",
  leg_win: "📣 <b>Post on @Biggy</b> — we were right",
  news: "📣 <b>Post on @Biggy</b> — match news",
};

export async function sendManualSocialDraft(
  bot: Bot,
  kind: SocialPostKind,
  text: string
): Promise<boolean> {
  const notifyId = socialNotifyTelegramId();
  if (!notifyId) return false;

  const header = KIND_LABELS[kind];
  const body = `${header}\n\n<pre>${escapeHtml(text)}</pre>\n\nCopy &amp; paste on X.`;

  try {
    await bot.api.sendMessage(notifyId, body, { parse_mode: "HTML" });
    console.log(`[social] Manual draft sent to ${notifyId} (${kind})`);
    return true;
  } catch (err) {
    console.warn("[social] Manual draft failed:", err);
    return false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
