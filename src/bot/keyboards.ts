import { InlineKeyboard } from "grammy";
import { PRICING, yearlySavingsPercent } from "../config/pricing.js";
import type { PickTier } from "../picks/types.js";
import { formatTierLabel } from "../picks/types.js";

export function dailyMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(formatTierLabel("hit"), "tier:hit")
    .text(formatTierLabel("aim"), "tier:aim")
    .row()
    .text(formatTierLabel("go_big"), "tier:go_big");
}

export function subscribeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(`📅 $${PRICING.monthlyUsdc} Monthly`, "pay:monthly")
    .text(`🏆 $${PRICING.yearlyUsdc} Yearly`, "pay:yearly");
}

/** @deprecated use subscribeKeyboard */
export function paywallKeyboard(): InlineKeyboard {
  return subscribeKeyboard();
}

export function paymentLinkKeyboard(phantomUrl: string, solflareUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .url("👻 Pay in Phantom", phantomUrl)
    .row()
    .url("🔥 Pay in Solflare", solflareUrl);
}

/** Monthly/Yearly open the pay page directly (no extra bot message). */
export function subscribeCheckoutKeyboard(
  webBase: string,
  monthlyId: string,
  yearlyId: string
): InlineKeyboard {
  return new InlineKeyboard()
    .url(
      `📅 $${PRICING.monthlyUsdc} Monthly`,
      `${webBase}?id=${encodeURIComponent(monthlyId)}`
    )
    .url(
      `🏆 $${PRICING.yearlyUsdc} Yearly`,
      `${webBase}?id=${encodeURIComponent(yearlyId)}`
    );
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

export const DAILY_DROP_TEXT = `⚽ Today's football picks

🎯 Hit · under 2.0 combined
🏹 Aim · under 10 combined
🔥 Go Big · up to 120 combined

Tap a tier for today's slip:`;

export const SUBSCRIBE_OFFER_TEXT = `💎 Unlimited daily football picks

Biggy Premium: $${PRICING.monthlyUsdc}/month or $${PRICING.yearlyUsdc}/year (save ~${yearlySavingsPercent()}% vs monthly). Pay with USDC in Phantom or Solflare:`;

export const PAYWALL_TEXT = `⚠️ Your ${PRICING.trialPicks} free football trial slips are used. Upgrade to keep getting daily picks.`;
