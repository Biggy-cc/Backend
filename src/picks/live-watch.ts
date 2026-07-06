import type { Bot } from "grammy";
import {
  appendLiveSection,
  buildLivePitchBlock,
  legStateFingerprint,
  stripLiveSection,
  type LegLiveState,
} from "./live-tracker.js";
import { slipActionKeyboard } from "../bot/keyboards.js";
import { PICK_PARSE_MODE, formatTierLabel } from "./types.js";
import type { PickTier } from "./types.js";

const TICK_MS = 60_000;
const SESSION_MAX_MS = 3 * 60 * 60_000;

export type LiveWatchSession = {
  telegramId: number;
  chatId: number;
  messageId: number;
  tier: PickTier;
  pickDate: string;
  slipContent: string;
  legFingerprints: string[];
  legsWonNotified: number[];
  slipWonNotified: boolean;
  startedAt: number;
};

const sessions = new Map<number, LiveWatchSession>();
let pollerStarted = false;

export function getLiveWatchSession(telegramId: number): LiveWatchSession | undefined {
  return sessions.get(telegramId);
}

export function pauseLiveWatch(telegramId: number): LiveWatchSession | undefined {
  const session = sessions.get(telegramId);
  sessions.delete(telegramId);
  return session;
}

export function registerLiveWatch(input: {
  telegramId: number;
  chatId: number;
  messageId: number;
  tier: PickTier;
  pickDate: string;
  slipContent: string;
  legs: LegLiveState[];
}): LiveWatchSession {
  const session: LiveWatchSession = {
    telegramId: input.telegramId,
    chatId: input.chatId,
    messageId: input.messageId,
    tier: input.tier,
    pickDate: input.pickDate,
    slipContent: input.slipContent,
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
  for (let i = 0; i < legs.length; i++) {
    const state = legs[i]!;
    if (state.progress?.state !== "won") continue;
    if (session.legsWonNotified.includes(i)) continue;

    session.legsWonNotified.push(i);
    await bot.api.sendMessage(session.chatId, formatWinAlert(session.tier, i, state, legs), {
      parse_mode: PICK_PARSE_MODE,
      reply_to_message_id: session.messageId,
    });
  }

  if (!session.slipWonNotified && allLegsWon(legs)) {
    session.slipWonNotified = true;
    await bot.api.sendMessage(session.chatId, formatSlipWinAlert(session.tier), {
      parse_mode: PICK_PARSE_MODE,
      reply_to_message_id: session.messageId,
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

  if (changedOrAlertsNeeded(session, legs)) {
    if (panelChanged(session.legFingerprints, legs)) {
      const html = appendLiveSection(session.slipContent, legs, session.tier, {
        autoWatch: true,
      });
      try {
        await bot.api.editMessageText(session.chatId, session.messageId, html, {
          parse_mode: PICK_PARSE_MODE,
          reply_markup: slipActionKeyboard(session.tier),
        });
        session.legFingerprints = legs.map(legStateFingerprint);
      } catch (err: unknown) {
        const desc = (err as { description?: string }).description ?? String(err);
        if (desc.includes("message is not modified")) {
          // still check alerts below
        } else if (
          desc.includes("message to edit not found") ||
          desc.includes("bot was blocked")
        ) {
          sessions.delete(session.telegramId);
          return;
        } else {
          console.error("[live-watch] edit failed:", desc);
        }
      }
    }

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

/** Register auto-updates on a slip message that already includes the live section. */
export function registerSlipLiveFeed(input: {
  telegramId: number;
  chatId: number;
  messageId: number;
  tier: PickTier;
  pickDate: string;
  slipContent: string;
  legs: LegLiveState[];
}): void {
  registerLiveWatch({
    telegramId: input.telegramId,
    chatId: input.chatId,
    messageId: input.messageId,
    tier: input.tier,
    pickDate: input.pickDate,
    slipContent: stripLiveSection(input.slipContent),
    legs: input.legs,
  });
}

/** Attach auto-updating live section to the user's tier slip message. */
export async function startSlipLiveFeed(
  bot: Bot,
  input: {
    telegramId: number;
    chatId: number;
    messageId: number;
    tier: PickTier;
    pickDate: string;
    slipContent: string;
    legs: LegLiveState[];
  }
): Promise<void> {
  const html = appendLiveSection(input.slipContent, input.legs, input.tier, {
    autoWatch: true,
  });

  await bot.api.editMessageText(input.chatId, input.messageId, html, {
    parse_mode: PICK_PARSE_MODE,
    reply_markup: slipActionKeyboard(input.tier),
  });

  registerLiveWatch({
    telegramId: input.telegramId,
    chatId: input.chatId,
    messageId: input.messageId,
    tier: input.tier,
    pickDate: input.pickDate,
    slipContent: stripLiveSection(input.slipContent),
    legs: input.legs,
  });
}

/** Stop auto-updates and restore the slip without the live block. */
export async function stopLiveFeed(bot: Bot, telegramId: number): Promise<boolean> {
  const session = pauseLiveWatch(telegramId);
  if (!session) return false;

  try {
    await bot.api.editMessageText(session.chatId, session.messageId, session.slipContent, {
      parse_mode: PICK_PARSE_MODE,
      reply_markup: slipActionKeyboard(session.tier),
    });
  } catch {
    // message may be gone — session is already cleared
  }

  return true;
}
