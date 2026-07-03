import http from "node:http";
import { getUpcomingFixturesPayload } from "./fixtures.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function startApiServer(port: number) {
  const server = http.createServer(async (req, res) => {
    const url = req.url?.split("?")[0];

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method === "GET" && url === "/api/fixtures") {
      try {
        const fixtures = await getUpcomingFixturesPayload();
        res.writeHead(200, {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
        });
        res.end(JSON.stringify({ fixtures }));
      } catch (err) {
        console.error("[api] /api/fixtures failed:", err);
        res.writeHead(502, {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: "Could not load fixtures" }));
      }
      return;
    }

    if (req.method === "GET" && url === "/api/health") {
      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, CORS_HEADERS);
    res.end();
  });

  server.listen(port, () => {
    console.log(`Fixtures API listening on http://localhost:${port}`);
  });

  return server;
}
