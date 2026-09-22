#!/usr/bin/env bun
// server.ts — droidread as an MCP server.
//
// Runs LOCALLY, where adb is. That is the whole design: the phone, the database and the
// photos never leave the machine, and the MCP client only ever sees what it asks for.
//
// Rule 6: AI-assisted work by Nexus (AI) with Nat Weerawan. Reads only the operator's own
// device over their own authorised adb connection.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { devices, adb } from "../src/adb.ts";
import { screenSnapshot } from "../src/snapshot.ts";
import { openConversation, readThread, fetchMedia, REMOTE_MEDIA_DIR } from "../src/apps/messenger.ts";
import { openDb, insertMessages, getExistingKeys, pendingMedia, markMediaDownloaded, search, listMessages } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { MEDIA_DIR, DATA_DIR, ensureDirs, loadEnvFile } from "../src/paths.ts";

loadEnvFile();  // ~/.droidread/.env, before any client is constructed
import { query, tapSelector, swipe, pressKey, typeText, assertControlAllowed } from "../src/control.ts";
import type { Selector } from "../src/tree.ts";

const APP = "messenger";
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

async function db() {
  const d = openDb();
  await migrate(d);
  return d;
}

const server = new McpServer({ name: "droidread", version: "0.1.0" });

server.tool(
  "droidread_devices",
  "List Android devices reachable over adb. Use this first to confirm the phone is connected.",
  {},
  async () => {
    const d = await devices();
    return text(d.length ? d.join("\n") : "no devices — check `adb devices` and USB/wireless debugging");
  },
);

server.tool(
  "droidread_where",
  "Show where extracted data is stored and whether it syncs to a cloud database.",
  {},
  async () => {
    ensureDirs();
    return text(`data dir : ${DATA_DIR}\nmedia    : ${MEDIA_DIR}\ncloud    : ${
      process.env.TURSO_DATABASE_URL ? "TURSO_DATABASE_URL set — index syncs to cloud" : "local only"}`);
  },
);

server.tool(
  "droidread_snapshot",
  "Readable accessibility-tree snapshot of whatever is on the phone screen right now. Shows which elements are clickable. Cheap and read-only — no taps.",
  { grep: z.string().optional().describe("case-insensitive regex to filter lines"),
    all: z.boolean().optional().describe("include structural nodes with no text") },
  async ({ grep, all }) => {
    let out = await screenSnapshot({ all });
    if (grep) { const re = new RegExp(grep, "i"); out = out.split("\n").filter((l) => re.test(l)).join("\n"); }
    return text(out || "(nothing matched)");
  },
);

server.tool(
  "droidread_read",
  "Open a Messenger conversation and read its recent messages, indexing them. SLOW: drives the real UI and scrolls, expect ~1s per screen. Photos are marked, not downloaded.",
  { chat: z.string().describe("substring of the conversation name"),
    n: z.number().optional().describe("how many messages to collect (default 100)") },
  async ({ chat, n }) => {
    const d = await db();
    await openConversation(chat);
    const { messages, ending } = await readThread(chat, { want: n ?? 100 });
    const res = await insertMessages(d, APP, chat, messages);
    const body = messages.map((m) => `${m.kind === "photo" ? "[photo] " : ""}${m.sender}: ${m.text}`).join("\n");
    return text(`${messages.length} messages · ${res.inserted} new, ${res.skipped} already indexed\nending: ${ending}\n\n${body}`);
  },
);

server.tool(
  "droidread_recap",
  "Read ONLY messages newer than what is already indexed, stopping as soon as it reaches known history. Much faster than droidread_read for keeping an existing index current.",
  { chat: z.string().describe("substring of the conversation name") },
  async ({ chat }) => {
    const d = await db();
    const known = await getExistingKeys(d, APP, chat);
    await openConversation(chat);
    const { messages, ending } = await readThread(chat, { want: 0, known });
    const res = await insertMessages(d, APP, chat, messages);
    const body = messages.map((m) => `${m.kind === "photo" ? "[photo] " : ""}${m.sender}: ${m.text}`).join("\n");
    return text(`known before: ${known.size}\nnew: ${messages.length} (${res.inserted} inserted)\nending: ${ending}\n\n${body}`);
  },
);

server.tool(
  "droidread_media_pending",
  "List photos that are marked in the index but not yet downloaded. Read-only, does not touch the phone.",
  { chat: z.string().describe("substring of the conversation name") },
  async ({ chat }) => {
    const pend = await pendingMedia(await db(), APP, chat);
    if (!pend.length) return text("no photos pending download");
    return text(pend.map((r) => `#${r.id} ${r.sender} ${r.media_when}`).join("\n"));
  },
);

server.tool(
  "droidread_media_fetch",
  "Download photos this chat has marked pending. VERY SLOW: each photo costs a tap/Save/back cycle of roughly 8 seconds and drives the real Messenger UI. Use a small cap.",
  { chat: z.string().describe("substring of the conversation name"),
    cap: z.number().optional().describe("max photos to fetch this run (default 10)") },
  async ({ chat, cap }) => {
    const d = await db();
    const pend = await pendingMedia(d, APP, chat);
    if (!pend.length) return text("no photos pending download");
    const refToId = new Map(pend.map((r) => [String(r.media_ref), Number(r.id)]));

    await openConversation(chat);
    const saved = await fetchMedia({ wanted: new Set(refToId.keys()), cap: cap ?? 10 });

    ensureDirs();
    const pull = Bun.spawn([process.env.DROIDREAD_ADB ?? "adb", "pull", REMOTE_MEDIA_DIR, MEDIA_DIR], { stdout: "pipe", stderr: "pipe" });
    await pull.exited;

    let updated = 0;
    for (const s of saved) {
      const id = refToId.get(s.ref);
      if (!id) continue;
      await markMediaDownloaded(d, id, `${MEDIA_DIR}/Messenger/${s.file}`);
      updated++;
    }
    return text(`saved ${saved.length}, db rows updated ${updated}\n${saved.map((s) => `${s.sender} ${s.when} -> ${s.file}`).join("\n")}`);
  },
);

