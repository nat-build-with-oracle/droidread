#!/usr/bin/env bun
// anchor-shapes.ts — every time-shaped node at the newest end, with FULL attributes.
//
// Written because extractSeparators() returned "10:02" from a screen where a human could
// plainly see 10:55, 10:14 and 10:02. Something about the missing ones fails the filter;
// this shows exactly which attribute, instead of guessing.

import { dump } from "../src/tree.ts";
import { adb } from "../src/adb.ts";
import { openConversation, extractSeparators } from "../src/apps/messenger.ts";
import { isSeparatorLabel } from "../src/time.ts";

const chat = process.argv[2] ?? "Nonsense Matters";
await openConversation(chat);
await Bun.sleep(1500);

const TIMEISH = /\b\d{1,2}:\d{2}\b|\bAT\b|TODAY|YESTERDAY/i;

for (let i = 0; i < 3; i++) {
  const nodes = await dump();
  const accepted = new Set(extractSeparators(nodes).map((s) => `${s.y}|${s.raw}`));
  console.log(`--- screen ${i + 1} ---`);
  for (const n of nodes) {
    if (!TIMEISH.test(n.text) && !TIMEISH.test(n.desc)) continue;
    if (n.desc.includes("double-tap")) continue;           // ordinary message, skip
    const key = `${n.y}|${n.text.trim()}`;
    const ok = accepted.has(key) ? "ACCEPTED" : "DROPPED ";
    const why = accepted.has(key) ? "" :
      n.clickable ? "(clickable)" :
      !n.text ? "(text empty)" :
      n.text !== n.desc ? `(text!==desc: desc=${JSON.stringify(n.desc)})` :
      (n.x2 - n.x1) > 700 ? `(too wide: ${n.x2 - n.x1}px)` :
      !isSeparatorLabel(n.text) ? "(label regex rejects)" : "(?)";
    console.log(`  ${ok} y=${String(n.y).padStart(5)} w=${String(n.x2 - n.x1).padStart(4)} cls=${n.cls.padEnd(10)} text=${JSON.stringify(n.text).padEnd(22)} ${why}`);
  }
  await adb("shell", "input", "swipe", "540", "600", "540", "2000", "150");
  await Bun.sleep(1200);
}
