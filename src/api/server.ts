import http from "node:http";
import { getUpcomingFixturesPayload } from "./fixtures.js";
import { getTrackRecordPayload } from "./track-record.js";
import { readJsonBody } from "./body.js";
import { getCheckoutSession, startWebCheckout } from "./checkout.js";
import { getWebAccess } from "./access.js";
import { serveTelegramAvatar } from "./telegram-avatar.js";
import { getTelegramBotInfo } from "./telegram-bot.js";
import { proxySolanaRpc } from "./solana-rpc.js";
import type { TelegramLoginPayload } from "./telegram-auth.js";
import { askBiggy, isParlayRevision, type ProposedParlay } from "../chat/assistant.js";
import { getLiveScoresPayload, getTodayScoresPayload } from "./live-scores.js";
import { getLeaguesPayload, getStandingsPayload } from "./leagues.js";
import { getFootballFeedHealth } from "../api-football/client.js";
import { randomUUID } from "node:crypto";
import { verifyGoogleCredential } from "./google-auth.js";
import { getVerifiedGoogleAccess, upsertGoogleAccount } from "../db/google-accounts.js";
import { startGoogleCheckout, getGoogleCheckout } from "./google-checkout.js";
import { extendSubscriptionUntil, formatSubscriptionDate } from "../db/users.js";
import { reserveChatUsage, reserveParlayUsage, refundChatUsage, type ChatTier } from "../chat/usage.js";
import { getCachedFixtures } from "../api-football/cache.js";
import { fetchMatchOdds, matchParlaySelectionOptions, bestParlayQuotes } from "../api-football/match-odds.js";
import { isParlayRequest } from "../chat/intents.js";

type ChatJob = { status: "working" | "complete" | "failed"; result?: Awaited<ReturnType<typeof askBiggy>>; error?: string; createdAt: number };
const chatJobs = new Map<string, ChatJob>();
const oddsRefreshAt = new Map<string, number>();

