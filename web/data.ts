#!/usr/bin/env bun
// web/data.ts — browse what has been INDEXED and DOWNLOADED. No phone, no adb, read-only.
//
// Distinct from web/server.ts (the live phone mirror) and mcp/http.ts (the agent API):
// this one only ever reads the database and the media files already on disk. It works
// with no device connected at all, and it is the one place a human looks at what droidread
// actually collected — every chat, every message, every downloaded photo, one page.
//
// WHY IT BINDS TIGHTER THAN THE PHONE VIEWER: web/server.ts shows a live camera view of
// whatever is on screen right now. This serves the actual indexed CONTENT — searchable,
// structured, every past message — which is a bigger exposure if left open on a shared
// network. Default is 127.0.0.1 only; opt into anything wider explicitly.
//
// Photos are served by database id, never by a path in the URL: `media_file` always comes
// from OUR OWN row, resolved server-side, so there is no path a request could supply to
// read an arbitrary file.
//
//   bun web/data.ts [--host=127.0.0.1] [--port=8793]
//
// Rule 6: AI-assisted work by Nexus (AI) with Nat Weerawan. Reads only the operator's own
// indexed data, already extracted from their own device over their own authorised
// connection — nothing here touches adb.

import { openDb } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import { loadEnvFile, DATA_DIR } from "../src/paths.ts";

