// db.ts — libSQL store for extracted messages.
//
// Local by default: a plain file under ~/.droidread. Setting TURSO_DATABASE_URL and
// TURSO_AUTH_TOKEN points the SAME code at a Turso cloud database instead — same engine,
// same API, only the URL differs. Nothing is uploaded unless you set those.

import { createClient, type Client } from "@libsql/client";
import { DB_PATH, ensureDirs } from "./paths.ts";

export function openDb(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (url) return createClient({ url, authToken });
  ensureDirs();
  return createClient({ url: `file:${DB_PATH}` });
}

export interface MsgRow {
  sender: string;
  text: string;
  kind?: "text" | "photo";
  mediaRef?: string;
  mediaWhen?: string;
  mediaFile?: string | null;
}

export interface InsertResult { inserted: number; skipped: number }

export async function insertMessages(db: Client, app: string, chat: string, rows: MsgRow[]): Promise<InsertResult> {
  let inserted = 0, skipped = 0;
  for (const r of rows) {
    if (!r.text.trim()) continue;
    const res = await db.execute({
      sql: `INSERT OR IGNORE INTO messages (app, chat, sender, text, kind, media_ref, media_when, media_file)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [app, chat, r.sender, r.text, r.kind ?? "text", r.mediaRef ?? "", r.mediaWhen ?? "", r.mediaFile ?? null],
    });
    if (res.rowsAffected > 0) inserted++; else skipped++;
  }
  return { inserted, skipped };
}

/** Keys already indexed for a chat, as "sender|text" — the recap stop-boundary. */
export async function getExistingKeys(db: Client, app: string, chat: string): Promise<Set<string>> {
  const res = await db.execute({
    sql: `SELECT sender, text FROM messages WHERE app = ? AND chat = ?`,
    args: [app, chat],
  });
  return new Set(res.rows.map((r) => `${r.sender as string}|${r.text as string}`));
}

export async function pendingMedia(db: Client, app: string, chat: string) {
  const res = await db.execute({
    sql: `SELECT id, sender, media_ref, media_when FROM messages
          WHERE app = ? AND chat = ? AND kind = 'photo' AND media_file IS NULL AND media_ref <> ''
          ORDER BY id`,
    args: [app, chat],
  });
  return res.rows;
}

export async function markMediaDownloaded(db: Client, id: number, file: string) {
  await db.execute({ sql: `UPDATE messages SET media_file = ? WHERE id = ?`, args: [file, id] });
}

export async function search(db: Client, query: string, limit = 20) {
  const res = await db.execute({
    sql: `SELECT m.id, m.app, m.chat, m.sender, m.text, m.kind, m.extracted_at, bm25(messages_fts) AS rank
          FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
          WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
    args: [query, limit],
  });
  return res.rows;
}

export async function listMessages(db: Client, app: string, chat: string, limit: number) {
  const res = await db.execute({
    sql: `SELECT id, sender, text, kind, media_when, media_file FROM messages
          WHERE app = ? AND chat = ? ORDER BY id DESC LIMIT ?`,
    args: [app, chat, limit],
  });
  return res.rows.reverse();
}
