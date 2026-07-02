import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("FAIL: GEMINI_API_KEY is missing from .env");
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt =
    'Reply with exactly: "Biggy Gemini OK" — nothing else.';

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  if (!text) {
    console.error("FAIL: Empty response from Gemini");
    process.exit(1);
  }

  console.log("PASS: Gemini API connected");
  console.log("Model: gemini-2.5-flash");
  console.log("Response:", text);
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  process.exit(1);
});
