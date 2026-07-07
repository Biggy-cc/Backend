import type { Bot } from "grammy";
import { tryCarryForwardPicks, tryPrunedCarryForward } from "../picks/carry-forward.js";
import { generateDailyPicks, todayPickDate } from "../picks/generate.js";
import { tryQuickOddsCard } from "../picks/quick-odds.js";
import { picksStaleDueToKickoff, upcomingBettableSummary } from "../picks/kickoff.js";
import { loadStoredBatch } from "../picks/store.js";
import { refreshStoredOdds } from "../picks/odds-refresh.js";
import { DAILY_DROP_TEXT, dailyMenuKeyboard } from "../bot/keyboards.js";
import { listActiveUserIds } from "../db/users.js";
import { postDailyFreePick, postPickUpdate, postNewWins } from "../social/posts.js";

function isNoFixturesError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("No upcoming fixtures") ||
    msg.includes("Not enough odds") ||
    msg.includes("no bundle produced")
  );
}

async function broadcastToActiveUsers(
  bot: Bot,
  text: string,
  options: { parseMode?: "HTML" } = {}
): Promise<number> {
  const userIds = await listActiveUserIds();
  for (const telegramId of userIds) {
    try {
      await bot.api.sendMessage(telegramId, text, {
        parse_mode: options.parseMode,
        reply_markup: dailyMenuKeyboard(),
      });
    } catch (err) {
      console.warn(`[cron] Could not message ${telegramId}:`, err);
    }
  }
  return userIds.length;
}

async function restDayNotice(): Promise<string> {
  const next = await upcomingBettableSummary(3);
  return `⚽ <b>No matches on today's card</b>

Nothing to price in the current World Cup window.

Next up: ${next}.

We'll message you when the next slip is ready.`;
}

export async function runRefreshPicks(bot: Bot) {
  const pickDate = todayPickDate();
  console.log(`[refresh] Checking picks for ${pickDate}…`);

  const hadBatchBefore = await loadStoredBatch(pickDate);
  if (!hadBatchBefore) {
    for (const attempt of [tryCarryForwardPicks, tryPrunedCarryForward, tryQuickOddsCard]) {
      const carried = await attempt(pickDate);
      if (carried) {
        console.log(`[refresh] First card for ${pickDate} via ${attempt.name}`);
        const userIds = await listActiveUserIds();
        for (const telegramId of userIds) {
          try {
            await bot.api.sendMessage(telegramId, DAILY_DROP_TEXT, {
              reply_markup: dailyMenuKeyboard(),
            });
          } catch (err) {
            console.warn(`[refresh] Could not notify ${telegramId}:`, err);
          }
        }
        return;
      }
    }
  }

  try {
    const kickoffStale = await picksStaleDueToKickoff(pickDate);
    let result;

    if (kickoffStale) {
      result = await generateDailyPicks(pickDate, { kickoffRefresh: true });
    } else {
      const oddsRefresh = await refreshStoredOdds(pickDate);
      if (oddsRefresh?.updated) {
        result = oddsRefresh;
      } else {
        result = await generateDailyPicks(pickDate, { onlyIfChanged: true });
      }
    }

    if (!result.updated || (result.version <= 1 && hadBatchBefore)) {
      console.log("[refresh] No update needed");
      return;
    }

    if (await picksStaleDueToKickoff(pickDate)) {
      console.warn("[refresh] Picks still not servable — skipping user broadcast");
      return;
    }

    const userIds = await listActiveUserIds();
    const notice =
      result.refreshKind === "odds"
        ? `📋 <b>Updated (v${result.version})</b>\n\n${result.changeNote ?? "Lines moved on today's card."}\n\nTap a tier for the latest slip:`
        : kickoffStale
          ? `⏱️ <b>Fixtures kicked off. Fresh football card (v${result.version})</b>\n\n${result.changeNote ?? "Picks updated with the next upcoming matches."}\n\nTap a tier for the latest slip:`
          : `📋 <b>Biggy football update (v${result.version})</b>\n\n${result.changeNote ?? "Today's football picks are refreshed."}\n\nTap a tier for the latest slip:`;

    console.log(`[refresh] Broadcasting v${result.version} to ${userIds.length} users`);

    for (const telegramId of userIds) {
      try {
        await bot.api.sendMessage(telegramId, notice, {
          parse_mode: "HTML",
          reply_markup: dailyMenuKeyboard(),
        });
      } catch (err) {
        console.warn(`[refresh] Could not notify ${telegramId}:`, err);
      }
    }

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
  console.log(`[cron] Generating picks for ${pickDate}…`);

  let ready = false;

  try {
    const result = await generateDailyPicks(pickDate);
    if (!result.updated && result.version > 0) {
      console.log(`[cron] Using existing v${result.version}`);
    }
    ready = true;
  } catch (err) {
    console.error("[cron] Pick generation failed:", err);
    for (const attempt of [tryCarryForwardPicks, tryPrunedCarryForward, tryQuickOddsCard]) {
      const carried = await attempt(pickDate);
      if (carried) {
        console.log(`[cron] ${attempt.name} saved card for ${pickDate}`);
        ready = true;
        break;
      }
    }
    if (!ready) {
      if (isNoFixturesError(err)) {
        const notice = await restDayNotice();
        const count = await broadcastToActiveUsers(bot, notice, { parseMode: "HTML" });
        console.log(`[cron] Rest-day notice sent to ${count} users`);
      } else {
        const count = await broadcastToActiveUsers(
          bot,
          "Today's card is delayed — we're still lining up the best value. Check back shortly."
        );
        console.log(`[cron] Delay notice sent to ${count} users`);
      }
      return;
    }
  }

  if (!ready) return;

  const count = await broadcastToActiveUsers(bot, DAILY_DROP_TEXT);
  console.log(`[cron] Broadcasting to ${count} users`);

  void postDailyFreePick(pickDate, bot).catch((err) =>
    console.error("[social] Daily free pick post failed:", err)
  );
}
