import { Bot, GrammyError, HttpError } from "grammy";
import { clearChatSession, handleFreeformMessage } from "./chat.js";
import { formatAccessStatus, upsertUser } from "../db/users.js";
import {
  startLiveWatchPoller,
  stopLiveFeed,
} from "../picks/live-watch.js";
import { runDailyDrop } from "../jobs/daily-drop.js";

let botInstance: Bot | null = null;

export function getBot(): Bot | null {
  return botInstance;
}

export async function startBot(): Promise<void> {
  try {
    await startBotPolling();
  } catch (err) {
    console.error("[bot] Failed to start — API still running:", err);
  }
}

async function startBotPolling(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN missing — bot not started.");
    return;
  }

  const bot = new Bot(token);
  botInstance = bot;

  bot.command("start", async (ctx) => {
    try {
      if (ctx.chat.type !== "private") return;
      if (ctx.from) clearChatSession(ctx.from.id);
      await ctx.reply("Hi, I’m Biggy. Ask me about scores, fixtures or football, or let’s research a parlay together. Use /newchat to start a fresh conversation. Times are shown in UTC on Telegram.");
    } catch (err) {
      console.error("[bot] /start failed:", err);
      await ctx.reply("Something went wrong. Try again in a moment.");
    }
  });

  bot.command("newchat", async (ctx) => {
    if (ctx.from) clearChatSession(ctx.from.id);
    await ctx.reply("New chat started. What would you like to explore?");
  });

  bot.command("status", async (ctx) => {
    if (!ctx.from) return;
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    await ctx.reply(user.subscribed_until ? `Telegram account: ${formatAccessStatus(user)}\nGoogle account plans are not yet linked to Telegram. Manage your web plan at https://biggy.cc/#subscription.` : "Telegram chat currently uses a separate free allowance. Google account plans are not yet linked to Telegram. Manage your web plan at https://biggy.cc/#subscription.");
  });

  bot.command("help", async (ctx) => {
    await ctx.reply("Ask me about live scores, fixtures, teams or football. Paid Telegram users can research a parlay and ask for changes. Use /newchat to start again. Telegram times are in UTC. Your Google plan and Telegram account are not yet linked.");
  });

  bot.command("stoplive", async (ctx) => {
    if (!ctx.from) return;
    const stopped = await stopLiveFeed(bot, ctx.from.id);
    await ctx.reply(stopped ? "Live feed stopped." : "No active live feed on your slip.");
  });

  bot.command("picks", async (ctx) => {
    await handleFreeformMessage(ctx, "Help me build a researched balanced parlay", bot);
  });

  bot.callbackQuery(/^tier:(hit|aim|go_big)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleFreeformMessage(ctx, `Help me build a researched ${ctx.match![1] === "hit" ? "safe" : ctx.match![1] === "aim" ? "balanced" : "go big"} parlay`, bot);
  });

  bot.on("inline_query", async (ctx) => {
    await ctx.answerInlineQuery([{ type: "article", id: "biggy-chat", title: "Chat with Biggy", description: "Ask Biggy about football or research a parlay together", input_message_content: { message_text: "Chat with Biggy about football: https://biggy.cc/" } }], { cache_time: 60 });
  });

  bot.callbackQuery(/^pay:(monthly|yearly)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Manage your subscription with your Google account at https://biggy.cc/#subscription. Google subscriptions are not yet linked to Telegram.");
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;
    try {
      await handleFreeformMessage(ctx, text, bot);
    } catch (err) {
      console.error("[bot] freeform message failed:", err);
      await ctx.reply("Something went wrong. Try /start or say start.");
    }
  });

  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Bot error for ${ctx.update.update_id}:`, err.error);
    if (err.error instanceof GrammyError) {
      console.error("Telegram API error:", err.error.description);
    } else if (err.error instanceof HttpError) {
      console.error("HTTP error:", err.error);
    }
  });

  console.log("Telegram bot polling…");
  startLiveWatchPoller(bot);

  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    console.warn("[bot] deleteWebhook failed:", err);
  }

  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.start();
      return;
    } catch (err) {
      const conflict = err instanceof GrammyError && err.error_code === 409;
      if (conflict) {
        const waitSec = Math.min(5 * attempt, 30);
        console.warn(
          `[bot] 409 conflict (another instance polling) — retry ${attempt}/${maxAttempts} in ${waitSec}s…`
        );
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      console.error("[bot] Polling stopped:", err);
      return;
    }
  }

  console.error("[bot] Could not acquire Telegram polling after retries");
}

export { runDailyDrop };
