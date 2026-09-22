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
import { dump, dumpSettled, match, type Node } from "../tree.ts";
import { isSeparatorLabel, resolveSeparator } from "../time.ts";

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
  sentAt?: string;      // resolved local timestamp
  sentAtRaw?: string;   // the divider label exactly as Messenger rendered it
}

export interface Separator { y: number; raw: string }

/**
 * Timestamp dividers between message clusters.
 *
 * Shape confirmed live: a non-clickable node, narrow and centred, whose text and
 * content-desc are the SAME string ("02:34", "FRI AT 14:29", "17 SEPT AT 12:06").
 * The text===desc equality is what separates a divider from an ordinary message, whose
 * desc carries the sender and the double-tap suffix while its text is usually empty.
 */
export function extractSeparators(nodes: Node[]): Separator[] {
  const out: Separator[] = [];
  for (const n of nodes) {
    if (n.clickable || !n.text || n.text !== n.desc) continue;
    if (n.x2 - n.x1 > 700) continue;  // a wide node is content, not a divider
    if (!isSeparatorLabel(n.text)) continue;
    out.push({ y: n.y, raw: n.text.trim() });
  }
  return out;
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

/** What "content" means for settle-waits here: messages and dividers, nothing decorative. */
const contentCount = (nodes: Node[]) => extract(nodes).length + extractSeparators(nodes).length;

/** Dump the conversation only once it has finished laying out. */
export async function dumpConversation(): Promise<{ nodes: Node[]; settled: boolean; dumps: number }> {
  const r = await dumpSettled(contentCount);
  if (!r.settled) console.error(`  warning: tree did not settle after ${r.dumps} dumps — this one may be incomplete`);
  return r;
}

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
  maxMs?: number;         // wall-clock budget; a step costs SECONDS, so this is the real limit
  onProgress?: (p: Progress) => void | Promise<void>;  // called after every screen
}

/**
 * Reported after each screen so a long read is visible while it runs and survivable if
 * it is killed. Both matter more than they sound: a step costs about 5 seconds, so 150
 * messages is ~7 minutes of silence otherwise, and a run killed at minute 10 previously
 * lost everything because nothing was written until the end.
 */
export interface Progress {
  step: number;
  collected: number;
  want: number;
  fresh: Msg[];          // messages first seen on THIS screen, newest-first
  seps: Separator[];
  settled: boolean;
  dumps: number;
  ms: number;
  elapsedMs: number;
}

