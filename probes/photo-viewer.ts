#!/usr/bin/env bun
// photo-viewer.ts — DISCOVERY ONLY. Opens one photo, reports the controls, backs out.
// Saves nothing.
//
// This exists because tapping blind inside a real messaging app can forward, react or
// delete. Before any save automation was written, this established what is actually there:
//
//   Button desc="Add to story" | "Save" | "More"   ImageButton desc="Close"
//
// "Save" is the only control the saver ever taps, resolved by name, never by coordinate.

import { dump } from "../src/tree.ts";
import { adb, tap, back } from "../src/adb.ts";

const PHOTO_RE = /(received|sent) photo message/i;
const META_RE = /^forward photo sent by /i;

const nodes = await dump();
const photos = nodes.filter((n) => PHOTO_RE.test(n.desc));
console.log(`photo nodes on screen: ${photos.length}`);
for (const p of photos) {
  console.log(` desc=${JSON.stringify(p.desc)} cls=${p.cls} clickable=${p.clickable} @${p.x},${p.y}`);
}
for (const m of nodes.filter((n) => META_RE.test(n.desc))) {
  console.log(` META ${JSON.stringify(m.desc)} @${m.x},${m.y}`);
}
if (!photos.length) { console.log("no photo on this screen — scroll and retry"); process.exit(0); }

const target = photos.find((p) => p.clickable) ?? photos[0]!;
console.log(`\nopening @${target.x},${target.y} ...`);
await tap(target.x, target.y);
await Bun.sleep(3000);

const viewer = await dump();
console.log(`\nviewer: ${viewer.length} nodes`);
console.log("--- clickable controls ---");
for (const n of viewer.filter((n) => n.clickable)) {
  console.log(` ${n.cls} text=${JSON.stringify(n.text)} desc=${JSON.stringify(n.desc)} @${n.x},${n.y}`);
}

console.log("\nbacking out (one BACK)");
await back();
await Bun.sleep(1500);