function isLongParlayTask(message: string, history: Array<{ role: "user" | "assistant"; content: string }>): boolean {
  if (/\b(?:odds|ods|betting prices?|bookmaker prices?)\b/i.test(message)) return true;
  if (isParlayRequest(message, history)) return true;
  if (/\b(?:tell me about|what(?:'s| is) happening|what happened|match summary)\b/i.test(message) && /\b(?:vs\.?|versus)\b/i.test(message)) return true;
  if (/\b(?:who\s+(?:has\s+)?scored|goalscorers?|goal\s*scorers?|who\s+got\s+the\s+goals?|match\s+events|red\s+cards?)\b/i.test(message)) return true;
  if (
    /\b(?:last|previous|recent)\b/i.test(message) &&
    /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|match(?:es)?|game(?:s)?|result(?:s)?)\b/i.test(message)
  ) return true;
  return /^(?:yes|yeah|yep|ok(?:ay)?|go ahead|do it|safe|balanced|go big)[.! ]*$/i.test(message)
    && history.slice(-6).some((item) => /\b(parlay|accumulator|acca)\b/i.test(item.content));
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, solana-client",
};

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

export function startApiServer(port: number, host = "0.0.0.0") {
  const server = http.createServer(async (req, res) => {
    const url = req.url?.split("?")[0];

    // Health FIRST — never wait behind fixtures/D1/odds. Railway probes must
    // get an instant 200 or the service is marked dead and looks "offline".
    if (
      req.method === "GET" &&
      (url === "/api/health" || url === "/" || url === "/health")
    ) {
      sendJson(res, 200, { ok: true, ts: Date.now() });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method === "POST" && url === "/api/google/session") {
      try {
        const body = await readJsonBody<{ credential?: string }>(req);
        let user;
        try { user = await verifyGoogleCredential(body.credential ?? ""); }
        catch (error) {
          const unavailable = error instanceof Error && /unavailable|fetch failed|timeout/i.test(error.message);
          sendJson(res, unavailable ? 503 : 401, { error: unavailable ? "Google verification is temporarily unavailable." : "Could not verify Google sign-in. Please try again." });
          return;
        }
        await upsertGoogleAccount(user);
        const subscription = await getVerifiedGoogleAccess(user);
        sendJson(res, 200, { user, ...subscription }, { "Cache-Control": "no-store" });
      } catch (err) {
        console.error("[api] Google sign-in failed:", err instanceof Error ? err.message : "unknown error");
        sendJson(res, 503, { error: "Account service is temporarily unavailable. Please try again." });
      }
      return;
    }

    if (req.method === "GET" && url === "/api/football-health") {
      sendJson(res, 200, getFootballFeedHealth(), { "Cache-Control": "no-store" });
      return;
    }

    if (req.method === "GET" && url === "/api/fixtures") {
      try {
        const fixtures = await Promise.race([
          getUpcomingFixturesPayload(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("fixtures timeout")), 10_000)
          ),
        ]);
        sendJson(res, 200, { fixtures }, {
          "Cache-Control": "public, max-age=60",
        });
      } catch (err) {
        console.error("[api] /api/fixtures failed:", err);
        sendJson(res, 502, { error: "Could not load fixtures" });
      }
      return;
    }

    if (req.method === "GET" && url === "/api/live-scores") {
      try {
        const matches = await Promise.race([
          getLiveScoresPayload(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("live scores timeout")), 12_000)
          ),
        ]);
        sendJson(res, 200, { matches, asOf: getFootballFeedHealth().liveAsOf }, {
          "Cache-Control": "public, max-age=20",
        });
      } catch (err) {
        console.error("[api] /api/live-scores failed:", err);
        sendJson(res, 502, { error: "Could not load live scores" });
      }
      return;
    }

    if (req.method === "GET" && url === "/api/matches-today") {
      try {
        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        const requestedDate = requestUrl.searchParams.get("date") ?? "";
        const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
          ? requestedDate
          : new Date().toISOString().slice(0, 10);
        let timezone = "UTC";
        const requestedTimezone = requestUrl.searchParams.get("timezone");
        if (requestedTimezone && requestedTimezone.length <= 64) {
          try { new Intl.DateTimeFormat("en", { timeZone: requestedTimezone }).format(); timezone = requestedTimezone; } catch { /* Keep UTC. */ }
        }
        const matches = await Promise.race([
          getTodayScoresPayload(date, timezone),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("today matches timeout")), 12_000)
          ),
        ]);
        const health = getFootballFeedHealth(date);
        sendJson(res, 200, { date, timezone, matches, asOf: health.liveAsOf, fixturesAsOf: health.dateAsOf }, {
          "Cache-Control": "public, max-age=20",
        });
      } catch (err) {
        console.error("[api] /api/matches-today failed:", err);
        sendJson(res, 502, { error: "Could not load today's matches" });
      }
      return;
    }

    if (req.method === "GET" && url === "/api/leagues") {
      try {
        const leagues = await getLeaguesPayload();
        sendJson(res, 200, { leagues }, { "Cache-Control": "public, max-age=21600" });
      } catch (err) {
        console.error("[api] /api/leagues failed:", err);
        sendJson(res, 502, { error: "Could not load leagues" });
      }
      return;
    }

    if (req.method === "GET" && url === "/api/standings") {
      try {
        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        const leagueId = Number(requestUrl.searchParams.get("league"));
        const season = Number(requestUrl.searchParams.get("season"));
        if (!Number.isInteger(leagueId) || !Number.isInteger(season)) {
          sendJson(res, 400, { error: "Valid league and season are required" });
          return;
        }
        const standings = await getStandingsPayload(leagueId, season);
        sendJson(res, 200, { standings }, { "Cache-Control": "public, max-age=300" });
      } catch (err) {
        console.error("[api] /api/standings failed:", err);
        sendJson(res, 502, { error: "Could not load standings" });
      }
      return;
    }

    if (req.method === "POST" && url === "/api/parlay-odds") {
      try {
        const body = await readJsonBody<{ googleCredential?: string; legs?: Array<{ fixtureId?: string; selection?: string }> }>(req);
        const user = await verifyGoogleCredential(body.googleCredential ?? "");
        if ((await getVerifiedGoogleAccess(user)).tier === "free") { sendJson(res, 403, { error: "Paid access required." }); return; }
        const legs = body.legs;
        if (!Array.isArray(legs) || legs.length < 2 || legs.length > 3 || legs.some((leg) => !/^\d{1,10}$/.test(leg.fixtureId ?? "") || typeof leg.selection !== "string" || leg.selection.length > 120)) { sendJson(res, 400, { error: "Invalid parlay legs." }); return; }
        const key = user.sub;
        if (Date.now() - (oddsRefreshAt.get(key) ?? 0) < 60_000) { sendJson(res, 429, { error: "Please wait before refreshing prices." }); return; }
        if (oddsRefreshAt.size >= 5000) oddsRefreshAt.delete(oddsRefreshAt.keys().next().value!);
        oddsRefreshAt.set(key, Date.now());
        const fixtures = getCachedFixtures(Number.POSITIVE_INFINITY) ?? [];
        const quotes = await Promise.all(legs.map(async (leg) => {
          const fixture = fixtures.find((item) => String(item.FixtureId) === leg.fixtureId);
          if (!fixture || fixture.StartTime * 1000 <= Date.now()) return [];
          try {
            const data = await fetchMatchOdds(fixture.FixtureId, { home: fixture.Participant1, away: fixture.Participant2, kickoffAt: new Date(fixture.StartTime * 1000).toISOString() });
            return "error" in data ? [] : matchParlaySelectionOptions(data, leg.selection!, fixture.Participant1, fixture.Participant2);
          } catch { return []; }
        }));
        sendJson(res, 200, { quotes: bestParlayQuotes(quotes) ?? quotes.map((leg) => leg[0] ?? null) }, { "Cache-Control": "no-store" });
      } catch { sendJson(res, 401, { error: "Could not verify access to prices." }); }
      return;
    }

    if (req.method === "POST" && url === "/api/chat") {
      try {
        if (!process.env.OPENAI_API_KEY?.trim()) {
          sendJson(res, 503, { error: "Biggy AI is not configured yet" });
          return;
        }
        const body = await readJsonBody<{
          message?: string;
          history?: Array<{ role?: string; content?: string }>;
          timezone?: string;
          fixtureId?: unknown;
          googleCredential?: string;
          guestId?: string;
          activeParlay?: ProposedParlay;
        }>(req);
        const message = body.message?.trim() ?? "";
        if (!message || message.length > 1_000) {
          sendJson(res, 400, { error: "Message must be between 1 and 1,000 characters" });
          return;
        }
        const history = (body.history ?? [])
          .filter((item) =>
            (item.role === "user" || item.role === "assistant") &&
            typeof item.content === "string" &&
            item.content.trim().length > 0
          )
          .slice(-10)
          .map((item) => ({
            role: item.role as "user" | "assistant",
            content: item.content!.trim().slice(0, 2_000),
          }));
        let principal: string;
        let tier: ChatTier = "guest";
        if (body.googleCredential) {
          let user;
          try {
            user = await verifyGoogleCredential(body.googleCredential);
          } catch (error) {
            const unavailable = error instanceof Error && /unavailable|fetch failed|timeout/i.test(error.message);
            sendJson(res, unavailable ? 503 : 401, { error: unavailable ? "Google verification is temporarily unavailable." : "Your Google session expired or could not be verified. Please sign in again." });
            return;
          }
          const access = await getVerifiedGoogleAccess(user);
          principal = `google:${user.sub}`;
          tier = access.tier;
        } else {
          if (typeof body.guestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.guestId)) {
            sendJson(res, 400, { error: "Please refresh the app before chatting." });
            return;
          }
          principal = `guest:${body.guestId}`;
        }
        const supplied = body.activeParlay;
        const activeParlay = supplied && ["safe", "balanced", "go_big"].includes(supplied.risk) && Array.isArray(supplied.legs) && supplied.legs.length >= 2 && supplied.legs.length <= 3 && supplied.legs.every((leg) => typeof leg.home === "string" && leg.home.length <= 100 && typeof leg.away === "string" && leg.away.length <= 100 && typeof leg.selection === "string" && leg.selection.length <= 120 && typeof leg.kickoffAt === "string" && leg.kickoffAt.length <= 40)
          ? { title: String(supplied.title ?? "Parlay").slice(0, 120), risk: supplied.risk, legs: supplied.legs.map(({ home, away, selection, kickoffAt }) => ({ home, away, selection, kickoffAt })) } : undefined;
        const parlayRequest = isParlayRequest(message, history) || isParlayRevision(message, activeParlay);
        if (parlayRequest && tier !== "pro" && tier !== "max") {
          sendJson(res, 403, { error: "Parlay research requires an active Biggy Pro or Max subscription." });
          return;
        }
        const reservedAt = new Date();
        const usage = await reserveChatUsage(principal, tier, false, reservedAt);
        if (!usage.allowed) {
          const error = usage.reason === "parlays" ? "Parlay research requires an active Biggy Pro or Max subscription." : tier === "guest" ? "You’ve used your two guest messages. Sign in to continue." : "You’ve reached your daily message limit.";
          sendJson(res, 403, { error });
          return;
        }
        let parlayReserved = false;
        let parlayReservation: Promise<boolean> | undefined;
        const authorizeProposal = () => {
          parlayReservation ??= reserveParlayUsage(principal, tier, reservedAt).then((allowed) => { parlayReserved = allowed; return allowed; });
          return parlayReservation;
        };
        let timezone = "UTC";
        const rawFixtureId = body.fixtureId;
        const fixtureId = typeof rawFixtureId === "string" && /^[1-9]\d{0,9}$/.test(rawFixtureId) ? Number(rawFixtureId) : undefined;
        if (typeof body.timezone === "string" && body.timezone.length <= 64) {
          try {
            new Intl.DateTimeFormat("en", { timeZone: body.timezone }).format();
            timezone = body.timezone;
          } catch {
            // Keep UTC for invalid or unsupported timezone names.
          }
        }
        if (isLongParlayTask(message, history) || parlayRequest) {
          const jobId = randomUUID();
          chatJobs.set(jobId, { status: "working", createdAt: Date.now() });
          void askBiggy(message, history, timezone, fixtureId, tier === "pro" || tier === "max", authorizeProposal, activeParlay).then((result) => {
            chatJobs.set(jobId, { status: "complete", result, createdAt: Date.now() });
          }).catch(async (error) => {
            console.error(`[api] chat job ${jobId} failed:`, error);
            try { await refundChatUsage(principal, tier, parlayReserved, reservedAt); } catch { console.error("[api] Failed to refund chat usage"); }
            chatJobs.set(jobId, { status: "failed", error: "Biggy could not complete the football research", createdAt: Date.now() });
          });
          sendJson(res, 202, { jobId, status: "working" }, { "Cache-Control": "no-store" });
          return;
        }
        try {
          const result = await askBiggy(message, history, timezone, fixtureId, tier === "pro" || tier === "max", authorizeProposal, activeParlay);
          sendJson(res, 200, result, { "Cache-Control": "no-store" });
        } catch (error) {
          try { await refundChatUsage(principal, tier, parlayReserved, reservedAt); } catch { console.error("[api] Failed to refund chat usage"); }
          throw error;
        }
      } catch (err) {
        console.error("[api] POST /api/chat failed:", err);
        sendJson(res, 502, { error: "Biggy could not answer right now" });
      }
      return;
    }

    if (req.method === "GET" && url === "/api/chat-job") {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const jobId = requestUrl.searchParams.get("id") ?? "";
      const job = chatJobs.get(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Chat job not found" });
        return;
      }
      if (Date.now() - job.createdAt > 10 * 60_000) {
        chatJobs.delete(jobId);
        sendJson(res, 410, { error: "Chat job expired" });
        return;
      }
      sendJson(res, 200, job, { "Cache-Control": "no-store" });
      if (job.status !== "working") setTimeout(() => chatJobs.delete(jobId), 60_000);
      return;
    }

    if (req.method === "GET" && url === "/api/track-record") {
      try {
        const trackRecord = await Promise.race([
          getTrackRecordPayload(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("track-record timeout")), 12_000)
          ),
        ]);
        sendJson(res, 200, { trackRecord }, {
          "Cache-Control": "public, max-age=120",
        });
      } catch (err) {
        console.error("[api] /api/track-record failed:", err);
        sendJson(res, 502, { error: "Could not load track record" });
      }
      return;
    }

    if (req.method === "GET" && url === "/api/telegram-bot") {
      try {
        const bot = await getTelegramBotInfo();
        sendJson(res, 200, bot ?? { username: null, id: null }, {
          "Cache-Control": "no-store",
        });
      } catch (err) {
        console.error("[api] /api/telegram-bot failed:", err);
        sendJson(res, 502, { error: "Could not load bot info" });
      }
      return;
    }

    if (req.method === "POST" && url === "/api/solana-rpc") {
      await proxySolanaRpc(req, res);
      return;
    }

    if (req.method === "POST" && url === "/api/access") {
      try {
        const body = await readJsonBody<{ telegramAuth?: TelegramLoginPayload; googleCredential?: string }>(req);

        if (body.googleCredential) {
          const user = await verifyGoogleCredential(body.googleCredential);
          const current = await getVerifiedGoogleAccess(user);
          const preview = (plan: "monthly" | "yearly") => {
            const until = extendSubscriptionUntil(current.activeUntil, plan).toISOString();
            return { until, untilLabel: formatSubscriptionDate(until) };
          };
          sendJson(res, 200, { access: { subscribed: current.tier !== "free", tier: current.tier, activeUntil: current.activeUntil, activeUntilLabel: current.activeUntil ? formatSubscriptionDate(current.activeUntil) : null, renewPreview: { monthly: preview("monthly"), yearly: preview("yearly") } } }, { "Cache-Control": "no-store" });
          return;
        }

        if (!body.telegramAuth) {
          sendJson(res, 401, { error: "Please sign in to check subscription access." });
          return;
        }

        const access = await getWebAccess(body.telegramAuth);
        sendJson(res, 200, { access }, { "Cache-Control": "no-store" });
      } catch (err) {
        console.error("[api] POST /api/access failed:", err);
        const message =
          err instanceof Error ? err.message : "Could not load access status";
        const status = message.includes("Invalid Telegram") ? 401 : 502;
        sendJson(res, status, { error: message });
      }
      return;
    }

    if (req.method === "POST" && url === "/api/checkout") {
      try {
        const body = await readJsonBody<{
          plan?: string;
          tier?: string;
          telegramAuth?: TelegramLoginPayload;
          googleCredential?: string;
        }>(req);

        const plan = body.plan;
        if (plan !== "monthly" && plan !== "yearly") {
          sendJson(res, 400, { error: "Invalid plan" });
          return;
        }

        const tier = body.tier ?? "pro";
        if (tier !== "pro" && tier !== "max") {
          sendJson(res, 400, { error: "Invalid subscription tier" });
          return;
        }

        let session;
        if (body.googleCredential) {
          const user = await verifyGoogleCredential(body.googleCredential);
          await upsertGoogleAccount(user);
          session = await startGoogleCheckout(user.sub, plan, tier);
        } else if (body.telegramAuth) {
          session = await startWebCheckout(plan, tier, body.telegramAuth);
        } else {
          sendJson(res, 401, { error: "Please sign in to continue." });
          return;
        }
        sendJson(res, 200, { checkout: session });
      } catch (err) {
        console.error("[api] POST /api/checkout failed:", err);
        const message =
          err instanceof Error ? err.message : "Could not start checkout";
        const status = message.includes("Invalid Telegram") ? 401 : 502;
        sendJson(res, status, { error: message });
      }
      return;
    }

    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const avatarMatch = parsedUrl.pathname.match(/^\/api\/telegram-avatar\/(\d+)$/);
    if (req.method === "GET" && avatarMatch) {
      try {
        const freshPhoto = parsedUrl.searchParams.get("photo");
        await serveTelegramAvatar(
          Number(avatarMatch[1]!),
          res,
          freshPhoto
        );
      } catch (err) {
        console.error("[api] GET /api/telegram-avatar failed:", err);
        sendJson(res, 502, { error: "Could not load avatar" });
      }
      return;
    }

    const checkoutMatch = parsedUrl.pathname.match(/^\/api\/checkout\/([^/]+)$/);
    if (req.method === "GET" && checkoutMatch) {
      try {
        const session = await getGoogleCheckout(checkoutMatch[1]!) ?? await getCheckoutSession(checkoutMatch[1]!);
        if (!session) {
          sendJson(res, 404, { error: "Checkout not found" });
          return;
        }
        sendJson(res, 200, { checkout: session }, {
          "Cache-Control": "no-store",
        });
      } catch (err) {
        console.error("[api] GET /api/checkout failed:", err);
        sendJson(res, 502, { error: "Could not load checkout" });
      }
      return;
    }

    res.writeHead(404, CORS_HEADERS);
    res.end();
  });

  server.listen(port, host, () => {
    console.log(`API listening on 0.0.0.0:${port}`);
  });

  // Don't let hung upstreams keep sockets open forever (Railway looks "offline").
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 10_000;

  return server;
}
