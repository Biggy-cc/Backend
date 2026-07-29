import type { Bot } from "grammy";
import {
  isApiFootballConfigured,
  loadApiFootballScoresForLegs,
  type ApiFootballLegScore,
} from "../api-football/results.js";
import { invalidateTrackRecordCache } from "../api/track-record.js";
import {
  gradeLegWithScore,
  matchScore,
  normalizeMatchKey,
  type PickLeg,
} from "../picks/grading.js";
import { loadStoredBatch } from "../picks/store.js";
import { todayPickDate } from "../picks/generate.js";
import type { PickTier } from "../picks/types.js";
import type { DailyPicksBundle } from "../picks/validate.js";
import { formatDailyFreePick, formatLegWin, formatPickUpdate } from "./copy.js";
import { isSocialAutoMode, sendManualSocialDraft } from "./notify.js";
import { recordPost, wasPosted, type SocialPostKind } from "./store.js";
import { isXConfigured, postTweet } from "./x-client.js";

function gradeLegForSocial(
  leg: PickLeg,
  af: ApiFootballLegScore | undefined
): boolean | null {
  if (af) return gradeLegWithScore(leg, af);
  const manual = matchScore(leg.match);
  if (manual) return gradeLegWithScore(leg, manual);
  return null;
}

function legDedupKey(kind: SocialPostKind, pickDate: string, leg: PickLeg): string {
  return `${kind}:${pickDate}:${normalizeMatchKey(leg.match)}:${leg.selection.toLowerCase()}`;
}

/** Best Hit leg for free daily post — lowest odds = highest implied probability. */
export function selectDailyFreeLeg(picks: DailyPicksBundle["picks"]): PickLeg | null {
  const legs = picks.hit?.legs ?? [];
  if (legs.length === 0) return null;
  return legs.reduce((best, leg) => (leg.odds < best.odds ? leg : best));
}

async function dispatchPost(
  bot: Bot | null,
  kind: SocialPostKind,
  dedupKey: string,
  text: string
): Promise<boolean> {
  if (await wasPosted(dedupKey)) {
    console.log("[social] Already sent:", dedupKey);
    return false;
  }

  if (isSocialAutoMode() && isXConfigured()) {
    const tweetId = await postTweet(text);
    if (!tweetId) return false;
    await recordPost(kind, dedupKey, text, tweetId);
    return true;
  }

  if (!bot) {
    console.warn("[social] Manual mode — bot not ready, skipping draft");
    return false;
  }

  const sent = await sendManualSocialDraft(bot, kind, text);
  if (!sent) return false;

  await recordPost(kind, dedupKey, text, null);
  return true;
}

export async function postDailyFreePick(
  pickDate: string,
  bot: Bot | null = null
): Promise<boolean> {
  const batch = await loadStoredBatch(pickDate);
  if (!batch) return false;

  const leg = selectDailyFreeLeg(batch.picks);
  if (!leg) return false;

  const key = legDedupKey("daily_free", pickDate, leg);
  return dispatchPost(bot, "daily_free", key, formatDailyFreePick(leg));
}

export async function postPickUpdate(
  pickDate: string,
  version: number,
  changeNote: string,
  bot: Bot | null = null
): Promise<boolean> {
  const key = `pick_update:${pickDate}:v${version}`;
  return dispatchPost(bot, "pick_update", key, formatPickUpdate(version, changeNote));
}

type WonLeg = { pickDate: string; tier: PickTier; leg: PickLeg; scoreLine?: string };

async function findNewWonLegs(): Promise<WonLeg[]> {
  if (!isApiFootballConfigured()) {
    console.log("[social] API-Football not configured — skip win check");
    return [];
  }

  const pickDate = todayPickDate();
  const dates = [pickDate];
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  dates.push(yesterday.toISOString().slice(0, 10));

  const won: WonLeg[] = [];

  for (const date of dates) {
    const batch = await loadStoredBatch(date);
    if (!batch) continue;

    const labels = new Set<string>();
    for (const tier of ["hit", "aim", "go_big"] as PickTier[]) {
      for (const leg of batch.picks[tier]?.legs ?? []) {
        labels.add(leg.match);
      }
    }
    if (labels.size === 0) continue;

    const afMap = await loadApiFootballScoresForLegs(date, [...labels]);

    for (const tier of ["hit", "aim", "go_big"] as PickTier[]) {
      for (const leg of batch.picks[tier]?.legs ?? []) {
        const af = afMap.get(normalizeMatchKey(leg.match));
        const grade = gradeLegForSocial(leg, af);
        if (grade !== true) continue;

        const key = legDedupKey("leg_win", date, leg);
        if (await wasPosted(key)) continue;

        won.push({
          pickDate: date,
          tier,
          leg,
          scoreLine: af ? `${af.home}-${af.away}` : undefined,
        });
      }
    }
  }

  return won;
}

/** Notify admin or post celebration for newly settled winning legs. */
export async function postNewWins(bot: Bot | null = null): Promise<number> {
  const wins = await findNewWonLegs();
  let sent = 0;

  for (const { pickDate, tier, leg, scoreLine } of wins) {
    const key = legDedupKey("leg_win", pickDate, leg);
    const ok = await dispatchPost(
      bot,
      "leg_win",
      key,
      formatLegWin(leg, tier, scoreLine)
    );
    if (ok) sent++;
  }

  if (sent > 0) {
    invalidateTrackRecordCache();
    console.log(`[social] Dispatched ${sent} win post(s) (${isSocialAutoMode() ? "auto" : "manual"})`);
  }
  return sent;
}
