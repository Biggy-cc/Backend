import type { Bot } from "grammy";
import { broadcastToActiveUsers } from "../bot/broadcast.js";
import { fetchMatchNews } from "../news/google.js";
import { todayPickDate } from "../picks/generate.js";
import { formatNewsHook } from "../social/copy.js";
import { isSocialAutoMode, sendManualSocialDraft } from "../social/notify.js";
import { recordPost, wasPosted } from "../social/store.js";
import { isXConfigured, postTweet } from "../social/x-client.js";
import {
  fetchFixturesSnapshot,
  fixtureKickoffMs,
  fixtureLabel,
  isBettableFixture,
  isWorldCupFixture,
} from "../txline/client.js";

const IMPORTANT_HEADLINE =
  /injur|suspension|suspended|lineup|line-up|starting\s*11|starting\s*xi|doubt|ruled\s*out|squad|miss|return|fit|ban|red\s*card|hamstring|knock|absent|available|press\s*conference|team\s*news/i;

function upcomingWorldCupFixtures(hoursAhead = 72) {
  const all = fetchFixturesSnapshot();
  return all.then((fixtures) => {
    const now = Date.now();
    const horizon = now + hoursAhead * 60 * 60 * 1000;
    return fixtures
      .filter(isWorldCupFixture)
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
  headline: string,
  url: string
): Promise<boolean> {
  const dedupKey = `news:user:${todayPickDate()}:${match.toLowerCase()}:${url}`;
  if (await wasPosted(dedupKey)) return false;

  const text = formatNewsHook(match, headline);
  const userCount = await broadcastToActiveUsers(bot, text);
  console.log(`[news] Sent to ${userCount} users: ${match} — ${headline.slice(0, 60)}`);

  if (isSocialAutoMode() && isXConfigured()) {
    const tweetId = await postTweet(text);
    await recordPost("news", dedupKey, text, tweetId);
    return true;
  }

  await sendManualSocialDraft(bot, "news", text);
  await recordPost("news", dedupKey, text, null);
  return true;
}

/** World Cup team news → Telegram users (+ X draft/auto). Match-scoped RSS, deduped. */
export async function runNewsBroadcast(bot: Bot): Promise<void> {
  const fixtures = await upcomingWorldCupFixtures();
  if (!fixtures.length) {
    console.log("[news] No upcoming WC fixtures in window");
    return;
  }

  let sent = 0;

  for (const fixture of fixtures) {
    const match = fixtureLabel(fixture);
    const articles = await fetchMatchNews(
      fixture.Participant1,
      fixture.Participant2,
      8
    );

    const important = articles.filter((a) => IMPORTANT_HEADLINE.test(a.title));
    const pool = important.length > 0 ? important : articles.slice(0, 1);

    for (const article of pool.slice(0, 2)) {
      const ok = await dispatchNews(bot, match, article.title, article.url);
      if (ok) sent++;
    }
  }

  if (sent > 0) {
    console.log(`[news] Dispatched ${sent} headline(s) for WC window`);
  }
}
