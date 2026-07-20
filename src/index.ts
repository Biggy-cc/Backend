import "dotenv/config";
import { startBot } from "./bot/index.js";
import { runMigrations } from "./db/client.js";
import { ensurePicksForToday } from "./picks/generate.js";
import { startScheduler } from "./jobs/scheduler.js";
import { configuredLlmProviders } from "./picks/llm.js";
import { startApiServer } from "./api/server.js";

/** Bot/Telegram errors must never take down the public API. */
process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled rejection (keeping process alive):", reason);
});

async function main() {
  const llm = configuredLlmProviders();
  console.log(
    "Biggy starting…",
    llm.length ? `LLM chain: ${llm.join(" → ")}` : "LLM: none configured"
  );

  try {
    await runMigrations();
    console.log("[db] Migrations OK");
  } catch (err) {
    console.error("[db] Migration failed — API may have limited data:", err);
  }

  // API first so /api/health + /api/fixtures stay up even if pick warm hangs
  const apiPort = Number(process.env.PORT ?? process.env.FIXTURES_API_PORT ?? 8787);
  if (Number.isFinite(apiPort) && apiPort > 0) {
    startApiServer(apiPort);
  } else {
    console.error("[api] Invalid PORT — API not started");
  }

  startScheduler();
  void startBot();

  if (process.env.SKIP_STARTUP_PICKS?.trim() === "1") {
    console.log("[picks] SKIP_STARTUP_PICKS=1 — skipping startup warm-up");
  } else {
    // Defer so health checks pass Railway before any API-Football work
    setTimeout(() => {
      void ensurePicksForToday()
        .then(() => console.log("[picks] Startup warm-up done"))
        .catch((err) => console.error("[picks] Startup warm-up failed:", err));
    }, 5_000);
  }
}

main().catch((err) => {
  console.error("[startup] Fatal error:", err);
  process.exit(1);
});
