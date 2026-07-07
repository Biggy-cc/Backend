import { dbAll, dbBatch, dbGet, dbRun } from "../db/client.js";
import type { PickTier } from "./types.js";
import type { DailyPicksBundle, MatchThesis } from "./validate.js";

export type StoredBatch = {
  version: number;
  thesis: MatchThesis[];
  picks: DailyPicksBundle["picks"];
  changeNote: string | null;
};

export async function loadStoredBatch(pickDate: string): Promise<StoredBatch | null> {
  const row = await dbGet<{
    version: number;
    thesis_json: string;
    picks_json: string;
    change_note: string | null;
  }>(
    `SELECT version, thesis_json, picks_json, change_note
     FROM daily_pick_batches WHERE pick_date = ? ORDER BY version DESC LIMIT 1`,
    pickDate
  );

  if (!row) return null;

  return {
    version: row.version,
    thesis: JSON.parse(row.thesis_json) as MatchThesis[],
    picks: JSON.parse(row.picks_json) as DailyPicksBundle["picks"],
    changeNote: row.change_note,
  };
}

export async function archiveCurrentPicks(
  pickDate: string,
  version: number
): Promise<void> {
  const rows = await dbAll<{
    pick_date: string;
    tier: PickTier;
    content: string;
    thesis_json: string | null;
    change_note: string | null;
  }>(`SELECT * FROM daily_picks WHERE pick_date = ?`, pickDate);

  for (const row of rows) {
    await dbRun(
      `INSERT OR REPLACE INTO daily_picks_history (pick_date, tier, version, content, thesis_json, change_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      row.pick_date,
      row.tier,
      version,
      row.content,
      row.thesis_json,
      row.change_note
    );
  }
}

export async function saveFullPickBundle(
  pickDate: string,
  version: number,
  tierContents: Array<{ tier: PickTier; content: string }>,
  thesis: MatchThesis[],
  picks: DailyPicksBundle["picks"],
  changeNote: string | null
): Promise<void> {
  const thesisJson = JSON.stringify(thesis);
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  for (const { tier, content } of tierContents) {
    statements.push({
      sql: `INSERT INTO daily_picks (pick_date, tier, content, version, thesis_json, change_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(pick_date, tier) DO UPDATE SET
         content = excluded.content,
         version = excluded.version,
         thesis_json = excluded.thesis_json,
         change_note = excluded.change_note,
         created_at = datetime('now')`,
      params: [pickDate, tier, content, version, thesisJson, changeNote],
    });
  }

  statements.push({
    sql: `INSERT OR REPLACE INTO daily_pick_batches (pick_date, version, thesis_json, picks_json, change_note, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    params: [
      pickDate,
      version,
      thesisJson,
      JSON.stringify(picks),
      changeNote,
    ],
  });

  await dbBatch(statements);
}

export async function savePickBatch(
  pickDate: string,
  tier: PickTier,
  content: string,
  version: number,
  thesisJson: string,
  changeNote: string | null
): Promise<void> {
  await dbRun(
    `INSERT INTO daily_picks (pick_date, tier, content, version, thesis_json, change_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(pick_date, tier) DO UPDATE SET
       content = excluded.content,
       version = excluded.version,
       thesis_json = excluded.thesis_json,
       change_note = excluded.change_note,
       created_at = datetime('now')`,
    pickDate,
    tier,
    content,
    version,
    thesisJson,
    changeNote
  );
}

export async function saveBatchSnapshot(
  pickDate: string,
  version: number,
  thesis: MatchThesis[],
  picks: DailyPicksBundle["picks"],
  changeNote: string | null
): Promise<void> {
  await dbRun(
    `INSERT OR REPLACE INTO daily_pick_batches (pick_date, version, thesis_json, picks_json, change_note, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    pickDate,
    version,
    JSON.stringify(thesis),
    JSON.stringify(picks),
    changeNote
  );
}

export async function getCachedPickContent(
  pickDate: string,
  tier: PickTier
): Promise<string | null> {
  const row = await dbGet<{ content: string }>(
    `SELECT content FROM daily_picks WHERE pick_date = ? AND tier = ?`,
    pickDate,
    tier
  );
  return row?.content ?? null;
}

export async function getPickMeta(pickDate: string): Promise<{
  version: number;
  changeNote: string | null;
} | null> {
  const row = await dbGet<{ version: number; change_note: string | null }>(
    `SELECT version, change_note FROM daily_picks WHERE pick_date = ? LIMIT 1`,
    pickDate
  );
  if (!row) return null;
  return { version: row.version, changeNote: row.change_note };
}
