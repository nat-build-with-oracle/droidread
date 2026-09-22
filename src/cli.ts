#!/usr/bin/env bun
// cli.ts — droidread.
//
// Rule 6: this tool is AI-assisted work, built by Nexus (AI) with Nat Weerawan. It reads
// only the operator's OWN device over their own authorised adb connection.

import { devices } from "./adb.ts";
import { screenSnapshot } from "./snapshot.ts";
import { openConversation, readThread, fetchMedia, REMOTE_MEDIA_DIR } from "./apps/messenger.ts";
import { openDb, insertMessages, getExistingKeys, pendingMedia, markMediaDownloaded, search, listMessages, messagesSince, upsertAnchors, listAnchors } from "./db.ts";
import { migrate } from "./migrate.ts";
import { MEDIA_DIR, DATA_DIR, ensureDirs, loadEnvFile } from "./paths.ts";

loadEnvFile();
import { adb } from "./adb.ts";

const APP = "messenger";
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flag = (name: string, def?: string) => rest.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? def;
const positional = rest.filter((a) => !a.startsWith("--"));

async function db() {
  const d = openDb();
  await migrate(d);
  return d;
}

function usage(): never {
  console.log(`droidread — read your own Android chat apps over adb

  droidread devices                         list adb devices
  droidread snapshot [--all] [--grep=RE]    accessibility tree of the current screen
  droidread screenshot [--width=540] [--out=F]  picture of the current screen
  droidread web [--port=8791]               browser viewer + tap control (LAN/VPN, no auth)
  droidread read <chat> [--n=100] [--max-ms=0]  read a conversation, index it
  droidread recap <chat>                    read only what's new since the last run
  droidread media <chat> [--cap=40]         download photos this chat has marked pending
  droidread search <query> [--limit=20]     full-text search the index
  droidread list <chat> [--n=50]            show indexed messages
  droidread since <chat> <YYYY-MM-DD HH:MM>  messages sent at or after a time
  droidread anchors <chat>                  every timestamp divider ever seen, newest first
  droidread where                           show where data is stored

Data lives in ${DATA_DIR} (override with DROIDREAD_HOME). Nothing is uploaded
unless TURSO_DATABASE_URL is set.`);
  process.exit(cmd ? 1 : 0);
}

