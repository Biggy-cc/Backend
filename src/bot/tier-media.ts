import type { Context } from "grammy";
import type { InlineKeyboard } from "grammy";
import type { PickTier } from "../picks/types.js";
import { PICK_PARSE_MODE, formatTierLabel, slipHtmlToPlain } from "../picks/types.js";

const PNG_EXT = /\.(png|jpe?g|webp|gif)(\?|$)/i;
const TELEGRAM_CAPTION_LIMIT = 1024;

function tierIconUrl(tier: PickTier): string | undefined {
  const key =
    tier === "hit"
      ? "TIER_ICON_HIT_URL"
      : tier === "aim"
        ? "TIER_ICON_AIM_URL"
        : "TIER_ICON_GOBIG_URL";
  const url = process.env[key]?.trim();
  if (!url || !PNG_EXT.test(url)) return undefined;
  return url;
}

/**
 * Telegram cannot render SVG/HTML inline images in text.
 * Optional PNG URLs show the tier badge as a photo; slips stay as HTML text.
 */
export async function replyWithPickSlip(
  ctx: Context,
  tier: PickTier,
  content: string,
  replyMarkup: InlineKeyboard
): Promise<void> {
  const iconUrl = tierIconUrl(tier);
  const plainLength = slipHtmlToPlain(content).length;

  if (iconUrl && plainLength <= TELEGRAM_CAPTION_LIMIT - 40) {
    await ctx.replyWithPhoto(iconUrl, {
      caption: content,
      parse_mode: PICK_PARSE_MODE,
      reply_markup: replyMarkup,
    });
    return;
  }

  if (iconUrl) {
    await ctx.replyWithPhoto(iconUrl, {
      caption: `${formatTierLabel(tier)} · today's football slip`,
    });
  }

  await ctx.reply(content, {
    parse_mode: PICK_PARSE_MODE,
    reply_markup: replyMarkup,
  });
}
