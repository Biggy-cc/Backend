import type { Bot } from "grammy";
import { broadcastToActiveUsers } from "../bot/broadcast.js";
import { DAILY_DROP_TEXT } from "../bot/keyboards.js";
import { isApiFootballFreeQuotaMode } from "../api-football/config.js";
import { isApiFootballProviderPaused } from "../api-football/client.js";
import { getFootballDataProvider } from "../providers/football.js";
import { enrichDailyCard } from "../picks/enrich.js";
import { todayPickDate } from "../picks/generate.js";
import { refreshStoredOdds } from "../picks/odds-refresh.js";
import {
  hasPublishedCard,
  publishDailyCard,
} from "../picks/publish.js";
import { postDailyFreePick, postPickUpdate } from "../social/posts.js";

/** Prevent overlapping cron publishes from stacking and wedging the process. */
let oddsWatchRunning = false;

/**
 * Keep today's saved card fresh.
 *
 * Preferred path (cheap + correct): re-price legs already on the D1 card,
 * save a new version only when lines move. Users always read from D1.
 *
 * Fallback: first publish / carry-forward if there is no card yet.
 */
export async function runOddsWatcher(bot: Bot): Promise<void> {
  if (oddsWatchRunning) {
    console.log("[odds-watch] Already running — skip overlapping tick");
    return;
  }
  oddsWatchRunning = true;

  const work = runOddsWatcherInner(bot).finally(() => {
    oddsWatchRunning = false;
  });

  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(true), 90_000)
    ),
  ]);

  if (timedOut) {
    console.error(
      "[odds-watch] Tick still running after 90s — next cron will skip until it finishes"
    );
  }
}

async function runOddsWatcherInner(bot: Bot): Promise<void> {
  const pickDate = todayPickDate();
  const hasCard = await hasPublishedCard(pickDate);
  const freeApiFootball =
    getFootballDataProvider() === "api-football" && isApiFootballFreeQuotaMode();

  if (hasCard) {
    if (freeApiFootball && isApiFootballProviderPaused()) {
      console.log("[odds-watch] Skipping refresh — API-Football provider paused");
      return;
    }
    const refreshed = await refreshStoredOdds(pickDate, { force: true });
    if (!refreshed) {
      console.log("[odds-watch] Card present — no refresh result");
      return;
    }
    if (!refreshed.updated) {
      console.log(`[odds-watch] Card v${refreshed.version} still current`);
      return;
    }

    console.log(
      `[odds-watch] Saved line moves → v${refreshed.version}: ${refreshed.changeNote}`
    );

    const notice = `📋 <b>Updated (v${refreshed.version})</b>\n\n${refreshed.changeNote ?? "Lines moved on today's card."}\n\nTap a tier for the latest slip:`;
    const count = await broadcastToActiveUsers(bot, notice, { parseMode: "HTML" });
    console.log(`[odds-watch] Broadcast price update to ${count} users`);

    if (refreshed.changeNote) {
      void postPickUpdate(pickDate, refreshed.version, refreshed.changeNote, bot).catch(
        (err) => console.error("[odds-watch] Social update failed:", err)
      );
    }
    return;
  }

  if (freeApiFootball && isApiFootballProviderPaused()) {
    console.log(
      `[odds-watch] No card for ${pickDate} — skipping publish (API-Football quota paused)`
    );
    return;
  }

  console.log(
    `[odds-watch] No card for ${pickDate} — publishing${freeApiFootball ? " (free-quota)" : ""}`
  );

  const published = await publishDailyCard(pickDate);
  if (!published) {
    console.log("[odds-watch] Publish unavailable");
    return;
  }

  void enrichDailyCard(pickDate).catch((err) =>
    console.error("[odds-watch] Background enrich failed:", err)
  );

  const count = await broadcastToActiveUsers(bot, DAILY_DROP_TEXT);
  console.log(`[odds-watch] Broadcast new card to ${count} users`);

  void postDailyFreePick(pickDate, bot).catch((err) =>
    console.error("[odds-watch] Social post failed:", err)
  );
}