const envPath = loadEnvFile();
const db = openDb();
await migrate(db);

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const HOSTS = (arg("host") ?? process.env.DROIDREAD_DATA_HOST ?? "127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = Number(arg("port") ?? process.env.DROIDREAD_DATA_PORT ?? 8793);

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

// ---------------------------------------------------------------------------
// Queries.
//
// SUM(bool-expr) silently returns 0 through this driver's HTTP path — measured directly,
// not assumed: `SUM(kind='photo')` gave 0 against real data that plainly had photo rows.
// Every aggregate below uses an explicit CASE instead of relying on boolean-as-integer.
// ---------------------------------------------------------------------------

async function overview() {
  const chats = await db.execute(`
    SELECT app, chat,
      COUNT(*) AS total,
      SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS dated,
      SUM(CASE WHEN kind = 'photo' THEN 1 ELSE 0 END) AS photos,
      SUM(CASE WHEN kind = 'photo' AND media_file IS NOT NULL THEN 1 ELSE 0 END) AS photos_downloaded,
      MAX(sent_at) AS last_at,
      MAX(extracted_at) AS last_indexed
    FROM messages GROUP BY app, chat ORDER BY last_at DESC, last_indexed DESC
  `);
  const anchorCounts = await db.execute(`SELECT app, chat, COUNT(*) AS n FROM anchors GROUP BY app, chat`);
  const anchorsByChat = new Map(anchorCounts.rows.map((r) => [`${r.app}|${r.chat}`, Number(r.n)]));

  const totals = await db.execute(`
    SELECT COUNT(*) AS total_messages,
      SUM(CASE WHEN kind = 'photo' THEN 1 ELSE 0 END) AS total_photos,
      SUM(CASE WHEN kind = 'photo' AND media_file IS NOT NULL THEN 1 ELSE 0 END) AS total_photos_downloaded,
      COUNT(DISTINCT chat) AS total_chats
    FROM messages
  `);

  return {
    chats: chats.rows.map((r) => ({
      app: r.app, chat: r.chat, total: Number(r.total), dated: Number(r.dated),
      photos: Number(r.photos), photosDownloaded: Number(r.photos_downloaded),
      anchors: anchorsByChat.get(`${r.app}|${r.chat}`) ?? 0,
      lastAt: r.last_at, lastIndexed: r.last_indexed,
    })),
    totals: {
      messages: Number(totals.rows[0]!.total_messages ?? 0),
      photos: Number(totals.rows[0]!.total_photos ?? 0),
      photosDownloaded: Number(totals.rows[0]!.total_photos_downloaded ?? 0),
      chats: Number(totals.rows[0]!.total_chats ?? 0),
    },
    dataDir: DATA_DIR,
    cloud: process.env.TURSO_DATABASE_URL ? "turso" : "local",
  };
}

/**
 * Reading order is extraction order (id), matching `droidread list`/`_list` elsewhere in
 * this project — NOT a guaranteed true timeline. Multiple reads of the same conversation
 * can interleave, so id order is a close approximation, not a proof; sent_at is shown
 * per-row so the honest gap between "extracted this order" and "sent at this time" is
 * visible rather than papered over.
 */
async function messages(app: string, chat: string, before: number | null, limit: number) {
  const rows = before
    ? await db.execute({
        sql: `SELECT id, sender, text, kind, media_ref, media_when, media_file, sent_at, sent_at_raw, extracted_at
              FROM messages WHERE app = ? AND chat = ? AND id < ? ORDER BY id DESC LIMIT ?`,
        args: [app, chat, before, limit],
      })
    : await db.execute({
        sql: `SELECT id, sender, text, kind, media_ref, media_when, media_file, sent_at, sent_at_raw, extracted_at
              FROM messages WHERE app = ? AND chat = ? ORDER BY id DESC LIMIT ?`,
        args: [app, chat, limit],
      });
  const list = rows.rows.map((r) => ({
    id: Number(r.id), sender: r.sender, text: r.text, kind: r.kind,
    mediaWhen: r.media_when || null, hasPhoto: r.kind === "photo" && r.media_file != null,
    sentAt: r.sent_at, sentAtRaw: r.sent_at_raw, extractedAt: r.extracted_at,
  }));
  list.reverse();   // fetched newest-first for the cursor, displayed oldest-first
  const oldestId = rows.rows.length ? Number(rows.rows[rows.rows.length - 1]!.id) : null;
  return { messages: list, nextBefore: rows.rows.length === limit ? oldestId : null };
}

async function anchorsFor(app: string, chat: string) {
  const rows = await db.execute({
    sql: `SELECT raw, sent_at, first_seen FROM anchors WHERE app = ? AND chat = ? ORDER BY sent_at DESC, id DESC`,
    args: [app, chat],
  });
  return rows.rows.map((r) => ({ raw: r.raw, sentAt: r.sent_at, firstSeen: r.first_seen }));
}

async function pending(app: string, chat: string) {
  const rows = await db.execute({
    sql: `SELECT id, sender, media_ref, media_when FROM messages
          WHERE app = ? AND chat = ? AND kind = 'photo' AND media_file IS NULL AND media_ref <> '' ORDER BY id`,
    args: [app, chat],
  });
  return rows.rows.map((r) => ({ id: Number(r.id), sender: r.sender, mediaRef: r.media_ref, mediaWhen: r.media_when }));
}

async function searchAll(q: string, limit: number) {
  const rows = await db.execute({
    sql: `SELECT m.id, m.app, m.chat, m.sender, m.text, m.kind, m.sent_at, bm25(messages_fts) AS rank
          FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
          WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
    args: [q, limit],
  });
  return rows.rows.map((r) => ({
    id: Number(r.id), app: r.app, chat: r.chat, sender: r.sender, text: r.text, kind: r.kind, sentAt: r.sent_at,
  }));
}

async function photoResponse(id: number): Promise<Response> {
  const row = await db.execute({ sql: `SELECT media_file FROM messages WHERE id = ? AND media_file IS NOT NULL`, args: [id] });
  const path = row.rows[0]?.media_file as string | undefined;
  if (!path) return new Response("not found", { status: 404 });
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response(`indexed but missing on disk: ${path}`, { status: 404 });
  return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable" } });
}

// ---------------------------------------------------------------------------
// The page. One file, no build step, no framework — matches web/server.ts's own style.
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>droidread — indexed data</title>
<style>
  :root {
    /* This page is dark-only, not dark-as-one-of-two-themes — so color-scheme is a plain
       dark, not "light dark". Declared and left undeclared were tried both: undeclared, a
       browser renders every NATIVE control in light mode regardless of the page's own
       colours, which is exactly the white scrollbar and light form-control chrome seen
       sitting on top of this dark page in a live screenshot. */
    color-scheme: dark;
    --bg: #0a0a0a; --sidebar: #18191a; --panel: #18191a; --hover: #2f3031; --active: #3a3b3c;
    --border: #2f3031; --text: #e4e6eb; --dim: #b0b3b8; --faint: #65676b;
    --bubble-in: #3e4042; --bubble-me: #0b93f6; --pill: #3a3b3c;
  }
  * { box-sizing: border-box; }
  /* Exactly two scroll regions exist on this page: the sidebar chat list, and the open
     thread. Everything else must be pinned to the viewport, or a flex child's default
     min-height:auto silently refuses to shrink, pushes its ancestor taller than the
     screen, and the OUTER page grows a second scrollbar stacked on top of the inner one. */
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { display: flex; background: var(--bg); color: var(--text);
         font: 15px/1.4 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  a, button, input { font: inherit; color: inherit; }

  /* color-scheme:dark gets WebKit/Blink most of the way on its own, but a thin, explicitly
     dark thumb reads calmer than the still-fairly-light default dark scrollbar, and Firefox
     needs scrollbar-color stated directly — color-scheme alone does not reach it there. */
  aside, #scroller { scrollbar-color: var(--border) transparent; scrollbar-width: thin; }
  aside::-webkit-scrollbar, #scroller::-webkit-scrollbar { width: 10px; }
  aside::-webkit-scrollbar-track, #scroller::-webkit-scrollbar-track { background: transparent; }
  aside::-webkit-scrollbar-thumb, #scroller::-webkit-scrollbar-thumb { background: var(--border); border-radius: 6px; border: 2px solid var(--bg); }
  aside::-webkit-scrollbar-thumb:hover, #scroller::-webkit-scrollbar-thumb:hover { background: var(--hover); }

  /* avatar: a colour-hashed initial circle, since no real avatar image exists */
  .avatar { width: 36px; height: 36px; border-radius: 50%; flex: none; display: flex;
            align-items: center; justify-content: center; font-weight: 600; font-size: 14px; color: #fff; }
  .avatar.lg { width: 44px; height: 44px; font-size: 17px; }

  /* ---- sidebar ---- */
  aside { width: 340px; flex: none; min-height: 0; border-right: 1px solid var(--border); overflow-y: auto;
          display: flex; flex-direction: column; }
  aside .head { padding: 16px 16px 8px; }
  aside h1 { font-size: 22px; margin: 0 0 6px; }
  .totals { font-size: 12px; color: var(--faint); margin-bottom: 12px; line-height: 1.5; }
  .search-wrap { padding: 0 16px 8px; }
  input[type=search] { width: 100%; padding: 9px 14px; border-radius: 20px; border: none;
                        background: var(--pill); color: var(--text); }
  input[type=search]::placeholder { color: var(--faint); }
  #searchResults { padding: 0 8px; }
  #searchResults .hit { padding: 8px 12px; border-radius: 10px; cursor: pointer; }
  #searchResults .hit:hover { background: var(--hover); }
  #searchResults .hit .chat { font-size: 11px; color: var(--faint); }
  #chatList { flex: 1; padding: 4px 8px 16px; }

  .chat-row { display: flex; gap: 12px; align-items: center; padding: 8px; border-radius: 10px;
              cursor: pointer; margin-bottom: 2px; }
  .chat-row:hover { background: var(--hover); }
  .chat-row.active { background: var(--active); }
  .chat-row .meta-col { min-width: 0; flex: 1; }
  .chat-row .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chat-row .preview { font-size: 13px; color: var(--dim); white-space: nowrap; overflow: hidden;
                        text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10.5px;
           background: var(--pill); color: var(--dim); flex: none; }
  .badge.pending { background: #6b4d0e; color: #ffce7a; }

  /* ---- main pane ---- */
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  #empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--faint); }
  #thread { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  #topbar { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--border); flex: none; }
  #topbar h2 { margin: 0; font-size: 16px; }
  #chatMeta { font-size: 12px; color: var(--faint); }
  #meBadge { margin-left: auto; font-size: 12px; color: var(--dim); display: flex; align-items: center; gap: 6px; }
  #meBadge button { background: var(--pill); border: none; border-radius: 14px; padding: 4px 10px; cursor: pointer; }
  #meBadge button:hover { background: var(--hover); }

  #anchorBar { padding: 6px 20px; font-size: 11.5px; color: var(--faint); border-bottom: 1px solid var(--border);
               overflow-x: auto; white-space: nowrap; flex: none; }
  #scroller { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; }
  #loadMore { display: block; margin: 4px auto 14px; padding: 7px 16px; border-radius: 16px;
              border: 1px solid var(--border); background: transparent; color: var(--dim); cursor: pointer; }
  #loadMore:hover { background: var(--hover); }
  footer#pendingNote { font-size: 11.5px; color: var(--faint); padding: 4px 20px 14px; flex: none; }

  /* ---- message groups & bubbles ---- */
  .group { display: flex; gap: 8px; margin-top: 10px; max-width: 78%; }
  .group.me { align-self: flex-end; flex-direction: row-reverse; }
  .group .gutter { width: 36px; flex: none; display: flex; align-items: flex-end; }
  .group .gutter .avatar { cursor: pointer; }
  .group .col { min-width: 0; display: flex; flex-direction: column; }
  .group.me .col { align-items: flex-end; }
  .sender-label { font-size: 12px; color: var(--dim); margin: 0 0 3px 12px; cursor: pointer; }
  .sender-label:hover { text-decoration: underline; }
  .group.me .sender-label { display: none; }

  .bubble { background: var(--bubble-in); color: var(--text); padding: 8px 12px; border-radius: 18px;
            margin-top: 2px; white-space: pre-wrap; word-break: break-word; max-width: 100%; cursor: pointer; }
  .group.me .bubble { background: var(--bubble-me); color: #fff; }
  .group .col > *:first-child.bubble,
  .group .col > .bubble:first-child { margin-top: 0; }
  .bubble.photo { padding: 0; overflow: hidden; background: transparent; }
  .bubble.photo img { display: block; max-width: 280px; max-height: 340px; border-radius: 14px; }
  .bubble.pending-photo { background: var(--pill); color: var(--faint); font-style: italic; font-size: 13px; }
  .bubble.undated-flag::after { content: " ·"; opacity: .5; }

  .stamp { font-size: 11px; color: var(--faint); margin: 3px 12px 0; display: none; }
  .stamp.shown { display: block; }
  .group.me .stamp { text-align: right; margin: 3px 12px 0; }
</style>
</head>
<body>
<aside>
  <div class="head">
    <h1>droidread</h1>
    <div class="totals" id="totals">loading…</div>
  </div>
  <div class="search-wrap"><input type="search" id="search" placeholder="Search everything…"></div>
  <div id="searchResults"></div>
  <div id="chatList"></div>
</aside>
<main>
  <div id="empty">Pick a chat on the left.</div>
  <div id="thread" style="display:none">
    <div id="topbar">
      <div class="avatar lg" id="chatAvatar"></div>
      <div><h2 id="chatTitle"></h2><div id="chatMeta"></div></div>
      <div id="meBadge"></div>
    </div>
    <div id="anchorBar"></div>
    <div id="scroller">
      <button id="loadMore" style="display:none">Load older messages</button>
      <div id="messages" style="display:flex;flex-direction:column"></div>
    </div>
    <footer id="pendingNote"></footer>
  </div>
</main>
<script>
let current = null;   // { app, chat }
let nextBefore = null;
let cache = [];        // all messages loaded so far for the open chat, oldest first

const esc = s => (s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtClock = t => { if (!t) return ""; const d = new Date(t.replace(" ", "T")); return isNaN(d) ? t : d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}); };
const fmtFull = t => t ? t.replace("T", " ") : "unknown time";

// Per-viewer convenience only — which sender to render as "me" in each chat. Never sent
// to the server, never read back by droidread; if storage is blocked (private window,
// blocked site data) the page still works, just always left-aligned.
function meKey(app, chat) { return \`droidread:me:\${app}:\${chat}\`; }
function getMe(app, chat) { try { return localStorage.getItem(meKey(app, chat)); } catch { return null; } }
function setMe(app, chat, sender) { try { if (sender) localStorage.setItem(meKey(app, chat), sender); else localStorage.removeItem(meKey(app, chat)); } catch {} }

// Stable colour per sender name, so the same person always gets the same avatar colour.
const PALETTE = ["#0b93f6","#7b5cff","#e0507a","#e8823c","#3fae5c","#1fb2c9","#c94f4f","#c99a1f","#5c7cff","#a25cff"];
function colorFor(name) {
  let h = 0; for (const c of (name || "?")) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initial(name) { return (name || "?").trim().charAt(0).toUpperCase() || "?"; }

async function loadOverview() {
  const r = await fetch("/api/overview").then(r => r.json());
  document.getElementById("totals").innerHTML =
    \`\${r.totals.messages} messages · \${r.totals.chats} chats<br>\${r.totals.photosDownloaded}/\${r.totals.photos} photos downloaded · \${r.cloud === "turso" ? "☁ Turso" : "local only"}\`;
  const list = document.getElementById("chatList");
  list.innerHTML = "";
  for (const c of r.chats) {
    const div = document.createElement("div");
    div.className = "chat-row";
    div.dataset.app = c.app; div.dataset.chat = c.chat;
    const pending = c.photos - c.photosDownloaded;
    div.innerHTML = \`<div class="avatar" style="background:\${colorFor(c.chat)}">\${esc(initial(c.chat))}</div>
      <div class="meta-col">
        <div class="name">\${esc(c.chat)}</div>
        <div class="preview">\${c.total} msgs · \${c.dated}/\${c.total} dated
          \${c.photos ? \`<span class="badge \${pending ? "pending" : ""}">\${c.photosDownloaded}/\${c.photos} 📷</span>\` : ""}
        </div>
      </div>\`;
    div.onclick = () => openChat(c.app, c.chat);
    list.appendChild(div);
  }
  return r;
}

function bubbleFor(m) {
  if (m.kind === "photo") {
    return m.hasPhoto
      ? \`<div class="bubble photo" data-id="\${m.id}"><img src="/api/photo/\${m.id}" loading="lazy" alt="photo"></div>\`
      : \`<div class="bubble pending-photo" data-id="\${m.id}">📷 marked, not downloaded\${m.mediaWhen ? " — " + esc(m.mediaWhen) : ""}</div>\`;
  }
  return \`<div class="bubble\${m.sentAt ? "" : " undated-flag"}" data-id="\${m.id}">\${esc(m.text)}</div>\`;
}

// Consecutive same-sender messages collapse into one group: avatar and name shown once,
// same as the reference UI. A fresh divider-based time gap (>10min) also starts a new
// group even for the same sender, so a long silence is visible.
function render(msgs, meSender) {
  const container = document.getElementById("messages");
  container.innerHTML = "";
  let group = null, lastSender = null, lastTs = null;
  for (const m of msgs) {
    const gapMs = (m.sentAt && lastTs) ? (new Date(m.sentAt.replace(" ","T")) - lastTs) : 0;
    const breaks = m.sender !== lastSender || gapMs > 10 * 60 * 1000;
    if (breaks || !group) {
      group = document.createElement("div");
      group.className = "group" + (meSender && m.sender === meSender ? " me" : "");
      const gutter = document.createElement("div");
      gutter.className = "gutter";
      gutter.innerHTML = \`<div class="avatar" style="background:\${colorFor(m.sender)}" title="click to mark \${esc(m.sender||"?")} as you" data-sender="\${esc(m.sender||"")}">\${esc(initial(m.sender))}</div>\`;
      const col = document.createElement("div");
      col.className = "col";
      const label = document.createElement("div");
      label.className = "sender-label";
      label.textContent = m.sender || "(unknown)";
      label.dataset.sender = m.sender || "";
      col.appendChild(label);
      group.appendChild(gutter);
      group.appendChild(col);
      container.appendChild(group);
      lastSender = m.sender;
    }
    const col = group.querySelector(".col");
    const wrap = document.createElement("div");
    wrap.innerHTML = bubbleFor(m);
    const bubbleEl = wrap.firstElementChild;
    col.appendChild(bubbleEl);
    const stamp = document.createElement("div");
    stamp.className = "stamp";
    stamp.textContent = fmtFull(m.sentAt) + (m.sentAtRaw ? \` (as shown: "\${m.sentAtRaw}")\` : "");
    col.appendChild(stamp);
    bubbleEl.onclick = () => stamp.classList.toggle("shown");
    lastTs = m.sentAt ? new Date(m.sentAt.replace(" ","T")) : lastTs;
  }
  // Click any avatar or sender name to mark them as "you" for this chat; click again to unmark.
  container.querySelectorAll("[data-sender]").forEach(el => {
    if (!el.dataset.sender) return;
    el.style.cursor = "pointer";
    el.onclick = (ev) => {
      ev.stopPropagation();
      const now = getMe(current.app, current.chat);
      setMe(current.app, current.chat, now === el.dataset.sender ? null : el.dataset.sender);
      renderMeBadge();
      render(cache, getMe(current.app, current.chat));
    };
  });
}

function renderMeBadge() {
  const me = getMe(current.app, current.chat);
  const el = document.getElementById("meBadge");
  el.innerHTML = me
    ? \`Viewing as <b>\${esc(me)}</b> <button id="clearMe">change</button>\`
    : \`<button id="clearMe">click a name to set "you"</button>\`;
  document.getElementById("clearMe").onclick = () => { setMe(current.app, current.chat, null); renderMeBadge(); render(cache, null); };
}

async function openChat(app, chat, loadOlder) {
  if (!loadOlder) {
    current = { app, chat };
    nextBefore = null; cache = [];
    document.querySelectorAll(".chat-row").forEach(r => r.classList.toggle("active", r.dataset.app === app && r.dataset.chat === chat));
    document.getElementById("empty").style.display = "none";
    document.getElementById("thread").style.display = "flex";
    document.getElementById("chatTitle").textContent = chat;
    document.getElementById("chatAvatar").textContent = initial(chat);
    document.getElementById("chatAvatar").style.background = colorFor(chat);
    renderMeBadge();

    const [ov, anchors, pend] = await Promise.all([
      fetch("/api/overview").then(r => r.json()),
      fetch(\`/api/anchors?app=\${encodeURIComponent(app)}&chat=\${encodeURIComponent(chat)}\`).then(r => r.json()),
      fetch(\`/api/pending?app=\${encodeURIComponent(app)}&chat=\${encodeURIComponent(chat)}\`).then(r => r.json()),
    ]);
    const meta = ov.chats.find(c => c.app === app && c.chat === chat);
    document.getElementById("chatMeta").textContent = meta ? \`\${meta.total} messages · \${meta.anchors} time anchors\` : "";
    document.getElementById("anchorBar").textContent = anchors.length
      ? "Timeline: " + anchors.slice(0, 16).map(a => (a.sentAt ? fmtClock(a.sentAt) + " " + a.sentAt.slice(0,10) : a.raw)).join("   ·   ")
      : "No timestamp dividers indexed yet for this chat.";
    document.getElementById("pendingNote").textContent = pend.length ? \`\${pend.length} photo(s) marked but not yet downloaded — run messenger_media_fetch to pull them.\` : "";
  }

  const url = new URL("/api/messages", location.origin);
  url.searchParams.set("app", app); url.searchParams.set("chat", chat);
  if (nextBefore) url.searchParams.set("before", nextBefore);
  const r = await fetch(url).then(r => r.json());

  const atBottom = !loadOlder;
  const scroller = document.getElementById("scroller");
  const prevHeight = scroller.scrollHeight;
  cache = [...r.messages, ...cache];
  render(cache, getMe(app, chat));

  nextBefore = r.nextBefore;
  const btn = document.getElementById("loadMore");
  btn.style.display = nextBefore ? "block" : "none";
  btn.onclick = () => openChat(app, chat, true);

  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop = scroller.scrollHeight - prevHeight;   // keep viewport steady when older messages prepend
}

let searchTimer = null;
document.getElementById("search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = document.getElementById("searchResults");
  if (!q) { box.innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    const rows = await fetch(\`/api/search?q=\${encodeURIComponent(q)}\`).then(r => r.json());
    box.innerHTML = "";
    for (const h of rows) {
      const div = document.createElement("div");
      div.className = "hit";
      div.innerHTML = \`<div class="chat">\${esc(h.chat)} · \${esc(h.sender)}</div>\${esc((h.text || "").slice(0, 90))}\`;
      div.onclick = () => openChat(h.app, h.chat);
      box.appendChild(div);
    }
    if (!rows.length) box.innerHTML = '<div style="opacity:.5;padding:8px">no hits</div>';
  }, 200);
});

loadOverview();
</script>
</body>
</html>`;

const HANDLER = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
  if (url.pathname === "/api/overview") return json(await overview());

  if (url.pathname === "/api/messages") {
    const app = url.searchParams.get("app") ?? "";
    const chat = url.searchParams.get("chat") ?? "";
    if (!app || !chat) return json({ error: "app and chat are required" }, 400);
    const before = url.searchParams.get("before");
    const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 60));
    return json(await messages(app, chat, before ? Number(before) : null, limit));
  }

  if (url.pathname === "/api/anchors") {
    const app = url.searchParams.get("app") ?? "";
    const chat = url.searchParams.get("chat") ?? "";
    if (!app || !chat) return json({ error: "app and chat are required" }, 400);
    return json(await anchorsFor(app, chat));
  }

  if (url.pathname === "/api/pending") {
    const app = url.searchParams.get("app") ?? "";
    const chat = url.searchParams.get("chat") ?? "";
    if (!app || !chat) return json({ error: "app and chat are required" }, 400);
    return json(await pending(app, chat));
  }

  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) return json([]);
    const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 30));
    try { return json(await searchAll(q, limit)); }
    catch (e) { return json({ error: (e as Error).message }, 400); }   // an unbalanced FTS5 query string, not a server fault
  }

  const photoMatch = url.pathname.match(/^\/api\/photo\/(\d+)$/);
  if (photoMatch) return photoResponse(Number(photoMatch[1]));

  return new Response("not found", { status: 404 });
};

const bound: ReturnType<typeof Bun.serve>[] = [];
for (const hostname of HOSTS) {
  try { bound.push(Bun.serve({ hostname, port: PORT, fetch: HANDLER })); }
  catch (e) { console.error(`cannot bind ${hostname}:${PORT} — ${(e as Error).message}`); }
}
if (!bound.length) { console.error("nothing bound — exiting"); process.exit(1); }

console.error(`droidread data viewer — read-only, no adb, no phone needed`);
for (const s of bound) console.error(`  listening : http://${s.hostname}:${s.port}/`);
console.error(`  data      : ${DATA_DIR} (${process.env.TURSO_DATABASE_URL ? "Turso cloud" : "local file"})`);
console.error(`  env       : ${envPath ?? "no ~/.droidread/.env found"}`);
