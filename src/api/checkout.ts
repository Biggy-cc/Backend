import { getUser, upsertUser, extendSubscriptionUntil, formatSubscriptionDate, isSubscribed } from "../db/users.js";
import { createPaymentLink } from "../payments/usdc.js";
import { dbGet } from "../db/client.js";
import { userHasTelegramAvatar } from "../telegram/profile.js";
import {
  verifyTelegramLogin,
  type TelegramLoginPayload,
} from "./telegram-auth.js";

type PendingPaymentRow = {
  id: string;
  telegram_id: number;
  plan: "monthly" | "yearly";
  amount_usdc: number;
  reference: string;
  fulfilled_at: string | null;
};

export type CheckoutSession = {
  paymentId: string;
  plan: "monthly" | "yearly";
  amount: number;
  recipient: string;
  mint: string;
  reference: string;
  solanaUrl: string;
  phantomUrl: string;
  solflareUrl: string;
  fulfilled: boolean;
  telegramId: number;
  telegramUsername: string | null;
  telegramFirstName: string | null;
  telegramPhotoUrl: string | null;
  telegramHasAvatar: boolean;
  subscriptionActiveUntil: string | null;
  subscriptionActiveUntilLabel: string | null;
  subscriptionRenewsUntil: string;
  subscriptionRenewsUntilLabel: string;
};

type CheckoutProfile = {
  telegramUsername: string | null;
  telegramFirstName: string | null;
  telegramPhotoUrl: string | null;
  telegramHasAvatar: boolean;
};

function subscriptionFields(
  user: Awaited<ReturnType<typeof getUser>>,
  plan: "monthly" | "yearly"
): Pick<
  CheckoutSession,
  | "subscriptionActiveUntil"
  | "subscriptionActiveUntilLabel"
  | "subscriptionRenewsUntil"
  | "subscriptionRenewsUntilLabel"
> {
  const activeUntil =
    user && isSubscribed(user) && user.subscribed_until
      ? user.subscribed_until
      : null;
  const renewsUntil = extendSubscriptionUntil(
    user?.subscribed_until ?? null,
    plan
  ).toISOString();

  return {
    subscriptionActiveUntil: activeUntil,
    subscriptionActiveUntilLabel: activeUntil
      ? formatSubscriptionDate(activeUntil)
      : null,
    subscriptionRenewsUntil: renewsUntil,
    subscriptionRenewsUntilLabel: formatSubscriptionDate(renewsUntil),
  };
}

function toCheckoutSession(
  row: Pick<PendingPaymentRow, "id" | "telegram_id" | "plan" | "amount_usdc" | "reference" | "fulfilled_at">,
  reference: string,
  profile: CheckoutProfile,
  user: Awaited<ReturnType<typeof getUser>>
): CheckoutSession {
  const receiver = process.env.USDC_RECEIVER_WALLET;
  if (!receiver) {
    throw new Error("USDC_RECEIVER_WALLET missing");
  }

  const mint = process.env.USDC_MINT ?? "";
  const message = row.plan === "monthly" ? "Biggy Monthly" : "Biggy Yearly";
  const solana = `solana:${receiver}?amount=${row.amount_usdc}&spl-token=${mint}&reference=${reference}&label=Biggy&message=${encodeURIComponent(message)}`;

  const params = new URLSearchParams({
    recipient: receiver,
    amount: String(row.amount_usdc),
    "spl-token": mint,
    reference,
    label: "Biggy",
    message,
  });

  return {
    paymentId: row.id,
    plan: row.plan,
    amount: row.amount_usdc,
    recipient: receiver,
    mint,
    reference,
    solanaUrl: solana,
    phantomUrl: `https://phantom.app/ul/v1/solana-pay?${params.toString()}`,
    solflareUrl: `https://solflare.com/ul/v1/solana-pay?${params.toString()}`,
    fulfilled: row.fulfilled_at != null,
    telegramId: row.telegram_id,
    ...profile,
    ...subscriptionFields(user, row.plan),
  };
}

async function resolveCheckoutProfile(
  telegramId: number,
  fallback?: Partial<Omit<CheckoutProfile, "telegramHasAvatar">>
): Promise<CheckoutProfile> {
  const user = await getUser(telegramId);
  const username = user?.username ?? fallback?.telegramUsername ?? null;
  const photoUrl = user?.photo_url ?? fallback?.telegramPhotoUrl ?? null;

  const telegramHasAvatar = await userHasTelegramAvatar({
    telegramId,
    photoUrl,
    username,
  });

  return {
    telegramUsername: username,
    telegramFirstName:
      user?.first_name ?? fallback?.telegramFirstName ?? null,
    telegramPhotoUrl: photoUrl,
    telegramHasAvatar,
  };
}

export async function startWebCheckout(
  plan: "monthly" | "yearly",
  telegramAuth: TelegramLoginPayload
): Promise<CheckoutSession> {
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

  const link = await createPaymentLink(telegramAuth.id, plan);

  const profile = await resolveCheckoutProfile(telegramAuth.id, {
    telegramUsername: telegramAuth.username ?? null,
    telegramFirstName: telegramAuth.first_name,
    telegramPhotoUrl: telegramAuth.photo_url ?? null,
  });
  const user = await getUser(telegramAuth.id);

  return toCheckoutSession(
    {
      id: link.paymentId,
      telegram_id: telegramAuth.id,
      plan,
      amount_usdc: link.amount,
      reference: link.reference,
      fulfilled_at: null,
    },
    link.reference,
    profile,
    user
  );
}

export async function getCheckoutSession(
  paymentId: string
): Promise<CheckoutSession | null> {
  const row = await dbGet<PendingPaymentRow>(
    `SELECT id, telegram_id, plan, amount_usdc, reference, fulfilled_at
     FROM pending_payments WHERE id = ?`,
    paymentId
  );

  if (!row) return null;

  const profile = await resolveCheckoutProfile(row.telegram_id);
  const user = await getUser(row.telegram_id);

  return toCheckoutSession(row, row.reference, profile, user);
}

/** Create checkout links for bot subscribe buttons (Monthly + Yearly). */
export async function createBotSubscribeLinks(telegramId: number): Promise<{
  monthlyId: string;
  yearlyId: string;
}> {
  const [monthly, yearly] = await Promise.all([
    createPaymentLink(telegramId, "monthly"),
    createPaymentLink(telegramId, "yearly"),
  ]);

  return {
    monthlyId: monthly.paymentId,
    yearlyId: yearly.paymentId,
  };
}
