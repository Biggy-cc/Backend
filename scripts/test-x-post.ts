import "dotenv/config";
import { runMigrations } from "../src/db/client.js";
import { todayPickDate } from "../src/picks/generate.js";
import { postDailyFreePick } from "../src/social/posts.js";
import { isXConfigured, postTweet } from "../src/social/x-client.js";

const mode = process.argv[2] ?? "ping";

async function main() {
  console.log("X configured:", isXConfigured());
  if (!isXConfigured()) {
    console.error("Missing X_API_* env vars in Backend/.env");
    process.exit(1);
  }

  if (mode === "ping") {
    const id = await postTweet(
      "⚽ Biggy X integration test — automated picks coming soon.\n\nt.me/BiggyCCBot"
    );
    console.log(id ? `Test tweet posted: https://x.com/i/web/status/${id}` : "Post failed");
    return;
  }

  if (mode === "daily") {
    await runMigrations();
    const ok = await postDailyFreePick(todayPickDate());
    console.log(ok ? "Daily free pick posted" : "Daily post skipped (no picks or already posted)");
    return;
  }

  console.log("Usage: npx tsx scripts/test-x-post.ts [ping|daily]");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
