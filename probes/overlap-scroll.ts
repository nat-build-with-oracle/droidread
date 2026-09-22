#!/usr/bin/env bun
// overlap-scroll.ts — does a SMALL, slow scroll step reveal dividers a fast fling skips?
//
// Hypothesis under test: a 1400px / 80ms swipe flings past more than one screen, so
// consecutive captures have a GAP between them. Anything in the gap (a divider, whole
// messages) is never seen, and content-dedup hides that it was ever missed.
//
// Method: from the newest message, scroll 800px at 300ms (no fling momentum), dump,
// repeat. Print each screen's dividers plus its first/last message, and whether it
// OVERLAPS the previous screen — overlap is the continuity guarantee.

import { adb } from "../src/adb.ts";
import { extract, extractSeparators, openConversation, dumpConversation } from "../src/apps/messenger.ts";

const chat = process.argv[2] ?? "Nonsense Matters";
await openConversation(chat);

let prevKeys = new Set<string>();
for (let i = 0; i < 6; i++) {
  const { nodes } = await dumpConversation();
  const msgs = extract(nodes).sort((a, b) => a.y - b.y);
  const seps = extractSeparators(nodes).sort((a, b) => a.y - b.y);
  const keys = new Set(msgs.map((m) => `${m.sender}|${m.text}`));
  const overlap = [...keys].filter((k) => prevKeys.has(k)).length;
  const first = msgs[0], last = msgs[msgs.length - 1];
  console.log(`--- step ${i} · ${msgs.length} msgs · overlap with previous: ${i === 0 ? "n/a" : overlap} ---`);
  console.log(`  dividers: [${seps.map((s) => s.raw).join(", ") || "none"}]`);
  if (first) console.log(`  first: ${first.sender}: ${first.text.replace(/\n/g, " ").slice(0, 40)}`);
  if (last && last !== first) console.log(`  last : ${last.sender}: ${last.text.replace(/\n/g, " ").slice(0, 40)}`);
  prevKeys = keys;
  await adb("shell", "input", "swipe", "540", "700", "540", "1500", "300");
  await Bun.sleep(500);
}
