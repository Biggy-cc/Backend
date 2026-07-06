import { dbGet, dbRun } from "../db/client.js";

export type SocialPostKind = "daily_free" | "pick_update" | "leg_win" | "news";

export async function wasPosted(dedupKey: string): Promise<boolean> {
  const row = await dbGet<{ dedup_key: string }>(
    `SELECT dedup_key FROM social_posts WHERE dedup_key = ?`,
    dedupKey
  );
  return Boolean(row);
}

export async function recordPost(
  kind: SocialPostKind,
  dedupKey: string,
  body: string,
  tweetId: string | null
): Promise<void> {
  await dbRun(
    `INSERT OR IGNORE INTO social_posts (kind, dedup_key, body, tweet_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    kind,
    dedupKey,
    body,
    tweetId
  );
}
