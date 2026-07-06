import type { Context } from "grammy";
import {
  DAILY_DROP_TEXT,
  dailyMenuKeyboard,
} from "./keyboards.js";
import { parseChatIntent } from "./chat-intents.js";
import { BIGGY_GREETING_HINT, BIGGY_UNKNOWN } from "./copy.js";
import { handleStart } from "./onboarding.js";
import { replyIfPaywalled } from "./subscribe-offer.js";
import { formatAccessStatus, upsertUser } from "../db/users.js";
import type { Bot } from "grammy";
import { stopLiveFeed } from "../picks/live-watch.js";

/**
 * Routes plain-text chat (no slash commands).
 * Today: keyword intents. Later: Gemini conversation when CONVERSATIONAL_CHAT=1.
 */
export async function handleFreeformMessage(
  ctx: Context,
  rawText: string,
  bot?: Bot
): Promise<void> {
  if (!ctx.from) return;

  const user = await upsertUser(ctx.from.id, ctx.from.username);

  if (process.env.CONVERSATIONAL_CHAT === "1") {
    // Future: Gemini-backed chat with tools (picks, status, subscribe).
    // Until then, fall through to keyword routing below.
  }

  const intent = parseChatIntent(rawText);

  if (intent === "start") {
    await handleStart(ctx);
    return;
  }

  if (intent === "stop_live") {
    if (bot) {
      const stopped = await stopLiveFeed(bot, ctx.from.id);
      await ctx.reply(stopped ? "Live feed stopped." : "No active live feed on your slip.");
      return;
    }
  }

  if (await replyIfPaywalled(ctx, user)) return;

  switch (intent) {
    case "greeting":
      await ctx.reply(BIGGY_GREETING_HINT);
      return;

    case "status": {
      await ctx.reply(formatAccessStatus(user));
      return;
    }

    case "picks": {
      await ctx.reply(DAILY_DROP_TEXT, { reply_markup: dailyMenuKeyboard() });
      return;
    }

    case "unknown":
    default:
      await ctx.reply(BIGGY_UNKNOWN);
  }
}
