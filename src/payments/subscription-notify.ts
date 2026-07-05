import type { Api } from "grammy";
import { getUser, userDisplayName } from "../db/users.js";

export type NewSubscription = {
  telegramId: number;
  plan: "monthly" | "yearly";
  amountUsdc: number;
};

/** Telegram user to ping on new subscriptions (defaults to Dracklyn). Set to 0 to disable. */
function subscriptionNotifyTelegramId(): number | null {
  const raw = process.env.SUBSCRIPTION_NOTIFY_TELEGRAM_ID ?? "5309840190";
  if (raw.trim() === "" || raw.trim() === "0") return null;

  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function formatSubscriberLabel(
  telegramId: number,
  username: string | null,
  firstName: string | null
): string {
  const name = userDisplayName({ first_name: firstName, username });
  const handle = username ? `@${username}` : name;
  return `${handle} · ${telegramId}`;
}

export async function notifyNewSubscription(
  api: Api,
  subscription: NewSubscription
): Promise<void> {
  const notifyId = subscriptionNotifyTelegramId();
  if (!notifyId) return;

  const user = await getUser(subscription.telegramId);
  const label = formatSubscriberLabel(
    subscription.telegramId,
    user?.username ?? null,
    user?.first_name ?? null
  );
  const planLabel = subscription.plan === "monthly" ? "Monthly" : "Yearly";

  const text = [
    "🎉 New Biggy Premium subscription",
    "",
    `User: ${label}`,
    `Plan: ${planLabel} · $${subscription.amountUsdc} USDC`,
  ].join("\n");

  try {
    await api.sendMessage(notifyId, text);
  } catch (err) {
    console.warn("[payments] Subscription notify failed:", err);
  }
}
