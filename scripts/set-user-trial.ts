import "dotenv/config";
import { dbGet, dbRun } from "../src/db/client.js";
import {
  formatAccessStatus,
  hasAccess,
  trialPickLimit,
  trialPicksRemaining,
  type UserRow,
} from "../src/db/users.js";

async function main() {
  const telegramId = Number(process.argv[2]);
  const remaining = Number(process.argv[3]);

  if (!Number.isFinite(telegramId) || !Number.isFinite(remaining) || remaining < 0) {
    console.error("Usage: npx tsx scripts/set-user-trial.ts <telegram_id> <picks_remaining>");
    process.exit(1);
  }

  const used = Math.max(0, trialPickLimit() - remaining);
  await dbRun(
    `UPDATE users SET trial_picks_used = ?, subscribed_until = NULL WHERE telegram_id = ?`,
    used,
    telegramId
  );

  const user = await dbGet<UserRow>(`SELECT * FROM users WHERE telegram_id = ?`, telegramId);
  if (!user) {
    console.error("User not found:", telegramId);
    process.exit(1);
  }

  console.log("Telegram ID:", user.telegram_id);
  console.log("Username:", user.username ? `@${user.username}` : "(none)");
  console.log("Trial limit:", trialPickLimit());
  console.log("Trial picks used:", user.trial_picks_used);
  console.log("Remaining:", trialPicksRemaining(user));
  console.log("Access:", hasAccess(user) ? "yes" : "no");
  console.log("Status:", formatAccessStatus(user));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
