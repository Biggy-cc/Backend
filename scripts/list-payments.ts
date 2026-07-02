import "dotenv/config";
import { dbAll } from "../src/db/client.js";

async function main() {
  const pending = await dbAll<{
    id: string;
    telegram_id: number;
    plan: string;
    amount_usdc: number;
    reference: string;
    created_at: string;
    fulfilled_at: string | null;
  }>(
    `SELECT id, telegram_id, plan, amount_usdc, reference, created_at, fulfilled_at
     FROM pending_payments ORDER BY created_at DESC LIMIT 10`
  );

  if (pending.length === 0) {
    console.log("No pending payments in DB yet.");
    return;
  }

  for (const p of pending) {
    console.log("—".repeat(40));
    console.log("User:", p.telegram_id);
    console.log("Plan:", p.plan, `$${p.amount_usdc}`);
    console.log("Reference:", p.reference);
    console.log("Created:", p.created_at);
    console.log("Status:", p.fulfilled_at ? `paid ${p.fulfilled_at}` : "waiting");
  }
}

main().catch(console.error);
