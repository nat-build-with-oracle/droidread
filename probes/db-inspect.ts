#!/usr/bin/env bun
// db-inspect.ts — what does the index contain, and does it agree with itself?
//
// The self-agreement check matters: a photo states its OWN time, so comparing that
// against the divider-derived sent_at is a free correctness test on timestamp inference.
// A mismatch means the divider assignment is wrong — which is exactly how the current
// known bug was caught.

import { openDb } from "../src/db.ts";
import { loadEnvFile, DATA_DIR } from "../src/paths.ts";

loadEnvFile();
const db = openDb();
const chat = process.argv[2];

console.log(`data dir: ${DATA_DIR}`);
console.log(`backend : ${process.env.TURSO_DATABASE_URL ? "turso cloud" : "local file"}\n`);

const totals = await db.execute(`SELECT kind, COUNT(*) AS n FROM messages GROUP BY kind`);
console.log("by kind:", totals.rows.map((r) => `${r.kind}=${r.n}`).join(", "));

const dated = await db.execute(`SELECT COUNT(*) AS n, SUM(sent_at IS NOT NULL) AS d FROM messages`);
console.log(`rows: ${dated.rows[0]!.n} | dated: ${dated.rows[0]!.d} | undated: ${Number(dated.rows[0]!.n) - Number(dated.rows[0]!.d)}`);

const range = await db.execute(`SELECT MIN(sent_at) AS a, MAX(sent_at) AS b FROM messages WHERE sent_at IS NOT NULL`);
console.log(`dated range: ${range.rows[0]!.a} -> ${range.rows[0]!.b}\n`);

// Photos state their own time; sent_at is inferred. They should agree.
console.log("=== photo self-check (own time vs inferred sent_at) ===");
const photos = await db.execute(
  chat
    ? { sql: `SELECT id, sender, media_when, sent_at, sent_at_raw FROM messages WHERE kind='photo' AND chat=? ORDER BY id`, args: [chat] }
    : `SELECT id, sender, media_when, sent_at, sent_at_raw FROM messages WHERE kind='photo' ORDER BY id`,
);
let agree = 0, disagree = 0, missing = 0;
for (const r of photos.rows) {
  const own = String(r.media_when ?? "");
  const raw = String(r.sent_at_raw ?? "");
  if (!own || !raw) { missing++; console.log(` #${r.id} ${String(r.sender || "(none)").padEnd(20)} own=${own || "-"} inferred=${raw || "NULL"}  [no comparison]`); continue; }
  // Compare on the time-of-day component, which both formats carry.
  const t1 = /(\d{1,2}:\d{2})/.exec(own)?.[1];
  const t2 = /(\d{1,2}:\d{2})/.exec(raw)?.[1];
  const ok = t1 && t2 && t1 === t2;
  if (ok) agree++; else disagree++;
  console.log(` #${r.id} ${String(r.sender || "(none)").padEnd(20)} own=${own.padEnd(18)} inferred=${raw.padEnd(18)} ${ok ? "OK" : "MISMATCH"}`);
}
console.log(`\nagree ${agree} · mismatch ${disagree} · uncomparable ${missing}`);
if (disagree > 0) console.log("timestamp inference is NOT trustworthy while mismatches exist.");
