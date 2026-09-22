// paths.ts — where extracted data lives.
//
// Default is ~/.droidread, OUTSIDE the repo. Chat content and photos pulled off a phone
// are private by nature; keeping them out of the working tree means they cannot be
// committed by accident even if .gitignore is wrong or someone clones and runs this.

import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

export const DATA_DIR = process.env.DROIDREAD_HOME ?? `${homedir()}/.droidread`;
export const DB_PATH = `${DATA_DIR}/chats.db`;
export const MEDIA_DIR = `${DATA_DIR}/media`;

export function ensureDirs(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
}
