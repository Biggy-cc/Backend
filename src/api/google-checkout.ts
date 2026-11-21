import { randomUUID } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { dbGet, dbRun } from "../db/client.js";
import { getGoogleSubscription } from "../db/google-accounts.js";
import { extendSubscriptionUntil, formatSubscriptionDate } from "../db/users.js";
import { planAmountUsdc, type BillingCycle, type SubscriptionTier } from "../config/pricing.js";
import { buildWalletPayUrls } from "../payments/usdc.js";

type GooglePayment = { id: string; google_sub: string; plan: BillingCycle; tier: SubscriptionTier; amount_usdc: number; reference: string; fulfilled_at: string | null; subscribed_until: string | null };

function checkout(row: GooglePayment, currentUntil: string | null) {
  const receiver = process.env.USDC_RECEIVER_WALLET?.trim();
  const mint = process.env.USDC_MINT?.trim();
  if (!receiver || !mint) throw new Error("USDC checkout is not configured");
  const urls = buildWalletPayUrls(receiver, row.amount_usdc, row.reference, row.plan, row.tier);
  const renewal = row.fulfilled_at && row.subscribed_until ? row.subscribed_until : extendSubscriptionUntil(currentUntil, row.plan).toISOString();
  return {
    paymentId: row.id, plan: row.plan, tier: row.tier, amount: row.amount_usdc,
    recipient: receiver, mint, reference: row.reference,
    solanaUrl: urls.solana, phantomUrl: urls.phantom, solflareUrl: urls.solflare,
    fulfilled: !!row.fulfilled_at, identityProvider: "google" as const,
    subscriptionActiveUntil: currentUntil, subscriptionActiveUntilLabel: currentUntil ? formatSubscriptionDate(currentUntil) : null,
    subscriptionRenewsUntil: renewal, subscriptionRenewsUntilLabel: formatSubscriptionDate(renewal),
  };
}

export async function startGoogleCheckout(sub: string, plan: BillingCycle, tier: SubscriptionTier) {
  const receiver = process.env.USDC_RECEIVER_WALLET?.trim();
  const mint = process.env.USDC_MINT?.trim();
  if (!receiver || !mint) throw new Error("USDC checkout is not configured");
  // Validate configuration before creating a payment request.
  new PublicKey(receiver); new PublicKey(mint);
  let rpcTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "finalized");
    await Promise.race([connection.getLatestBlockhash("finalized"), new Promise<never>((_, reject) => { rpcTimeout = setTimeout(() => reject(new Error("RPC timeout")), 8_000); })]);
  } catch { throw new Error("Payment verification is temporarily unavailable. Please try again later."); }
  finally { if (rpcTimeout) clearTimeout(rpcTimeout); }
  const subscription = await getGoogleSubscription(sub);
  if (subscription.tier !== "free" && subscription.tier !== tier) throw new Error("Plan changes are not yet supported during an active subscription. Please contact support before paying.");
  const existing = await dbGet<GooglePayment>(`SELECT id, google_sub, plan, tier, amount_usdc, reference, fulfilled_at, subscribed_until FROM google_pending_payments WHERE google_sub = ? AND plan = ? AND tier = ? AND fulfilled_at IS NULL AND datetime(created_at) > datetime('now', '-1 hour') ORDER BY created_at DESC LIMIT 1`, sub, plan, tier);
  if (existing) return checkout(existing, subscription.activeUntil);
  const amount = planAmountUsdc(0, plan, tier);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid subscription price");
  const row: GooglePayment = { id: randomUUID(), google_sub: sub, plan, tier, amount_usdc: amount, reference: Keypair.generate().publicKey.toBase58(), fulfilled_at: null, subscribed_until: null };
  await dbRun(`INSERT INTO google_pending_payments (id, google_sub, plan, tier, amount_usdc, reference) VALUES (?, ?, ?, ?, ?, ?)`, row.id, sub, plan, tier, amount, row.reference);
  return checkout(row, subscription.activeUntil);
}

export async function getGoogleCheckout(paymentId: string) {
  const row = await dbGet<GooglePayment>(`SELECT id, google_sub, plan, tier, amount_usdc, reference, fulfilled_at, subscribed_until FROM google_pending_payments WHERE id = ?`, paymentId);
  if (!row) return null;
  const subscription = await getGoogleSubscription(row.google_sub);
  return checkout(row, subscription.activeUntil);
}
