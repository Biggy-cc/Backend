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

export function startApiServer(port: number) {
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
        const body = await readJsonBody<{ telegramAuth?: TelegramLoginPayload }>(req);

        if (!body.telegramAuth) {
          sendJson(res, 400, { error: "Telegram login required" });
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
          telegramAuth?: TelegramLoginPayload;
        }>(req);

        const plan = body.plan;
        if (plan !== "monthly" && plan !== "yearly") {
          sendJson(res, 400, { error: "Invalid plan" });
          return;
        }

        if (!body.telegramAuth) {
          sendJson(res, 400, { error: "Telegram login required" });
          return;
        }

        const session = await startWebCheckout(plan, body.telegramAuth);
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
        const session = await getCheckoutSession(checkoutMatch[1]!);
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

  server.listen(port, "0.0.0.0", () => {
    console.log(`API listening on 0.0.0.0:${port}`);
  });

  // Don't let hung upstreams keep sockets open forever (Railway looks "offline").
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 10_000;

  return server;
}
