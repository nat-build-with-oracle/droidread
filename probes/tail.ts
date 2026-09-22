#!/usr/bin/env bun
// tail.ts — read the NEWEST end of a conversation with dividers and messages interleaved.
//
// Use this to answer "what happened today" from evidence you can read yourself, rather
// than trusting the index. Opens the conversation (which lands at the newest message),
// walks back a few screens, and prints everything in reading order, oldest first.

import { dump } from "../src/tree.ts";
import { adb } from "../src/adb.ts";
import { extract, extractSeparators, openConversation } from "../src/apps/messenger.ts";

const chat = process.argv[2] ?? "Nonsense Matters";
const SCREENS = Number(process.env.PROBE_SCREENS ?? 7);

await openConversation(chat);
await Bun.sleep(1500);

const screens: { y: number; kind: string; s: string }[][] = [];
for (let i = 0; i < SCREENS; i++) {
  const nodes = await dump();
  screens.push([
    ...extractSeparators(nodes).map((s) => ({ y: s.y, kind: "SEP", s: s.raw })),
    ...extract(nodes).map((m) => ({
      y: m.y,
      kind: m.kind === "photo" ? "PHOTO" : "MSG",
      s: `${m.sender}: ${m.text.replace(/\n/g, " ").slice(0, 45)}`,
    })),
  ].sort((a, b) => a.y - b.y));
  await adb("shell", "input", "swipe", "540", "600", "540", "2000", "150");
  await Bun.sleep(1200);
}

for (const [i, rows] of screens.slice().reverse().entries()) {
  console.log(`--- depth ${screens.length - i} ---`);
  for (const r of rows) console.log(`  ${r.kind.padEnd(5)} ${r.s}`);
}
