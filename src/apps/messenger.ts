// messenger.ts — Facebook Messenger, read through the accessibility tree.
//
// GROUND TRUTH. Every selector below was read off a real dump on a Samsung SM-A146P,
// Messenger (Sept 2026 build). None of it is guessed, and all of it is version-fragile —
// if Messenger changes its content-desc strings these break loudly rather than silently.
//
//   text message   desc: "<Sender>, <body>, double-tap to see sent/receive date and
//                        time, double-tap and hold to react on message"
//   photo message  Button desc: "Received photo message" | "Sent photo message"
//   photo identity ViewGroup desc: "Forward photo sent by <Sender> on 16 Sept at 18:27"
//   photo viewer   Button desc: "Save"  (beside "Add to story", "More", "Close")
//   inbox marker   text contains "Ask Meta AI"  (absent inside a conversation)
//
// Messenger STRIPS resource-ids — every node reports "(name removed)" — so text and
// content-desc are the only usable selectors here.

import { adb, tap, back, wake, swipeUp, swipeDown } from "../adb.ts";
import { dump, match, type Node } from "../tree.ts";

export const SUFFIX = ", double-tap to see sent/receive date and time, double-tap and hold to react on message";
const PHOTO_RE = /(received|sent) photo message/i;
const META_RE = /^forward photo sent by (.+?) on (.+)$/i;
export const REMOTE_MEDIA_DIR = "/sdcard/Pictures/Messenger";

export interface Msg {
  sender: string;
  text: string;
  y: number;
  kind: "text" | "photo";
  mediaRef?: string;
  mediaWhen?: string;
}

/**
 * Every message on screen, text and photo alike.
 *
 * Photos carry NO text suffix, which is why a suffix-only parser silently returns a
 * text-only history and looks correct while doing it. They are MARKED here, never
 * downloaded — the tap->Save->back cycle costs ~8s each and has no business running
 * during a read.
 */
export function extract(nodes: Node[]): Msg[] {
  const out: Msg[] = [];
  const metas = nodes.filter((n) => META_RE.test(n.desc));

  for (const n of nodes) {
    if (n.desc.endsWith(SUFFIX)) {
      const body = n.desc.slice(0, -SUFFIX.length);
      const comma = body.indexOf(", ");
      if (comma < 0) continue;
      out.push({ sender: body.slice(0, comma), text: body.slice(comma + 2), y: n.y, kind: "text" });
      continue;
    }
    if (n.clickable && PHOTO_RE.test(n.desc)) {
      const near = metas.slice().sort((a, b) => Math.abs(a.y - n.y) - Math.abs(b.y - n.y))[0];
      const m = near ? META_RE.exec(near.desc) : null;
      const when = m?.[2] ?? "";
      out.push({
        sender: m?.[1] ?? "",
        text: `[photo] ${when}`.trim(),
        y: n.y,
        kind: "photo",
        mediaRef: near?.desc ?? "",
        mediaWhen: when,
      });
    }
  }
  return out;
}

export const onInbox = (nodes: Node[]) => match(nodes, { textContains: "Ask Meta AI" }).length > 0;

/** Get from wherever Messenger resumed to a named conversation, or throw. */
export async function openConversation(target: string): Promise<void> {
  await wake();

  // Messenger resumes into the last conversation, not the inbox. Exactly ONE back per
  // attempt — a second press leaves the app entirely.
  for (let i = 0; i < 5; i++) {
    if (onInbox(await dump())) break;
    await back();
    await Bun.sleep(1200);
  }

  // The visible "Unread X." node is often clickable=false; the wrapping Button carrying
  // desc "X, N new messages" is the real target. Tapping the former does nothing.
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    const nodes = await dump();
    const hit = nodes.find((n) => n.clickable && n.desc.toLowerCase().includes(target.toLowerCase()))
             ?? nodes.find((n) => n.clickable && n.text.toLowerCase().includes(target.toLowerCase()));
    if (hit) { await tap(hit.x, hit.y); await Bun.sleep(2500); opened = true; break; }
    await swipeDown(300);
    await Bun.sleep(700);
  }
  if (!opened) throw new Error(`chat not found: ${target}`);

  // Verify navigation actually happened. A stale coordinate can land on the wrong row if
  // the list scrolled between dump and tap — which silently reads the WRONG conversation.
  if (onInbox(await dump())) throw new Error("tap did not open a conversation — still on inbox");
}

export interface ReadOpts {
  want?: number;          // stop once this many messages are collected (0 = no limit)
  hardCap?: number;       // safety ceiling on scroll iterations
  stagnantStop?: number;  // consecutive no-new-content scrolls before giving up
  known?: Set<string>;    // stop on contact with already-indexed history (recap mode)
}

export interface ReadResult { messages: Msg[]; ending: string; hitKnown: boolean }

