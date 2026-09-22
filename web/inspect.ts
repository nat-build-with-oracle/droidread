// inspect.ts — "inspect element" for the phone.
//
// Serves the live screen with every accessibility node drawn as a clickable box.
// Clicking one shows what you would actually write in code: the adr selector, the
// resource-id, the text, and the raw bounds.
//
// Why this exists: writing automation against LINE meant dumping XML, eyeballing
// bounds="[63,304][1017,502]", and doing centre-point arithmetic by hand — then
// discovering the id you targeted was an empty container (chat_ui_row_text_message
// holds no text; chat_ui_message_text does). That is invisible in a screenshot and
// obvious here.

const ADB = process.env.DROIDREAD_ADB ?? process.env.DROIDCAST_ADB ?? "adb";

export interface UiNode {
  id: string;
  cls: string;
  text: string;
  desc: string;
  clickable: boolean;
  bounds: [number, number, number, number];
}

async function adb(...args: string[]): Promise<string> {
  const p = Bun.spawn([ADB, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

async function adbBytes(...args: string[]): Promise<Uint8Array> {
  const p = Bun.spawn([ADB, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).bytes();
  await p.exited;
  return out;
}

function unescapeXml(s: string): string {
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export async function dumpNodes(): Promise<{ nodes: UiNode[]; w: number; h: number }> {
  const remote = "/sdcard/inspect-ui.xml";
  await adb("shell", "uiautomator", "dump", remote);
  const xml = await adb("shell", "cat", remote);
  if (!xml.includes("<hierarchy")) throw new Error("no hierarchy — screen off, locked, or secure window");

  const nodes: UiNode[] = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a: Record<string, string> = {};
    const ar = /([\w-]+)="([^"]*)"/g;
    let x: RegExpExecArray | null;
    while ((x = ar.exec(m[1])) !== null) a[x[1]] = unescapeXml(x[2]);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(a["bounds"] ?? "");
    if (!b) continue;
    nodes.push({
      id: (a["resource-id"] ?? "").split("/").pop() ?? "",
      cls: (a["class"] ?? "").split(".").pop() ?? "",
      text: (a["text"] ?? "").trim(),
      desc: (a["content-desc"] ?? "").trim(),
      clickable: a["clickable"] === "true",
      bounds: [+b[1], +b[2], +b[3], +b[4]],
    });
  }

  const size = await adb("shell", "wm", "size");
  const sm = /(\d+)x(\d+)/.exec(size);
  return { nodes, w: Number(sm?.[1] ?? 1080), h: Number(sm?.[2] ?? 2400) };
}

export async function screenshotPng(): Promise<Uint8Array> {
  return adbBytes("exec-out", "screencap", "-p");
}

export const INSPECT_PAGE = `<!doctype html>
<title>droidcast-web · inspect</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0b0e; color:#e5e5e8; font:13px system-ui, sans-serif; display:flex; height:100vh; }
  #left { flex:0 0 auto; padding:12px; overflow:auto; }
  #stage { position:relative; display:inline-block; border:1px solid #2a2a30; border-radius:6px; overflow:hidden; }
  #stage img { display:block; width:380px; }
  .box { position:absolute; border:1px solid rgba(80,180,255,.35); cursor:pointer; }
  .box:hover { border-color:#6cb6ff; background:rgba(108,182,255,.15); }
  .box.sel { border-color:#3fb950; background:rgba(63,185,80,.2); }
  .box.txt { border-color:rgba(210,153,34,.5); }
  #right { flex:1; padding:12px 16px; overflow:auto; border-left:1px solid #2a2a30; min-width:0; }
  h3 { margin:0 0 8px; font-size:13px; opacity:.7; font-weight:600; }
  table { border-collapse:collapse; width:100%; }
  td { padding:3px 8px 3px 0; vertical-align:top; font-size:12px; }
  td:first-child { opacity:.55; white-space:nowrap; width:1%; }
  code { background:#1c1c22; padding:2px 6px; border-radius:4px; font-size:12px; word-break:break-all; }
  .snip { background:#141418; border:1px solid #2a2a30; border-radius:6px; padding:8px 10px; margin:6px 0; }
  button { background:#1c1c22; color:#e5e5e8; border:1px solid #2a2a30; border-radius:6px; padding:5px 12px; cursor:pointer; margin-right:6px; }
  button:hover { background:#26262e; }
  #bar { padding:8px 12px; border-bottom:1px solid #2a2a30; background:#141418; display:flex; gap:8px; align-items:center; }
  .warn { color:#d29922; }
</style>
<div style="display:flex;flex-direction:column;width:100%">
<div id="bar">
  <button onclick="refresh()">↻ Refresh</button>
  <label><input type="checkbox" id="onlyText" onchange="render()"> text/clickable only</label>
  <span id="status" style="opacity:.6"></span>
</div>
<div style="display:flex;flex:1;min-height:0">
  <div id="left"><div id="stage"><img id="shot"><div id="boxes"></div></div></div>
  <div id="right"><h3>click an element</h3><div id="detail"></div></div>
</div>
</div>
<script>
let data = { nodes: [], w: 1080, h: 2400 }, scale = 1, selected = -1;

async function refresh() {
  document.getElementById('status').textContent = 'dumping…';
  try {
    const r = await fetch('/ui.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(await r.text());
    data = await r.json();
    document.getElementById('shot').src = '/shot.png?t=' + Date.now();
    document.getElementById('status').textContent = data.nodes.length + ' nodes · ' + data.w + 'x' + data.h;
    render();
  } catch (e) {
    document.getElementById('status').innerHTML = '<span class="warn">' + e.message + '</span>';
  }
}

function render() {
  const img = document.getElementById('shot');
  scale = (img.clientWidth || 380) / data.w;
  const onlyText = document.getElementById('onlyText').checked;
  const boxes = document.getElementById('boxes');
  boxes.innerHTML = '';
  data.nodes.forEach((n, i) => {
    if (onlyText && !n.text && !n.desc && !n.clickable) return;
    const [x1,y1,x2,y2] = n.bounds;
    const d = document.createElement('div');
    d.className = 'box' + (n.text ? ' txt' : '') + (i === selected ? ' sel' : '');
    d.style.left = (x1*scale)+'px'; d.style.top = (y1*scale)+'px';
    d.style.width = ((x2-x1)*scale)+'px'; d.style.height = ((y2-y1)*scale)+'px';
    d.onclick = (e) => { e.stopPropagation(); selected = i; render(); detail(n); };
    boxes.appendChild(d);
  });
}

function esc(s) { return (s||'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

function detail(n) {
  const [x1,y1,x2,y2] = n.bounds;
  const cx = Math.round((x1+x2)/2), cy = Math.round((y1+y2)/2);
  // Prefer the most durable selector: id > text > desc > raw coords. Coordinates move
  // with every layout change; ids and text mostly do not.
  let sel = n.id ? 'id=' + n.id : n.text ? 'text=' + n.text : n.desc ? 'desc=' + n.desc : cx + ',' + cy;
  const empty = !n.text && !n.desc;
  document.getElementById('right').innerHTML =
    '<h3>' + esc(n.cls || 'node') + (n.clickable ? ' · clickable' : '') + '</h3>' +
    '<table>' +
    '<tr><td>id</td><td><code>' + esc(n.id || '—') + '</code></td></tr>' +
    '<tr><td>text</td><td>' + (n.text ? '<code>' + esc(n.text) + '</code>' : '<span style="opacity:.4">(empty)</span>') + '</td></tr>' +
    '<tr><td>desc</td><td>' + (n.desc ? '<code>' + esc(n.desc) + '</code>' : '<span style="opacity:.4">(empty)</span>') + '</td></tr>' +
    '<tr><td>bounds</td><td><code>[' + x1 + ',' + y1 + '][' + x2 + ',' + y2 + ']</code> · centre <code>' + cx + ',' + cy + '</code></td></tr>' +
    '</table>' +
    (empty ? '<div class="snip warn">No text or desc — this is a container. The text usually lives on a child node; click inside it.</div>' : '') +
    '<div class="snip"><div style="opacity:.55;margin-bottom:4px">tap it</div><code>adr tap \\'' + esc(sel) + '\\'</code></div>' +
    '<div class="snip"><div style="opacity:.55;margin-bottom:4px">read it in code</div><code>nodes.find(n =&gt; n.id === "' + esc(n.id) + '")</code></div>' +
    '<div style="margin-top:10px"><button onclick="tap(' + cx + ',' + cy + ')">Tap on device</button></div>';
}

async function tap(x, y) {
  await fetch('/tap', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ nx: x/data.w, ny: y/data.h }) });
  setTimeout(refresh, 1200);
}

document.getElementById('shot').onload = render;
refresh();
</script>
`;
