import type { Context } from "grammy";
import type { InlineKeyboard } from "grammy";
import type { PickTier } from "../picks/types.js";
import { PICK_PARSE_MODE, formatTierLabel } from "../picks/types.js";
import { replyWithMediaHeader, slipBannerUrl } from "./telegram-banners.js";

/**
 * Telegram cannot render SVG/HTML inline images in text.
 * Optional banner sits above the slip; the slip is always a text message so live
 * feed can edit it in place.
 */
export async function replyWithPickSlip(
  ctx: Context,
  tier: PickTier,
  content: string,
  replyMarkup: InlineKeyboard
): Promise<number | undefined> {
  const bannerUrl = slipBannerUrl(tier);

  if (bannerUrl) {
    await replyWithMediaHeader(ctx, bannerUrl, `${formatTierLabel(tier)} · today's football slip`);
  }

  const sent = await ctx.reply(content, {
    parse_mode: PICK_PARSE_MODE,
    reply_markup: replyMarkup,
  });
  return sent.message_id;
}
