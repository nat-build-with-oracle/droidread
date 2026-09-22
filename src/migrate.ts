// migrate.ts — numbered .sql files, applied once, tracked in _migrations.

import { readdir, readFile } from "node:fs/promises";
import type { Client } from "@libsql/client";

const MIGRATIONS_DIR = `${import.meta.dir}/migrations`;

export async function migrate(db: Client): Promise<{ applied: string[] }> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const already = new Set(
    (await db.execute("SELECT name FROM _migrations")).rows.map((r) => r.name as string),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const applied: string[] = [];
  for (const file of files) {
    if (already.has(file)) continue;
    const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, "utf8");
    // executeMultiple, NOT a hand-split on ';' — a CREATE TRIGGER body legitimately
    // contains semicolons, and splitting on them produces "incomplete input" errors.
    await db.executeMultiple(sql);
    await db.execute({ sql: "INSERT INTO _migrations (name) VALUES (?)", args: [file] });
    applied.push(file);
  }
  return { applied };
}
