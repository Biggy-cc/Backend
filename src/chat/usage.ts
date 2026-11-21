import { dbGet, dbRun } from "../db/client.js";

export type ChatTier = "guest" | "free" | "pro" | "max";
export const CHAT_LIMITS: Record<ChatTier, { messages: number; parlays: number }> = {
  guest: { messages: 2, parlays: 0 },
  free: { messages: 5, parlays: 0 },
  pro: { messages: 50, parlays: 5 },
  max: { messages: 150, parlays: 15 },
};

/** A conditional upsert reserves one request atomically, including under concurrent load. */
export async function reserveChatUsage(
  principal: string,
  tier: ChatTier,
  isParlay: boolean,
  now = new Date()
): Promise<{ allowed: boolean; reason?: "messages" | "parlays" }> {
  const limits = CHAT_LIMITS[tier];
  if (isParlay && limits.parlays === 0) return { allowed: false, reason: "parlays" };
  const date = tier === "guest" ? "lifetime" : now.toISOString().slice(0, 10);
  const row = await dbGet<{ messages: number }>(
    `INSERT INTO chat_usage (principal, usage_date, messages, parlays)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(principal, usage_date) DO UPDATE SET
       messages = messages + 1, parlays = parlays + excluded.parlays
     WHERE messages < ? AND parlays + excluded.parlays <= ?
     RETURNING messages`,
    principal, date, isParlay ? 1 : 0, limits.messages, limits.parlays
  );
  if (row) return { allowed: true };
  const current = await dbGet<{ messages: number }>(
    `SELECT messages FROM chat_usage WHERE principal = ? AND usage_date = ?`, principal, date
  );
  return { allowed: false, reason: (current?.messages ?? limits.messages) >= limits.messages ? "messages" : "parlays" };
}

export async function refundChatUsage(principal: string, tier: ChatTier, isParlay: boolean, reservedAt: Date): Promise<void> {
  const date = tier === "guest" ? "lifetime" : reservedAt.toISOString().slice(0, 10);
  await dbRun(`UPDATE chat_usage SET messages = MAX(0, messages - 1), parlays = MAX(0, parlays - ?) WHERE principal = ? AND usage_date = ?`, isParlay ? 1 : 0, principal, date);
}

export async function reserveParlayUsage(principal: string, tier: ChatTier, reservedAt: Date): Promise<boolean> {
  const limit = CHAT_LIMITS[tier].parlays;
  if (!limit) return false;
  const date = tier === "guest" ? "lifetime" : reservedAt.toISOString().slice(0, 10);
  return !!await dbGet<{ parlays: number }>(`UPDATE chat_usage SET parlays = parlays + 1 WHERE principal = ? AND usage_date = ? AND parlays < ? RETURNING parlays`, principal, date, limit);
}
