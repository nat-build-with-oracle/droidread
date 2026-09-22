// paths.ts — where extracted data lives.
//
// Default is ~/.droidread, OUTSIDE the repo. Chat content and photos pulled off a phone
// are private by nature; keeping them out of the working tree means they cannot be
// committed by accident even if .gitignore is wrong or someone clones and runs this.

import { homedir } from "node:os";
import { mkdirSync, readFileSync, existsSync } from "node:fs";

export const DATA_DIR = process.env.DROIDREAD_HOME ?? `${homedir()}/.droidread`;
export const DB_PATH = `${DATA_DIR}/chats.db`;
export const MEDIA_DIR = `${DATA_DIR}/media`;

export function ensureDirs(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
}

/**
 * Load ~/.droidread/.env into the environment, if present.
 *
 * WHY A FILE AND NOT THE MCP CLIENT CONFIG: an MCP server is launched by a client
 * (Claude Code, etc.) whose own config file is typically mode 644. A Turso auth token
 * pasted in there is world-readable. This file is expected to be 600, stays outside any
 * repo, and keeps the client config free of secrets.
 *
 * Real environment variables always win — this never overwrites what the caller set.
 */
export function loadEnvFile(): string | null {
  const path = `${DATA_DIR}/.env`;
  if (!existsSync(path)) return null;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
  return path;
}
