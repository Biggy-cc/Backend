/** Full Biggy schema — used for fresh D1 databases and SQLite base tables. */
export const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  trial_started_at TEXT NOT NULL DEFAULT (datetime('now')),
  subscribed_until TEXT,
  early_bird INTEGER NOT NULL DEFAULT 0,
  trial_picks_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_payments (
  id TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('monthly', 'yearly')),
  amount_usdc REAL NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fulfilled_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_picks (
  pick_date TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('hit', 'aim', 'go_big')),
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  thesis_json TEXT,
  change_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pick_date, tier)
);

CREATE TABLE IF NOT EXISTS daily_picks_history (
  pick_date TEXT NOT NULL,
  tier TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  thesis_json TEXT,
  change_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pick_date, tier, version)
);

CREATE TABLE IF NOT EXISTS daily_pick_batches (
  pick_date TEXT NOT NULL,
  version INTEGER NOT NULL,
  thesis_json TEXT NOT NULL,
  picks_json TEXT NOT NULL,
  change_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pick_date, version)
);
`;

/** Legacy SQLite upgrades for databases created before versioning columns. */
export const SQLITE_ALTER_STATEMENTS = [
  `ALTER TABLE daily_picks ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE daily_picks ADD COLUMN thesis_json TEXT`,
  `ALTER TABLE daily_picks ADD COLUMN change_note TEXT`,
  `ALTER TABLE users ADD COLUMN trial_picks_used INTEGER NOT NULL DEFAULT 0`,
];
