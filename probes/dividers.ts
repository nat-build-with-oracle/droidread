#!/usr/bin/env bun
// dividers.ts — scan a conversation for timestamp dividers and report the vocabulary.
//
// FINDING (SM-A146P, Messenger Sept 2026): dividers are non-clickable, narrow, centred
// nodes whose text and content-desc are the SAME string, in exactly three shapes:
//
//   "02:34"             today
//   "FRI AT 14:29"      within the last week
//   "17 SEPT AT 12:06"  older than a week
//
// The text===desc equality is the discriminator: an ordinary message carries sender and
// the double-tap suffix in desc while its text is empty.

import { dump } from "../src/tree.ts";
import { adb } from "../src/adb.ts";
import { extract, extractSeparators } from "../src/apps/messenger.ts";

const SCREENS = Number(process.env.PROBE_SCREENS ?? 12);
const seen = new Map<string, number>();

for (let i = 0; i < SCREENS; i++) {
  const nodes = await dump();
  const seps = extractSeparators(nodes);
  const msgs = extract(nodes);
  for (const s of seps) seen.set(s.raw, (seen.get(s.raw) ?? 0) + 1);

  if (seps.length) {
    console.log(`--- screen ${i + 1} ---`);
    const rows = [
      ...seps.map((s) => ({ y: s.y, s: `SEP  ${s.raw}` })),
      ...msgs.map((m) => ({ y: m.y, s: `MSG  ${m.sender}: ${m.text.replace(/\n/g, " ").slice(0, 40)}` })),
    ].sort((a, b) => a.y - b.y);
    for (const r of rows) console.log(`  ${String(r.y).padStart(5)} ${r.s}`);
  }
  await adb("shell", "input", "swipe", "540", "600", "540", "2000", "120");
  await Bun.sleep(1100);
}

console.log("\n=== divider vocabulary ===");
for (const [k, v] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${JSON.stringify(k)} x${v}`);
}
