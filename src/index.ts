import "dotenv/config";
import { startBot } from "./bot/index.js";
import { runMigrations } from "./db/client.js";
import { ensurePicksForToday } from "./picks/generate.js";
import { startScheduler } from "./jobs/scheduler.js";
import { configuredLlmProviders } from "./picks/llm.js";
import { startApiServer } from "./api/server.js";
import { getFootballDataProvider } from "./providers/football.js";
import { isApiFootballFreeQuotaMode } from "./api-football/config.js";

/** Bot/Telegram errors must never take down the public API. */
process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled rejection (keeping process alive):", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught exception (keeping process alive):", err);
});

async function main() {
  const llm = configuredLlmProviders();
  console.log(
    "Biggy starting…",
    llm.length ? `LLM chain: ${llm.join(" → ")}` : "LLM: none configured"
  );
  console.log(
    `[boot] provider=${getFootballDataProvider()} db=${process.env.DATABASE_BACKEND ?? "sqlite"} port=${process.env.PORT ?? process.env.FIXTURES_API_PORT ?? "8787"}`
  );

  // CRITICAL for Railway: bind health BEFORE migrations / Telegram / picks.
  // If D1 or API-Football hangs, probes still get 200 and the service stays up.
  const apiPort = Number(process.env.PORT ?? process.env.FIXTURES_API_PORT ?? 8787);
  if (Number.isFinite(apiPort) && apiPort > 0) {
    startApiServer(apiPort);
  } else {
    console.error("[api] Invalid PORT — API not started");
  }

  try {
    await Promise.race([
      runMigrations(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("DB migration timeout (15s)")), 15_000)
      ),
    ]);
    console.log("[db] Migrations OK");
  } catch (err) {
    console.error("[db] Migration failed/timed out — API stays up with limited data:", err);
  }

  startScheduler();
  void startBot().catch((err) => console.error("[bot] start failed:", err));

  const skipStartup =
    process.env.SKIP_STARTUP_PICKS?.trim() === "1" ||
    (getFootballDataProvider() === "api-football" &&
      isApiFootballFreeQuotaMode() &&
      process.env.SKIP_STARTUP_PICKS?.trim() !== "0");

  if (skipStartup) {
    console.log(
      "[picks] Skipping startup warm-up (set SKIP_STARTUP_PICKS=0 to force). Cron will publish."
    );
  } else {
    setTimeout(() => {
      void ensurePicksForToday()
        .then(() => console.log("[picks] Startup warm-up done"))
        .catch((err) => console.error("[picks] Startup warm-up failed:", err));
    }, 8_000);
  }
}

main().catch((err) => {
  console.error("[startup] Fatal error:", err);
  // Still avoid hard-exit if API already listening — but fatal before listen must exit
  process.exit(1);
});
