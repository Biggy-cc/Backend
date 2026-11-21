import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { dbAll, dbGet } from "../db/client.js";
import type { BillingCycle, SubscriptionTier } from "../config/pricing.js";

type Pending = { id: string; google_sub: string; plan: BillingCycle; tier: SubscriptionTier; amount_usdc: number; reference: string };

/** Check actual USDC balance change, never just an instruction or client claim. */
export function verifiedUsdcDelta(tx: ParsedTransactionWithMeta, receiver: PublicKey, mint: PublicKey): bigint | null {
  if (!tx.meta || tx.meta.err != null) return null;
  let total = 0n;
  for (const post of tx.meta.postTokenBalances ?? []) {
    if (post.mint !== mint.toBase58() || post.owner !== receiver.toBase58()) continue;
    const pre = (tx.meta.preTokenBalances ?? []).find((item) => item.accountIndex === post.accountIndex && item.mint === post.mint);
    if (post.uiTokenAmount.decimals !== 6 || (pre && pre.uiTokenAmount.decimals !== 6)) return null;
    try { total += BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0"); } catch { return null; }
  }
  return total > 0n ? total : null;
}

/** Atomically record a unique verified signature and calculate renewal in one SQL statement. */
export async function fulfillGooglePayment(id: string, signature: string): Promise<boolean> {
  const row = await dbGet<{ id: string }>(
    `UPDATE google_pending_payments SET
       fulfilled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), paid_signature = ?,
       subscribed_until = strftime('%Y-%m-%dT%H:%M:%fZ',
         CASE WHEN COALESCE((SELECT MAX(p.subscribed_until) FROM google_pending_payments p WHERE p.google_sub = google_pending_payments.google_sub AND p.fulfilled_at IS NOT NULL), '') > strftime('%Y-%m-%dT%H:%M:%fZ','now')
              THEN (SELECT MAX(p.subscribed_until) FROM google_pending_payments p WHERE p.google_sub = google_pending_payments.google_sub AND p.fulfilled_at IS NOT NULL) ELSE 'now' END,
         CASE WHEN plan = 'monthly' THEN '+30 days' ELSE '+365 days' END)
     WHERE id = ? AND fulfilled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM google_pending_payments p WHERE p.paid_signature = ?)
       AND NOT EXISTS (SELECT 1 FROM google_pending_payments p WHERE p.google_sub = google_pending_payments.google_sub AND p.fulfilled_at IS NOT NULL AND p.subscribed_until > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND p.tier <> google_pending_payments.tier)
     RETURNING id`, signature, id, signature
  );
  return !!row;
}

export async function checkGooglePendingPayments(connectionOverride?: Pick<Connection, "getSignaturesForAddress" | "getParsedTransaction">): Promise<void> {
  const receiverText = process.env.USDC_RECEIVER_WALLET?.trim();
  const mintText = process.env.USDC_MINT?.trim();
  if (!receiverText || !mintText) return;
  const receiver = new PublicKey(receiverText);
  const mint = new PublicKey(mintText);
  const pending = await dbAll<Pending>(`SELECT id, google_sub, plan, tier, amount_usdc, reference FROM google_pending_payments WHERE fulfilled_at IS NULL ORDER BY created_at ASC`);
  if (!pending.length) return;
  const legacy = await dbAll<{ reference: string }>(`SELECT reference FROM pending_payments WHERE fulfilled_at IS NULL`);
  const allReferences = new Set([...pending.map((item) => item.reference), ...legacy.map((item) => item.reference)]);
  const connection = connectionOverride ?? new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "finalized");
  for (const payment of pending) {
    let reference: PublicKey;
    try { reference = new PublicKey(payment.reference); } catch { continue; }
    const signatures = await connection.getSignaturesForAddress(reference, { limit: 10 }, "finalized");
    for (const signature of signatures) {
      if (signature.err || signature.confirmationStatus !== "finalized") continue;
      const tx = await connection.getParsedTransaction(signature.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta?.err != null) continue;
      const keys = new Set(tx.transaction.message.accountKeys.map((key) => key.pubkey.toBase58()));
      if (!keys.has(payment.reference) || [...allReferences].filter((item) => keys.has(item)).length !== 1) continue;
      const delta = verifiedUsdcDelta(tx, receiver, mint);
      const expected = BigInt(Math.round(payment.amount_usdc * 1_000_000));
      if (delta === null || delta < expected) continue;
      const subscription = await dbGet<{ tier: string; subscribed_until: string }>(`SELECT tier, subscribed_until FROM google_pending_payments WHERE google_sub = ? AND fulfilled_at IS NOT NULL AND subscribed_until > strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY subscribed_until DESC LIMIT 1`, payment.google_sub);
      if (subscription && subscription.tier !== payment.tier) {
        console.error(`[payments] Google payment ${payment.id} requires manual review: active tier differs`);
        continue;
      }
      if (await fulfillGooglePayment(payment.id, signature.signature)) console.log(`[payments] Google payment ${payment.id} verified`);
      break;
    }
  }
}
