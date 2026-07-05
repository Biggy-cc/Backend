import type { Context } from "grammy";
import type { InlineKeyboard } from "grammy";
import type { PickTier } from "../picks/types.js";
import { PICK_PARSE_MODE, formatTierLabel, slipHtmlToPlain } from "../picks/types.js";
import { replyWithMediaHeader, slipBannerUrl } from "./telegram-banners.js";

const TELEGRAM_CAPTION_LIMIT = 1024;

/**
 * Telegram cannot render SVG/HTML inline images in text.
 * Optional banner URLs (PNG or GIF) sit above the slip; long slips split header + text.
 */
export async function replyWithPickSlip(
  ctx: Context,
  tier: PickTier,
  content: string,
  replyMarkup: InlineKeyboard
): Promise<void> {
  const bannerUrl = slipBannerUrl(tier);
  const plainLength = slipHtmlToPlain(content).length;

  if (bannerUrl && plainLength <= TELEGRAM_CAPTION_LIMIT - 40) {
    await replyWithMediaHeader(ctx, bannerUrl, content, {
      parse_mode: PICK_PARSE_MODE,
      reply_markup: replyMarkup,
    });
    return;
  }

  if (bannerUrl) {
    await replyWithMediaHeader(ctx, bannerUrl, `${formatTierLabel(tier)} · today's football slip`);
  }

  await ctx.reply(content, {
    parse_mode: PICK_PARSE_MODE,
    reply_markup: replyMarkup,
  });
}
