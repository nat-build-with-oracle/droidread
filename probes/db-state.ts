#!/usr/bin/env bun
// db-state.ts — one-line health of the index: rows, dated coverage, anchors.
import { openDb } from "../src/db.ts";
import { loadEnvFile } from "../src/paths.ts";
loadEnvFile();
const db = openDb();
const m = await db.execute(`SELECT COUNT(*) AS n, SUM(sent_at IS NOT NULL) AS d FROM messages`);
const a = await db.execute(`SELECT COUNT(*) AS n FROM anchors`);
console.log(`messages ${m.rows[0]!.n} · dated ${m.rows[0]!.d} · anchors ${a.rows[0]!.n}`);
