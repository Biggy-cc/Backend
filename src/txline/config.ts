import { PublicKey } from "@solana/web3.js";

export const TXLINE_MAINNET = {
  apiOrigin: "https://txline.txodds.com",
  programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
  txlTokenMint: new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
} as const;

export function getTxlineConfig() {
  const origin = process.env.TXLINE_API_ORIGIN ?? TXLINE_MAINNET.apiOrigin;
  return {
    apiOrigin: origin,
    apiBaseUrl: `${origin}/api`,
    programId: TXLINE_MAINNET.programId,
    txlTokenMint: TXLINE_MAINNET.txlTokenMint,
    serviceLevel: Number(process.env.TXLINE_SERVICE_LEVEL ?? "12"),
    durationWeeks: 4,
  };
}
