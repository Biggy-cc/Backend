import cron from "node-cron";
import { getBot } from "../bot/index.js";
import { runDailyDrop, runRefreshPicks } from "./daily-drop.js";

export function startScheduler() {
  const dailySchedule = process.env.DAILY_CRON ?? "0 8 * * *";
  const refreshSchedule = process.env.PICKS_REFRESH_CRON ?? "0 12,18 * * *";

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

  console.log(`Scheduler: daily ${dailySchedule} UTC, refresh ${refreshSchedule} UTC`);
}
