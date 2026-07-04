import type http from "node:http";
import { getUser } from "../db/users.js";
import { resolveTelegramAvatarBytes } from "../telegram/profile.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
};

export async function serveTelegramAvatar(
  telegramId: number,
  res: http.ServerResponse,
  freshPhotoUrl?: string | null
): Promise<void> {
  const user = await getUser(telegramId);

  const { bytes, contentType } = await resolveTelegramAvatarBytes({
    telegramId,
    photoUrl: freshPhotoUrl ?? user?.photo_url,
    username: user?.username,
    fallbackLabel: user?.username ?? user?.first_name,
  });

  if (contentType.includes("svg")) {
    res.writeHead(404, { ...CORS_HEADERS, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  res.writeHead(200, {
    ...CORS_HEADERS,
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(bytes);
}
