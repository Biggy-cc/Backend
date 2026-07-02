import "dotenv/config";
import { createGeminiClient, generateGrounded } from "../src/picks/gemini.js";

async function main() {
  const ai = createGeminiClient();
  const { text, sources } = await generateGrounded(
    ai,
    `Search for Brazil vs Japan World Cup 2026: injuries, head-to-head, recent form.
Reply in 3 bullet points only. Cite what you find.`
  );

  console.log("PASS: Grounded research works\n");
  console.log(text);
  if (sources.length) {
    console.log("\nSources:");
    for (const s of sources) {
      console.log(`• ${s.label}\n  ${s.url}`);
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  process.exit(1);
});
