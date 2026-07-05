import type { Bot } from "grammy";
import { generateDailyPicks, todayPickDate } from "../picks/generate.js";
import { picksStaleDueToKickoff } from "../picks/kickoff.js";
import { refreshStoredOdds } from "../picks/odds-refresh.js";
import { DAILY_DROP_TEXT, dailyMenuKeyboard } from "../bot/keyboards.js";
import { listActiveUserIds } from "../db/users.js";

export async function runRefreshPicks(bot: Bot) {
  const pickDate = todayPickDate();
  console.log(`[refresh] Checking picks for ${pickDate}…`);

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

    if (!result.updated || result.version <= 1) {
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
  } catch (err) {
    console.error("[refresh] Failed:", err);
  }
}

export async function runDailyDrop(bot: Bot) {
  const pickDate = todayPickDate();
  console.log(`[cron] Generating picks for ${pickDate}…`);

  try {
    const result = await generateDailyPicks(pickDate);
    if (!result.updated && result.version > 0) {
      console.log(`[cron] Using existing v${result.version}`);
    }
  } catch (err) {
    console.error("[cron] Pick generation failed:", err);
    return;
  }

  const userIds = await listActiveUserIds();
  console.log(`[cron] Broadcasting to ${userIds.length} users`);

  for (const telegramId of userIds) {
    try {
      await bot.api.sendMessage(telegramId, DAILY_DROP_TEXT, {
        reply_markup: dailyMenuKeyboard(),
      });
    } catch (err) {
      console.warn(`[cron] Could not message ${telegramId}:`, err);
    }
  }
}
