import type { Context } from "grammy";
import type { InlineKeyboard } from "grammy";
import type { PickTier } from "../picks/types.js";

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|mp4)(\?|$)/i;
const TELEGRAM_CAPTION_LIMIT = 1024;
const DEFAULT_TELEGRAM_BANNERS = "https://biggy.cc/telegram";

function mediaUrl(envKey: string, fallback?: string): string | undefined {
  const url = process.env[envKey]?.trim() || fallback;
  if (!url || !MEDIA_EXT.test(url)) return undefined;
  return url;
}

export function welcomeBannerUrl(): string | undefined {
  return mediaUrl(
    "TELEGRAM_WELCOME_BANNER_URL",
    `${DEFAULT_TELEGRAM_BANNERS}/welcome-banner.gif`
  );
}

export function slipBannerUrl(tier: PickTier): string | undefined {
  const tierKey =
    tier === "hit"
      ? "TELEGRAM_SLIP_HIT_BANNER_URL"
      : tier === "aim"
        ? "TELEGRAM_SLIP_AIM_BANNER_URL"
        : "TELEGRAM_SLIP_GOBIG_BANNER_URL";
  const tierSlug = tier === "go_big" ? "gobig" : tier;
  return (
    mediaUrl(tierKey, `${DEFAULT_TELEGRAM_BANNERS}/slip-${tierSlug}.gif`) ??
    mediaUrl("TELEGRAM_SLIP_BANNER_URL")
  );
}

function isAnimated(url: string): boolean {
  return /\.(gif|mp4)(\?|$)/i.test(url);
}

export async function replyWithMediaHeader(
  ctx: Context,
  url: string,
  caption: string | undefined,
  extra?: { reply_markup?: InlineKeyboard; parse_mode?: "HTML" }
): Promise<void> {
  if (isAnimated(url)) {
    await ctx.replyWithAnimation(url, {
      caption,
      ...extra,
    });
    return;
  }

  await ctx.replyWithPhoto(url, {
    caption,
    ...extra,
  });
}

/** Welcome / start banner — animated GIF or static image, then text in a follow-up if needed. */
export async function replyWithWelcomeBanner(
  ctx: Context,
  text: string,
  extra?: { reply_markup?: InlineKeyboard }
): Promise<void> {
  const url = welcomeBannerUrl();
  if (!url) {
    await ctx.reply(text, extra);
    return;
  }

  const fitsCaption = text.length <= TELEGRAM_CAPTION_LIMIT - 40;
  if (fitsCaption) {
    await replyWithMediaHeader(ctx, url, text, extra);
    return;
  }

  await replyWithMediaHeader(ctx, url, undefined);
  await ctx.reply(text, extra);
}
