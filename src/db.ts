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
  sentAt?: string;
  sentAtRaw?: string;
}

export interface InsertResult { inserted: number; skipped: number; dated: number }

export async function insertMessages(db: Client, app: string, chat: string, rows: MsgRow[]): Promise<InsertResult> {
  // rowsAffected is 1 for an upsert whether it inserted or updated, so it cannot tell
  // new from existing. Count the table before and after instead — one extra query for
  // the whole batch, rather than a wrong number reported per row.
  const countOf = async () =>
    Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM messages WHERE app = ? AND chat = ?`, args: [app, chat] })).rows[0]!.n);
  const before = await countOf();
  let processed = 0, dated = 0;
  for (const r of rows) {
    if (!r.text.trim()) continue;
    // Upsert rather than INSERT OR IGNORE: a re-read of history already indexed must be
    // able to FILL IN a timestamp that was missing, otherwise rows captured before
    // divider support existed would stay permanently undated. COALESCE keeps whatever
    // is already there — a later read never overwrites a known value with null.
    const res = await db.execute({
      sql: `INSERT INTO messages (app, chat, sender, text, kind, media_ref, media_when, media_file, sent_at, sent_at_raw)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (app, chat, sender, text, media_ref) DO UPDATE SET
              sent_at     = COALESCE(messages.sent_at, excluded.sent_at),
              sent_at_raw = COALESCE(messages.sent_at_raw, excluded.sent_at_raw),
              media_file  = COALESCE(messages.media_file, excluded.media_file)`,
      args: [app, chat, r.sender, r.text, r.kind ?? "text", r.mediaRef ?? "", r.mediaWhen ?? "",
             r.mediaFile ?? null, r.sentAt ?? null, r.sentAtRaw ?? null],
    });
    if (res.rowsAffected > 0) processed++;
    if (r.sentAt) dated++;
  }
  const inserted = (await countOf()) - before;
  return { inserted, skipped: processed - inserted, dated };
}

/** Keys already indexed for a chat, as "sender|text" — the recap stop-boundary. */
export async function getExistingKeys(db: Client, app: string, chat: string): Promise<Set<string>> {
  const res = await db.execute({
    sql: `SELECT sender, text FROM messages WHERE app = ? AND chat = ?`,
    args: [app, chat],
  });
  return new Set(res.rows.map((r) => `${r.sender as string}|${r.text as string}`));
}

/**
 * Resolve what a caller typed to the ONE chat name its rows are indexed under.
 *
 * Read-side tools describe their `chat` argument as a substring, but every query keys
 * on the exact name a read indexed under — so "Team" against "Team Chat" matched
 * nothing and reported 0 messages, indistinguishable from an empty chat. Exact match
 * wins; otherwise a case-insensitive substring must hit exactly one indexed chat.
 * Ambiguity is refused, not guessed — the rule messenger_open_chat applies on the phone.
 *
 * READ side only. Indexing keeps the caller's exact name: resolving there would file a
 * new chat's messages under an older chat whose name happens to contain it.
 */
export async function resolveChat(db: Client, app: string, chat: string): Promise<string> {
  if (!chat.trim()) throw new Error("chat name is empty");
  const res = await db.execute({
    sql: `SELECT chat FROM messages WHERE app = ? UNION SELECT chat FROM anchors WHERE app = ?`,
    args: [app, app],
  });
  const names = res.rows.map((r) => String(r.chat)).sort();
  if (names.includes(chat)) return chat;
  const needle = chat.toLocaleLowerCase();
  const hits = names.filter((n) => n.toLocaleLowerCase().includes(needle));
  if (hits.length === 1) return hits[0]!;
  const quote = (xs: string[]) => xs.slice(0, 20).map((x) => `"${x}"`).join(", ") + (xs.length > 20 ? ", …" : "");
  if (hits.length > 1) throw new Error(`"${chat}" matches ${hits.length} indexed ${app} chats — pass one exactly: ${quote(hits)}`);
  throw new Error(names.length
    ? `no indexed ${app} chat matches "${chat}" — indexed: ${quote(names)}`
    : `no ${app} chat indexed yet — run a read first`);
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
    sql: `SELECT id, sender, text, kind, media_when, media_file, sent_at, sent_at_raw FROM messages
          WHERE app = ? AND chat = ? ORDER BY id DESC LIMIT ?`,
    args: [app, chat, limit],
  });
  return res.rows.reverse();
}

/**
 * Messages sent at or after `since` (local "YYYY-MM-DD HH:MM:SS").
 * Rows with no known send time are reported separately rather than assumed to be
 * inside or outside the window — an undated row is unknown, not old.
 */
export async function messagesSince(db: Client, app: string, chat: string, since: string) {
  const inWindow = await db.execute({
    sql: `SELECT id, sender, text, kind, sent_at, sent_at_raw FROM messages
          WHERE app = ? AND chat = ? AND sent_at IS NOT NULL AND sent_at >= ?
          ORDER BY sent_at, id`,
    args: [app, chat, since],
  });
  const undated = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM messages WHERE app = ? AND chat = ? AND sent_at IS NULL`,
    args: [app, chat],
  });
  const total = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM messages WHERE app = ? AND chat = ?`,
    args: [app, chat],
  });
  return { rows: inWindow.rows, undated: Number(undated.rows[0]!.n), total: Number(total.rows[0]!.n) };
}

export async function upsertAnchors(db: Client, app: string, chat: string, anchors: { raw: string; sentAt: string | null }[]): Promise<number> {
  let n = 0;
  for (const a of anchors) {
    const res = await db.execute({
      sql: `INSERT INTO anchors (app, chat, raw, sent_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (app, chat, raw) DO UPDATE SET sent_at = COALESCE(anchors.sent_at, excluded.sent_at)`,
      args: [app, chat, a.raw, a.sentAt],
    });
    if (res.rowsAffected > 0) n++;
  }
  return n;
}

export async function listAnchors(db: Client, app: string, chat: string) {
  const res = await db.execute({
    sql: `SELECT raw, sent_at, first_seen FROM anchors WHERE app = ? AND chat = ? ORDER BY sent_at DESC, id DESC`,
    args: [app, chat],
  });
  return res.rows;
}
