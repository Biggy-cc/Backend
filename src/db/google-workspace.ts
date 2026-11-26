import { dbGet } from "./client.js";

export type Workspace = { chats: unknown[]; parlays: unknown[]; messages: unknown[]; activeChatId: string | null };

export async function readWorkspace(sub: string): Promise<{ revision: number; data: Workspace }> {
  const row = await dbGet<{ revision: number; data_json: string }>("SELECT revision, data_json FROM google_workspace WHERE google_sub = ?", sub);
  if (!row) return { revision: 0, data: { chats: [], parlays: [], messages: [], activeChatId: null } };
  return { revision: row.revision, data: JSON.parse(row.data_json) as Workspace };
}

/** Compare-and-swap: stale clients can never overwrite another device's saved work. */
export async function writeWorkspace(sub: string, expected: number, data: Workspace): Promise<number | null> {
  const encoded = JSON.stringify(data);
  const row = expected === 0
    ? await dbGet<{ revision: number }>("INSERT INTO google_workspace (google_sub, revision, data_json) VALUES (?, 1, ?) ON CONFLICT(google_sub) DO NOTHING RETURNING revision", sub, encoded)
    : await dbGet<{ revision: number }>("UPDATE google_workspace SET revision = revision + 1, data_json = ?, updated_at = datetime('now') WHERE google_sub = ? AND revision = ? RETURNING revision", encoded, sub, expected);
  return row?.revision ?? null;
}

export function validateWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.chats) || !Array.isArray(data.parlays) || !Array.isArray(data.messages)) return false;
  if (data.activeChatId !== null && typeof data.activeChatId !== "string") return false;
  if (data.chats.length > 100 || data.parlays.length > 100 || data.messages.length > 1000) return false;
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 900_000;
}
