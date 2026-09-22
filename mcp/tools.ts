// tools.ts — every droidread MCP tool, registered onto a fresh McpServer.
//
// Shared by both transports: mcp/server.ts (stdio, one local client) and mcp/http.ts
// (Streamable HTTP, many clients over LAN or VPN). Each connected client gets its own
// McpServer; the DEVICE LOCK below is module-global, so however many clients connect,
// only one of them drives the phone at a time.
//
// Never write to stdout from here: in stdio mode stdout IS the protocol channel.
//
// Rule 6: AI-assisted work by Nexus (AI) with Nat Weerawan. Reads only the operator's own
// device over their own authorised adb connection.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { devices } from "../src/adb.ts";
import { screenSnapshot, refCount } from "../src/snapshot.ts";
import { openConversation, readScreen, fetchMedia, REMOTE_MEDIA_DIR } from "../src/apps/messenger.ts";
import { openDb, insertMessages, getExistingKeys, pendingMedia, markMediaDownloaded, search, listMessages, messagesSince, upsertAnchors, listAnchors } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { MEDIA_DIR, DATA_DIR, ensureDirs } from "../src/paths.ts";
import { screenshot } from "../src/screen.ts";
import { query, tapSelector, tapRef, typeIntoRef, swipe, pressKey, typeText, assertControlAllowed, openScreen, currentFocus, SETTINGS_SCREENS } from "../src/control.ts";
import type { Selector } from "../src/tree.ts";

const APP = "messenger";
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const image = (data: Uint8Array, mimeType: string, caption: string) => ({
  content: [
    { type: "image" as const, data: Buffer.from(data).toString("base64"), mimeType },
    { type: "text" as const, text: caption },
  ],
});
const log = (s: string) => process.stderr.write(`[droidread ${new Date().toISOString().slice(11, 19)}] ${s}\n`);

async function db() {
  const d = openDb();
  await migrate(d);
  return d;
}

// ---------------------------------------------------------------------------
// Device lock.
//
// There is ONE phone. Two agents scrolling it at once would corrupt each other's read:
// uiautomator dumps taken mid-scroll, continuity checks failing for no reason, one
// agent's tap landing in the conversation the other just opened. Every tool that
// touches the phone runs through here in arrival order. Tools that only read the index
// never wait.
// ---------------------------------------------------------------------------
let chain: Promise<unknown> = Promise.resolve();
let busy: { tool: string; since: number } | null = null;
let queued = 0;

export function deviceStatus(): string {
  if (!busy) return "idle";
  const secs = Math.round((Date.now() - busy.since) / 1000);
  return `busy — ${busy.tool} running for ${secs}s${queued ? `, ${queued} waiting` : ""}`;
}

function withDevice<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  queued++;
  const run = chain.then(async () => {
    queued--;
    busy = { tool, since: Date.now() };
    log(`${tool} start${queued ? ` (${queued} still waiting)` : ""}`);
    try { return await fn(); }
    finally {
      log(`${tool} done in ${Math.round((Date.now() - busy.since) / 1000)}s`);
      busy = null;
    }
  });
  chain = run.catch(() => {}); // one failure must not poison the queue for the next caller
  return run;
}

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

