import { randomUUID } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { dbAll, dbRun } from "../db/client.js";
import { extendSubscriptionUntil, getUser } from "../db/users.js";
import {
  planAmountUsdc,
  type BillingCycle,
  type SubscriptionTier,
} from "../config/pricing.js";

export function buildWalletPayUrls(
  receiver: string,
  amount: number,
  reference: string,
  plan: BillingCycle,
  tier: SubscriptionTier
): { solana: string; phantom: string; solflare: string } {
  const mint = process.env.USDC_MINT ?? "";
  const tierLabel = tier === "max" ? "Max" : "Pro";
  const cycleLabel = plan === "monthly" ? "Monthly" : "Yearly";
  const message = `Biggy ${tierLabel} ${cycleLabel}`;
  const solana = `solana:${receiver}?amount=${amount}&spl-token=${mint}&reference=${reference}&label=Biggy&message=${encodeURIComponent(message)}`;

  const params = new URLSearchParams({
    recipient: receiver,
    amount: String(amount),
    "spl-token": mint,
    reference,
    label: "Biggy",
    message,
  });

  return {
    solana,
    phantom: `https://phantom.app/ul/v1/solana-pay?${params.toString()}`,
    solflare: `https://solflare.com/ul/v1/solana-pay?${params.toString()}`,
  };
}

export async function createPaymentLink(
  telegramId: number,
  plan: BillingCycle,
  tier: SubscriptionTier = "pro"
): Promise<{
  url: string;
  phantomUrl: string;
  solflareUrl: string;
  reference: string;
  amount: number;
  paymentId: string;
}> {
  const receiver = process.env.USDC_RECEIVER_WALLET;
  if (!receiver) throw new Error("USDC_RECEIVER_WALLET missing");

  const amount = planAmountUsdc(telegramId, plan, tier);

  // Solana Pay requires a real pubkey as reference — text IDs break wallet deep links.
  const referenceKey = Keypair.generate().publicKey.toBase58();
  const id = randomUUID();

  await dbRun(
    `DELETE FROM pending_payments
     WHERE telegram_id = ? AND plan = ? AND tier = ? AND fulfilled_at IS NULL`,
    telegramId,
    plan,
    tier
  );

  await dbRun(
    `INSERT INTO pending_payments (id, telegram_id, plan, tier, amount_usdc, reference)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    telegramId,
    plan,
    tier,
    amount,
    referenceKey
  );

  const urls = buildWalletPayUrls(receiver, amount, referenceKey, plan, tier);

  return {
    url: urls.solana,
    phantomUrl: urls.phantom,
    solflareUrl: urls.solflare,
    reference: referenceKey,
    amount,
    paymentId: id,
  };
}

function parseUsdcTransfer(
  tx: ParsedTransactionWithMeta,
  receiver: PublicKey,
  mint: PublicKey
): number | null {
  const meta = tx.meta;
  if (!meta) return null;

  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];

  for (const postBal of post) {
    if (postBal.mint !== mint.toBase58()) continue;
    if (postBal.owner !== receiver.toBase58()) continue;

    const preBal = pre.find(
      (p) => p.accountIndex === postBal.accountIndex && p.mint === postBal.mint
    );
    const preAmt = preBal?.uiTokenAmount.uiAmount ?? 0;
    const postAmt = postBal.uiTokenAmount.uiAmount ?? 0;
    const delta = postAmt - preAmt;
    if (delta > 0) return delta;
  }

  return null;
}

function txIncludesReference(tx: ParsedTransactionWithMeta, reference: PublicKey): boolean {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  return keys.includes(reference.toBase58());
}

export type PaidSubscription = {
  telegramId: number;
  plan: BillingCycle;
  tier: SubscriptionTier;
  amountUsdc: number;
  renewsUntil: string;
};

export async function checkPendingPayments(
  onPaid: (payment: PaidSubscription) => Promise<void>
) {
  const receiverStr = process.env.USDC_RECEIVER_WALLET;
  const mintStr = process.env.USDC_MINT;
  if (!receiverStr || !mintStr) return;

  const connection = new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    "confirmed"
  );
  const receiver = new PublicKey(receiverStr);
  const mint = new PublicKey(mintStr);

  const pending = await dbAll<{
    id: string;
    telegram_id: number;
    plan: BillingCycle;
    tier: SubscriptionTier;
    amount_usdc: number;
    reference: string;
  }>(
    `SELECT * FROM pending_payments WHERE fulfilled_at IS NULL ORDER BY created_at ASC`
  );

  if (pending.length === 0) return;

  for (const payment of pending) {
    let reference: PublicKey;
    try {
      reference = new PublicKey(payment.reference);
    } catch {
      console.warn("[payments] Skipping invalid reference:", payment.reference);
      continue;
    }

    let sigs;
    try {
      sigs = await connection.getSignaturesForAddress(reference, { limit: 10 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|Too many requests/i.test(msg)) {
        // Surface to poller for backoff; avoid dumping full RPC error objects.
        throw new Error("429 Too many requests (Solana RPC)");
      }
      console.warn("[payments] Solana RPC error — will retry:", msg.slice(0, 160));
      return;
    }

    for (const sig of sigs) {
      let tx;
      try {
        tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
      } catch {
        continue;
      }
      if (!tx || !txIncludesReference(tx, reference)) continue;

      const amount = parseUsdcTransfer(tx, receiver, mint);
      if (amount === null || Math.abs(payment.amount_usdc - amount) >= 0.01) continue;

      const user = await getUser(payment.telegram_id);
      const until = extendSubscriptionUntil(user?.subscribed_until, payment.plan);

      await dbRun(
        `UPDATE users
         SET subscribed_until = ?, subscription_tier = ?, early_bird = 1
         WHERE telegram_id = ?`,
        until.toISOString(),
        payment.tier,
        payment.telegram_id
      );

      await dbRun(
        `UPDATE pending_payments SET fulfilled_at = datetime('now') WHERE id = ?`,
        payment.id
      );

      await onPaid({
        telegramId: payment.telegram_id,
        plan: payment.plan,
        tier: payment.tier,
        amountUsdc: payment.amount_usdc,
        renewsUntil: until.toISOString(),
      });
      break;
    }
  }
}
