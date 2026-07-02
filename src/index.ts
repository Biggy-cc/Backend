import "dotenv/config";
import { startBot } from "./bot/index.js";
import { startScheduler } from "./jobs/scheduler.js";
import { configuredLlmProviders } from "./picks/llm.js";

async function main() {
  const llm = configuredLlmProviders();
  console.log(
    "Biggy starting…",
    llm.length ? `LLM chain: ${llm.join(" → ")}` : "LLM: none configured"
  );  startScheduler();
  await startBot();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
