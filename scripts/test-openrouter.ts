import "dotenv/config";

async function main() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    console.log("FAIL: OPENROUTER_API_KEY not set");
    process.exit(1);
  }

  const model =
    process.env.OPENROUTER_MODEL ?? "google/gemma-4-26b-a4b-it:free";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer":
        process.env.OPENROUTER_HTTP_REFERER ?? "https://t.me/BiggyCCBot",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Biggy",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: 'Reply exactly: "OpenRouter OK"' }],
      max_tokens: 16,
      temperature: 0,
    }),
  });

  const body = await res.json();
  console.log("Model:", model);
  console.log("HTTP:", res.status);

  if (body.error) {
    console.log("FAIL:", body.error.message ?? JSON.stringify(body.error));
    process.exit(1);
  }

  console.log("PASS: OpenRouter is working today");
  console.log("Reply:", body.choices?.[0]?.message?.content?.trim());
}

main().catch((err) => {
  console.log("FAIL:", err.message ?? err);
  process.exit(1);
});
