import { dbAll, dbGet, dbRun } from "./client.js";

export type UserRow = {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  photo_url: string | null;
  trial_started_at: string;
  subscribed_until: string | null;
  early_bird: number;
  trial_picks_used: number;
};

export function userDisplayName(user: Pick<UserRow, "first_name" | "username">): string {
  if (user.first_name?.trim()) return user.first_name.trim();
  if (user.username?.trim()) return user.username.trim();
  return "Telegram user";
}

export function trialPickLimit(): number {
  return Number(process.env.TRIAL_PICKS ?? "2");
}

export async function upsertUser(
  telegramId: number,
  username?: string,
  firstName?: string,
  photoUrl?: string
): Promise<UserRow> {
  await dbRun(
    `INSERT INTO users (telegram_id, username, first_name, photo_url) VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       username = COALESCE(excluded.username, users.username),
       first_name = COALESCE(excluded.first_name, users.first_name),
       photo_url = COALESCE(excluded.photo_url, users.photo_url)`,
    telegramId,
    username ?? null,
    firstName ?? null,
    photoUrl ?? null
  );

  return (await getUser(telegramId))!;
}

export async function getUser(telegramId: number): Promise<UserRow | null> {
  return (
    (await dbGet<UserRow>(`SELECT * FROM users WHERE telegram_id = ?`, telegramId)) ??
    null
  );
}

function parseSubscribedUntil(value: string): Date {
  if (value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value)) {
    return new Date(value);
  }
  return new Date(`${value}Z`);
}

export function formatSubscriptionDate(value: string): string {
  return parseSubscribedUntil(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function paymentVerifiedMessage(subscribedUntil: string): string {
  return `✅ Payment verified. Biggy Premium active until ${formatSubscriptionDate(subscribedUntil)}.`;
}

export function subscriptionPeriodDays(plan: "monthly" | "yearly"): number {
  return plan === "monthly" ? 30 : 365;
}

/** Stack renewal on current expiry when still active; otherwise start from now. */
export function extendSubscriptionUntil(
  currentUntil: string | null | undefined,
  plan: "monthly" | "yearly",
  now: Date = new Date()
): Date {
  const base = new Date(now);

  if (currentUntil) {
    const existing = parseSubscribedUntil(currentUntil);
    if (!Number.isNaN(existing.getTime()) && existing > base) {
      base.setTime(existing.getTime());
    }
  }

  base.setUTCDate(base.getUTCDate() + subscriptionPeriodDays(plan));
  return base;
}

export function isSubscribed(user: UserRow): boolean {
  if (!user.subscribed_until) return false;
  const until = parseSubscribedUntil(user.subscribed_until);
  return !Number.isNaN(until.getTime()) && until > new Date();
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
    const until = formatSubscriptionDate(user.subscribed_until!);
    const plan = user.early_bird ? "Premium (legacy rate)" : "Premium";
    return `✅ ${plan} active until ${until}. Renewal adds time on top.`;
  }

  const remaining = trialPicksRemaining(user);
  if (remaining > 0) {
    return `🆓 Free trial. ${remaining} pick${remaining === 1 ? "" : "s"} left`;
  }

  return "⚠️ Free trial used. Subscribe for unlimited daily football picks.";
}

export async function listActiveUserIds(): Promise<number[]> {
  const rows = await dbAll<UserRow>(`SELECT * FROM users`);
  return rows.filter(hasAccess).map((u) => u.telegram_id);
}
