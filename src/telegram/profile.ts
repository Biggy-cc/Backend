const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://telegram.org/",
  Accept: "image/*,*/*;q=0.8",
};

/** Bot API file URL (server-side only — never send to the browser). */
export async function fetchTelegramPhotoUrl(
  telegramId: number
): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;

  try {
    const photosRes = await fetch(
      `https://api.telegram.org/bot${token}/getUserProfilePhotos?user_id=${telegramId}&limit=1`
    );
    const photosData = (await photosRes.json()) as {
      ok?: boolean;
      result?: { total_count?: number; photos?: Array<Array<{ file_id: string }>> };
    };

    if (!photosData.ok || !photosData.result?.total_count) return null;

    const sizes = photosData.result.photos?.[0];
    const fileId = sizes?.[sizes.length - 1]?.file_id;
    if (!fileId) return null;

    const fileRes = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
    );
    const fileData = (await fileRes.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
    };

    const filePath = fileData.result?.file_path;
    if (!filePath) return null;

    return `https://api.telegram.org/file/bot${token}/${filePath}`;
  } catch {
    return null;
  }
}

export async function fetchImageBytes(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { headers: FETCH_HEADERS });
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/") || contentType.includes("gif")) {
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/** Telegram Login photo_url or public username userpic. */
export function telegramUserpicSources(opts: {
  photoUrl?: string | null;
  username?: string | null;
}): string[] {
  const sources: string[] = [];

  if (opts.photoUrl?.includes("t.me/i/userpic")) {
    sources.push(opts.photoUrl);
  }

  if (opts.username) {
    sources.push(`https://t.me/i/userpic/320/${opts.username}.jpg`);
    const lower = opts.username.toLowerCase();
    if (lower !== opts.username) {
      sources.push(`https://t.me/i/userpic/320/${lower}.jpg`);
    }
  }

  return sources;
}

export function initialAvatarSvg(label: string): Buffer {
  const initial = label.replace(/^@/, "").charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="32" fill="#2a4538"/>
  <text x="32" y="34" text-anchor="middle" fill="#eae2cf" font-family="Arial,sans-serif" font-size="26" font-weight="700">${initial}</text>
</svg>`;
  return Buffer.from(svg);
}

export async function resolveTelegramAvatarBytes(opts: {
  telegramId: number;
  photoUrl?: string | null;
  username?: string | null;
  fallbackLabel?: string | null;
}): Promise<{ bytes: Buffer; contentType: string }> {
  const botFileUrl = await fetchTelegramPhotoUrl(opts.telegramId);
  if (botFileUrl) {
    const bytes = await fetchImageBytes(botFileUrl);
    if (bytes) return { bytes, contentType: "image/jpeg" };
  }

  for (const url of telegramUserpicSources(opts)) {
    const bytes = await fetchImageBytes(url);
    if (bytes) return { bytes, contentType: "image/jpeg" };
  }

  const label =
    opts.fallbackLabel ?? opts.username ?? opts.photoUrl ?? "?";
  return { bytes: initialAvatarSvg(label), contentType: "image/svg+xml" };
}

export async function userHasTelegramAvatar(opts: {
  telegramId: number;
  photoUrl?: string | null;
  username?: string | null;
}): Promise<boolean> {
  const { contentType } = await resolveTelegramAvatarBytes({
    telegramId: opts.telegramId,
    photoUrl: opts.photoUrl,
    username: opts.username,
  });
  return !contentType.includes("svg");
}
