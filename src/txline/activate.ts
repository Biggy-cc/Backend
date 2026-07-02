import * as anchor from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import axios from "axios";
import nacl from "tweetnacl";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTxlineConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const txoracleIdl = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../idl/txoracle.json"), "utf8")
) as Idl;

export type TxlineSession = {
  guestJwt: string;
  apiToken: string;
};

export async function activateTxline(
  connection: Connection,
  keypair: Keypair
): Promise<{ txSig: string; apiToken: string; guestJwt: string }> {
  const cfg = getTxlineConfig();
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new anchor.Program(txoracleIdl as Idl, provider);

  const authResponse = await axios.post(`${cfg.apiOrigin}/auth/guest/start`);
  const guestJwt: string = authResponse.data.token;

  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    keypair,
    cfg.txlTokenMint,
    keypair.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    cfg.programId
  );

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    cfg.programId
  );

  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    cfg.txlTokenMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  const selectedLeagues: number[] = [];

  console.log(
    `Subscribing on-chain (service level ${cfg.serviceLevel}, ${cfg.durationWeeks} weeks)…`
  );

  const txSig = await program.methods
    .subscribe(cfg.serviceLevel, cfg.durationWeeks)
    .accounts({
      user: keypair.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: cfg.txlTokenMint,
      userTokenAccount: userTokenAccount.address,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const messageString = `${txSig}:${selectedLeagues.join(",")}:${guestJwt}`;
  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, keypair.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  const activationResponse = await axios.post(
    `${cfg.apiBaseUrl}/token/activate`,
    { txSig, walletSignature, leagues: selectedLeagues },
    { headers: { Authorization: `Bearer ${guestJwt}` } }
  );

  const apiToken: string =
    activationResponse.data.token ?? activationResponse.data;

  return { txSig, apiToken, guestJwt };
}
