#!/usr/bin/env bun
// fix-photo-times.ts — photos state their own time; make sent_at agree with it.
//
// A one-off repair for rows indexed before "photo time wins" existed, and a safe thing
// to re-run any time: it only ever sets sent_at FROM media_when, which is Messenger's own
// caption, never from inference.

import { openDb } from "../src/db.ts";
import { loadEnvFile } from "../src/paths.ts";
import { migrate } from "../src/migrate.ts";
import { resolveSeparator } from "../src/time.ts";

loadEnvFile();
const db = openDb();
const { applied } = await migrate(db);
if (applied.length) console.log("migrations applied:", applied.join(", "));

const rows = await db.execute(`SELECT id, media_when, sent_at_raw FROM messages WHERE kind = 'photo' AND media_when <> ''`);
const now = new Date();
let fixed = 0, unchanged = 0, unresolved = 0;
for (const r of rows.rows) {
  const own = String(r.media_when);
  const resolved = resolveSeparator(own, now);
  if (!resolved) { unresolved++; console.log(` #${r.id} cannot resolve ${JSON.stringify(own)}`); continue; }
  if (String(r.sent_at_raw ?? "") === own) { unchanged++; continue; }
  await db.execute({ sql: `UPDATE messages SET sent_at = ?, sent_at_raw = ? WHERE id = ?`, args: [resolved, own, Number(r.id)] });
  fixed++;
}
console.log(`photos: ${fixed} corrected · ${unchanged} already right · ${unresolved} unresolvable`);
