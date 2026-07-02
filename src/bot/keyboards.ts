import { InlineKeyboard } from "grammy";
import type { PickTier } from "../picks/types.js";

export function dailyMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎯 Show Hit", "tier:hit")
    .text("🏹 Show Aim", "tier:aim")
    .text("🔥 Show Go Big", "tier:go_big");
}

export function paywallKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📅 $5 Monthly Plan", "pay:monthly")
    .text("🏆 $54 Yearly Pass", "pay:yearly");
}

export function paymentLinkKeyboard(phantomUrl: string, solflareUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .url("👻 Pay in Phantom", phantomUrl)
    .row()
    .url("🔥 Pay in Solflare", solflareUrl);
}

export function paymentWebKeyboard(checkoutUrl: string): InlineKeyboard {
  return new InlineKeyboard().url("💳 Pay with USDC", checkoutUrl);
}

/** Opens Telegram's share picker → inline result with the full slip. */
export function shareKeyboard(tier: PickTier): InlineKeyboard {
  return new InlineKeyboard().switchInline(
    "📲 Share this Slip with Friends",
    tier
  );
}

export const DAILY_DROP_TEXT = `⚽ BIGGY DAILY COMBINATIONS ⚽
The data engines have parsed today's lines and sentiment. Pick your goal for today:

🎯 Hit — capped under 2.0 odds. Safe, consistent wins.
🏹 Aim — capped under 10.0 odds. The smart value play.
🔥 Go Big — capped up to 120.0 odds. High-leverage parlay.

Click a button below to get today's selections instantly:`;

export const SUBSCRIBE_OFFER_TEXT = `💎 Unlock unlimited daily picks

Early-Bird access: $5/month or $54/year (normally $10–$15). Pay with USDC via Phantom or Solflare — one tap:`;

export const PAYWALL_TEXT = `⚠️ Your 2 free trial picks are used!

To keep getting daily data-driven match selections and avoid guessing on emotion, unlock Early-Bird access for just $5/month (normally $10–$15).

Choose your plan to generate a fast Solana Pay link:`;
