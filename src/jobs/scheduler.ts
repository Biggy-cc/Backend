import cron from "node-cron";
import { getBot } from "../bot/index.js";
import { isApiFootballFreeQuotaMode } from "../api-football/config.js";
import { getFootballDataProvider } from "../providers/football.js";
import { runDailyDrop, runRefreshPicks } from "./daily-drop.js";
import { runNewsBroadcast } from "./news-broadcast.js";
import { runOddsWatcher } from "./odds-watcher.js";
import { postNewWins } from "../social/posts.js";

export function startScheduler() {
  const dailySchedule = process.env.DAILY_CRON ?? "0 8 * * *";
  const freeApiFootball =
    getFootballDataProvider() === "api-football" && isApiFootballFreeQuotaMode();

  // Free API-Football: one midday refresh max (not noon+6pm)
  const refreshSchedule =
    process.env.PICKS_REFRESH_CRON ??
    (freeApiFootball ? "0 14 * * *" : "0 12,18 * * *");
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

  // Free API-Football: ~8 watches/day (fresh enough, ~2–4 odds calls each when card exists)
  // Paid / TxLINE: every 30m unless overridden
  const oddsWatchSchedule =
    process.env.ODDS_WATCH_CRON?.trim() === "off"
      ? null
      : process.env.ODDS_WATCH_CRON?.trim() ||
        (freeApiFootball ? "0 7,9,11,13,15,17,19,21 * * *" : "*/30 * * * *");

  if (oddsWatchSchedule) {
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
  }

  // Free: one news digests/day (RSS is free; fixture list is cached)
  const newsSchedule =
    process.env.NEWS_CRON ?? (freeApiFootball ? "0 9 * * *" : "0 7,11,15,19 * * *");
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

  const socialMode =
    process.env.SOCIAL_MODE?.trim().toLowerCase() === "auto" ? "auto/X" : "manual/Telegram";
  console.log(
    `Scheduler: daily ${dailySchedule} UTC, refresh ${refreshSchedule} UTC, odds-watch ${oddsWatchSchedule ?? "off"} UTC, news ${newsSchedule} UTC, social wins ${winCheckSchedule} UTC (${socialMode})${freeApiFootball ? " [api-football free-quota mode]" : ""}`
  );
}
