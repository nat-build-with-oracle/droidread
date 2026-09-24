// line.ts — LINE, read through the accessibility tree.
//
// GROUND TRUTH, observed live on a Samsung SM-A146P (2026-09-22). Unlike Messenger, LINE
// keeps its resource-ids, so selectors here are ids rather than content-descriptions:
//
//   chat list          #name  #last_message  #date  #unread_message_count
//   conversation       #chat_ui_message_text  #chat_ui_row_timestamp
//                      #chat_ui_text_message_balloon_root  #chat_ui_row_thumbnail
//
// The two views share NO ids, which is how each is detected unambiguously.
//
// THE TRAP, and the reason this project reads trees rather than screenshots: the message
// text is on #chat_ui_message_text, NOT #chat_ui_row_text_message. The row and the balloon
// root are both empty containers. Filter on the row id and you get zero messages from a
// screen that plainly has them, with no error to tell you why.
//
// Rule 6: AI-assisted work by Nexus (AI) with Nat Weerawan. Reads only the operator's own
// device over their own authorised adb connection.

import { adb, tap, back, wake } from "../adb.ts";
import { dump, dumpSettled, type Node } from "../tree.ts";

export const LINE_PACKAGE = "jp.naver.line.android";

export interface LineMsg {
  text: string;
  time: string;       // as LINE renders it, e.g. "14:29"
  y: number;
  outgoing: boolean;  // your own messages sit on the right half of the screen
}

const onChatList = (nodes: Node[]) => nodes.some((n) => n.id === "name") && nodes.some((n) => n.id === "last_message");
// The message list itself, not a text bubble: a screen of only photos/videos/stickers has
// no #chat_ui_message_text at all, and keying on bubbles called that "not in a conversation".
const inConversation = (nodes: Node[]) =>
  nodes.some((n) => n.id === "chathistory_message_list" || n.id === "chat_ui_message_text" || n.id === "chat_ui_text_message_balloon_root");

let screenWidth = 0;
async function width(): Promise<number> {
  if (screenWidth) return screenWidth;
  const out = await adb("shell", "wm", "size");
  screenWidth = Number(/(\d+)x\d+/.exec(out)?.[1] ?? 1080);
  return screenWidth;
}

/** Messages visible right now. Sender side comes from geometry; LINE does not label it. */
export function extractLine(nodes: Node[], screenW: number): LineMsg[] {
  const out: LineMsg[] = [];
  for (const n of nodes) {
    if (n.id !== "chat_ui_message_text" || !n.text) continue;
    const near = nodes
      .filter((t) => t.id === "chat_ui_row_timestamp" && Math.abs(t.y - n.y) < 90)
      .sort((a, b) => Math.abs(a.y - n.y) - Math.abs(b.y - n.y));
    out.push({ text: n.text, time: near[0]?.text ?? "", y: n.y, outgoing: n.x1 > screenW / 2 });
  }
  return out.sort((a, b) => a.y - b.y);
}

const contentCount = (nodes: Node[]) =>
  nodes.filter((n) => n.id === "chat_ui_message_text" || n.id === "chat_ui_row_timestamp").length;

export async function dumpLine(): Promise<{ nodes: Node[]; settled: boolean; dumps: number }> {
  return dumpSettled(contentCount);
}

/** The chat list, for "what conversations exist". */
export async function listChats(): Promise<{ name: string; last: string; when: string; unread: string }[]> {
  const nodes = await dump();
  const rows: { name: string; last: string; when: string; unread: string }[] = [];
  for (const n of nodes) {
    if (n.id !== "name" || !n.text) continue;
    const near = (id: string) => nodes.filter((m) => m.id === id && Math.abs(m.y - n.y) < 120)
      .sort((a, b) => Math.abs(a.y - n.y) - Math.abs(b.y - n.y))[0]?.text ?? "";
    rows.push({ name: n.text, last: near("last_message"), when: near("date"), unread: near("unread_message_count") });
  }
  return rows;
}

/** Get to LINE's chat list from wherever the app happens to be. */
export async function toChatList(): Promise<void> {
  await wake();
  const acts = await adb("shell", "dumpsys", "activity", "activities");
  if (!new RegExp(`topResumedActivity=.*${LINE_PACKAGE.replace(/\./g, "\\.")}`).test(acts)) {
    await adb("shell", "monkey", "-p", LINE_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1");
    await Bun.sleep(3000);
  }
  for (let i = 0; i < 6; i++) {
    const nodes = await dump();
    if (onChatList(nodes)) return;
    // Exactly one back per attempt — a second press can leave the app entirely.
    if (inConversation(nodes)) { await back(); await Bun.sleep(1200); continue; }
    await Bun.sleep(800);
  }
  throw new Error("could not reach LINE's chat list — is LINE installed and unlocked?");
}

export async function openLineChat(target: string): Promise<void> {
  await toChatList();

  // Exact name wins; a substring is never tapped on its own. A loose case-insensitive
  // `includes` once opened "MIdS Student Affairs" for the target "sT" — a read-only group,
  // entered by accident because "St" sits inside "Student". Partial hits are collected and
  // reported, so the caller can pick the real name instead of the tool guessing.
  const partial = new Set<string>();
  const lower = target.toLowerCase();
  let lastPage = "";
  for (let i = 0; i < 12; i++) {
    const nodes = await dump();
    const names = nodes.filter((n) => n.id === "name" && n.text);
    const row = names.find((n) => n.text === target) ?? names.find((n) => n.text.toLowerCase() === lower);
    if (row) {
      await tap(row.x, row.y);
      await Bun.sleep(2200);
      // Verify: a coordinate read before the list scrolled lands on the wrong row.
      const opened = await dump();
      if (!inConversation(opened)) throw new Error("tap did not open a conversation — the list may have scrolled");
      const header = opened.find((n) => n.id === "header_title")?.text;
      if (header !== undefined && header !== row.text) throw new Error(`opened "${header}", not "${row.text}" — the list may have scrolled`);
      return;
    }
    for (const n of names) if (n.text.toLowerCase().includes(lower)) partial.add(n.text);
    const page = names.map((n) => n.text).join("\n");
    if (page === lastPage) break; // bottom of the list
    lastPage = page;
    await adb("shell", "input", "swipe", "540", "1800", "540", "700", "300");
    await Bun.sleep(600);
  }
  if (partial.size) throw new Error(`no chat named exactly "${target}" in LINE; partial matches: ${[...partial].map((p) => `"${p}"`).join(", ")} — pass the full name`);
  throw new Error(`chat not found in LINE: ${target}`);
}

export interface LineScreen {
  messages: LineMsg[];
  settled: boolean;
  dumps: number;
  inConversation: boolean;
}

/** One screen. No scrolling — the caller owns the loop. */
export async function readLineScreen(): Promise<LineScreen> {
  const { nodes, settled, dumps } = await dumpLine();
  return {
    messages: extractLine(nodes, await width()),
    settled,
    dumps,
    inConversation: inConversation(nodes),
  };
}
