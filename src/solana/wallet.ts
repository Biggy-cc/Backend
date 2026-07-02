import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export function loadKeypairFromEnv(raw: string): Keypair {
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    const bytes = Uint8Array.from(JSON.parse(trimmed) as number[]);
    return Keypair.fromSecretKey(bytes);
  }

  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export function parsePublicKey(label: string, value: string): PublicKey {
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new Error(`${label} is not a valid Solana public key`);
  }
}
