import type { Context } from "grammy";
import {
  DAILY_DROP_TEXT,
  PAYWALL_TEXT,
  SUBSCRIBE_OFFER_TEXT,
  dailyMenuKeyboard,
  subscribeCheckoutKeyboard,
  subscribeKeyboard,
} from "./keyboards.js";
import { BIGGY_WELCOME } from "./copy.js";
import { replyWithWelcomeBanner } from "./telegram-banners.js";
import { createBotSubscribeLinks } from "../api/checkout.js";
import {
  formatAccessStatus,
  hasAccess,
  isSubscribed,
  upsertUser,
  type UserRow,
} from "../db/users.js";

async function replySubscribeOffer(ctx: Context): Promise<void> {
  const webBase = process.env.PAYMENT_WEB_URL?.trim().replace(/\/$/, "");

  if (webBase && ctx.from) {
    await upsertUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    const { monthlyId, yearlyId } = await createBotSubscribeLinks(ctx.from.id);
    await ctx.reply(SUBSCRIBE_OFFER_TEXT, {
      reply_markup: subscribeCheckoutKeyboard(webBase, monthlyId, yearlyId),
    });
    return;
  }

  await ctx.reply(SUBSCRIBE_OFFER_TEXT, { reply_markup: subscribeKeyboard() });
}

/** Trial exhausted — status, then subscribe offer in a second message. */
export async function replyPaywall(ctx: Context, user: UserRow): Promise<void> {
  await replyWithWelcomeBanner(ctx, `${formatAccessStatus(user)}\n\n${PAYWALL_TEXT}`);
  await replySubscribeOffer(ctx);
}

/** /start for users still on trial or subscribed. */
export async function replyStartWithAccess(
  ctx: Context,
  user: UserRow
): Promise<void> {
  await replyWithWelcomeBanner(ctx, `${BIGGY_WELCOME}\n\n${formatAccessStatus(user)}`);
  await ctx.reply(DAILY_DROP_TEXT, { reply_markup: dailyMenuKeyboard() });

  if (!isSubscribed(user)) {
    await replySubscribeOffer(ctx);
  }
}

/** /start when trial is used up. */
export async function replyStartPaywalled(
  ctx: Context,
  user: UserRow
): Promise<void> {
  await replyWithWelcomeBanner(ctx, `${BIGGY_WELCOME}\n\n${formatAccessStatus(user)}`);
  await ctx.reply(PAYWALL_TEXT);
  await replySubscribeOffer(ctx);
}

export async function replyIfPaywalled(
  ctx: Context,
  user: UserRow
): Promise<boolean> {
  if (hasAccess(user)) return false;
  await replyPaywall(ctx, user);
  return true;
}
