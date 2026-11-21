import { dbGet, dbRun } from "./client.js";
import type { VerifiedGoogleUser } from "../api/google-auth.js";

export type GoogleAccount = {
  google_sub: string;
  email: string;
  display_name: string;
  picture_url: string | null;
  subscription_tier: "free" | "pro" | "max";
  subscribed_until: string | null;
};

export async function upsertGoogleAccount(user: VerifiedGoogleUser): Promise<GoogleAccount> {
  await dbRun(
    `INSERT INTO google_accounts (google_sub, email, display_name, picture_url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(google_sub) DO UPDATE SET
       email = excluded.email, display_name = excluded.display_name, picture_url = excluded.picture_url`,
    user.sub, user.email, user.name, user.picture
  );
  const account = await getGoogleAccount(user.sub);
  if (!account) throw new Error("Could not load Google account");
  return account;
}

export async function getGoogleAccount(sub: string): Promise<GoogleAccount | null> {
  return await dbGet<GoogleAccount>(
    `SELECT google_sub, email, display_name, picture_url, subscription_tier, subscribed_until
     FROM google_accounts WHERE google_sub = ?`, sub
  ) ?? null;
}

export function activeGoogleTier(account: GoogleAccount): "free" | "pro" | "max" {
  if (!account.subscribed_until || Date.parse(account.subscribed_until) <= Date.now()) return "free";
  return account.subscription_tier === "max" ? "max" : account.subscription_tier === "pro" ? "pro" : "free";
}

/** The verified-payment ledger is the source of truth for web subscriptions. */
export async function getGoogleSubscription(sub: string): Promise<{ tier: "free" | "pro" | "max"; activeUntil: string | null }> {
  const row = await dbGet<{ tier: "pro" | "max"; subscribed_until: string }>(
    `SELECT tier, subscribed_until FROM google_pending_payments
     WHERE google_sub = ? AND fulfilled_at IS NOT NULL AND subscribed_until IS NOT NULL
     ORDER BY subscribed_until DESC LIMIT 1`, sub
  );
  if (!row || !Number.isFinite(Date.parse(row.subscribed_until)) || Date.parse(row.subscribed_until) <= Date.now()) return { tier: "free", activeUntil: null };
  return { tier: row.tier, activeUntil: row.subscribed_until };
}

/** Complimentary testing access, only after the Google ID token has been verified. */
export async function getVerifiedGoogleAccess(user: VerifiedGoogleUser): Promise<{ tier: "free" | "pro" | "max"; activeUntil: string | null }> {
  const testAccessUntil = "2026-11-29T23:00:00.000Z";
  if (user.email.trim().toLowerCase() === "shedracklyn@gmail.com" && Date.now() < Date.parse(testAccessUntil)) return { tier: "max", activeUntil: testAccessUntil };
  return getGoogleSubscription(user.sub);
}