/** A fresh McpServer with every droidread tool registered. One per connected client. */
export function buildServer(): McpServer {
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
    "Show where extracted data is stored, whether it syncs to a cloud database, and whether the phone is currently busy serving another caller.",
    {},
    async () => {
      ensureDirs();
      return text(`data dir : ${DATA_DIR}\nmedia    : ${MEDIA_DIR}\ncloud    : ${
        process.env.TURSO_DATABASE_URL ? "TURSO_DATABASE_URL set — index syncs to cloud" : "local only"}\ndevice   : ${deviceStatus()}`);
    },
  );

  server.tool(
    "droidread_snapshot",
    "Readable accessibility-tree snapshot of the phone screen, as a nested tree. Every actionable element gets a [ref=eN] handle — pass that to droidread_tap or droidread_type instead of coordinates, which go stale the moment anything scrolls. Refs belong to the LATEST snapshot: take a new one after anything that changes the screen. Cheap and read-only.",
    { grep: z.string().optional().describe("case-insensitive regex to filter lines; NOTE refs are still assigned from the full tree"),
      all: z.boolean().optional().describe("include structural nodes with no text") },
    ({ grep, all }) => withDevice("droidread_snapshot", async () => {
      let out = await screenSnapshot({ all, refs: true });
      const total = refCount();
      if (grep) { const re = new RegExp(grep, "i"); out = out.split("\n").filter((l) => re.test(l)).join("\n"); }
      return text((out || "(nothing matched)") + `\n\n${total} actionable elements have refs`);
    }),
  );

  server.tool(
    "droidread_screenshot",
    "PICTURE of the phone screen right now, as an image. Use this when the accessibility tree is not enough: photos, stickers, unlabelled dialogs, or checking that a tap did what you meant. Read-only. droidread_snapshot is far cheaper and is what you act on by selector — reach for the image second, not first.",
    { width: z.number().optional().describe("downscale width in px (default 540; 0 = original PNG, ~10x more tokens)"),
      quality: z.number().optional().describe("JPEG quality 2 (best) to 31 (worst), default 6") },
    // Deliberately NOT behind the device lock. A screenshot changes nothing, and the
    // whole point of being able to look is to look WHILE a long read is running — queueing
    // it behind a five-minute scroll would defeat that. With DROIDREAD_STREAM_URL set it
    // does not touch adb at all: the web viewer's capture loop already has the frame.
    async ({ width, quality }) => {
      const shot = await screenshot(width ?? 540, quality ?? 6);
      const kb = Math.round(shot.bytes / 1024);
      const via = shot.source === "stream" ? `via web viewer, frame ${shot.ageMs ?? 0}ms old` : "via adb screencap";
      return image(shot.data, shot.mime, `phone screen · ${shot.mime} · ${shot.width ? `${shot.width}px wide · ` : "original size · "}${kb} KB · ${via}`);
    },
  );

  server.tool(
    "droidread_open_chat",
    "Open a Messenger conversation by name and stop there. Does NOT read or scroll — pair it with droidread_read_screen and droidread_swipe, and decide for yourself when to stop.",
    { chat: z.string().describe("substring of the conversation name") },
    ({ chat }) => withDevice("droidread_open_chat", async () => {
      await openConversation(chat);
      return text(`opened "${chat}" — now use droidread_read_screen, then droidread_swipe direction=up for older messages`);
    }),
  );

  server.tool(
    "droidread_read_screen",
    "Index the messages VISIBLE RIGHT NOW in the open conversation, and report which are new. Does not scroll. Takes about 5 seconds. THIS IS THE LOOP PRIMITIVE: call it, then droidread_swipe direction=up, then call it again, and stop when you have what you need or when 'new' reaches 0. Driving the loop yourself means you see every screen, can stop early, and nothing is lost if you change your mind — unlike a tool that scrolls for five minutes and returns once.",
    { chat: z.string().describe("conversation name to index these messages under") },
    ({ chat }) => withDevice("droidread_read_screen", async () => {
      const d = await db();
      const r = await readScreen();
      if (r.onInboxNow) return text("not in a conversation — you are on the inbox. Use droidread_open_chat first.");

      const before = await getExistingKeys(d, APP, chat);
      const fresh = r.messages.filter((m) => !before.has(`${m.sender}|${m.text}`));
      const res = await insertMessages(d, APP, chat, r.messages);
      const na = await upsertAnchors(d, APP, chat, r.anchors);

      const body = r.messages.map((m) => {
        const mark = before.has(`${m.sender}|${m.text}`) ? "  " : "+ ";
        return `${mark}${m.sentAt ? String(m.sentAt).slice(0, 16) + "  " : ""}${m.kind === "photo" ? "[photo] " : ""}${m.sender}: ${m.text}`;
      }).join("\n");

      const hints = [
        `${r.messages.length} on screen · ${fresh.length} new (${res.inserted} inserted) · ${r.anchors.length} time dividers (${na} new)`,
        r.settled ? "" : `tree did not settle after ${r.dumps} dumps — this screen may be incomplete`,
        r.atTop ? "START OF CONVERSATION is visible — no more history above" : "",
        fresh.length === 0 ? "nothing new here; one more swipe up, and if it is still 0 you have reached indexed history" : "",
      ].filter(Boolean).join("\n");

      return text(`${hints}\n\n${body}`);
    }),
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
    "Download photos this chat has marked pending. VERY SLOW: each photo costs a tap/Save/back cycle of roughly 8 seconds and drives the real Messenger UI. Use a small cap. Waits if another caller is using the phone.",
    { chat: z.string().describe("substring of the conversation name"),
      cap: z.number().optional().describe("max photos to fetch this run (default 10)") },
    ({ chat, cap }) => withDevice("droidread_media_fetch", async () => {
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
    }),
  );

  server.tool(
    "droidread_anchors",
    "Every timestamp divider ever seen in a chat, newest first. These are the anchors a message's time is derived from; inspect them to see which hours of a day have activity. Does not touch the phone.",
    { chat: z.string().describe("substring of the conversation name") },
    async ({ chat }) => {
      const rows = await listAnchors(await db(), APP, chat);
      if (!rows.length) return text("no anchors recorded yet — run a read first");
      return text(`${rows.length} anchors\n` + rows.map((r) => `${String(r.sent_at ?? "unresolved").padEnd(20)} ${r.raw}`).join("\n"));
    },
  );

  server.tool(
    "droidread_since",
    "Count and list messages sent at or after a given local time, e.g. '2026-09-22 08:00'. Rows whose send time is unknown are reported separately and never assumed to be inside or outside the window. Does not touch the phone.",
    { chat: z.string().describe("substring of the conversation name"),
      since: z.string().describe("local time, 'YYYY-MM-DD HH:MM'") },
    async ({ chat, since }) => {
      const { rows, undated, total } = await messagesSince(await db(), APP, chat, since);
      const head = `${rows.length} messages at or after ${since} (of ${total} indexed; ${undated} have no known send time)`;
      if (!rows.length) return text(head);
      return text(head + "\n\n" + rows.map((r) =>
        `${String(r.sent_at).slice(0, 16)}  ${r.kind === "photo" ? "[photo] " : ""}${r.sender}: ${String(r.text).replace(/\n/g, " ").slice(0, 100)}`).join("\n"));
    },
  );

  server.tool(
    "droidread_search",
    "Full-text search across everything already indexed. Fast, local, does not touch the phone.",
    { query: z.string().describe("FTS5 query"),
      limit: z.number().optional().describe("max hits (default 20)") },
    async ({ query: q, limit }) => {
      const rows = await search(await db(), q, limit ?? 20);
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
  // Control tools require DROIDREAD_ALLOW_CONTROL=1 on the SERVER process — see
  // src/control.ts for why. A remote client cannot switch it on.
  // ---------------------------------------------------------------------------

  server.tool(
    "droidread_query",
    "Find elements on the current screen matching a selector. Returns role, name, clickable and coordinates. Read-only — use this to see what is tappable before tapping it.",
    selectorShape,
    (args) => withDevice("droidread_query", async () => {
      const found = await query(toSelector(args));
      if (!found.length) return text("no elements matched");
      return text(found.map((e) =>
        `${e.role} ${JSON.stringify(e.name)}${e.clickable ? " [clickable]" : ""} @${e.x},${e.y}`).join("\n"));
    }),
  );

  server.tool(
    "droidread_tap",
    "Tap an element, by ref from the last snapshot (preferred) or by selector. A ref is re-found in a FRESH dump by its identity before tapping, so a scroll between snapshot and tap is caught instead of silently hitting whatever moved into that spot. Refuses on zero or multiple matches rather than guessing. Requires DROIDREAD_ALLOW_CONTROL=1.",
    { ref: z.string().optional().describe("handle from droidread_snapshot, e.g. 'e12' — preferred"), ...selectorShape },
    ({ ref, ...args }) => withDevice("droidread_tap", async () => {
      const el = ref ? await tapRef(ref) : await tapSelector(toSelector(args));
      return text(`tapped ${el.role} ${JSON.stringify(el.name)} @${el.x},${el.y}\ntake a new snapshot — the old refs are stale now`);
    }),
  );

  server.tool(
    "droidread_swipe",
    "Swipe the screen. 'up' reveals older messages in a chat. Requires DROIDREAD_ALLOW_CONTROL=1.",
    { direction: z.enum(["up", "down", "left", "right"]),
      durationMs: z.number().optional().describe("swipe duration; lower is faster/longer throw") },
    ({ direction, durationMs }) => withDevice("droidread_swipe", async () => {
      await swipe(direction, durationMs ?? 250);
      return text(`swiped ${direction}`);
    }),
  );

  server.tool(
    "droidread_key",
    "Press a hardware key. NOTE: inside a chat, one 'back' returns to the inbox and a second leaves the app. Requires DROIDREAD_ALLOW_CONTROL=1.",
    { key: z.enum(["back", "home", "enter", "wake"]) },
    ({ key }) => withDevice("droidread_key", async () => { await pressKey(key); return text(`pressed ${key}`); }),
  );

  server.tool(
    "droidread_type",
    "Type ASCII text into the focused field. Does NOT press send. Non-ASCII (Thai, emoji) is refused rather than silently mangled — that needs an IME such as ADBKeyboard. Requires DROIDREAD_ALLOW_CONTROL=1.",
    { text: z.string().describe("ASCII text to type"),
      ref: z.string().optional().describe("focus this element first, by ref from the last snapshot") },
    ({ text: s, ref }) => withDevice("droidread_type", async () => {
      if (ref) { const el = await typeIntoRef(ref, s); return text(`typed ${s.length} chars into ${el.role} ${JSON.stringify(el.name)} (not sent)`); }
      await typeText(s);
      return text(`typed ${s.length} chars into whatever had focus (not sent)`);
    }),
  );

  server.tool(
    "droidread_open",
    `Open a Settings screen or an app, by short name, intent action, or package. One step instead of home-launcher-scroll-tap, which depends on the launcher's layout and the device language. Verifies by reading the focused window afterwards rather than trusting the launch command, which reports success even for an activity it merely brought to the front. Short names: ${Object.keys(SETTINGS_SCREENS).join(", ")}. Requires DROIDREAD_ALLOW_CONTROL=1.`,
    { target: z.string().describe("short name (e.g. 'developer'), an android.settings.* action, or a package like com.facebook.orca") },
    ({ target }) => withDevice("droidread_open", async () => {
      const r = await openScreen(target);
      return text(`opened ${r.target} (via ${r.via})\nfocused window: ${r.focus}`);
    }),
  );

  server.tool(
    "droidread_focus",
    "Which window has focus on the phone right now. The cheapest way to confirm where you are before acting. Read-only.",
    {},
    () => withDevice("droidread_focus", async () => text(await currentFocus())),
  );

  server.tool(
    "droidread_control_status",
    "Report whether write control (tap/swipe/type/keys) is currently enabled on the server.",
    {},
    async () => {
      try { assertControlAllowed(); return text("control ENABLED (DROIDREAD_ALLOW_CONTROL=1)"); }
      catch (e) { return text(`control DISABLED — ${(e as Error).message}`); }
    },
  );

  return server;
}
