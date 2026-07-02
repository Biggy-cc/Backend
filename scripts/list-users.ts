import "dotenv/config";
import { dbAll } from "../src/db/client.js";
import { formatAccessStatus, hasAccess, trialPicksRemaining } from "../src/db/users.js";

async function main() {
  const users = await dbAll<{
    telegram_id: number;
    username: string | null;
    trial_started_at: string;
    subscribed_until: string | null;
    early_bird: number;
    trial_picks_used: number;
    created_at: string;
  }>(`SELECT * FROM users ORDER BY created_at ASC`);

  if (users.length === 0) {
    console.log("No users in database.");
    return;
  }

  for (const u of users) {
    console.log("—".repeat(40));
    console.log("Telegram ID:", u.telegram_id);
    console.log("Username:", u.username ? `@${u.username}` : "(none)");
    console.log("Trial started:", u.trial_started_at);
    console.log("Subscribed until:", u.subscribed_until ?? "(not paid)");
    console.log("Access:", hasAccess(u) ? "yes" : "no");
    console.log("Status:", formatAccessStatus(u));
    console.log("Trial picks remaining:", trialPicksRemaining(u));
  }
}

main().catch(console.error);
