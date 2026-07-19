import type { Bot } from "grammy";
import { enrichDailyCard } from "../picks/enrich.js";
import { publishDailyCard } from "../picks/publish.js";
import { todayPickDate } from "../picks/generate.js";
import { picksStaleDueToKickoff, upcomingBettableSummary } from "../picks/kickoff.js";
import { loadStoredBatch } from "../picks/store.js";
import { refreshStoredOdds } from "../picks/odds-refresh.js";
import { DAILY_DROP_TEXT } from "../bot/keyboards.js";
import { broadcastToActiveUsers } from "../bot/broadcast.js";
import { postDailyFreePick, postPickUpdate, postNewWins } from "../social/posts.js";

async function restDayNotice(): Promise<string> {
  const next = await upcomingBettableSummary(3);
  return `⚽ <b>Lines aren't on the feed yet</b>

There's a World Cup kickoff coming up, but TxLINE hasn't posted (or has pulled) priced markets for today's card.

Next up: ${next}.

We'll message you as soon as a slip is ready.`;
}

export async function runRefreshPicks(bot: Bot) {
  const pickDate = todayPickDate();
  console.log(`[refresh] Checking picks for ${pickDate}…`);

  const hadBatchBefore = await loadStoredBatch(pickDate);
  if (!hadBatchBefore) {
    const published = await publishDailyCard(pickDate);
    if (published) {
      console.log(`[refresh] Published first card for ${pickDate}`);
      void enrichDailyCard(pickDate).catch((err) =>
        console.error("[refresh] Background enrich failed:", err)
      );
      await broadcastToActiveUsers(bot, DAILY_DROP_TEXT);
      return;
    }
  }

  try {
    const kickoffStale = await picksStaleDueToKickoff(pickDate);
    let result;

    if (kickoffStale) {
      result = await publishDailyCard(pickDate, { force: true });
      if (result) {
        void enrichDailyCard(pickDate).catch((err) =>
          console.error("[refresh] Background enrich failed:", err)
        );
      }
    } else {
      result = (await refreshStoredOdds(pickDate)) ?? undefined;
    }

    if (!result?.updated || ((result.version ?? 0) <= 1 && hadBatchBefore)) {
      console.log("[refresh] No update needed");
      return;
    }

    if (await picksStaleDueToKickoff(pickDate)) {
      console.warn("[refresh] Picks still not servable — skipping user broadcast");
      return;
    }

    const notice =
      result.refreshKind === "odds"
        ? `📋 <b>Updated (v${result.version})</b>\n\n${result.changeNote ?? "Lines moved on today's card."}\n\nTap a tier for the latest slip:`
        : kickoffStale
          ? `⏱️ <b>Fixtures kicked off. Fresh football card (v${result.version})</b>\n\n${result.changeNote ?? "Picks updated with the next upcoming matches."}\n\nTap a tier for the latest slip:`
          : `📋 <b>Biggy football update (v${result.version})</b>\n\n${result.changeNote ?? "Today's football picks are refreshed."}\n\nTap a tier for the latest slip:`;

    const count = await broadcastToActiveUsers(bot, notice, { parseMode: "HTML" });
    console.log(`[refresh] Broadcasting v${result.version} to ${count} users`);

    if (result.changeNote) {
      void postPickUpdate(pickDate, result.version, result.changeNote, bot).catch((err) =>
        console.error("[social] Update post failed:", err)
      );
    }
  } catch (err) {
    console.error("[refresh] Failed:", err);
  }
}

export async function runDailyDrop(bot: Bot) {
  const pickDate = todayPickDate();
  console.log(`[cron] Publishing picks for ${pickDate}…`);

  const published = await publishDailyCard(pickDate);
  if (!published) {
    const notice = await restDayNotice();
    const count = await broadcastToActiveUsers(bot, notice, { parseMode: "HTML" });
    console.log(`[cron] Rest-day notice sent to ${count} users`);
    return;
  }

  if (published.updated) {
    void enrichDailyCard(pickDate).catch((err) =>
      console.error("[cron] Background enrich failed:", err)
    );
  }

  const count = await broadcastToActiveUsers(bot, DAILY_DROP_TEXT);
  console.log(`[cron] Broadcasting to ${count} users`);

  void postDailyFreePick(pickDate, bot).catch((err) =>
    console.error("[social] Daily free pick post failed:", err)
  );
}
