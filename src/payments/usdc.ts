import { randomUUID } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { dbAll, dbRun } from "../db/client.js";
import { planAmountUsdc } from "../config/pricing.js";

function buildWalletPayUrls(
  receiver: string,
  amount: number,
  reference: string,
  plan: "monthly" | "yearly"
): { solana: string; phantom: string; solflare: string } {
  const mint = process.env.USDC_MINT ?? "";
  const message = plan === "monthly" ? "Biggy Monthly" : "Biggy Yearly";
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
  plan: "monthly" | "yearly"
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

  const amount = planAmountUsdc(telegramId, plan);

  // Solana Pay requires a real pubkey as reference — text IDs break wallet deep links.
  const referenceKey = Keypair.generate().publicKey.toBase58();
  const id = randomUUID();

  await dbRun(
    `DELETE FROM pending_payments
     WHERE telegram_id = ? AND plan = ? AND fulfilled_at IS NULL`,
    telegramId,
    plan
  );

  await dbRun(
    `INSERT INTO pending_payments (id, telegram_id, plan, amount_usdc, reference)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    telegramId,
    plan,
    amount,
    referenceKey
  );

  const urls = buildWalletPayUrls(receiver, amount, referenceKey, plan);

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

export async function checkPendingPayments(
  onPaid: (telegramId: number, plan: "monthly" | "yearly") => Promise<void>
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
    plan: "monthly" | "yearly";
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
      console.warn("[payments] Solana RPC error — will retry:", err);
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

      const days = payment.plan === "monthly" ? 30 : 365;
      const until = new Date();
      until.setUTCDate(until.getUTCDate() + days);

      await dbRun(
        `UPDATE users SET subscribed_until = ?, early_bird = 1 WHERE telegram_id = ?`,
        until.toISOString(),
        payment.telegram_id
      );

      await dbRun(
        `UPDATE pending_payments SET fulfilled_at = datetime('now') WHERE id = ?`,
        payment.id
      );

      await onPaid(payment.telegram_id, payment.plan);
      break;
    }
  }
}
