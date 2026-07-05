import type { Bot } from "grammy";
import {
  buildLivePitchBlock,
  buildLivePitchPanelHtml,
  legStateFingerprint,
  shouldAutoWatchLegs,
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
  autoWatch: boolean;
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
  legs: LegLiveState[];
  autoWatch?: boolean;
}): LiveWatchSession {
  const session: LiveWatchSession = {
    telegramId: input.telegramId,
    chatId: input.chatId,
    messageId: input.messageId,
    tier: input.tier,
    pickDate: input.pickDate,
    autoWatch: input.autoWatch ?? shouldAutoWatchLegs(input.legs),
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

async function tickSession(bot: Bot, session: LiveWatchSession): Promise<void> {
  if (Date.now() - session.startedAt > SESSION_MAX_MS) {
    sessions.delete(session.telegramId);
    return;
  }

  if (!session.autoWatch) return;

  const block = await buildLivePitchBlock(session.pickDate, session.tier, {
    autoWatch: true,
    tier: session.tier,
  });
  if (!block) {
    sessions.delete(session.telegramId);
    return;
  }

  const { legs, html } = block;

  if (changedOrAlertsNeeded(session, legs)) {
    if (panelChanged(session.legFingerprints, legs)) {
      try {
        await bot.api.editMessageText(session.chatId, session.messageId, html, {
          parse_mode: PICK_PARSE_MODE,
          reply_markup: slipActionKeyboard(session.tier, true),
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
    session.autoWatch = false;
    if (session.slipWonNotified || session.legsWonNotified.length > 0) {
      sessions.delete(session.telegramId);
    }
  }
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

  console.log("[live-watch] Contextual auto-refresh started (60s, open slips only)");
}

export async function deliverLivePanel(
  bot: Bot,
  input: {
    telegramId: number;
    chatId: number;
    tier: PickTier;
    pickDate: string;
    messageId?: number;
    edit?: boolean;
  }
): Promise<{ messageId: number; autoWatch: boolean } | null> {
  const block = await buildLivePitchBlock(input.pickDate, input.tier, { tier: input.tier });
  if (!block) return null;

  const autoWatch = shouldAutoWatchLegs(block.legs);
  const html = buildLivePitchPanelHtml(block.legs, { autoWatch, tier: input.tier });
  const markup = slipActionKeyboard(input.tier, autoWatch);

  if (input.edit && input.messageId) {
    await bot.api.editMessageText(input.chatId, input.messageId, html, {
      parse_mode: PICK_PARSE_MODE,
      reply_markup: markup,
    });
    registerLiveWatch({
      telegramId: input.telegramId,
      chatId: input.chatId,
      messageId: input.messageId,
      tier: input.tier,
      pickDate: input.pickDate,
      legs: block.legs,
      autoWatch,
    });
    return { messageId: input.messageId, autoWatch };
  }

  const sent = await bot.api.sendMessage(input.chatId, html, {
    parse_mode: PICK_PARSE_MODE,
    reply_markup: markup,
  });

  registerLiveWatch({
    telegramId: input.telegramId,
    chatId: input.chatId,
    messageId: sent.message_id,
    tier: input.tier,
    pickDate: input.pickDate,
    legs: block.legs,
    autoWatch,
  });

  return { messageId: sent.message_id, autoWatch };
}

export async function refreshLivePanelAfterPause(
  bot: Bot,
  session: LiveWatchSession
): Promise<void> {
  const block = await buildLivePitchBlock(session.pickDate, session.tier, { tier: session.tier });
  if (!block) return;

  const html = buildLivePitchPanelHtml(block.legs, { autoWatch: false, tier: session.tier });
  await bot.api.editMessageText(session.chatId, session.messageId, html, {
    parse_mode: PICK_PARSE_MODE,
    reply_markup: slipActionKeyboard(session.tier, false),
  });
}
