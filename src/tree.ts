// tree.ts — the Android accessibility tree, parsed.
//
// Everything in this project reads the accessibility tree rather than pixels. It is
// faster than screenshots, needs no OCR, and exposes what a screenshot cannot: which
// node is actually clickable, and which "text" is an empty container.

import { adb } from "./adb.ts";

export interface Node {
  id: string; cls: string; text: string; desc: string;
  clickable: boolean; x: number; y: number; x1: number; y1: number; x2: number; y2: number;
}

export type Selector =
  | { id: string } | { text: string } | { textContains: string }
  | { desc: string } | { descContains: string };

function unescapeXml(s: string): string {
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export async function dump(): Promise<Node[]> {
  const remote = "/sdcard/droidread-ui.xml";
  await adb("shell", "uiautomator", "dump", remote);
  const xml = await adb("shell", "cat", remote);
  if (!xml.includes("<hierarchy")) {
    throw new Error("no UI hierarchy — screen off, locked, or a secure window is in front");
  }
  const out: Node[] = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a: Record<string, string> = {};
    const ar = /([\w-]+)="([^"]*)"/g;
    let x: RegExpExecArray | null;
    while ((x = ar.exec(m[1]!)) !== null) a[x[1]!] = unescapeXml(x[2]!);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(a["bounds"] ?? "");
    if (!b) continue;
    const rid = (a["resource-id"] ?? "").split("/").pop() ?? "";
    out.push({
      // Messenger reports the literal string "(name removed)" rather than omitting the
      // attribute. Treat it as absent, or every node looks like it shares one id.
      id: rid === "(name removed)" ? "" : rid,
      cls: (a["class"] ?? "").split(".").pop() ?? "",
      text: (a["text"] ?? "").trim(),
      desc: (a["content-desc"] ?? "").trim(),
      clickable: a["clickable"] === "true",
      x1: +b[1]!, y1: +b[2]!, x2: +b[3]!, y2: +b[4]!,
      x: Math.round((+b[1]! + +b[3]!) / 2),
      y: Math.round((+b[2]! + +b[4]!) / 2),
    });
  }
  return out;
}

export function match(nodes: Node[], sel: Selector): Node[] {
  if ("id" in sel) return nodes.filter((n) => n.id === sel.id);
  if ("text" in sel) return nodes.filter((n) => n.text === sel.text);
  if ("textContains" in sel) return nodes.filter((n) => n.text.toLowerCase().includes(sel.textContains.toLowerCase()));
  if ("desc" in sel) return nodes.filter((n) => n.desc === sel.desc);
  return nodes.filter((n) => n.desc.toLowerCase().includes(sel.descContains.toLowerCase()));
}

/** Resolve to exactly one node, or throw. A tap into empty space looks like success. */
export function resolveOne(nodes: Node[], sel: Selector): Node {
  const hits = match(nodes, sel);
  if (hits.length === 0) throw new Error(`no match for ${JSON.stringify(sel)}`);
  const pick = hits.length > 1 && hits.some((h) => h.clickable) ? hits.filter((h) => h.clickable) : hits;
  if (pick.length > 1) throw new Error(`${pick.length} matches for ${JSON.stringify(sel)} — refusing to guess`);
  return pick[0]!;
}

/**
 * Dump, but only once the tree has stopped changing.
 *
 * WHY: a dump taken right after opening a conversation or after a scroll can be
 * INCOMPLETE — the RecyclerView has not finished laying out, so nodes that are plainly
 * visible on the glass are missing from the tree. Measured: the newest screen of a chat
 * returned 2 items and zero timestamp dividers where a human could see 5 messages and
 * three dividers (10:55, 10:14, 10:02). Reading from that dump silently produces wrong
 * timestamps, which is worse than waiting a second.
 *
 * "Settled" = the same count of message-bearing nodes on `stableSamples` consecutive
 * polls. Content counts are used rather than raw node counts because animations churn
 * decorative nodes indefinitely.
 */
/**
 * Dump repeatedly until the amount of content stops changing.
 *
 * THE TIMEOUT MUST BE BIGGER THAN THE WORK. Measured on an SM-A146P, a single
 * `uiautomator dump` costs a steady 2.4 SECONDS. Proving stability needs
 * stableSamples+1 dumps, so the old defaults (6000ms budget, 2 stable samples,
 * 400ms poll) needed 3 x 2400 + 2 x 400 = 8000ms and could never finish inside
 * 6000ms. Every "tree did not settle" warning was that arithmetic, not a restless
 * screen: five consecutive dumps returned byte-identical 94-node trees.
 *
 * So the defaults now assume a slow dump and a calm tree: one confirming sample,
 * a short poll, and a budget with room for four dumps. With device animations
 * disabled (window/transition/animator scale 0) the tree is stable immediately and
 * this costs two dumps, about 5s, instead of three and about 8s.
 */
export async function dumpSettled(
  countContent: (nodes: Node[]) => number,
  opts: { timeoutMs?: number; pollMs?: number; stableSamples?: number } = {},
): Promise<{ nodes: Node[]; settled: boolean; dumps: number }> {
  const { timeoutMs = 20000, pollMs = 150, stableSamples = 1 } = opts;
  const deadline = Date.now() + timeoutMs;
  let last = -1, stable = 0, nodes: Node[] = [], dumps = 0;
  while (Date.now() < deadline) {
    nodes = await dump();
    dumps++;
    const n = countContent(nodes);
    if (n === last) { if (++stable >= stableSamples) return { nodes, settled: true, dumps }; }
    else { stable = 0; last = n; }
    await Bun.sleep(pollMs);
  }
  return { nodes, settled: false, dumps };
}
