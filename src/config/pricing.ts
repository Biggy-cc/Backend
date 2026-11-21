export const PRICING = {
  monthlyUsdc: Number(process.env.MONTHLY_USDC ?? "9"),
  yearlyUsdc: Number(process.env.YEARLY_USDC ?? "79"),
  maxMonthlyUsdc: Number(process.env.MAX_MONTHLY_USDC ?? "19"),
  maxYearlyUsdc: Number(process.env.MAX_YEARLY_USDC ?? "169"),
  trialPicks: Number(process.env.TRIAL_PICKS ?? "2"),
} as const;

export type SubscriptionTier = "pro" | "max";
export type BillingCycle = "monthly" | "yearly";

/** Optional live payment test: one Telegram user pays PAYMENT_TEST_USDC instead of list price. */
export function planAmountUsdc(
  telegramId: number,
  plan: BillingCycle,
  tier: SubscriptionTier = "pro"
): number {
  const testTelegramId = Number(process.env.PAYMENT_TEST_TELEGRAM_ID ?? "");
  const testUsdc = Number(process.env.PAYMENT_TEST_USDC ?? "");
  if (
    Number.isFinite(testTelegramId) &&
    testTelegramId > 0 &&
    telegramId === testTelegramId &&
    Number.isFinite(testUsdc) &&
    testUsdc > 0
  ) {
    return testUsdc;
  }

  if (tier === "max") {
    return plan === "monthly" ? PRICING.maxMonthlyUsdc : PRICING.maxYearlyUsdc;
  }
  return plan === "monthly" ? PRICING.monthlyUsdc : PRICING.yearlyUsdc;
}

export function yearlySavingsPercent(): number {
  const fullYear = PRICING.monthlyUsdc * 12;
  if (fullYear <= 0) return 0;
  return Math.round(((fullYear - PRICING.yearlyUsdc) / fullYear) * 100);
}
