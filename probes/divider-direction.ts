#!/usr/bin/env bun
// divider-direction.ts — does a divider timestamp the cluster ABOVE it or BELOW it?
//
// Settled by ground truth rather than assumption: a PHOTO states its own time in
// "Forward photo sent by <X> on <when>", so a photo sitting next to a divider decides it.
//
// RESULT (measured):
//     y=1213  SEP   15 SEPT AT 16:25
//     y=1704  PHOTO truth=15 Sept at 16:25
// The photo matches the divider ABOVE it => a divider labels the cluster BELOW it.
//
// Re-run this after any Messenger update before trusting timestamps again.

import { dump } from "../src/tree.ts";
import { adb } from "../src/adb.ts";
import { extractSeparators } from "../src/apps/messenger.ts";

const META = /^forward photo sent by (.+?) on (.+)$/i;
const SCREENS = Number(process.env.PROBE_SCREENS ?? 14);

for (let i = 0; i < SCREENS; i++) {
  const nodes = await dump();
  const seps = extractSeparators(nodes);
  const photos = nodes
    .filter((n) => META.test(n.desc))
    .map((n) => ({ y: n.y, when: META.exec(n.desc)![2]! }));

  if (seps.length && photos.length) {
    console.log(`--- screen ${i + 1} ---`);
    const rows = [
      ...seps.map((s) => ({ y: s.y, s: `SEP   ${s.raw}` })),
      ...photos.map((p) => ({ y: p.y, s: `PHOTO truth=${p.when}` })),
    ].sort((a, b) => a.y - b.y);
    for (const r of rows) console.log(`  y=${String(r.y).padStart(5)}  ${r.s}`);
  }
  await adb("shell", "input", "swipe", "540", "600", "540", "2000", "120");
  await Bun.sleep(1100);
}
