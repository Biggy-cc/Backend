import type { IncomingMessage, ServerResponse } from "node:http";
import { readRawBody } from "./body.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function proxySolanaRpc(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

  try {
    const body = await readRawBody(req);
    const upstream = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const text = await upstream.text();
    res.writeHead(upstream.status, {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(text);
  } catch (err) {
    console.error("[api] /api/solana-rpc failed:", err);
    res.writeHead(502, {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: "Solana RPC proxy failed" }));
  }
}
