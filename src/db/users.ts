import { dbAll, dbGet, dbRun } from "./client.js";

export type UserRow = {
  telegram_id: number;
  username: string | null;
  trial_started_at: string;
  subscribed_until: string | null;
  early_bird: number;
  trial_picks_used: number;
};

export function trialPickLimit(): number {
  return Number(process.env.TRIAL_PICKS ?? "2");
}

export async function upsertUser(
  telegramId: number,
  username?: string
): Promise<UserRow> {
  await dbRun(
    `INSERT INTO users (telegram_id, username) VALUES (?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET username = COALESCE(excluded.username, users.username)`,
    telegramId,
    username ?? null
  );

  return (await getUser(telegramId))!;
}

export async function getUser(telegramId: number): Promise<UserRow | null> {
  return (
    (await dbGet<UserRow>(`SELECT * FROM users WHERE telegram_id = ?`, telegramId)) ??
    null
  );
}

export function isSubscribed(user: UserRow): boolean {
  if (!user.subscribed_until) return false;
  return new Date(`${user.subscribed_until}Z`) > new Date();
}

export function trialPicksRemaining(user: UserRow): number {
  if (isSubscribed(user)) return trialPickLimit();
  const used = user.trial_picks_used ?? 0;
  return Math.max(0, trialPickLimit() - used);
}

export function hasAccess(user: UserRow): boolean {
  return isSubscribed(user) || trialPicksRemaining(user) > 0;
}

export async function recordTrialPickView(telegramId: number): Promise<UserRow | null> {
  const user = await getUser(telegramId);
  if (!user || isSubscribed(user)) return user;

  await dbRun(
    `UPDATE users SET trial_picks_used = trial_picks_used + 1 WHERE telegram_id = ?`,
    telegramId
  );
  return getUser(telegramId);
}

export function formatAccessStatus(user: UserRow): string {
  if (isSubscribed(user)) {
    const until = new Date(`${user.subscribed_until}Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const plan = user.early_bird ? "Early-Bird ($5/mo locked)" : "Premium";
    return `✅ ${plan} active until ${until}`;
  }

  const remaining = trialPicksRemaining(user);
  if (remaining > 0) {
    return `🆓 Free trial — ${remaining} pick${remaining === 1 ? "" : "s"} left`;
  }

  return "⚠️ Free trial used — subscribe to keep daily picks";
}

export async function listActiveUserIds(): Promise<number[]> {
  const rows = await dbAll<UserRow>(`SELECT * FROM users`);
  return rows.filter(hasAccess).map((u) => u.telegram_id);
}
