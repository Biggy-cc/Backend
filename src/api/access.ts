import {
  extendSubscriptionUntil,
  formatSubscriptionDate,
  getUser,
  isSubscribed,
  upsertUser,
} from "../db/users.js";
import {
  verifyTelegramLogin,
  type TelegramLoginPayload,
} from "./telegram-auth.js";

export type RenewPreview = {
  until: string;
  untilLabel: string;
};

export type AccessStatus = {
  subscribed: boolean;
  activeUntil: string | null;
  activeUntilLabel: string | null;
  renewPreview: {
    monthly: RenewPreview;
    yearly: RenewPreview;
  };
};

function buildRenewPreview(
  currentUntil: string | null | undefined,
  plan: "monthly" | "yearly"
): RenewPreview {
  const until = extendSubscriptionUntil(currentUntil, plan).toISOString();
  return { until, untilLabel: formatSubscriptionDate(until) };
}

export async function getWebAccess(
  telegramAuth: TelegramLoginPayload
): Promise<AccessStatus> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN missing");
  }

  if (!verifyTelegramLogin(telegramAuth, botToken)) {
    throw new Error("Invalid Telegram login");
  }

  await upsertUser(
    telegramAuth.id,
    telegramAuth.username ?? undefined,
    telegramAuth.first_name,
    telegramAuth.photo_url ?? undefined
  );

  const user = await getUser(telegramAuth.id);
  const subscribed = user ? isSubscribed(user) : false;
  const activeUntil =
    subscribed && user?.subscribed_until ? user.subscribed_until : null;

  return {
    subscribed,
    activeUntil,
    activeUntilLabel: activeUntil ? formatSubscriptionDate(activeUntil) : null,
    renewPreview: {
      monthly: buildRenewPreview(user?.subscribed_until, "monthly"),
      yearly: buildRenewPreview(user?.subscribed_until, "yearly"),
    },
  };
}
