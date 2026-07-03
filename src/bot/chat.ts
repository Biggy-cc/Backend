import type { Context } from "grammy";
import {
  DAILY_DROP_TEXT,
  PAYWALL_TEXT,
  dailyMenuKeyboard,
  paywallKeyboard,
} from "./keyboards.js";
import { parseChatIntent } from "./chat-intents.js";
import { BIGGY_GREETING_HINT, BIGGY_UNKNOWN } from "./copy.js";
import { handleStart } from "./onboarding.js";
import { formatAccessStatus, hasAccess, upsertUser } from "../db/users.js";

/**
 * Routes plain-text chat (no slash commands).
 * Today: keyword intents. Later: Gemini conversation when CONVERSATIONAL_CHAT=1.
 */
export async function handleFreeformMessage(ctx: Context, rawText: string): Promise<void> {
  if (!ctx.from) return;

  if (process.env.CONVERSATIONAL_CHAT === "1") {
    // Future: Gemini-backed chat with tools (picks, status, subscribe).
    // Until then, fall through to keyword routing below.
  }

  const intent = parseChatIntent(rawText);

  switch (intent) {
    case "start":
      await handleStart(ctx);
      return;

    case "greeting":
      await ctx.reply(BIGGY_GREETING_HINT);
      return;

    case "status": {
      const user = await upsertUser(ctx.from.id, ctx.from.username);
      await ctx.reply(formatAccessStatus(user));
      return;
    }

    case "picks": {
      const user = await upsertUser(ctx.from.id, ctx.from.username);
      if (!hasAccess(user)) {
        await ctx.reply(PAYWALL_TEXT, { reply_markup: paywallKeyboard() });
        return;
      }
      await ctx.reply(DAILY_DROP_TEXT, { reply_markup: dailyMenuKeyboard() });
      return;
    }

    case "unknown":
    default:
      await ctx.reply(BIGGY_UNKNOWN);
  }
}
