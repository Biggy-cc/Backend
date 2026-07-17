import type { Bot } from "grammy";
import { broadcastToActiveUsers } from "../bot/broadcast.js";
import { DAILY_DROP_TEXT } from "../bot/keyboards.js";
import { enrichDailyCard } from "../picks/enrich.js";
import { todayPickDate } from "../picks/generate.js";
import {
  cardCoversAvailableOdds,
  fixturesWithLiveOdds,
  hasPublishedCard,
  publishDailyCard,
} from "../picks/publish.js";
import { postDailyFreePick } from "../social/posts.js";

/**
 * Republish when TxLINE posts odds for fixtures not yet on today's card.
 * Fixes semi-final gap: 8am rest-day → odds land at 2pm → no user message until manual tap.
 */
export async function runOddsWatcher(bot: Bot): Promise<void> {
  const pickDate = todayPickDate();
  const priced = await fixturesWithLiveOdds();

  if (!priced.length) {
    console.log("[odds-watch] No priced upcoming fixtures");
    return;
  }

  const hasCard = await hasPublishedCard(pickDate);
  const coversAll = hasCard && (await cardCoversAvailableOdds(pickDate));

  if (coversAll) {
    console.log("[odds-watch] Card already covers:", priced.join(", "));
    return;
  }

  console.log(
    `[odds-watch] Publishing — priced: ${priced.join(", ")} | had card: ${hasCard}`
  );

  const published = await publishDailyCard(pickDate, { force: true });
  if (!published) {
    console.warn("[odds-watch] Publish failed despite priced fixtures");
    return;
  }

  if (!published.updated && hasCard) return;

  void enrichDailyCard(pickDate).catch((err) =>
    console.error("[odds-watch] Background enrich failed:", err)
  );

  const count = await broadcastToActiveUsers(bot, DAILY_DROP_TEXT);
  console.log(`[odds-watch] Broadcast semi/card update to ${count} users (${priced.join(", ")})`);

  void postDailyFreePick(pickDate, bot).catch((err) =>
    console.error("[odds-watch] Social post failed:", err)
  );
}
