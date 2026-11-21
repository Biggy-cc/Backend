import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

const GOOGLE_CLIENT_ID = "974976986420-ge2cfqm49h4hq2dhb56eec9gbm2cuc7a.apps.googleusercontent.com";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
type GoogleKey = JsonWebKey & { kid?: string; alg?: string; use?: string };
type GoogleClaims = {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  exp?: number;
  iat?: number;
};

let keyCache: { expiresAt: number; keys: GoogleKey[] } | null = null;
let keyRequest: Promise<GoogleKey[]> | null = null;

async function googleKeys(): Promise<GoogleKey[]> {
  if (keyCache && Date.now() < keyCache.expiresAt) return keyCache.keys;
  if (keyRequest) return keyRequest;
  keyRequest = (async () => {
    const response = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error("Google identity verification unavailable");
    const body = await response.json() as { keys?: GoogleKey[] };
    if (!Array.isArray(body.keys) || !body.keys.length) throw new Error("Google identity keys unavailable");
    keyCache = { keys: body.keys, expiresAt: Date.now() + 60 * 60_000 };
    return body.keys;
  })();
  try { return await keyRequest; } finally { keyRequest = null; }
}

export type VerifiedGoogleUser = { sub: string; email: string; name: string; picture: string | null };

/** Verify Google's signed ID token on the server before using its identity. */
export async function verifyGoogleCredential(credential: string): Promise<VerifiedGoogleUser> {
  if (typeof credential !== "string" || credential.length > 12_000) throw new Error("Invalid Google credential");
  const parts = credential.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("Invalid Google credential");
  let header: { alg?: string; kid?: string };
  let claims: GoogleClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { throw new Error("Invalid Google credential"); }
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || !header.kid ||
      !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "") ||
      claims.aud !== (process.env.GOOGLE_CLIENT_ID?.trim() || GOOGLE_CLIENT_ID) ||
      typeof claims.exp !== "number" || claims.exp <= now ||
      typeof claims.iat !== "number" || claims.iat > now + 60 ||
      !claims.sub || !claims.email || claims.email_verified !== true) {
    throw new Error("Invalid or expired Google credential");
  }
  let keys = await googleKeys();
  let key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA" && (!candidate.alg || candidate.alg === "RS256"));
  if (!key && keyCache) {
    keyCache = null;
    keys = await googleKeys();
    key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA" && (!candidate.alg || candidate.alg === "RS256"));
  }
  if (!key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"))) {
    throw new Error("Invalid Google credential signature");
  }
  return { sub: claims.sub, email: claims.email, name: claims.name ?? "Biggy user", picture: claims.picture ?? null };
}
