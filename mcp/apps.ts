// apps.ts — the per-app plugin packs.
//
// The core tool set is generic Android: look, tap by ref, swipe, type, open an app. Every
// app beyond that is a PACK, switched on or off by the operator and remembered in
// ~/.droidread/plugins.json. Two reasons that matters:
//
//   1. Tools cost context. A model that will never touch LINE should not be carrying
//      LINE's tools in every request.
//   2. Selectors are app-specific and version-fragile. Keeping each app's knowledge in one
//      pack means a broken app breaks one pack, loudly, rather than the whole server.
//
// The MCP SDK can enable and disable a registered tool at runtime and notifies the client,
// so toggling a pack takes effect immediately without a restart.
//
// Rule 6: AI-assisted work by Nexus (AI) with Nat Weerawan.

import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { openConversation, readScreen, fetchMedia, REMOTE_MEDIA_DIR } from "../src/apps/messenger.ts";
import { openLineChat, readLineScreen, listChats, LINE_PACKAGE } from "../src/apps/line.ts";
import { openDb, insertMessages, getExistingKeys, pendingMedia, markMediaDownloaded, upsertAnchors } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { MEDIA_DIR, ensureDirs } from "../src/paths.ts";
import { screenSnapshot } from "../src/snapshot.ts";
import type { PluginMeta } from "../src/plugins.ts";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

async function db() {
  const d = openDb();
  await migrate(d);
  return d;
}

export interface AppPlugin {
  meta: Omit<PluginMeta, "toolNames">;
  register(server: McpServer, withDevice: <T>(tool: string, fn: () => Promise<T>) => Promise<T>): RegisteredTool[];
}

// ---------------------------------------------------------------------------

