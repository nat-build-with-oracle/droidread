#!/usr/bin/env bun
// settle-check.ts — is the newest-end dump complete once we WAIT for it?
//
// Compares an immediate dump against a settled one on the same screen. If the settled
// dump has dividers the immediate one lacked, the "missing anchors" were a timing
// artefact, not a filter bug.

import { dump, dumpSettled } from "../src/tree.ts";
import { extract, extractSeparators, openConversation } from "../src/apps/messenger.ts";

const chat = process.argv[2] ?? "Nonsense Matters";
await openConversation(chat);

const quick = await dump();
const q = { msgs: extract(quick).length, seps: extractSeparators(quick).map((s) => s.raw) };

const { nodes: slow, settled } = await dumpSettled((n) => extract(n).length + extractSeparators(n).length, { timeoutMs: 8000 });
const s = { msgs: extract(slow).length, seps: extractSeparators(slow).map((s) => s.raw) };

console.log(`immediate : ${q.msgs} msgs, dividers [${q.seps.join(", ")}]`);
console.log(`settled   : ${s.msgs} msgs, dividers [${s.seps.join(", ")}]  (settled=${settled})`);
