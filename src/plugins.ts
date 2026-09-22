// plugins.ts — which app packs are switched on, remembered across restarts.
//
// WHY THIS EXISTS: the core of droidread is generic Android — look at the screen, tap by
// ref, swipe, type, open an app. Everything beyond that is per-app knowledge, and every
// app pack you switch on costs the model context for tools it may never call. So apps are
// plugins: on or off, chosen by the operator, remembered in ~/.droidread/plugins.json.
//
// The MCP SDK lets a registered tool be enabled and disabled at runtime and notifies the
// client each time, so toggling one takes effect immediately with no restart.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { DATA_DIR, ensureDirs } from "./paths.ts";

export const PLUGIN_CONFIG = `${DATA_DIR}/plugins.json`;

export interface PluginMeta {
  id: string;
  name: string;
  packages: string[];       // Android packages this pack knows about
  summary: string;          // one line, shown when listing
  toolNames: string[];      // filled in as tools register
  verified: string;         // device and build the ground truth came from
}

type Config = { enabled: Record<string, boolean> };

function read(): Config {
  if (!existsSync(PLUGIN_CONFIG)) return { enabled: {} };
  try {
    const parsed = JSON.parse(readFileSync(PLUGIN_CONFIG, "utf8")) as Partial<Config>;
    return { enabled: parsed.enabled ?? {} };
  } catch {
    // A corrupt config must not take the server down; defaults are safe and the operator
    // finds out the moment they list plugins.
    process.stderr.write(`[droidread] ${PLUGIN_CONFIG} is unreadable — using defaults\n`);
    return { enabled: {} };
  }
}

function write(c: Config): void {
  ensureDirs();
  writeFileSync(PLUGIN_CONFIG, JSON.stringify(c, null, 2) + "\n");
}

/**
 * Default ON. A plugin only exists because someone established ground truth for that app,
 * so the useful default is "available"; an operator who wants a smaller tool surface turns
 * off what they do not need, and that choice is what gets remembered.
 */
export function isEnabled(id: string): boolean {
  return read().enabled[id] ?? true;
}

export function setEnabled(id: string, on: boolean): void {
  const c = read();
  c.enabled[id] = on;
  write(c);
}

export function allSettings(): Record<string, boolean> {
  return read().enabled;
}
