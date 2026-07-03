import type { Context } from "grammy";
import {
  PAYWALL_TEXT,
  dailyMenuKeyboard,
  paywallKeyboard,
} from "./keyboards.js";
import { BIGGY_WELCOME } from "./copy.js";
import { formatAccessStatus, hasAccess, upsertUser } from "../db/users.js";

/** One welcome bubble with trial status + today's tier menu. */
export async function handleStart(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const user = await upsertUser(ctx.from.id, ctx.from.username);

  if (!hasAccess(user)) {
    await ctx.reply(PAYWALL_TEXT, { reply_markup: paywallKeyboard() });
    return;
  }

  await ctx.reply(`${BIGGY_WELCOME}\n\n${formatAccessStatus(user)}`, {
    reply_markup: dailyMenuKeyboard(),
  });
}
