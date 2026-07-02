import "dotenv/config";

async function main() {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) {
    console.log("FAIL: GROQ_API_KEY not set");
    process.exit(1);
  }

  const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: 'Reply exactly: "Groq OK"' }],
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

  console.log("PASS: Groq is working today");
  console.log("Reply:", body.choices?.[0]?.message?.content?.trim());
}

main().catch((err) => {
  console.log("FAIL:", err.message ?? err);
  process.exit(1);
});