switch (cmd) {
  case "devices": {
    const d = await devices();
    console.log(d.length ? d.join("\n") : "no devices — check `adb devices` and USB/wireless debugging");
    break;
  }

  case "where": {
    ensureDirs();
    console.log(`data dir : ${DATA_DIR}`);
    console.log(`media    : ${MEDIA_DIR}`);
    console.log(`cloud    : ${process.env.TURSO_DATABASE_URL ? "TURSO_DATABASE_URL is set — index syncs to cloud" : "local only"}`);
    break;
  }

  case "snapshot": {
    let out = await screenSnapshot({ all: rest.includes("--all") });
    const grep = flag("grep");
    if (grep) { const re = new RegExp(grep, "i"); out = out.split("\n").filter((l) => re.test(l)).join("\n"); }
    console.log(out);
    break;
  }

  case "web": {
    // Runs in the foreground: it is a server, and the operator should see it and be able
    // to stop it. Binds 0.0.0.0 with no authentication — LAN or VPN only.
    const port = flag("port");
    const proc = Bun.spawn(["bun", `${import.meta.dir}/../web/server.ts`], {
      env: { ...process.env, ...(port ? { DROIDREAD_WEB_PORT: port } : {}) },
      stdout: "inherit", stderr: "inherit", stdin: "inherit",
    });
    process.exit(await proc.exited);
  }

  case "screenshot": {
    const { screenshot } = await import("./screen.ts");
    const shot = await screenshot(Number(flag("width", "540")), Number(flag("quality", "6")));
    const out = flag("out") ?? `${DATA_DIR}/screen-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${shot.mime === "image/jpeg" ? "jpg" : "png"}`;
    ensureDirs();
    await Bun.write(out, shot.data);
    console.log(`${out}  (${shot.mime}, ${shot.width ? `${shot.width}px wide, ` : ""}${Math.round(shot.bytes / 1024)} KB, ${shot.source === "stream" ? `via web viewer, frame ${shot.ageMs ?? 0}ms old` : "via adb screencap"})`);
    break;
  }

  case "read":
  case "recap": {
    const chat = positional[0];
    if (!chat) usage();
    const d = await db();
    const known = cmd === "recap" ? await getExistingKeys(d, APP, chat) : undefined;
    if (known) console.error(`already indexed: ${known.size} messages`);

    await openConversation(chat);

    // A step costs SECONDS (a single uiautomator dump is ~2.4s on an SM-A146P), so a
    // 150-message read is minutes long. Two consequences, both handled here rather than
    // left to the operator to discover: say something after every screen, and write as
    // you go. A run killed at minute ten used to lose all ten minutes.
    const t0 = Date.now();
    const { messages, anchors, ending, steps, elapsedMs } = await readThread(chat, {
      want: Number(flag("n", cmd === "recap" ? "0" : "100")),
      maxMs: Number(flag("max-ms", "0")),
      known,
      async onProgress(p) {
        if (p.fresh.length) await insertMessages(d, APP, chat, p.fresh);
        const rate = p.collected / Math.max(1, (Date.now() - t0) / 1000);
        const eta = p.want > 0 && rate > 0 ? `, eta ${Math.round((p.want - p.collected) / rate)}s` : "";
        console.error(
          `  step ${String(p.step + 1).padStart(3)}  ${String(p.collected).padStart(4)}` +
          `${p.want > 0 ? `/${p.want}` : ""} msgs  +${p.fresh.length}  ${p.dumps} dumps ${p.ms}ms` +
          `${p.settled ? "" : " UNSETTLED"}${eta}`,
        );
      },
    });

    const res = await insertMessages(d, APP, chat, messages);
    const na = await upsertAnchors(d, APP, chat, anchors);
    console.error(`anchors seen this pass: ${anchors.length} (${na} recorded)`);
    console.error(`${steps} steps in ${Math.round(elapsedMs / 1000)}s — ${ending}`);
    console.log(`${messages.length} messages read · ${res.inserted} new, ${res.skipped} already indexed · ${res.dated} carried a timestamp`);
    for (const m of messages) console.log(`${m.sentAt ? String(m.sentAt).slice(0, 16) + "  " : ""}${m.kind === "photo" ? "[photo] " : ""}${m.sender}: ${m.text}`);
    break;
  }

  case "media": {
    const chat = positional[0];
    if (!chat) usage();
    const d = await db();
    const pend = await pendingMedia(d, APP, chat);
    console.log(`photos pending download: ${pend.length}`);
    if (!pend.length) break;

    const refToId = new Map(pend.map((r) => [String(r.media_ref), Number(r.id)]));
    await openConversation(chat);
    const saved = await fetchMedia({ wanted: new Set(refToId.keys()), cap: Number(flag("cap", "40")) });

    ensureDirs();
    const pull = Bun.spawn([process.env.DROIDREAD_ADB ?? "adb", "pull", REMOTE_MEDIA_DIR, MEDIA_DIR], { stdout: "pipe", stderr: "pipe" });
    await pull.exited;

    let updated = 0;
    for (const s of saved) {
      const id = refToId.get(s.ref);
      if (!id) continue;
      await markMediaDownloaded(d, id, `${MEDIA_DIR}/Messenger/${s.file}`);
      updated++;
    }
    console.log(`saved ${saved.length}, db rows updated ${updated}`);
    break;
  }

  case "search": {
    const q = positional.join(" ");
    if (!q) usage();
    const rows = await search(await db(), q, Number(flag("limit", "20")));
    console.log(`${rows.length} hits`);
    for (const r of rows) console.log(` [${r.chat}] ${r.sender}: ${String(r.text).slice(0, 90)}`);
    break;
  }

  case "list": {
    const chat = positional[0];
    if (!chat) usage();
    const rows = await listMessages(await db(), APP, chat, Number(flag("n", "50")));
    for (const r of rows) {
      const mark = r.kind === "photo" ? (r.media_file ? "[photo ✓] " : "[photo …] ") : "";
      const when = r.sent_at ? `${String(r.sent_at).slice(0, 16)}  ` : "(no time)         ";
      console.log(`${when}${mark}${r.sender}: ${String(r.text).replace(/\n/g, " ").slice(0, 80)}`);
    }
    break;
  }

  case "anchors": {
    const chat = positional[0];
    if (!chat) usage();
    const rows = await listAnchors(await db(), APP, chat);
    console.log(`${rows.length} anchors`);
    for (const r of rows) console.log(`  ${String(r.sent_at ?? "unresolved").padEnd(20)} ${r.raw}`);
    break;
  }

  case "since": {
    const chat = positional[0];
    const since = positional.slice(1).join(" ");
    if (!chat || !since) usage();
    const { rows, undated, total } = await messagesSince(await db(), APP, chat, since);
    console.log(`${rows.length} messages at or after ${since}  (of ${total} indexed; ${undated} have no known send time)`);
    for (const r of rows) {
      console.log(`${String(r.sent_at).slice(0, 16)}  ${r.kind === "photo" ? "[photo] " : ""}${r.sender}: ${String(r.text).replace(/\n/g, " ").slice(0, 80)}`);
    }
    break;
  }

  default:
    usage();
}
