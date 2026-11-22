import type { Bot, Context } from "grammy";
import { askBiggy, type BiggyChatMessage, type ProposedParlay } from "../chat/assistant.js";
import { refundChatUsage, reserveChatUsage, reserveParlayUsage, type ChatTier } from "../chat/usage.js";
import { isSubscribed, upsertUser } from "../db/users.js";

type Session = { history: BiggyChatMessage[]; parlay?: ProposedParlay; updated: number };
const sessions = new Map<number, Session>();
const running = new Set<number>();
const SESSION_TTL = 24 * 60 * 60_000;

export function clearChatSession(id: number): void { sessions.delete(id); }

/** Telegram uses the same verified football tools as web; conversations are private and short-lived. */
export async function handleFreeformMessage(ctx: Context, rawText: string, _bot?: Bot): Promise<void> {
  if (!ctx.from || ctx.chat?.type !== "private") return;
  const id = ctx.from.id;
  if (/^(?:approve|track|approve and track)[.! ]*$/i.test(rawText.trim()) && sessions.get(id)?.parlay) {
    await ctx.reply("I can revise this proposal here, but Telegram approval and tracking aren’t connected yet. You can build and approve a proposal at https://biggy.cc/.");
    return;
  }
  if (running.has(id)) { await ctx.reply("I’m still working on your last question. Please give me a moment."); return; }
  running.add(id);
  try {
    const user = await upsertUser(id, ctx.from.username, ctx.from.first_name);
    // Telegram subscriptions remain separate until Google linking is server-verified.
    const tier: ChatTier = isSubscribed(user) ? user.subscription_tier : "free";
    const principal = `telegram:${id}`;
    const reservedAt = new Date();
    const usage = await reserveChatUsage(principal, tier, false, reservedAt);
    if (!usage.allowed) { await ctx.reply("You’ve reached your daily chat limit. Visit biggy.cc for your plan options."); return; }
    let chargedParlay: Promise<boolean> | undefined;
    const old = sessions.get(id);
    const session: Session = old && Date.now() - old.updated < SESSION_TTL ? old : { history: [], updated: Date.now() };
    try {
      await ctx.replyWithChatAction("typing").catch(() => undefined);
      const result = await askBiggy(rawText.slice(0, 2000), session.history, "UTC", undefined, tier === "pro" || tier === "max", () => chargedParlay ??= reserveParlayUsage(principal, tier, reservedAt), session.parlay);
      session.history = [...session.history, { role: "user" as const, content: rawText.slice(0, 2000) }, { role: "assistant" as const, content: result.answer }].slice(-12);
      session.parlay = result.parlay ?? session.parlay;
      session.updated = Date.now();
      if (sessions.size >= 1000 && !sessions.has(id)) sessions.delete(sessions.keys().next().value!);
      sessions.set(id, session);
      const card = result.parlay ? `\n\n${result.parlay.legs.map((leg, index) => `${index + 1}. ${leg.home} vs ${leg.away}: ${leg.selection}${leg.odds ? ` (${leg.odds.price.toFixed(2)})` : ""}`).join("\n")}\nEstimated combined odds: ${result.parlay.legs.reduce((n, leg) => n * (leg.odds?.price ?? 1), 1).toFixed(2)}. Prices may come from different sources; confirm at your sportsbook.\n\nTell me what you’d like to change. For now, tracking approval is available on biggy.cc; Telegram proposals don’t sync to the web.` : "";
      await ctx.reply(`${result.answer}${card}`.replace(/\*\*/g, "").slice(0, 4096));
    } catch (error) {
      const hadParlayCharge = chargedParlay ? await chargedParlay.catch(() => false) : false;
      await refundChatUsage(principal, tier, hadParlayCharge, reservedAt).catch(() => undefined);
      console.error("[telegram-chat] request failed:", error instanceof Error ? error.message : "unknown error");
      await ctx.reply("I couldn’t complete that request just now. Please try again.");
    }
  } finally { running.delete(id); }
}
