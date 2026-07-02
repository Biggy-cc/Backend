import "dotenv/config";
import {
  configuredLlmProviders,
  generateJsonLlm,
  generateTextLlm,
} from "../src/picks/llm.js";

async function main() {
  const providers = configuredLlmProviders();

  if (providers.length === 0) {
    console.error(
      "FAIL: Set at least one of GEMINI_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY"
    );
    process.exit(1);
  }

  console.log("Configured providers:", providers.join(" → "));

  const { text, provider: textProvider } = await generateTextLlm(
    'Reply with exactly: "Biggy LLM OK" — nothing else.'
  );
  console.log(`PASS: Text via ${textProvider}:`, text);

  const { result, provider: jsonProvider } = await generateJsonLlm<{
    status: string;
  }>('Return JSON: {"status":"ok"}');
  console.log(`PASS: JSON via ${jsonProvider}:`, result);
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  process.exit(1);
});
