import { getBot } from "../bot/index.js";
import { checkPendingPayments } from "./usdc.js";
import { DAILY_DROP_TEXT, dailyMenuKeyboard } from "../bot/keyboards.js";
import { getCachedPick, todayPickDate } from "../picks/generate.js";
import { PICK_PARSE_MODE } from "../picks/types.js";

export function startPaymentPoller() {
  const receiver = process.env.USDC_RECEIVER_WALLET;
  if (!receiver) {
    console.warn("USDC_RECEIVER_WALLET missing — payment poller not started.");
    return;
  }

  const tick = async () => {
    try {
      const bot = getBot();
      if (!bot) return;

      await checkPendingPayments(async (telegramId) => {
        await bot.api.sendMessage(
          telegramId,
          "✅ Payment verified! Welcome to Biggy Premium."
        );

        const hit = await getCachedPick(todayPickDate(), "hit");
        if (hit) {
          await bot.api.sendMessage(telegramId, hit, { parse_mode: PICK_PARSE_MODE });
        } else {
          await bot.api.sendMessage(telegramId, DAILY_DROP_TEXT, {
            reply_markup: dailyMenuKeyboard(),
          });
        }
      });
    } catch (err) {
      console.warn("[payments] Poller tick failed:", err);
    }
  };

  setInterval(tick, 30_000);
  console.log("Payment poller running (30s interval)");
}
