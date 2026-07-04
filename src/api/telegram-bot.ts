export type TelegramBotInfo = {
  id: number;
  username: string;
};

let cachedBotInfo: TelegramBotInfo | null | undefined;

export async function getTelegramBotInfo(): Promise<TelegramBotInfo | null> {
  if (cachedBotInfo !== undefined) return cachedBotInfo;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    cachedBotInfo = null;
    return null;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as {
      ok?: boolean;
      result?: { id?: number; username?: string };
    };

    if (data.ok && data.result?.id && data.result.username) {
      cachedBotInfo = { id: data.result.id, username: data.result.username };
      return cachedBotInfo;
    }

    cachedBotInfo = null;
    return null;
  } catch (err) {
    console.error("[api] getMe failed:", err);
    cachedBotInfo = null;
    return null;
  }
}
