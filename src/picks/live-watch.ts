import type { Bot } from "grammy";
import {
  buildLiveFeedHtml,
  buildLivePitchBlock,
  hasReportableLiveData,
  legStateFingerprint,
  type LegLiveState,
} from "./live-tracker.js";
import { PICK_PARSE_MODE, formatTierLabel } from "./types.js";
import type { PickTier } from "./types.js";

const TICK_MS = 60_000;
const SESSION_MAX_MS = 3 * 60 * 60_000;

export type LiveWatchSession = {
  telegramId: number;
  chatId: number;
  liveMessageId: number | null;
  tier: PickTier;
  pickDate: string;
  legFingerprints: string[];
  legsWonNotified: number[];
  slipWonNotified: boolean;
  startedAt: number;
};

type PausedLiveFeed = {
  chatId: number;
  tier: PickTier;
  pickDate: string;
};

const sessions = new Map<number, LiveWatchSession>();
const pausedFeeds = new Map<number, PausedLiveFeed>();
let pollerStarted = false;

export function clearPausedLiveFeed(telegramId: number): void {
  pausedFeeds.delete(telegramId);
}

export function getLiveWatchSession(telegramId: number): LiveWatchSession | undefined {
  return sessions.get(telegramId);
}

async function deleteLiveMessage(bot: Bot, chatId: number, messageId: number): Promise<void> {
  try {
    await bot.api.deleteMessage(chatId, messageId);
  } catch {
    // already gone
  }
}

export function pauseLiveWatch(telegramId: number): LiveWatchSession | undefined {
  const session = sessions.get(telegramId);
  sessions.delete(telegramId);
  return session;
}

function registerLiveWatch(input: {
  telegramId: number;
  chatId: number;
  liveMessageId: number | null;
  tier: PickTier;
  pickDate: string;
  legs: LegLiveState[];
}): LiveWatchSession {
  const session: LiveWatchSession = {
    telegramId: input.telegramId,
    chatId: input.chatId,
    liveMessageId: input.liveMessageId,
    tier: input.tier,
    pickDate: input.pickDate,
    legFingerprints: input.legs.map(legStateFingerprint),
    legsWonNotified: input.legs
      .map((l, i) => (l.progress?.state === "won" ? i : -1))
      .filter((i) => i >= 0),
    slipWonNotified: input.legs.length > 0 && input.legs.every((l) => l.progress?.state === "won"),
    startedAt: Date.now(),
  };
  sessions.set(input.telegramId, session);
  return session;
}

function allLegsFinished(legs: LegLiveState[]): boolean {
  return legs.length > 0 && legs.every((l) => l.phase === "ft");
}

function allLegsWon(legs: LegLiveState[]): boolean {
  return legs.length > 0 && legs.every((l) => l.progress?.state === "won");
}

function formatWinAlert(
  tier: PickTier,
  legIndex: number,
  state: LegLiveState,
  legs: LegLiveState[]
): string {
  const tierLabel = formatTierLabel(tier);
  const score = state.scoreLine ? ` · ${state.scoreLine}` : "";
  const remaining = legs.filter(
    (_, i) => i !== legIndex && legs[i]!.progress?.state !== "won"
  ).length;
  const tail =
    remaining > 0
      ? `\n\nStill tracking ${remaining} leg${remaining === 1 ? "" : "s"} on your ${tierLabel} slip.`
      : "";
  return `✅ <b>${tierLabel} leg ${legIndex + 1} cleared</b>\n${state.matchLabel}${score}\n→ ${state.leg.selection}${tail}`;
}

function formatSlipWinAlert(tier: PickTier): string {
  return `🎯 <b>${formatTierLabel(tier)} slip fully in</b> — every leg on your card cleared at full time.`;
}

async function pushContextualAlerts(
  bot: Bot,
  session: LiveWatchSession,
  legs: LegLiveState[]
): Promise<void> {
  if (!session.liveMessageId) return;

  for (let i = 0; i < legs.length; i++) {
    const state = legs[i]!;
    if (state.progress?.state !== "won") continue;
    if (session.legsWonNotified.includes(i)) continue;

    session.legsWonNotified.push(i);
    await bot.api.sendMessage(session.chatId, formatWinAlert(session.tier, i, state, legs), {
      parse_mode: PICK_PARSE_MODE,
      reply_to_message_id: session.liveMessageId,
    });
  }

  if (!session.slipWonNotified && allLegsWon(legs)) {
    session.slipWonNotified = true;
    await bot.api.sendMessage(session.chatId, formatSlipWinAlert(session.tier), {
      parse_mode: PICK_PARSE_MODE,
      reply_to_message_id: session.liveMessageId,
    });
  }
}

function panelChanged(prev: string[], next: LegLiveState[]): boolean {
  const fps = next.map(legStateFingerprint);
  if (fps.length !== prev.length) return true;
  return fps.some((fp, i) => fp !== prev[i]);
}

function changedOrAlertsNeeded(session: LiveWatchSession, legs: LegLiveState[]): boolean {
  if (panelChanged(session.legFingerprints, legs)) return true;
  for (let i = 0; i < legs.length; i++) {
    if (legs[i]!.progress?.state === "won" && !session.legsWonNotified.includes(i)) {
      return true;
    }
  }
  return !session.slipWonNotified && allLegsWon(legs);
}

