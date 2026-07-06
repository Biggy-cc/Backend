import {
  gradeLegWithScore,
  matchScore,
  normalizeMatchKey,
  type PickLeg,
} from "../picks/grading.js";
import {
  isHighlightlyConfigured,
  isHighlightlyFinished,
  loadHighlightlyMatchesForLegs,
  scoreForPickLabel,
  type HighlightlyMatch,
} from "../highlightly/client.js";
import { loadStoredBatch } from "../picks/store.js";
import { todayPickDate } from "../picks/generate.js";
import type { PickTier } from "../picks/types.js";
import type { DailyPicksBundle } from "../picks/validate.js";
import { formatDailyFreePick, formatLegWin, formatPickUpdate } from "./copy.js";
import { recordPost, wasPosted, type SocialPostKind } from "./store.js";
import { isXConfigured, postTweet } from "./x-client.js";

function gradeLegForSocial(
  leg: PickLeg,
  hl: HighlightlyMatch | undefined
): boolean | null {
  if (hl && isHighlightlyFinished(hl)) {
    const score = scoreForPickLabel(leg.match, hl);
    if (score) return gradeLegWithScore(leg, score);
  }
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

async function publish(
  kind: SocialPostKind,
  dedupKey: string,
  text: string
): Promise<boolean> {
  if (!isXConfigured()) return false;
  if (await wasPosted(dedupKey)) {
    console.log("[social] Already posted:", dedupKey);
    return false;
  }

  const tweetId = await postTweet(text);
  if (!tweetId) return false;

  await recordPost(kind, dedupKey, text, tweetId);
  return true;
}

export async function postDailyFreePick(pickDate: string): Promise<boolean> {
  const batch = await loadStoredBatch(pickDate);
  if (!batch) return false;

  const leg = selectDailyFreeLeg(batch.picks);
  if (!leg) return false;

  const key = legDedupKey("daily_free", pickDate, leg);
  return publish("daily_free", key, formatDailyFreePick(leg));
}

export async function postPickUpdate(
  pickDate: string,
  version: number,
  changeNote: string
): Promise<boolean> {
  const key = `pick_update:${pickDate}:v${version}`;
  return publish("pick_update", key, formatPickUpdate(version, changeNote));
}

type WonLeg = { pickDate: string; tier: PickTier; leg: PickLeg; scoreLine?: string };

async function findNewWonLegs(): Promise<WonLeg[]> {
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

    const hlMap = isHighlightlyConfigured()
      ? await loadHighlightlyMatchesForLegs(date, [...labels])
      : new Map<string, HighlightlyMatch>();

    for (const tier of ["hit", "aim", "go_big"] as PickTier[]) {
      for (const leg of batch.picks[tier]?.legs ?? []) {
        const hl = hlMap.get(normalizeMatchKey(leg.match));
        const grade = gradeLegForSocial(leg, hl);
        if (grade !== true) continue;

        const key = legDedupKey("leg_win", date, leg);
        if (await wasPosted(key)) continue;

        let scoreLine: string | undefined;
        if (hl && isHighlightlyFinished(hl)) {
          const s = scoreForPickLabel(leg.match, hl);
          if (s) scoreLine = `${s.home}-${s.away}`;
        }

        won.push({ pickDate: date, tier, leg, scoreLine });
      }
    }
  }

  return won;
}

/** Post celebration tweets for newly settled winning legs. */
export async function postNewWins(): Promise<number> {
  if (!isXConfigured()) return 0;

  const wins = await findNewWonLegs();
  let posted = 0;

  for (const { pickDate, tier, leg, scoreLine } of wins) {
    const key = legDedupKey("leg_win", pickDate, leg);
    const ok = await publish("leg_win", key, formatLegWin(leg, tier, scoreLine));
    if (ok) posted++;
  }

  if (posted > 0) console.log(`[social] Posted ${posted} win tweet(s)`);
  return posted;
}
