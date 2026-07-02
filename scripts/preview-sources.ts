import { db } from "../src/db/client.js";

const row = db
  .prepare(`SELECT content FROM daily_picks WHERE tier = 'aim' ORDER BY created_at DESC LIMIT 1`)
  .get() as { content: string };

const tail = row.content.slice(row.content.indexOf("📰"));
console.log(tail);
