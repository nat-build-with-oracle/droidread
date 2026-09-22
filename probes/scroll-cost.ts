#!/usr/bin/env bun
// scroll-cost.ts — what does ONE reader step actually cost, and does the tree settle?
//
// Written after a 150-message read spent ten minutes producing nothing: 18 "tree did not
// settle" timeouts and 3 continuity back-ups, with no output, because readThread only
// prints when it finishes. This measures the step in isolation so the loop's behaviour
// stops being a guess:
//
//   settle   did dumpSettled() converge, or burn its whole timeout?
//   ms       wall-clock for the dump
//   msgs     messages visible
//   new      messages not seen on any earlier step  (0 repeatedly = no progress)
//   overlap  did this screen share content with the last one?
//
// A step that settles fast with steady `new` and overlap=yes is healthy. Timeouts, or
// `new` at 0 while `overlap` says no, is the pathology the reader was stuck in.
//
// Device animations are the usual cause of a tree that never settles: Messenger animates
// message rows, so the hierarchy keeps changing while the poller waits for it to stop.
//   adb shell settings put global window_animation_scale 0.0
//   adb shell settings put global transition_animation_scale 0.0
//   adb shell settings put global animator_duration_scale 0.0
//
//   bun probes/scroll-cost.ts "Nonsense Matters" [steps]

import { adb } from "../src/adb.ts";
import { dumpSettled } from "../src/tree.ts";
import { extract, extractSeparators, openConversation } from "../src/apps/messenger.ts";
import { loadEnvFile } from "../src/paths.ts";

loadEnvFile();

const target = process.argv[2] ?? "Nonsense Matters";
const steps = Number(process.argv[3] ?? 8);

await openConversation(target);

const seen = new Set<string>();
let prev = new Set<string>();
let settledCount = 0, totalMs = 0;

console.log("step  settle  ms     msgs  new  seps  overlap");
for (let i = 0; i < steps; i++) {
  const t0 = Date.now();
  const { nodes, settled } = await dumpSettled((n) => extract(n).length + extractSeparators(n).length);
  const ms = Date.now() - t0;
  totalMs += ms;
  if (settled) settledCount++;

  const msgs = extract(nodes);
  const seps = extractSeparators(nodes);
  const keys = new Set(msgs.map((m) => `${m.sender}|${m.text}`));
  let fresh = 0;
  for (const k of keys) if (!seen.has(k)) { seen.add(k); fresh++; }
  const overlap = i === 0 ? "-" : ([...keys].some((k) => prev.has(k)) ? "yes" : "NO");
  prev = keys;

  console.log(
    `${String(i).padStart(4)}  ${(settled ? "ok" : "TIMEOUT").padEnd(7)} ${String(ms).padStart(5)}  ` +
    `${String(msgs.length).padStart(4)}  ${String(fresh).padStart(3)}  ${String(seps.length).padStart(4)}  ${overlap}`,
  );

  await adb("shell", "input", "swipe", "540", "800", "540", "1400", "300");
  await Bun.sleep(400);
}

console.log(`\n${settledCount}/${steps} settled · ${Math.round(totalMs / steps)}ms average dump · ${seen.size} distinct messages in ${steps} steps`);
console.log(seen.size < steps ? "PROGRESS IS POOR — the reader would spin here" : "healthy: content advances every step");
