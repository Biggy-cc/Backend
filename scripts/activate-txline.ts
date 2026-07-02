import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Connection } from "@solana/web3.js";
import { loadKeypairFromEnv } from "../src/solana/wallet.js";
import { activateTxline } from "../src/txline/activate.js";
import { getTxlineConfig } from "../src/txline/config.js";

function upsertEnv(key: string, value: string) {
  const envPath = path.resolve(".env");
  const line = `${key}=${value}`;
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${line}\n`);
    return;
  }
  const raw = fs.readFileSync(envPath, "utf8");
  const pattern = new RegExp(`^${key}=.*$`, "m");
  fs.writeFileSync(
    envPath,
    pattern.test(raw) ? raw.replace(pattern, line) : `${raw.trimEnd()}\n${line}\n`
  );
}

async function main() {
  if (process.env.TXLINE_API_TOKEN) {
    console.log("TXLINE_API_TOKEN already set — skipping on-chain subscribe.");
    console.log("Delete TXLINE_API_TOKEN from .env to re-activate.");
    return;
  }

  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) {
    console.error("Missing SOLANA_PRIVATE_KEY");
    process.exit(1);
  }

  const cfg = getTxlineConfig();
  const keypair = loadKeypairFromEnv(privateKey);
  const connection = new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    "confirmed"
  );

  const { txSig, apiToken } = await activateTxline(connection, keypair);

  upsertEnv("TXLINE_API_TOKEN", apiToken);

  console.log("\nPASS: TxLINE activated");
  console.log("Wallet:", keypair.publicKey.toBase58());
  console.log("Tx:", `https://explorer.solana.com/tx/${txSig}`);
  console.log("API origin:", cfg.apiOrigin);
  console.log("TXLINE_API_TOKEN saved to .env");
}

main().catch((err) => {
  console.error("FAIL:", err.response?.data ?? err.message ?? err);
  process.exit(1);
});