server.tool(
  "droidread_search",
  "Full-text search across everything already indexed. Fast, local, does not touch the phone.",
  { query: z.string().describe("FTS5 query"),
    limit: z.number().optional().describe("max hits (default 20)") },
  async ({ query, limit }) => {
    const rows = await search(await db(), query, limit ?? 20);
    if (!rows.length) return text("no hits");
    return text(rows.map((r) => `[${r.chat}] ${r.sender}: ${String(r.text).slice(0, 120)}`).join("\n"));
  },
);

server.tool(
  "droidread_list",
  "Show indexed messages for a chat in chronological order. Does not touch the phone.",
  { chat: z.string().describe("substring of the conversation name"),
    n: z.number().optional().describe("how many (default 50)") },
  async ({ chat, n }) => {
    const rows = await listMessages(await db(), APP, chat, n ?? 50);
    if (!rows.length) return text("nothing indexed for that chat yet");
    return text(rows.map((r) => {
      const mark = r.kind === "photo" ? (r.media_file ? "[photo ✓] " : "[photo …] ") : "";
      return `${mark}${r.sender}: ${r.text}`;
    }).join("\n"));
  },
);

// ---------------------------------------------------------------------------
// Two-way half: query elements, then act on them by selector.
// Control tools require DROIDREAD_ALLOW_CONTROL=1 — see src/control.ts for why.
// ---------------------------------------------------------------------------

const selectorShape = {
  id: z.string().optional().describe("resource-id (Messenger strips these; usually empty)"),
  text: z.string().optional().describe("exact visible text"),
  textContains: z.string().optional().describe("substring of visible text"),
  desc: z.string().optional().describe("exact content-description"),
  descContains: z.string().optional().describe("substring of content-description"),
};

function toSelector(a: Record<string, string | undefined>): Selector {
  for (const k of ["id", "text", "textContains", "desc", "descContains"] as const) {
    if (a[k] !== undefined) return { [k]: a[k] } as Selector;
  }
  throw new Error("give exactly one of: id, text, textContains, desc, descContains");
}

server.tool(
  "droidread_query",
  "Find elements on the current screen matching a selector. Returns role, name, clickable and coordinates. Read-only — use this to see what is tappable before tapping it.",
  selectorShape,
  async (args) => {
    const found = await query(toSelector(args));
    if (!found.length) return text("no elements matched");
    return text(found.map((e) =>
      `${e.role} ${JSON.stringify(e.name)}${e.clickable ? " [clickable]" : ""} @${e.x},${e.y}`).join("\n"));
  },
);

server.tool(
  "droidread_tap",
  "Tap the single element matching a selector. Requires DROIDREAD_ALLOW_CONTROL=1. Refuses if the selector matches zero or multiple elements — it will not guess. Coordinates are resolved fresh, never reused.",
  selectorShape,
  async (args) => {
    const el = await tapSelector(toSelector(args));
    return text(`tapped ${el.role} ${JSON.stringify(el.name)} @${el.x},${el.y}`);
  },
);

server.tool(
  "droidread_swipe",
  "Swipe the screen. 'up' reveals older messages in a chat. Requires DROIDREAD_ALLOW_CONTROL=1.",
  { direction: z.enum(["up", "down", "left", "right"]),
    durationMs: z.number().optional().describe("swipe duration; lower is faster/longer throw") },
  async ({ direction, durationMs }) => {
    await swipe(direction, durationMs ?? 250);
    return text(`swiped ${direction}`);
  },
);

server.tool(
  "droidread_key",
  "Press a hardware key. NOTE: inside a chat, one 'back' returns to the inbox and a second leaves the app. Requires DROIDREAD_ALLOW_CONTROL=1.",
  { key: z.enum(["back", "home", "enter", "wake"]) },
  async ({ key }) => { await pressKey(key); return text(`pressed ${key}`); },
);

server.tool(
  "droidread_type",
  "Type ASCII text into the focused field. Does NOT press send. Non-ASCII (Thai, emoji) is refused rather than silently mangled — that needs an IME such as ADBKeyboard. Requires DROIDREAD_ALLOW_CONTROL=1.",
  { text: z.string().describe("ASCII text to type") },
  async ({ text: s }) => { await typeText(s); return text(`typed ${s.length} chars (not sent)`); },
);

server.tool(
  "droidread_control_status",
  "Report whether write control (tap/swipe/type/keys) is currently enabled.",
  {},
  async () => {
    try { assertControlAllowed(); return text("control ENABLED (DROIDREAD_ALLOW_CONTROL=1)"); }
    catch (e) { return text(`control DISABLED — ${(e as Error).message}`); }
  },
);

await server.connect(new StdioServerTransport());
