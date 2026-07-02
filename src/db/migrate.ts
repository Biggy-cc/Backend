import { runMigrations } from "./client.js";

await runMigrations();
console.log("Database migrated:", process.env.DATABASE_PATH ?? "./data/biggy.db");
