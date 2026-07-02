import { Bot, GrammyError, HttpError } from "grammy";
import {
  DAILY_DROP_TEXT,
  PAYWALL_TEXT,
  SUBSCRIBE_OFFER_TEXT,
  dailyMenuKeyboard,
  paymentLinkKeyboard,
  paymentWebKeyboard,
  paywallKeyboard,
  shareKeyboard,
} from "./keyboards.js";
import {
  formatAccessStatus,
  hasAccess,
  isSubscribed,
  recordTrialPickView,
  upsertUser,
} from "../db/users.js";
import { isPickContentStale, picksStaleDueToKickoff, upcomingBettableSummary } from "../picks/kickoff.js";
import {
  generateDailyPicks,
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
import { runMigrations } from "../db/client.js";
import { runDailyDrop } from "../jobs/daily-drop.js";

let botInstance: Bot | null = null;

export function getBot(): Bot | null {
  return botInstance;
}

export async function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN missing — bot not started.");
    return;
  }

  await runMigrations();
  const bot = new Bot(token);
  botInstance = bot;

  bot.command("start", async (ctx) => {
    if (!ctx.from) return;
    try {
      const user = await upsertUser(ctx.from.id, ctx.from.username);
      await ctx.reply(
        `⚽ Welcome to Biggy!\n\nI scan live World Cup lines and today's news, then build the smartest combinations for your odds goal — so you bet on data, not emotion.\n\nYour free trial includes 2 pick slips.\n\n${formatAccessStatus(user)}\n\nTap /help anytime.`
      );

      if (hasAccess(user)) {
        await ctx.reply(DAILY_DROP_TEXT, { reply_markup: dailyMenuKeyboard() });
        if (!isSubscribed(user)) {
          await ctx.reply(SUBSCRIBE_OFFER_TEXT, { reply_markup: paywallKeyboard() });
        }
      } else {
        await ctx.reply(PAYWALL_TEXT, { reply_markup: paywallKeyboard() });
      }
    } catch (err) {
      console.error("[bot] /start failed:", err);
      await ctx.reply("Something went wrong — try again in a moment.");
    }
  });

  bot.command("status", async (ctx) => {
    if (!ctx.from) return;
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    await ctx.reply(formatAccessStatus(user));
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Commands:\n/start — begin your free trial\n/status — trial or subscription status\n/help — this message\n\nEach morning I'll drop Hit, Aim, and Go Big tiers. Tap a button to get your slip."
    );
  });

  bot.command("picks", async (ctx) => {
    if (!ctx.from) return;
    const user = await upsertUser(ctx.from.id, ctx.from.username);
    if (!hasAccess(user)) {
      await ctx.reply(PAYWALL_TEXT, { reply_markup: paywallKeyboard() });
      return;
    }
    await ctx.reply(DAILY_DROP_TEXT, { reply_markup: dailyMenuKeyboard() });
  });

  bot.callbackQuery(/^tier:(hit|aim|go_big)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const tier = ctx.match![1] as PickTier;
    const user = await upsertUser(ctx.from!.id, ctx.from!.username);

    if (!hasAccess(user)) {
      await ctx.reply(PAYWALL_TEXT, { reply_markup: paywallKeyboard() });
      return;
    }

    const pickDate = todayPickDate();
    let content = await getCachedPick(pickDate, tier);

    if (content && (await isPickContentStale(content))) {
      const next = await upcomingBettableSummary(3);
      await ctx.reply(
        `This slip is from matches that already kicked off. Next games: ${next}. The scheduled refresh will update the card — try again shortly.`
      );
      return;
    }

    if (!content) {
      await ctx.reply("No card cached yet — building from live lines (about a minute)…");
      try {
        await generateDailyPicks(pickDate);
        content = await getCachedPick(pickDate, tier);
      } catch (err) {
        console.error("[bot] On-demand pick generation failed:", err);
      }
    }

    if (!content) {
      await ctx.reply(
        "I couldn't build today's card yet (usually the 8:00 UTC morning drop, or live data/API limits). There are upcoming games today — try again in a few minutes or tap /picks."
      );
      return;
    }

    await ctx.reply(content, {
      parse_mode: PICK_PARSE_MODE,
      reply_markup: shareKeyboard(tier),
    });

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
            title: "Biggy — daily World Cup picks",
            description: "Share a tier: hit, aim, or go_big",
            input_message_content: {
              message_text:
                "⚽ Get today's data-driven World Cup picks from Biggy:\nt.me/BiggyCCBot",
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
            title: "Picks not ready yet",
            description: "Check back after the morning drop",
            input_message_content: {
              message_text:
                "Today's Biggy slip isn't ready yet.\n\nGet picks when they drop: t.me/BiggyCCBot",
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
          title: `Biggy ${tierName} — today's slip`,
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
    const { amount, url, phantomUrl, solflareUrl, paymentId } = await createPaymentLink(
      ctx.from!.id,
      plan
    );

    const webBase = process.env.PAYMENT_WEB_URL?.trim().replace(/\/$/, "");
    if (webBase) {
      const checkoutUrl = `${webBase}?id=${paymentId}`;
      await ctx.reply(
        `⚡ Pay <b>${amount} USDC</b> to unlock Biggy Premium.\n\n` +
          `Tap the button below — opens our secure checkout page in your browser (works on phone and desktop).\n\n` +
          `I'll unlock you automatically within ~30 seconds after payment.`,
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: paymentWebKeyboard(checkoutUrl),
        }
      );
      return;
    }

    const safeUrl = url.replace(/&/g, "&amp;");

    await ctx.reply(
      `⚡ Pay <b>${amount} USDC</b> to unlock Biggy Premium.\n\n` +
        `<b>Best on phone</b> (Phantom or Solflare installed):\n` +
        `1. Tap a wallet button below\n` +
        `2. Confirm the transfer in your wallet app\n\n` +
        `If a button opens a website instead of your wallet, tap this link:\n` +
        `<a href="${safeUrl}">👉 Open payment in wallet</a>\n\n` +
        `Still stuck? Tap ⋮ on the page → <b>Open in browser</b> — that usually launches Phantom.\n` +
        `Desktop Telegram can't open wallet apps — use your phone.\n` +
        `I'll unlock you automatically within ~30 seconds after payment.`,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: paymentLinkKeyboard(phantomUrl, solflareUrl),
      }
    );
  });

  bot.on("message:text", async (ctx) => {
    if (!ctx.from) return;
    const text = ctx.message.text.toLowerCase();
    if (text.startsWith("/")) return;

    if (["hi", "hello", "hey", "help me"].some((w) => text.includes(w))) {
      await ctx.reply(
        "Hey! I'm Biggy ⚽\n\nUse /picks to see today's tiers, or /status to check your trial.\n\nEach morning I send Hit, Aim, and Go Big combinations built from live lines + news."
      );
      return;
    }

    if (text.includes("trial") || text.includes("status") || text.includes("subscri")) {
      const user = await upsertUser(ctx.from.id, ctx.from.username);
      await ctx.reply(formatAccessStatus(user));
      return;
    }

    if (text.includes("pick") || text.includes("slip") || text.includes("odds")) {
      const user = await upsertUser(ctx.from.id, ctx.from.username);
      if (!hasAccess(user)) {
        await ctx.reply(PAYWALL_TEXT, { reply_markup: paywallKeyboard() });
        return;
      }
      await ctx.reply(DAILY_DROP_TEXT, { reply_markup: dailyMenuKeyboard() });
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
  await bot.start();

  return bot;
}

export { runDailyDrop };
