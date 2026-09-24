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
import { isEnabled, setEnabled } from "../src/plugins.ts";
import { PLUGINS } from "./apps.ts";
import { openDb, search, listMessages, messagesSince, listAnchors } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { MEDIA_DIR, DATA_DIR, ensureDirs } from "../src/paths.ts";
import { screenshot } from "../src/screen.ts";
import { query, tapSelector, tapRef, typeIntoRef, swipe, pressKey, typeText, assertControlAllowed, openScreen, currentFocus, restartApp, SETTINGS_SCREENS } from "../src/control.ts";
import { dump, type Node, type Selector } from "../src/tree.ts";

// What is on screen, and where. Position is included so a scroll that shows the same rows
// shifted still counts as movement.
const screenSignature = (nodes: Node[]) =>
  nodes.filter((n) => n.text || n.desc).map((n) => `${n.text}|${n.desc}|${n.y}`).join("\n");

const APP = "messenger";
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const image = (data: Uint8Array, mimeType: string, caption: string) => ({
  content: [
    { type: "image" as const, data: Buffer.from(data).toString("base64"), mimeType },
    { type: "text" as const, text: caption },
  ],
});
/**
 * Every action returns the screen it produced.
 *
 * Acting blind and then looking is two round trips, and the gap between them is where
 * mistakes hide: the tap landed somewhere unexpected and nothing said so. Returning a
 * fresh snapshot with the receipt means the next decision is made from what is actually
 * on screen, with usable refs, and it halves the calls.
 *
 * Refs from the returned snapshot are the current ones — the older set is now stale.
 */
async function withScreen(receipt: string, want = true): Promise<string> {
  if (!want) return receipt;
  try {
    return `${receipt}\n\n--- screen now ---\n${await screenSnapshot({ refs: true })}`;
  } catch (e) {
    // A failed look must not turn a successful action into an error.
    return `${receipt}\n\n(could not snapshot: ${(e as Error).message})`;
  }
}

