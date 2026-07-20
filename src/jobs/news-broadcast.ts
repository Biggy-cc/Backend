import type { Bot } from "grammy";
import { broadcastToActiveUsers } from "../bot/broadcast.js";
import { articleMatchesFixture, fetchMatchNews } from "../news/google.js";
import { summarizeMatchNews } from "../news/summarize.js";
import { todayPickDate } from "../picks/generate.js";
import { formatNewsHook } from "../social/copy.js";
import { isSocialAutoMode, sendManualSocialDraft } from "../social/notify.js";
import { recordPost, wasPosted } from "../social/store.js";
import { isXConfigured, postTweet } from "../social/x-client.js";
import {
  fetchFixturesSnapshot,
  fixtureKickoffMs,
  fixtureLabel,
  getFootballDataProvider,
  isBettableFixture,
  isWorldCupFixture,
} from "../providers/football.js";

const IMPORTANT_HEADLINE =
  /injur|suspension|suspended|lineup|line-up|starting\s*11|starting\s*xi|doubt|ruled\s*out|squad|miss|return|fit|ban|red\s*card|hamstring|knock|absent|available|press\s*conference|team\s*news/i;

function upcomingWorldCupFixtures(hoursAhead = 72) {
  const all = fetchFixturesSnapshot();
  return all.then((fixtures) => {
    const now = Date.now();
    const horizon = now + hoursAhead * 60 * 60 * 1000;
    const provider = getFootballDataProvider();
    return fixtures
      .filter((f) =>
        provider === "api-football" ? true : isWorldCupFixture(f)
      )
      .filter((f) => isBettableFixture(f, now))
      .filter((f) => {
        const k = fixtureKickoffMs(f);
        return k >= now && k <= horizon;
      })
      .sort((a, b) => fixtureKickoffMs(a) - fixtureKickoffMs(b))
      .slice(0, 6);
  });
}

async function dispatchNews(
  bot: Bot,
  match: string,
  summary: string,
  dedupKey: string
): Promise<boolean> {
  if (await wasPosted(dedupKey)) return false;

  const text = formatNewsHook(match, summary);
  const userCount = await broadcastToActiveUsers(bot, text);
  console.log(`[news] Sent to ${userCount} users: ${match} — ${summary.slice(0, 80)}`);

  if (isSocialAutoMode() && isXConfigured()) {
    const tweetId = await postTweet(text);
    await recordPost("news", dedupKey, text, tweetId);
    return true;
  }

  await sendManualSocialDraft(bot, "news", text);
  await recordPost("news", dedupKey, text, null);
  return true;
}

/**
 * World Cup team news → Telegram users (+ X draft/auto).
 * One summarized blurb per match (not raw headlines / outlet names).
 */
export async function runNewsBroadcast(bot: Bot): Promise<void> {
  const fixtures = await upcomingWorldCupFixtures();
  if (!fixtures.length) {
    console.log("[news] No upcoming WC fixtures in window");
    return;
  }

  let sent = 0;

  for (const fixture of fixtures) {
    const match = fixtureLabel(fixture);
    const articles = (
      await fetchMatchNews(fixture.Participant1, fixture.Participant2, 8)
    ).filter((a) =>
      articleMatchesFixture(a, fixture.Participant1, fixture.Participant2)
    );

    if (!articles.length) continue;

    const important = articles.filter((a) => IMPORTANT_HEADLINE.test(a.title));
    const pool = important.length > 0 ? important : articles.slice(0, 3);

    // One digest per match per day — not a headline spam drip
    const dedupKey = `news:user:${todayPickDate()}:${match.toLowerCase()}:digest`;
    if (await wasPosted(dedupKey)) continue;

    const summary = await summarizeMatchNews(match, pool);
    const ok = await dispatchNews(bot, match, summary, dedupKey);
    if (ok) sent++;
  }

  if (sent > 0) {
    console.log(`[news] Dispatched ${sent} match summary(ies) for WC window`);
  }
}
