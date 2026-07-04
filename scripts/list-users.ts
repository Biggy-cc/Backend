import "dotenv/config";
import { dbAll } from "../src/db/client.js";
import { formatAccessStatus, hasAccess, trialPicksRemaining, type UserRow } from "../src/db/users.js";

async function main() {
  const users = await dbAll<UserRow>(`SELECT * FROM users ORDER BY created_at ASC`);

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
