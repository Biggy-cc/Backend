export const PRICING = {
  monthlyUsdc: Number(process.env.MONTHLY_USDC ?? "9"),
  yearlyUsdc: Number(process.env.YEARLY_USDC ?? "79"),
  trialPicks: Number(process.env.TRIAL_PICKS ?? "2"),
} as const;

export function yearlySavingsPercent(): number {
  const fullYear = PRICING.monthlyUsdc * 12;
  if (fullYear <= 0) return 0;
  return Math.round(((fullYear - PRICING.yearlyUsdc) / fullYear) * 100);
}
