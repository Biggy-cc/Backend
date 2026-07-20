import { Bot, GrammyError, HttpError } from "grammy";
import {
  DAILY_DROP_TEXT,
  dailyMenuKeyboard,
  paymentLinkKeyboard,
  paymentWebKeyboard,
  slipActionKeyboard,
  SUBSCRIBE_OFFER_TEXT,
} from "./keyboards.js";
import { replyIfPaywalled } from "./subscribe-offer.js";
import { replyWithPickSlip } from "./tier-media.js";
import { handleStart } from "./onboarding.js";
import { handleFreeformMessage } from "./chat.js";
import { BIGGY_HELP } from "./copy.js";
import {
  formatAccessStatus,
  recordTrialPickView,
  upsertUser,
} from "../db/users.js";
import { isPickContentStale, picksStaleDueToKickoff, upcomingBettableSummary } from "../picks/kickoff.js";
import {
  buildLivePitchBlock,
} from "../picks/live-tracker.js";
import {
  clearLiveFeedForUser,
  registerPendingLiveWatch,
  resumeLiveFeed,
  startLiveWatchPoller,
  stopLiveFeed,
} from "../picks/live-watch.js";
import {
  getCachedPick,
  todayPickDate,
} from "../picks/generate.js";
import {
  PICK_PARSE_MODE,
  TIER_LABELS,
  formatShareText,
  parseShareTier,
} from "../picks/types.js";
import type { PickTier } from "../picks/types.js";
import { createPaymentLink } from "../payments/usdc.js";
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
      await handleStart(ctx);
    } catch (err) {
      console.error("[bot] /start failed:", err);
      await ctx.reply("Something went wrong. Try again in a moment.");
    }
  });

  bot.command("status", async (ctx) => {
    if (!ctx.from) return;
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    await ctx.reply(formatAccessStatus(user));
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(BIGGY_HELP);
  });

  bot.command("stoplive", async (ctx) => {
    if (!ctx.from) return;
    const stopped = await stopLiveFeed(bot, ctx.from.id);
    await ctx.reply(stopped ? "Live feed stopped." : "No active live feed on your slip.");
  });

  bot.command("picks", async (ctx) => {
    if (!ctx.from) return;
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    if (await replyIfPaywalled(ctx, user)) return;
    await ctx.reply(DAILY_DROP_TEXT, { reply_markup: dailyMenuKeyboard() });
  });

  bot.callbackQuery(/^tier:(hit|aim|go_big)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const tier = ctx.match![1] as PickTier;
    const user = await upsertUser(ctx.from!.id, ctx.from!.username);

    if (await replyIfPaywalled(ctx, user)) return;

    const pickDate = todayPickDate();
    const content = await getCachedPick(pickDate, tier);

    if (!content) {
      const next = await upcomingBettableSummary(3);
      await ctx.reply(
        `No card in the system yet for today. Next fixtures: ${next}. The morning drop (8:00 UTC) publishes automatically when priced lines are on the feed.`
      );
      return;
    }

    if (await isPickContentStale(content)) {
      const next = await upcomingBettableSummary(3);
      await ctx.reply(
        `This slip covers fixtures that already kicked off. Next up: ${next}. The noon refresh will republish.`
      );
      return;
    }

    await clearLiveFeedForUser(bot, ctx.from!.id);

    await replyWithPickSlip(ctx, tier, content, slipActionKeyboard(tier));

    try {
      if (ctx.from && ctx.chat) {
        const block = await buildLivePitchBlock(pickDate, tier, { tier });
        if (block?.legs.length) {
          registerPendingLiveWatch({
            telegramId: ctx.from.id,
            chatId: ctx.chat.id,
            tier,
            pickDate,
            legs: block.legs,
          });
        }
      }
    } catch (err) {
      console.error("[bot] Live feed watch failed:", err);
    }

    await recordTrialPickView(ctx.from!.id);
  });

  bot.on("inline_query", async (ctx) => {
    const tier = parseShareTier(ctx.inlineQuery.query);
    const date = todayPickDate();

    if (!tier) {
      await ctx.answerInlineQuery(
        [
          {
            type: "article",
            id: "biggy-help",
            title: "Biggy daily football picks",
            description: "Share a football tier: hit, aim, or go_big",
            input_message_content: {
              message_text:
                "⚽ Get today's football picks from Biggy:\nt.me/BiggyCCBot",
            },
          },
        ],
        { cache_time: 60 }
      );
      return;
    }

    const content = await getCachedPick(date, tier);
    if (!content) {
      await ctx.answerInlineQuery(
        [
          {
            type: "article",
            id: `empty-${tier}`,
            title: "Football picks not ready yet",
            description: "Check back after the morning drop",
            input_message_content: {
              message_text:
                "Today's Biggy football slip isn't ready yet.\n\nGet picks when they drop: t.me/BiggyCCBot",
            },
          },
        ],
        { cache_time: 30 }
      );
      return;
    }

    const shareText = formatShareText(content);
    const tierName = TIER_LABELS[tier].replace(/[^\p{L}\p{N}\s]/gu, "").trim();

    await ctx.answerInlineQuery(
      [
        {
          type: "article",
          id: `${date}-${tier}`,
          title: `Biggy ${tierName}. Today's football slip`,
          description: shareText.slice(0, 200),
          input_message_content: { message_text: shareText },
        },
      ],
      { cache_time: 300, is_personal: false }
    );
  });

  bot.callbackQuery(/^pay:(monthly|yearly)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const plan = ctx.match![1] as "monthly" | "yearly";
    await upsertUser(ctx.from!.id, ctx.from!.username, ctx.from!.first_name);
    const { phantomUrl, solflareUrl, paymentId, amount } = await createPaymentLink(
      ctx.from!.id,
      plan
    );

    const webBase = process.env.PAYMENT_WEB_URL?.trim().replace(/\/$/, "");
    if (webBase) {
      await ctx.reply(`Pay $${amount} USDC for Biggy Premium ↗`, {
        reply_markup: paymentWebKeyboard(`${webBase}?id=${encodeURIComponent(paymentId)}`),
      });
      return;
    }

    await ctx.reply(SUBSCRIBE_OFFER_TEXT, {
      reply_markup: paymentLinkKeyboard(phantomUrl, solflareUrl),
    });
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
  const { startPaymentPoller } = await import("../payments/poller.js");
  startPaymentPoller();
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
