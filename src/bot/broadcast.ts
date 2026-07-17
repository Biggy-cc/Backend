import type { Bot } from "grammy";
import { dailyMenuKeyboard } from "./keyboards.js";
import { listActiveUserIds } from "../db/users.js";

export async function broadcastToActiveUsers(
  bot: Bot,
  text: string,
  options: { parseMode?: "HTML" } = {}
): Promise<number> {
  const userIds = await listActiveUserIds();
  for (const telegramId of userIds) {
    try {
      await bot.api.sendMessage(telegramId, text, {
        parse_mode: options.parseMode,
        reply_markup: dailyMenuKeyboard(),
      });
    } catch (err) {
      console.warn(`[broadcast] Could not message ${telegramId}:`, err);
    }
  }
  return userIds.length;
}
