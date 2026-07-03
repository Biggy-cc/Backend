import "dotenv/config";
import { startBot } from "./bot/index.js";
import { startScheduler } from "./jobs/scheduler.js";
import { configuredLlmProviders } from "./picks/llm.js";
import { startApiServer } from "./api/server.js";

async function main() {
  const llm = configuredLlmProviders();
  console.log(
    "Biggy starting…",
    llm.length ? `LLM chain: ${llm.join(" → ")}` : "LLM: none configured"
  );
  startScheduler();

  const apiPort = Number(process.env.FIXTURES_API_PORT ?? 8787);
  if (Number.isFinite(apiPort) && apiPort > 0) {
    startApiServer(apiPort);
  }

  await startBot();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