async function publishLiveFeed(
  bot: Bot,
  session: LiveWatchSession,
  legs: LegLiveState[]
): Promise<void> {
  const html = buildLiveFeedHtml(legs, session.tier);
  if (!html) return;

  if (session.liveMessageId == null) {
    const sent = await bot.api.sendMessage(session.chatId, html, {
      parse_mode: PICK_PARSE_MODE,
    });
    session.liveMessageId = sent.message_id;
    session.legFingerprints = legs.map(legStateFingerprint);
    return;
  }

  if (!panelChanged(session.legFingerprints, legs)) return;

  try {
    await bot.api.editMessageText(session.chatId, session.liveMessageId, html, {
      parse_mode: PICK_PARSE_MODE,
    });
    session.legFingerprints = legs.map(legStateFingerprint);
  } catch (err: unknown) {
    const desc = (err as { description?: string }).description ?? String(err);
    if (desc.includes("message is not modified")) return;
    if (desc.includes("message to edit not found") || desc.includes("bot was blocked")) {
      sessions.delete(session.telegramId);
      return;
    }
    console.error("[live-watch] edit failed:", desc);
  }
}

async function tickSession(bot: Bot, session: LiveWatchSession): Promise<void> {
  if (Date.now() - session.startedAt > SESSION_MAX_MS) {
    sessions.delete(session.telegramId);
    return;
  }

  const block = await buildLivePitchBlock(session.pickDate, session.tier, {
    tier: session.tier,
    fresh: true,
  });
  if (!block) {
    sessions.delete(session.telegramId);
    return;
  }

  const { legs } = block;

  if (!hasReportableLiveData(legs)) return;

  if (changedOrAlertsNeeded(session, legs)) {
    await publishLiveFeed(bot, session, legs);
    await pushContextualAlerts(bot, session, legs);
  }

  if (allLegsFinished(legs)) {
    sessions.delete(session.telegramId);
  }
}

export function startLiveWatchPoller(bot: Bot): void {
  if (pollerStarted) return;
  pollerStarted = true;

  setInterval(() => {
    void (async () => {
      if (sessions.size === 0) return;
      for (const session of [...sessions.values()]) {
        try {
          await tickSession(bot, session);
        } catch (err) {
          console.error("[live-watch] tick failed:", err);
        }
      }
    })();
  }, TICK_MS);

  console.log("[live-watch] Auto live feed poller started (60s)");
}

/** Watch a slip silently — live messages go out only when matches have real data. */
export function registerPendingLiveWatch(input: {
  telegramId: number;
  chatId: number;
  tier: PickTier;
  pickDate: string;
  legs: LegLiveState[];
}): void {
  registerLiveWatch({
    telegramId: input.telegramId,
    chatId: input.chatId,
    liveMessageId: null,
    tier: input.tier,
    pickDate: input.pickDate,
    legs: input.legs,
  });
}

/** Stop auto-updates and remove any live feed message. */
export async function stopLiveFeed(bot: Bot, telegramId: number): Promise<boolean> {
  const session = pauseLiveWatch(telegramId);
  if (!session) return false;

  pausedFeeds.set(telegramId, {
    chatId: session.chatId,
    tier: session.tier,
    pickDate: session.pickDate,
  });

  if (session.liveMessageId != null) {
    await deleteLiveMessage(bot, session.chatId, session.liveMessageId);
  }
  return true;
}

export type ResumeLiveFeedResult = "resumed" | "already_active" | "nothing_paused" | "no_legs";

/** Resume watching — still waits for real match data before sending. */
export async function resumeLiveFeed(bot: Bot, telegramId: number): Promise<ResumeLiveFeedResult> {
  if (sessions.has(telegramId)) return "already_active";

  const paused = pausedFeeds.get(telegramId);
  if (!paused) return "nothing_paused";

  const block = await buildLivePitchBlock(paused.pickDate, paused.tier, {
    tier: paused.tier,
    fresh: true,
  });
  if (!block?.legs.length) {
    pausedFeeds.delete(telegramId);
    return "no_legs";
  }

  if (allLegsFinished(block.legs)) {
    pausedFeeds.delete(telegramId);
    return "no_legs";
  }

  registerPendingLiveWatch({
    telegramId,
    chatId: paused.chatId,
    tier: paused.tier,
    pickDate: paused.pickDate,
    legs: block.legs,
  });

  pausedFeeds.delete(telegramId);

  if (hasReportableLiveData(block.legs)) {
    const session = sessions.get(telegramId);
    if (session) {
      await publishLiveFeed(bot, session, block.legs);
      await pushContextualAlerts(bot, session, block.legs);
    }
  }

  return "resumed";
}

/** Tear down any active live feed when the user opens a new slip. */
export async function clearLiveFeedForUser(bot: Bot, telegramId: number): Promise<void> {
  const session = pauseLiveWatch(telegramId);
  if (session?.liveMessageId != null) {
    await deleteLiveMessage(bot, session.chatId, session.liveMessageId);
  }
  clearPausedLiveFeed(telegramId);
}