const messenger: AppPlugin = {
  meta: {
    id: "messenger",
    name: "Facebook Messenger",
    packages: ["com.facebook.orca"],
    summary: "Read and index Messenger conversations; mark and download photos.",
    verified: "Samsung SM-A146P, Messenger September 2026 build",
  },
  register(server, withDevice) {
    const APP = "messenger";
    const out: RegisteredTool[] = [];
    out.push(server.tool(
      "messenger_open_chat",
      "Open a Messenger conversation by name and stop there. Restarts Messenger first so it begins at the inbox rather than wherever it was left — pass fresh:false to skip that when the app is already on the inbox. Does NOT read or scroll: pair with messenger_read_screen and droidread_swipe, and decide for yourself when to stop. Requires DROIDREAD_ALLOW_CONTROL=1 when fresh is true.",
      { chat: z.string().describe("substring of the conversation name; use the name exactly as it appears, including Thai script"),
        fresh: z.boolean().optional().describe("restart the app first (default true)") },
      ({ chat, fresh }) => withDevice("messenger_open_chat", async () => {
        await openConversation(chat, { fresh: fresh ?? true });
        // Show the screen it landed on: the whole failure mode worth catching here is
        // opening the WRONG conversation, and the header makes that obvious at a glance.
        let screen = "";
        try { screen = `\n\n--- screen now ---\n${await screenSnapshot({ refs: true })}`; }
        catch (e) { screen = `\n\n(could not snapshot: ${(e as Error).message})`; }
        return text(`opened "${chat}" — now use messenger_read_screen, then droidread_swipe direction=up for older messages${screen}`);
      }),
    ));

    out.push(server.tool(
      "messenger_read_screen",
      "Index the messages VISIBLE RIGHT NOW in the open conversation, and report which are new. Does not scroll. Takes about 5 seconds. THIS IS THE LOOP PRIMITIVE: call it, then droidread_swipe direction=up, then call it again, and stop when you have what you need or when 'new' reaches 0. Driving the loop yourself means you see every screen, can stop early, and nothing is lost if you change your mind — unlike a tool that scrolls for five minutes and returns once.",
      { chat: z.string().describe("conversation name to index these messages under") },
      ({ chat }) => withDevice("messenger_read_screen", async () => {
        const d = await db();
        const r = await readScreen();
        if (r.onInboxNow) return text("not in a conversation — you are on the inbox. Use messenger_open_chat first.");

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
    ));

    out.push(server.tool(
      "messenger_media_pending",
      "List photos that are marked in the index but not yet downloaded. Read-only, does not touch the phone.",
      { chat: z.string().describe("substring of the conversation name") },
      async ({ chat }) => {
        const pend = await pendingMedia(await db(), APP, chat);
        if (!pend.length) return text("no photos pending download");
        return text(pend.map((r) => `#${r.id} ${r.sender} ${r.media_when}`).join("\n"));
      },
    ));

    out.push(server.tool(
      "messenger_media_fetch",
      "Download photos this chat has marked pending. VERY SLOW: each photo costs a tap/Save/back cycle of roughly 8 seconds and drives the real Messenger UI. Use a small cap. Waits if another caller is using the phone.",
      { chat: z.string().describe("substring of the conversation name"),
        cap: z.number().optional().describe("max photos to fetch this run (default 10)") },
      ({ chat, cap }) => withDevice("messenger_media_fetch", async () => {
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
    ));
    return out;
  },
};

// ---------------------------------------------------------------------------

const line: AppPlugin = {
  meta: {
    id: "line",
    name: "LINE",
    packages: [LINE_PACKAGE],
    summary: "Read LINE chat list and conversations. LINE keeps resource-ids, so selectors are ids.",
    verified: "Samsung SM-A146P, 2026-09-22",
  },
  register(server, withDevice) {
    const APP = "line";
    const out: RegisteredTool[] = [];

    out.push(server.tool(
      "line_chats",
      "List LINE conversations: name, last message, time, unread count. Read-only, does not open anything.",
      {},
      () => withDevice("line_chats", async () => {
        const rows = await listChats();
        if (!rows.length) return text("no chat rows found — LINE may not be on its chat list. Try line_open_chat, or check the phone is unlocked.");
        return text(rows.map((r) =>
          `${r.unread ? `(${r.unread}) ` : ""}${r.name}  ${r.when}\n    ${r.last}`).join("\n"));
      }),
    ));

    out.push(server.tool(
      "line_open_chat",
      "Open a LINE conversation by name and stop there. Does NOT read or scroll — pair with line_read_screen and droidread_swipe.",
      { chat: z.string().describe("substring of the conversation name") },
      ({ chat }) => withDevice("line_open_chat", async () => {
        await openLineChat(chat);
        let screen = "";
        try { screen = `\n\n--- screen now ---\n${await screenSnapshot({ refs: true })}`; }
        catch (e) { screen = `\n\n(could not snapshot: ${(e as Error).message})`; }
        return text(`opened "${chat}" in LINE — now use line_read_screen, then droidread_swipe direction=up for older messages${screen}`);
      }),
    ));

    out.push(server.tool(
      "line_read_screen",
      "Index the LINE messages VISIBLE RIGHT NOW, and report which are new. Does not scroll. THE LOOP PRIMITIVE: call it, swipe up, call again, stop when new reaches 0.",
      { chat: z.string().describe("conversation name to index these messages under") },
      ({ chat }) => withDevice("line_read_screen", async () => {
        const d = await db();
        const r = await readLineScreen();
        if (!r.inConversation) return text("not in a LINE conversation — use line_open_chat first");

        // LINE does not name the sender on a message row; side of the screen is all there
        // is, so "you" and "them" is the honest granularity here.
        const msgs = r.messages.map((m) => ({
          sender: m.outgoing ? "you" : "them",
          text: m.text,
          y: m.y,
          kind: "text" as const,
          sentAtRaw: m.time || undefined,
        }));

        const before = await getExistingKeys(d, APP, chat);
        const fresh = msgs.filter((m) => !before.has(`${m.sender}|${m.text}`));
        const res = await insertMessages(d, APP, chat, msgs);

        const body = msgs.map((m) =>
          `${before.has(`${m.sender}|${m.text}`) ? "  " : "+ "}${m.sentAtRaw ? m.sentAtRaw + "  " : ""}${m.sender}: ${m.text}`).join("\n");
        const hints = [
          `${msgs.length} on screen · ${fresh.length} new (${res.inserted} inserted)`,
          r.settled ? "" : `tree did not settle after ${r.dumps} dumps — this screen may be incomplete`,
          fresh.length === 0 ? "nothing new here; one more swipe up, and if it is still 0 you have reached indexed history" : "",
        ].filter(Boolean).join("\n");
        return text(`${hints}\n\n${body}`);
      }),
    ));

    return out;
  },
};

// ---------------------------------------------------------------------------

export const PLUGINS: AppPlugin[] = [messenger, line];
