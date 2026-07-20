import { getBot } from "../bot/index.js";
import { paymentVerifiedMessage } from "../db/users.js";
import { checkPendingPayments } from "./usdc.js";
import { notifyNewSubscription } from "./subscription-notify.js";
import { DAILY_DROP_TEXT, dailyMenuKeyboard } from "../bot/keyboards.js";
import { getCachedPick, todayPickDate } from "../picks/generate.js";
import { PICK_PARSE_MODE } from "../picks/types.js";

const BASE_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 15 * 60_000;

function isSolanaRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|Too many requests/i.test(msg);
}

export function startPaymentPoller() {
  const receiver = process.env.USDC_RECEIVER_WALLET;
  if (!receiver) {
    console.warn("USDC_RECEIVER_WALLET missing — payment poller not started.");
    return;
  }

  let intervalMs = BASE_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), intervalMs);
  };

  const tick = async () => {
    if (inFlight) {
      schedule();
      return;
    }
    inFlight = true;
    try {
      const bot = getBot();
      if (!bot) {
        schedule();
        return;
      }

      await checkPendingPayments(async (payment) => {
        const { telegramId } = payment;

        await bot.api.sendMessage(
          telegramId,
          paymentVerifiedMessage(payment.renewsUntil)
        );

        await notifyNewSubscription(bot.api, payment);

        const hit = await getCachedPick(todayPickDate(), "hit");
        if (hit) {
          await bot.api.sendMessage(telegramId, hit, { parse_mode: PICK_PARSE_MODE });
        } else {
          await bot.api.sendMessage(telegramId, DAILY_DROP_TEXT, {
            reply_markup: dailyMenuKeyboard(),
          });
        }
      });

      // Success — ease back toward the normal cadence.
      intervalMs = BASE_INTERVAL_MS;
    } catch (err) {
      if (isSolanaRateLimit(err)) {
        intervalMs = Math.min(Math.max(intervalMs * 2, 60_000), MAX_INTERVAL_MS);
        console.warn(
          `[payments] Solana RPC rate-limited — backing off to ${Math.round(intervalMs / 1000)}s`
        );
      } else {
        console.warn("[payments] Poller tick failed:", err);
      }
    } finally {
      inFlight = false;
      schedule();
    }
  };

  void tick();
  console.log(`Payment poller running (adaptive ${BASE_INTERVAL_MS / 1000}s–${MAX_INTERVAL_MS / 1000}s)`);
}
