import cron from "node-cron";
import { getBot } from "../bot/index.js";
import { runDailyDrop, runRefreshPicks } from "./daily-drop.js";
import { runNewsBroadcast } from "./news-broadcast.js";
import { runOddsWatcher } from "./odds-watcher.js";
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

  const oddsWatchSchedule = process.env.ODDS_WATCH_CRON ?? "*/30 * * * *";
  cron.schedule(oddsWatchSchedule, async () => {
    const bot = getBot();
    if (!bot) {
      console.warn("[odds-watch] Bot not ready — skipping");
      return;
    }
    try {
      await runOddsWatcher(bot);
    } catch (err) {
      console.error("[odds-watch] Failed:", err);
    }
  });

  const newsSchedule = process.env.NEWS_CRON ?? "0 7,11,15,19 * * *";
  cron.schedule(newsSchedule, async () => {
    const bot = getBot();
    if (!bot) {
      console.warn("[news] Bot not ready — skipping");
      return;
    }
    try {
      await runNewsBroadcast(bot);
    } catch (err) {
      console.error("[news] Failed:", err);
    }
  });

  const socialMode = process.env.SOCIAL_MODE?.trim().toLowerCase() === "auto" ? "auto/X" : "manual/Telegram";
  console.log(
    `Scheduler: daily ${dailySchedule} UTC, refresh ${refreshSchedule} UTC, odds-watch ${oddsWatchSchedule} UTC, news ${newsSchedule} UTC, social wins ${winCheckSchedule} UTC (${socialMode})`
  );
}
