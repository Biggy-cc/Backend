import "dotenv/config";

const key = process.env.DEEPSEEK_API_KEY?.trim();
if (!key) {
  console.error("No DEEPSEEK_API_KEY");
  process.exit(1);
}

const res = await fetch("https://api.deepseek.com/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "deepseek-chat",
    messages: [{ role: "user", content: "Reply exactly: DeepSeek OK" }],
    temperature: 0,
  }),
});

const body = await res.json();
console.log("HTTP", res.status);
if (body.error) {
  console.log("Error:", body.error.message ?? body.error);
} else {
  console.log("Reply:", body.choices?.[0]?.message?.content);
}
