import type { Bot } from "grammy";
import { dailyMenuKeyboard } from "./keyboards.js";
import { listActiveUserIds } from "../db/users.js";

/** Users who blocked the bot — skip for this process lifetime. */
const broadcastBlocked = new Set<number>();

function isBlockedError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message} ${JSON.stringify(err)}`
      : String(err);
  return (
    /bot was blocked|user is deactivated|chat not found|Forbidden: bots can't send/i.test(
      msg
    ) || (err as { error_code?: number })?.error_code === 403
  );
}

export async function broadcastToActiveUsers(
  bot: Bot,
  text: string,
  options: { parseMode?: "HTML" } = {}
): Promise<number> {
  const userIds = (await listActiveUserIds()).filter(
    (id) => !broadcastBlocked.has(id)
  );
  let sent = 0;
  for (const telegramId of userIds) {
    try {
      await bot.api.sendMessage(telegramId, text, {
        parse_mode: options.parseMode,
        reply_markup: dailyMenuKeyboard(),
      });
      sent += 1;
    } catch (err) {
      if (isBlockedError(err)) {
        broadcastBlocked.add(telegramId);
        console.warn(
          `[broadcast] Skipping ${telegramId} going forward (blocked/forbidden)`
        );
      } else {
        console.warn(`[broadcast] Could not message ${telegramId}:`, err);
      }
    }
  }
  return sent;
}
