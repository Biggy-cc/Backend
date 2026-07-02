import "dotenv/config";
import { createGeminiClient, generateGrounded } from "../src/picks/gemini.js";

async function main() {
  const ai = createGeminiClient();
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "Brazil vs Japan World Cup injuries - brief",
    config: { tools: [{ googleSearch: {} }] },
  });

  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  for (const c of chunks.slice(0, 5)) {
    console.log(JSON.stringify(c.web, null, 2));
    console.log("---");
  }
}

main();