/**
 * Read a conversation by scrolling UP from the newest message.
 *
 * Ordering: screens are captured newest-first and each screen is oldest-first internally,
 * so reversing the screen order yields true chronological order. Merging everything into
 * one Map instead (first-seen order) produces an unreadable interleaved log.
 *
 * HONEST LIMITATION: "reached top" is inferred from content no longer changing, and that
 * is NOT a reliable signal — a slow lazy-load fetch looks identical to the end of history.
 * Measured on one real conversation: three runs claimed "top" at 33, 46 and 6 messages
 * where 88 were actually reachable. Treat the ending string as a claim, not a fact. The
 * dependable stop conditions are `want` and `known`.
 */
export async function readThread(target: string, opts: ReadOpts = {}): Promise<ReadResult> {
  const { want = 100, hardCap = 300, stagnantStop = 4, known } = opts;

  const seen = new Set<string>();
  const screens: Msg[][] = [];
  let stagnant = 0, hitKnown = false, hitCap = true;

  for (let i = 0; i < hardCap; i++) {
    const msgs = extract(await dump()).sort((a, b) => a.y - b.y);
    const before = seen.size;
    const fresh: Msg[] = [];
    for (const m of msgs) {
      const key = `${m.sender}|${m.text}`;
      if (known?.has(key)) { hitKnown = true; continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(m);
    }
    if (fresh.length) screens.push(fresh);

    if (want > 0 && seen.size >= want) { hitCap = false; break; }
    if (hitKnown) { hitCap = false; break; }

    stagnant = seen.size === before ? stagnant + 1 : 0;
    if (stagnant >= stagnantStop) { hitCap = false; break; }

    await swipeUp(80);
    await Bun.sleep(1100);
  }

  const messages = screens.slice().reverse().flat();
  const ending = hitKnown ? "reached history already in the database"
    : !hitCap && want > 0 && messages.length >= want ? `reached requested count (${want})`
    : !hitCap ? `content stopped changing after ${stagnantStop} scrolls — MAY be the top, see caveat`
    : `stopped at hard cap (${hardCap} scrolls)`;
  return { messages, ending, hitKnown };
}

async function listRemote(): Promise<Set<string>> {
  const out = await adb("shell", `ls ${REMOTE_MEDIA_DIR} 2>/dev/null`);
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

/** Tap a photo, use Messenger's own labelled Save, come back. Returns the new filename. */
export async function savePhoto(photo: Node): Promise<string | null> {
  const before = await listRemote();
  await tap(photo.x, photo.y);
  await Bun.sleep(3000);

  const save = (await dump()).find((n) => n.clickable && n.desc === "Save");
  if (!save) {
    // Never guess a coordinate inside a real messaging app: neighbouring controls
    // forward, react and delete.
    await back();
    await Bun.sleep(1500);
    return null;
  }
  await tap(save.x, save.y);
  await Bun.sleep(2500);
  await back();
  await Bun.sleep(1500);

  const after = await listRemote();
  return [...after].find((f) => !before.has(f)) ?? null;
}

export interface FetchedMedia { ref: string; sender: string; when: string; file: string }

/** Walk the thread and save photos, optionally only those whose ref is still wanted. */
export async function fetchMedia(
  opts: { wanted?: Set<string>; cap?: number; scrolls?: number; stagnantStop?: number } = {},
): Promise<FetchedMedia[]> {
  const { wanted, cap = 40, scrolls = 60, stagnantStop = 8 } = opts;
  const saved: FetchedMedia[] = [];
  const seenRef = new Set<string>();
  let stagnant = 0;

  for (let step = 0; step < scrolls && saved.length < cap; step++) {
    const nodes = await dump();
    const photos = nodes.filter((n) => n.clickable && PHOTO_RE.test(n.desc)).sort((a, b) => a.y - b.y);
    const metas = nodes.filter((n) => META_RE.test(n.desc));

    let got = 0;
    for (const p of photos) {
      if (saved.length >= cap) break;
      const near = metas.slice().sort((a, b) => Math.abs(a.y - p.y) - Math.abs(b.y - p.y))[0];
      const ref = near?.desc ?? "";
      if (!ref || seenRef.has(ref)) continue;
      seenRef.add(ref);
      if (wanted && !wanted.has(ref)) continue;  // already downloaded — skip the 8s cycle
      const m = META_RE.exec(ref);
      const file = await savePhoto(p);
      if (file) { saved.push({ ref, sender: m?.[1] ?? "", when: m?.[2] ?? "", file }); got++; }
    }

    stagnant = got > 0 ? 0 : stagnant + 1;
    if (stagnant >= stagnantStop) break;
    await swipeUp(250);
    await Bun.sleep(900);
  }
  return saved;
}
