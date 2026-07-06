import "dotenv/config";
import { Bot } from "grammy";
import { runMigrations } from "../src/db/client.js";
import { todayPickDate } from "../src/picks/generate.js";
import { loadStoredBatch } from "../src/picks/store.js";
import { formatDailyFreePick } from "../src/social/copy.js";
import { isSocialAutoMode, sendManualSocialDraft, socialNotifyTelegramId } from "../src/social/notify.js";
import { postDailyFreePick, selectDailyFreeLeg } from "../src/social/posts.js";

async function main() {
  const force = process.argv.includes("--force");

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN missing");
    process.exit(1);
  }

  const notifyId = socialNotifyTelegramId();
  if (!notifyId) {
    console.error("SOCIAL_NOTIFY_TELEGRAM_ID not set (or 0)");
    process.exit(1);
  }

  await runMigrations();

  const mode = isSocialAutoMode() ? "auto/X" : "manual/Telegram";
  const pickDate = todayPickDate();
  const bot = new Bot(token);

  if (force) {
    const batch = await loadStoredBatch(pickDate);
    const leg = batch ? selectDailyFreeLeg(batch.picks) : null;
    if (!leg) {
      console.error("No Hit leg for today");
      process.exit(1);
    }
    console.log(`Sending draft (${mode}, force) to ${notifyId}…`);
    console.log("\n---\n" + formatDailyFreePick(leg) + "\n---\n");
    const ok = await sendManualSocialDraft(bot, "daily_free", formatDailyFreePick(leg));
    console.log(ok ? "Draft sent." : "Send failed.");
    return;
  }

  console.log(`Sending daily draft (${mode}) to ${notifyId}…`);
  const ok = await postDailyFreePick(pickDate, bot);
  console.log(ok ? "Draft sent." : "Nothing sent (no picks today or already sent). Use --force to resend.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
