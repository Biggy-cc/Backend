import cron from "node-cron";
import { getBot } from "../bot/index.js";
import { runDailyDrop, runRefreshPicks } from "./daily-drop.js";
import { postNewWins } from "../social/posts.js";

export function startScheduler() {
  const dailySchedule = process.env.DAILY_CRON ?? "0 8 * * *";
  const refreshSchedule = process.env.PICKS_REFRESH_CRON ?? "0 12,18 * * *";
  const winCheckSchedule = process.env.SOCIAL_WIN_CRON ?? "*/30 14-23 * * *";

  cron.schedule(dailySchedule, async () => {
    const bot = getBot();
    if (!bot) {
      console.warn("[cron] Bot not ready — skipping daily drop");
      return;
    }
    await runDailyDrop(bot);
  });

  cron.schedule(refreshSchedule, async () => {
    const bot = getBot();
    if (!bot) {
      console.warn("[refresh] Bot not ready — skipping pick refresh");
      return;
    }
    await runRefreshPicks(bot);
  });

  cron.schedule(winCheckSchedule, async () => {
    const bot = getBot();
    if (!bot) {
      console.warn("[social] Bot not ready — skipping win check");
      return;
    }
    try {
      await postNewWins(bot);
    } catch (err) {
      console.error("[social] Win check failed:", err);
    }
  });

  const socialMode = process.env.SOCIAL_MODE?.trim().toLowerCase() === "auto" ? "auto/X" : "manual/Telegram";
  console.log(
    `Scheduler: daily ${dailySchedule} UTC, refresh ${refreshSchedule} UTC, social wins ${winCheckSchedule} UTC (${socialMode})`
  );
}