const snapshotOpt = { snapshot: z.boolean().optional().describe("return the screen after acting (default true)") };

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
    { ref: z.string().optional().describe("handle from droidread_snapshot, e.g. 'e12' — preferred"), ...snapshotOpt, ...selectorShape },
    ({ ref, snapshot, ...args }) => withDevice("droidread_tap", async () => {
      const el = ref ? await tapRef(ref) : await tapSelector(toSelector(args));
      await Bun.sleep(800);   // let the tap land before looking
      return text(await withScreen(`tapped ${el.role} ${JSON.stringify(el.name)} @${el.x},${el.y}`, snapshot ?? true));
    }),
  );

  server.tool(
    "droidread_swipe",
    "Swipe the screen. DIRECTION NAMES THE CONTENT, NOT THE FINGER: 'up' pulls content down so you see what is ABOVE (older messages in a chat; back toward the top of a list), 'down' shows what is BELOW (further down an inbox/chat list = older chats). So on a chat list sitting at its top, 'up' does nothing — use 'down'. If the screen did not change, the reply says so. DEFAULT IS GENTLE (600px/300ms) — this project's own proven-safe step for reading, where every message matters. A bigger 'pixels' throw is for a different job: hunting for a name in a long inbox, where skipping content is fine and speed is the point. Confusing the two cost a real read once: a short durationMs alone does NOT make a swipe gentle, because duration only changes fling speed, not how far the gesture travels — only 'pixels' does that. Requires DROIDREAD_ALLOW_CONTROL=1.",
    { direction: z.enum(["up", "down", "left", "right"]),
      pixels: z.number().optional().describe("how far the swipe travels (default 600 — gentle, safe for reading; ~1400 overshoots a full screen, for fast inbox search only)"),
      durationMs: z.number().optional().describe("how slow the swipe is (default 300); does NOT change distance — see 'pixels'"),
      ...snapshotOpt },
    ({ direction, pixels, durationMs, snapshot }) => withDevice("droidread_swipe", async () => {
      const before = screenSignature(await dump());
      await swipe(direction, durationMs ?? 300, pixels ?? 600);
      await Bun.sleep(600);
      // A swipe that moved nothing looks exactly like a swipe that worked unless someone
      // compares — and the usual cause is the wrong direction (e.g. 'up' on a list already
      // at its top), not a broken gesture. Say so, so the caller flips direction instead of
      // reaching for raw adb.
      const moved = screenSignature(await dump()) !== before;
      const receipt = moved
        ? `swiped ${direction}`
        : `swiped ${direction} — SCREEN DID NOT MOVE (already at the ${direction === "up" ? "top" : direction === "down" ? "bottom" : "edge"}? try the opposite direction)`;
      // Every action returns the screen it produced — swipe included. A swipe whose result
      // you cannot see is a blind step, and blind steps are how a caller ends up swiping
      // repeatedly hoping something appeared. Pass snapshot:false when you genuinely do not
      // need to look, for instance when a read tool follows immediately.
      return text(await withScreen(receipt, snapshot ?? true));
    }),
  );

  server.tool(
    "droidread_key",
    "Press a hardware key. NOTE: inside a chat, one 'back' returns to the inbox and a second leaves the app. Requires DROIDREAD_ALLOW_CONTROL=1.",
    { key: z.enum(["back", "home", "enter", "wake"]), ...snapshotOpt },
    ({ key, snapshot }) => withDevice("droidread_key", async () => {
      await pressKey(key);
      await Bun.sleep(900);
      return text(await withScreen(`pressed ${key}`, snapshot ?? true));
    }),
  );

  server.tool(
    "droidread_type",
    "Type ASCII text into the focused field. Does NOT press send. Non-ASCII (Thai, emoji) is refused rather than silently mangled — that needs an IME such as ADBKeyboard. Requires DROIDREAD_ALLOW_CONTROL=1.",
    { text: z.string().describe("ASCII text to type"),
      ref: z.string().optional().describe("focus this element first, by ref from the last snapshot"),
      ...snapshotOpt },
    ({ text: s, ref, snapshot }) => withDevice("droidread_type", async () => {
      const where = ref
        ? await typeIntoRef(ref, s).then((el) => `${el.role} ${JSON.stringify(el.name)}`)
        : (await typeText(s), "whatever had focus");
      await Bun.sleep(600);
      return text(await withScreen(`typed ${s.length} chars into ${where} (not sent)`, snapshot ?? true));
    }),
  );

  server.tool(
    "droidread_open",
    `Open a Settings screen or an app, by short name, intent action, or package. One step instead of home-launcher-scroll-tap, which depends on the launcher's layout and the device language. Verifies by reading the focused window afterwards rather than trusting the launch command, which reports success even for an activity it merely brought to the front. Short names: ${Object.keys(SETTINGS_SCREENS).join(", ")}. Requires DROIDREAD_ALLOW_CONTROL=1.`,
    { target: z.string().describe("short name (e.g. 'developer'), an android.settings.* action, or a package like com.facebook.orca"),
      ...snapshotOpt },
    ({ target, snapshot }) => withDevice("droidread_open", async () => {
      const r = await openScreen(target);
      return text(await withScreen(`opened ${r.target} (via ${r.via})\nfocused window: ${r.focus}`, snapshot ?? true));
    }),
  );

  server.tool(
    "droidread_restart_app",
    "Force-stop an app and launch it again, so it starts at its own front door instead of wherever it was left. Use this when an app resumed somewhere unexpected and backing out would be guesswork. Nothing is deleted — this is the same as swiping the app away from recents. Requires DROIDREAD_ALLOW_CONTROL=1.",
    { package: z.string().describe("package name, e.g. com.facebook.orca"), ...snapshotOpt },
    ({ package: pkg, snapshot }) => withDevice("droidread_restart_app", async () => {
      await restartApp(pkg);
      return text(await withScreen(`restarted ${pkg}\nfocused window: ${await currentFocus()}`, snapshot ?? true));
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

  // -------------------------------------------------------------------------
  // App packs. Registered either way, then disabled if the operator switched them
  // off — the SDK tells the client the list changed, so a toggle takes effect at once.
  // -------------------------------------------------------------------------
  const packs = PLUGINS.map((plugin) => {
    const tools = plugin.register(server, withDevice);
    const on = isEnabled(plugin.meta.id);
    if (!on) for (const t of tools) t.disable();
    return { plugin, tools, on };
  });

  const describePack = (p: typeof packs[number]) =>
    `${p.on ? "on " : "off"}  ${p.plugin.meta.id.padEnd(10)} ${p.plugin.meta.name}\n` +
    `     ${p.plugin.meta.summary}\n` +
    `     packages: ${p.plugin.meta.packages.join(", ")}\n` +
    `     tools: ${p.tools.length}  ·  ground truth: ${p.plugin.meta.verified}`;

  server.tool(
    "droidread_apps",
    "List the app packs and whether each is switched on. A pack is one app's tools — Messenger, LINE — on top of the generic Android core. Switching one off hides its tools so they stop costing context.",
    {},
    async () => text(
      `${packs.filter((p) => p.on).length} of ${packs.length} packs on\n\n` +
      packs.map(describePack).join("\n\n") +
      `\n\nToggle with droidread_app_enable / droidread_app_disable. The choice is remembered.`,
    ),
  );

  const toggle = (id: string, on: boolean) => {
    const pack = packs.find((p) => p.plugin.meta.id === id);
    if (!pack) {
      return text(`no pack called ${JSON.stringify(id)} — available: ${packs.map((p) => p.plugin.meta.id).join(", ")}`);
    }
    if (pack.on === on) return text(`${id} is already ${on ? "on" : "off"}`);
    for (const t of pack.tools) (on ? t.enable() : t.disable());
    pack.on = on;
    setEnabled(id, on);   // remembered in ~/.droidread/plugins.json
    return text(`${id} ${on ? "enabled" : "disabled"} — ${pack.tools.length} tools ${on ? "added" : "hidden"}, remembered for next time`);
  };

  server.tool(
    "droidread_app_enable",
    "Switch an app pack on, adding its tools immediately. The choice is remembered across restarts.",
    { app: z.string().describe("pack id, e.g. 'messenger' or 'line'") },
    async ({ app }) => toggle(app, true),
  );

  server.tool(
    "droidread_app_disable",
    "Switch an app pack off, hiding its tools so they stop costing context. The choice is remembered across restarts.",
    { app: z.string().describe("pack id, e.g. 'messenger' or 'line'") },
    async ({ app }) => toggle(app, false),
  );

  return server;
}
