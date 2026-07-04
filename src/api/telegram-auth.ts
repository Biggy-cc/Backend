import crypto from "node:crypto";

export type TelegramLoginPayload = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

export function verifyTelegramLogin(
  data: TelegramLoginPayload,
  botToken: string
): boolean {
  const { hash, ...rest } = data;
  if (!hash || !data.id || !data.auth_date) return false;

  const checkPairs = Object.entries(rest)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);

  const dataCheckString = checkPairs.join("\n");
  const secretKey = crypto.createHash("sha256").update(botToken).digest();
  const hmac = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (hmac !== hash) return false;

  const ageSec = Math.floor(Date.now() / 1000) - data.auth_date;
  return ageSec >= 0 && ageSec <= 86400;
}
