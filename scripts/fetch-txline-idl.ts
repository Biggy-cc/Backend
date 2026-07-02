import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { loadKeypairFromEnv } from "../src/solana/wallet.js";
import { TXLINE_MAINNET } from "../src/txline/config.js";

async function main() {
  const keypair = loadKeypairFromEnv(process.env.SOLANA_PRIVATE_KEY!);
  const connection = new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    "confirmed"
  );
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idl = await anchor.Program.fetchIdl(TXLINE_MAINNET.programId, provider);
  if (!idl) {
    console.error("Could not fetch IDL from chain");
    process.exit(1);
  }
  console.log("IDL fetched:", idl.metadata?.name ?? "txoracle");
  console.log("Instructions:", idl.instructions?.map((i) => i.name).join(", "));
}

main().catch(console.error);