export interface Anchor { raw: string; sentAt: string | null }
export interface ReadResult { messages: Msg[]; anchors: Anchor[]; ending: string; hitKnown: boolean; steps: number; elapsedMs: number }

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
  const { want = 100, hardCap = 300, stagnantStop = 4, known, maxMs = 0, onProgress } = opts;
  const startedAt = Date.now();

  const seen = new Set<string>();
  const screens: { msgs: Msg[]; seps: Separator[] }[] = [];
  const anchorsSeen = new Map<string, Anchor>();
  let stagnant = 0, hitKnown = false, hitCap = true, gaps = 0, outOfTime = false, lastStep = 0;
  let screenKeys = new Set<string>();
  let screenSeps = new Set<string>();

  // The first dump after opening is the one most likely to be incomplete — the list is
  // still settling onto the newest message. Settle-wait applies to every screen, but
  // matters most here.
  for (let i = 0; i < hardCap; i++) {
    lastStep = i + 1;
    const stepStart = Date.now();
    let { nodes, settled, dumps } = await dumpConversation();
    let msgs = extract(nodes).sort((a, b) => a.y - b.y);
    let seps = extractSeparators(nodes);

    // Continuity check, on THIS dump against the previous screen: they must share at
    // least one message or divider. Zero overlap means the scroll skipped content —
    // back up a little and re-read rather than silently accept a hole in the history.
    // Costs nothing when overlap holds, which is the normal case at a 600px step.
    if (i > 0 && screenKeys.size > 0) {
      const shared = msgs.some((m) => screenKeys.has(`${m.sender}|${m.text}`))
        || seps.some((sp) => screenSeps.has(sp.raw));
      if (!shared) {
        gaps++;
        console.error(`  continuity: no overlap after scroll — backing up`);
        await adb("shell", "input", "swipe", "540", "1300", "540", "900", "300");
        await Bun.sleep(400);
        ({ nodes, settled, dumps } = await dumpConversation());
        msgs = extract(nodes).sort((a, b) => a.y - b.y);
        seps = extractSeparators(nodes);
      }
    }
    for (const sp of seps) if (!anchorsSeen.has(sp.raw)) anchorsSeen.set(sp.raw, { raw: sp.raw, sentAt: null });
    const before = seen.size;
    const fresh: Msg[] = [];
    for (const m of msgs) {
      const key = `${m.sender}|${m.text}`;
      if (known?.has(key)) { hitKnown = true; continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(m);
    }
    if (fresh.length || seps.length) screens.push({ msgs: fresh, seps });
    screenKeys = new Set(msgs.map((m) => `${m.sender}|${m.text}`));
    screenSeps = new Set(seps.map((sp) => sp.raw));

    if (onProgress) {
      await onProgress({
        step: i, collected: seen.size, want, fresh, seps, settled, dumps,
        ms: Date.now() - stepStart, elapsedMs: Date.now() - startedAt,
      });
    }

    if (want > 0 && seen.size >= want) { hitCap = false; break; }
    if (hitKnown) { hitCap = false; break; }
    if (maxMs > 0 && Date.now() - startedAt >= maxMs) { hitCap = false; outOfTime = true; break; }

    stagnant = seen.size === before ? stagnant + 1 : 0;
    if (stagnant >= stagnantStop) { hitCap = false; break; }

    // SMALL step, SLOW swipe. A 1400px/80ms fling overshoots a full screen, leaving a
    // gap between consecutive captures; anything in the gap (a divider, whole messages)
    // is never seen, and dedup-by-content hides that it was ever missed. Measured: the
    // fling returned 2 of today's 4 dividers; 800px/300ms returned all 4 but still showed
    // zero overlap on 3 of 6 steps. 600px is ~a third of the message area, so every
    // capture shares content with the last one even when a single long message fills
    // the screen. Slower, and correct.
    await adb("shell", "input", "swipe", "540", "800", "540", "1400", "300");
    await Bun.sleep(400);  // brief; dumpConversation() does the real waiting

  }

  // Assemble chronologically, then walk the merged divider/message stream carrying the
  // last divider forward. This has to happen AFTER reversal: a cluster's divider often
  // sits on the screen ABOVE, which is captured on a later iteration while scrolling up,
  // so it is only adjacent to its messages once everything is back in reading order.
  const now = new Date();
  const messages: Msg[] = [];
  let current: string | null = null;
  for (const screen of screens.slice().reverse()) {
    const events = [
      ...screen.seps.map((s) => ({ y: s.y, sep: s.raw, msg: null as Msg | null })),
      ...screen.msgs.map((m) => ({ y: m.y, sep: null as string | null, msg: m })),
    ].sort((a, b) => a.y - b.y);
    for (const e of events) {
      if (e.sep !== null) { current = e.sep; continue; }
      if (!e.msg) continue;
      // A photo STATES its own time in Messenger's caption. That beats any inference —
      // and disagreement between the two is the built-in correctness check for dividers.
      if (e.msg.kind === "photo" && e.msg.mediaWhen) {
        messages.push({ ...e.msg, sentAtRaw: e.msg.mediaWhen, sentAt: resolveSeparator(e.msg.mediaWhen, now) ?? undefined });
        continue;
      }
      messages.push(current
        ? { ...e.msg, sentAtRaw: current, sentAt: resolveSeparator(current, now) ?? undefined }
        : e.msg);
    }
  }
  const anchors = [...anchorsSeen.values()].map((a) => ({ ...a, sentAt: resolveSeparator(a.raw, now) }));
  if (gaps > 0) console.error(`  continuity: ${gaps} scroll(s) needed a back-up — history may still have holes`);
  const ending = hitKnown ? "reached history already in the database"
    : outOfTime ? `ran out of time after ${Math.round((Date.now() - startedAt) / 1000)}s — raise --max-ms or lower --n`
    : !hitCap && want > 0 && messages.length >= want ? `reached requested count (${want})`
    : !hitCap ? `content stopped changing after ${stagnantStop} scrolls — MAY be the top, see caveat`
    : `stopped at hard cap (${hardCap} scrolls)`;
  return { messages, anchors, ending, hitKnown, steps: lastStep, elapsedMs: Date.now() - startedAt };
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
