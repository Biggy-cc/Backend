import { InputFile, type Context } from "grammy";
import type { InlineKeyboard } from "grammy";
import type { PickTier } from "../picks/types.js";

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|mp4)(\?|$)/i;
const TELEGRAM_CAPTION_LIMIT = 1024;
const DEFAULT_TELEGRAM_BANNERS = "https://biggy.cc/telegram";
/** Bump when banner assets change so Telegram re-fetches instead of serving stale media. */
const BANNER_CACHE_VERSION = "4";

type CachedBanner = {
  bytes: Buffer;
  filename: string;
  fetchedAt: number;
};

const bannerCache = new Map<string, CachedBanner>();
const CACHE_MS = 15 * 60 * 1000;

function mediaUrl(envKey: string, fallback?: string): string | undefined {
  const url = process.env[envKey]?.trim() || fallback;
  if (!url || !MEDIA_EXT.test(url)) return undefined;
  return url;
}

function withCacheVersion(url: string): string {
  if (/[?&]v=/.test(url)) return url;
  const join = url.includes("?") ? "&" : "?";
  return `${url}${join}v=${BANNER_CACHE_VERSION}`;
}

export function welcomeBannerUrl(): string | undefined {
  const url = mediaUrl(
    "TELEGRAM_WELCOME_BANNER_URL",
    `${DEFAULT_TELEGRAM_BANNERS}/welcome-banner.mp4`
  );
  return url ? withCacheVersion(url) : undefined;
}

export function slipBannerUrl(tier: PickTier): string | undefined {
  const tierKey =
    tier === "hit"
      ? "TELEGRAM_SLIP_HIT_BANNER_URL"
      : tier === "aim"
        ? "TELEGRAM_SLIP_AIM_BANNER_URL"
        : "TELEGRAM_SLIP_GOBIG_BANNER_URL";
  const tierSlug = tier === "go_big" ? "gobig" : tier;
  const url =
    mediaUrl(tierKey, `${DEFAULT_TELEGRAM_BANNERS}/slip-${tierSlug}.mp4`) ??
    mediaUrl("TELEGRAM_SLIP_BANNER_URL");
  return url ? withCacheVersion(url) : undefined;
}

function isAnimated(url: string): boolean {
  return /\.(gif|mp4)(\?|$)/i.test(url);
}

function bannerFilename(url: string): string {
  const path = url.split("?")[0] ?? url;
  const name = path.split("/").pop();
  return name && MEDIA_EXT.test(name) ? name : "banner.mp4";
}

async function loadBanner(url: string): Promise<CachedBanner> {
  const cached = bannerCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached;
  }

  const res = await fetch(url, {
    headers: { Accept: "*/*" },
  });
  if (!res.ok) {
    throw new Error(`Banner fetch failed (${res.status}): ${url}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const entry: CachedBanner = {
    bytes,
    filename: bannerFilename(url),
    fetchedAt: Date.now(),
  };
  bannerCache.set(url, entry);
  return entry;
}

export async function replyWithMediaHeader(
  ctx: Context,
  url: string,
  caption: string | undefined,
  extra?: { reply_markup?: InlineKeyboard; parse_mode?: "HTML" }
): Promise<void> {
  try {
    const banner = await loadBanner(url);

    if (isAnimated(url)) {
      await ctx.replyWithAnimation(new InputFile(banner.bytes, banner.filename), {
        caption,
        ...extra,
      });
      return;
    }

    await ctx.replyWithPhoto(new InputFile(banner.bytes, banner.filename), {
      caption,
      ...extra,
    });
  } catch (err) {
    console.error("[bot] Banner upload failed, falling back to URL:", url, err);

    if (isAnimated(url)) {
      await ctx.replyWithAnimation(url, { caption, ...extra });
      return;
    }

    await ctx.replyWithPhoto(url, { caption, ...extra });
  }
}

/** Welcome / start banner — animated MP4/GIF or static image, then text in a follow-up if needed. */
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
