import "dotenv/config";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadKeypairFromEnv, parsePublicKey } from "../src/solana/wallet.js";

async function main() {
  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  const receiver = process.env.USDC_RECEIVER_WALLET;
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

  if (!privateKey) {
    console.error("FAIL: SOLANA_PRIVATE_KEY missing from .env");
    process.exit(1);
  }
  if (!receiver) {
    console.error("FAIL: USDC_RECEIVER_WALLET missing from .env");
    process.exit(1);
  }

  const keypair = loadKeypairFromEnv(privateKey);
  const backendPubkey = keypair.publicKey.toBase58();
  const receiverPubkey = parsePublicKey("USDC_RECEIVER_WALLET", receiver);

  const connection = new Connection(rpcUrl, "confirmed");
  const lamports = await connection.getBalance(keypair.publicKey);
  const sol = lamports / LAMPORTS_PER_SOL;

  console.log("PASS: Solana wallet config valid");
  console.log("RPC:", rpcUrl);
  console.log("Backend wallet:", backendPubkey);
  console.log("USDC receiver:", receiverPubkey.toBase58());
  console.log("SOL balance:", sol.toFixed(4), "SOL");

  if (sol < 0.005) {
    console.warn("WARN: Low SOL — fund with ~0.01 SOL for TxLINE signup gas");
  } else {
    console.log("OK: Enough SOL for TxLINE activation");
  }

  if (backendPubkey !== receiverPubkey.toBase58()) {
    console.log("Note: Backend wallet and USDC receiver are different addresses");
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  process.exit(1);
});
