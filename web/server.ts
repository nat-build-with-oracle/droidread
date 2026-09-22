#!/usr/bin/env bun
// web/server.ts — browser viewer and tap control for an adb-reachable Android device.
//
// The EYES half of droidread. The rest of the repo reads the accessibility tree, which is
// precise but blind: it cannot show you a photo, a sticker, an unlabelled dialog or a
// rendering glitch. This serves the actual screen to a browser on your LAN or VPN, with
// click-to-tap, plus two endpoints the indexer itself uses:
//
//   GET /shot.png   one frame  (src/screen.ts prefers this over its own adb screencap
//                   when DROIDREAD_STREAM_URL is set — see "warm frames" below)
//   GET /ui.json    the accessibility tree as JSON
//
// Transport is MJPEG over HTTP via `adb exec-out screencap`, not H.264. That is a
// deliberate simplification: one shared capture loop, one capture in flight, ~1.4fps.
// Measured the hard way — a per-client loop (fresh adb process and a ~4MB PNG each)
// pushed ~11 MB/s over USB and the SM-A146P re-enumerated itself. The /h264 path exists
// as an opt-in upgrade and needs a scrcpy server jar you supply yourself.
//
// Originally a portable reimplementation of laris-co/neo-oracle's DroidCast.swift
// (AppKit + VideoToolbox, macOS only) for a Linux host.
//
// Rule 6: AI-assisted work by Nexus (AI) with Nat Weerawan. Serves only the operator's own
// device over their own authorised adb connection. It binds 0.0.0.0 and has NO
// authentication — it is a LAN/VPN tool, never something to expose to the internet.

const PORT = Number(process.env.DROIDREAD_WEB_PORT ?? process.env.DROIDCAST_WEB_PORT ?? 8791);
const ADB = process.env.DROIDREAD_ADB ?? process.env.DROIDCAST_ADB ?? "adb";
const FRAME_INTERVAL_MS = Number(process.env.DROIDREAD_WEB_FRAME_MS ?? process.env.DROIDCAST_FRAME_MS ?? 700); // ~1.4fps — measured: 400ms
// with a per-client loop (fresh adb process + ~4MB PNG each) pushed ~11 MB/s over USB and the
// SM-A146P re-enumerated (devnum climbing); idle it held for 60s. So: ONE shared loop, one
// capture in flight, gentler cadence.
const NO_DEVICE_BACKOFF_MS = 1500;
const SERIAL_CACHE_MS = 3000;

// ── adb helpers ──────────────────────────────────────────────────────────────

async function adb(args: string[], serial?: string): Promise<{ stdout: Uint8Array; stderr: string; code: number }> {
  const full = serial ? ["-s", serial, ...args] : args;
  const proc = Bun.spawn([ADB, ...full], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

type Device = { serial: string; state: string };

async function listDevices(): Promise<Device[]> {
  const { stdout } = await adb(["devices"]);
  const text = new TextDecoder().decode(stdout);
  return text
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*"))
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state };
    });
}

// device screen size cache, per serial — needed to scale normalized tap coords
const sizeCache = new Map<string, { w: number; h: number }>();

async function getScreenSize(serial: string): Promise<{ w: number; h: number } | null> {
  if (sizeCache.has(serial)) return sizeCache.get(serial)!;
  const { stdout } = await adb(["shell", "wm", "size"], serial);
  const text = new TextDecoder().decode(stdout);
  // "Physical size: 1080x2400"
  const m = text.match(/(\d+)x(\d+)/);
  if (!m) return null;
  const size = { w: Number(m[1]), h: Number(m[2]) };
  sizeCache.set(serial, size);
  return size;
}

async function firstDevice(): Promise<string | null> {
  const devs = await listDevices();
  const online = devs.find((d) => d.state === "device");
  return online?.serial ?? null;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const PAGE = `<!doctype html>
<title>droidcast-web</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0b0e; color:#e5e5e8; font:14px system-ui, sans-serif; }
  #bar { padding:8px 12px; display:flex; gap:12px; align-items:center; background:#141418; border-bottom:1px solid #2a2a30; }
  #bar span.dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
  #wrap { display:flex; justify-content:center; padding:16px; }
  #frame { position:relative; max-width:420px; width:100%; border:1px solid #2a2a30; border-radius:8px; overflow:hidden; }
  #frame img { width:100%; display:block; cursor:crosshair; }
  #hint { padding:8px 12px; opacity:.6; }
  .row { display:flex; gap:8px; justify-content:center; padding:8px; }
  button { background:#1c1c22; color:#e5e5e8; border:1px solid #2a2a30; border-radius:6px; padding:6px 14px; cursor:pointer; }
  button:hover { background:#26262e; }
</style>
<div id="bar"><span class="dot" id="dot" style="background:#666"></span><span id="status">connecting…</span></div>
<div id="wrap"><div id="frame"><img id="v" src="/stream" alt="device screen"></div></div>
<div class="row">
  <button onclick="key(4)">← Back</button>
  <button onclick="key(3)">● Home</button>
  <button onclick="key(187)">▢ Recents</button>
</div>
<div id="hint">Click the screen to tap. Serving on port ${PORT}. Frame ~${FRAME_INTERVAL_MS}ms (screencap-bound, not real-time video — see README).</div>
<script>
const img = document.getElementById('v');
const dot = document.getElementById('dot');
const status = document.getElementById('status');

img.addEventListener('click', (e) => {
  const r = img.getBoundingClientRect();
  const nx = (e.clientX - r.left) / r.width;
  const ny = (e.clientY - r.top) / r.height;
  fetch('/tap', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ nx, ny }) });
});

function key(code) {
  fetch('/key', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ code }) });
}

async function pollStatus() {
  try {
    const r = await fetch('/devices');
    const devs = await r.json();
    const online = devs.find(d => d.state === 'device');
    if (online) {
      dot.style.background = '#3fb950';
      status.textContent = 'device: ' + online.serial;
    } else if (devs.length) {
      dot.style.background = '#d29922';
      status.textContent = devs.length + ' device(s), none authorized/online';
    } else {
      dot.style.background = '#f85149';
      status.textContent = 'no device — connect USB or: adb connect <phone-ip>:5555';
    }
  } catch (e) {
    dot.style.background = '#f85149';
    status.textContent = 'server unreachable';
  }
}
pollStatus();
setInterval(pollStatus, 3000);
</script>
`;

// placeholder PNG (1x1 transparent) for when no device is attached — kept the
// stream alive with a real (tiny) frame rather than hanging the connection
const PLACEHOLDER_PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
), c => c.charCodeAt(0));

// ── shared capture loop ──────────────────────────────────────────────────────
// One loop for ALL viewers. Runs only while someone is subscribed; exactly one
// screencap in flight at a time; the frame is fanned out to every subscriber.

const BOUNDARY = "droidcastweb";
const ENC = new TextEncoder();

type Subscriber = { controller: ReadableStreamDefaultController<Uint8Array> };
const subscribers = new Set<Subscriber>();
let loopRunning = false;

// The most recent real frame, kept so /shot.png can answer without spawning another
// `adb exec-out screencap`. That matters more than it looks: while droidread is scrolling
// a conversation, a second adb capture competes with uiautomator on the same device and
// slows the read it is meant to be watching. When a viewer is open the loop is already
// producing frames, so a screenshot is free.
let lastFrame: { png: Uint8Array; at: number } | null = null;

let serialCache: { serial: string | null; at: number } = { serial: null, at: 0 };
async function cachedFirstDevice(): Promise<string | null> {
  const now = Date.now();
  if (now - serialCache.at < SERIAL_CACHE_MS) return serialCache.serial;
  const serial = await firstDevice();
  serialCache = { serial, at: now };
  return serial;
}

function broadcast(png: Uint8Array) {
  if (png !== PLACEHOLDER_PNG) lastFrame = { png, at: Date.now() };
  const header = ENC.encode(`--${BOUNDARY}\r\nContent-Type: image/png\r\nContent-Length: ${png.length}\r\n\r\n`);
  const tail = ENC.encode("\r\n");
  for (const s of subscribers) {
    try {
      s.controller.enqueue(header);
      s.controller.enqueue(png);
      s.controller.enqueue(tail);
    } catch {
      subscribers.delete(s); // client went away
    }
  }
}

async function ensureCaptureLoop() {
  if (loopRunning) return;
  loopRunning = true;
  try {
    while (subscribers.size > 0) {
      const serial = await cachedFirstDevice();
      if (!serial) {
        broadcast(PLACEHOLDER_PNG);
        await Bun.sleep(NO_DEVICE_BACKOFF_MS);
        continue;
      }
      const { stdout, code } = await adb(["exec-out", "screencap", "-p"], serial);
      if (code === 0 && stdout.length > 0) {
        broadcast(stdout);
        await Bun.sleep(FRAME_INTERVAL_MS);
      } else {
        // capture failed — device probably just dropped; forget the cached serial and back off
        serialCache = { serial: null, at: 0 };
        broadcast(PLACEHOLDER_PNG);
        await Bun.sleep(NO_DEVICE_BACKOFF_MS);
      }
    }
  } finally {
    loopRunning = false;
  }
}

// ── h264 (low-latency path) ──────────────────────────────────────────────────
// Opt-in second transport. Started lazily on first /h264ws connection so the phone's
// encoder isn't running when nobody is watching, and torn down when the last one leaves.

import { startH264, type H264Stream } from "./h264.ts";
import { INSPECT_PAGE, dumpNodes, screenshotPng } from "./inspect.ts";

let h264: H264Stream | null = null;
let h264Viewers = 0;

async function ensureH264(): Promise<H264Stream> {
  if (!h264) h264 = await startH264({ maxSize: 1024, bitRate: 4_000_000, maxFps: 30 });
  return h264;
}

function releaseH264() {
  if (h264Viewers <= 0 && h264) {
    h264.stop();
    h264 = null;
  }
}

const H264_PAGE = `<!doctype html>
<title>droidcast-web · h264</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0b0e; color:#e5e5e8; font:14px system-ui, sans-serif; }
  #bar { padding:8px 12px; display:flex; gap:12px; align-items:center; background:#141418; border-bottom:1px solid #2a2a30; }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; background:#666; }
  #wrap { display:flex; justify-content:center; padding:16px; }
  canvas { max-width:420px; width:100%; border:1px solid #2a2a30; border-radius:8px; cursor:crosshair; display:block; }
  .row { display:flex; gap:8px; justify-content:center; padding:8px; }
  button { background:#1c1c22; color:#e5e5e8; border:1px solid #2a2a30; border-radius:6px; padding:6px 14px; cursor:pointer; }
  button:hover { background:#26262e; }
  #hint { padding:8px 12px; opacity:.6; font-size:12px; }
  a { color:#6cb6ff; }
</style>
<div id="bar"><span class="dot" id="dot"></span><span id="status">connecting…</span><span id="fps" style="margin-left:auto;opacity:.6"></span></div>
<div id="wrap"><canvas id="cv"></canvas></div>
<div class="row">
  <button onclick="key(4)">← Back</button>
  <button onclick="key(3)">● Home</button>
  <button onclick="key(187)">▢ Recents</button>
</div>
<div id="hint">H.264 via the phone's hardware encoder, decoded in-browser by WebCodecs.
Host does not transcode. <a href="/">MJPEG version →</a></div>
<script>
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const dot = document.getElementById('dot'), status = document.getElementById('status'), fpsEl = document.getElementById('fps');
let frames = 0, t0 = performance.now();

// WebCodecs is SECURE-CONTEXT ONLY. Over plain http:// on a LAN IP, VideoDecoder is
// simply not defined — it throws ReferenceError before any stream work happens, which
// looks like a decode failure but is a page-origin problem. Say so plainly instead.
if (typeof VideoDecoder === "undefined") {
  dot.style.background = '#f85149';
  status.textContent = 'WebCodecs unavailable — needs HTTPS or localhost';
  document.getElementById('hint').innerHTML =
    '<b>This page must be served over HTTPS or from localhost.</b><br>' +
    'WebCodecs (<code>VideoDecoder</code>) is disabled in insecure contexts, so H.264 cannot decode here.<br><br>' +
    'Fix, pick one:<br>' +
    '&nbsp;&nbsp;1. <a href="' + location.href.replace(/^http:/, 'https:').replace(':' + location.port, ':' + (Number(location.port)+1)) + '">Use HTTPS</a> (self-signed — accept the warning once)<br>' +
    '&nbsp;&nbsp;2. SSH tunnel: <code>ssh -L ' + location.port + ':localhost:' + location.port + ' nat@' + location.hostname + '</code> then open <code>http://localhost:' + location.port + '/h264</code><br>' +
    '&nbsp;&nbsp;3. <a href="/">Use the MJPEG viewer</a> — works over plain HTTP, no WebCodecs needed';
  throw new Error('WebCodecs unavailable in insecure context');
}

const decoder = new VideoDecoder({
  output: (frame) => {
    if (cv.width !== frame.displayWidth) { cv.width = frame.displayWidth; cv.height = frame.displayHeight; }
    ctx.drawImage(frame, 0, 0);
    frame.close();
    frames++;
    const el = (performance.now() - t0) / 1000;
    if (el >= 1) { fpsEl.textContent = (frames/el).toFixed(1) + ' fps'; frames = 0; t0 = performance.now(); }
  },
  error: (e) => { status.textContent = 'decoder error: ' + e.message; dot.style.background = '#f85149'; },
});

// The codec string is NOT guessed. A wrong profile lets configure() succeed and then
// decode silently produces no frames — a black canvas with no error, which is exactly
// the failure this replaced. Instead we wait for the SPS, read profile_idc /
// constraint_flags / level_idc out of it, and build the real string.
// Annex-B needs no description field; SPS/PPS travel inline in the stream.
let configured = false;
function configureFromSps(sps) {
  // sps = [00 00 00 01] [67] [profile_idc] [constraint_flags] [level_idc] ...
  const profile = sps[5], constraints = sps[6], level = sps[7];
  const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
  const codec = 'avc1.' + hex(profile) + hex(constraints) + hex(level);
  decoder.configure({ codec, optimizeForLatency: true });
  configured = true;
  status.textContent = 'streaming · ' + codec;
  return codec;
}

const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/h264ws');
ws.binaryType = 'arraybuffer';
ws.onopen = () => { dot.style.background = '#3fb950'; status.textContent = 'streaming'; };
ws.onclose = () => { dot.style.background = '#f85149'; status.textContent = 'disconnected'; };
ws.onerror = () => { dot.style.background = '#f85149'; status.textContent = 'ws error'; };
let pending = [];
let sawKeyframe = false;

ws.onmessage = (ev) => {
  const buf = new Uint8Array(ev.data);
  const nalType = buf[4] & 0x1f;

  // SPS(7)/PPS(8) carry no picture. Hold them: they must be prepended to the first IDR,
  // and the SPS is also what tells us which codec string to configure with.
  if (nalType === 7 || nalType === 8) {
    pending.push(buf);
    if (nalType === 7 && !configured) {
      try { configureFromSps(buf); }
      catch (e) {
        dot.style.background = '#f85149';
        status.textContent = 'configure failed: ' + e.message;
      }
    }
    return;
  }

  // Nothing decodable until the decoder is configured AND a keyframe has arrived.
  // Feeding deltas before an IDR is not an error worth showing — it is the normal
  // first second of any stream — but everything after that IS worth showing.
  const isKey = nalType === 5;
  if (!configured) return;
  if (!isKey && !sawKeyframe) return;

  let payload = buf;
  if (isKey) {
    sawKeyframe = true;
    if (pending.length) {
      const total = pending.reduce((n, p) => n + p.length, 0) + buf.length;
      payload = new Uint8Array(total);
      let off = 0;
      for (const p of pending) { payload.set(p, off); off += p.length; }
      payload.set(buf, off);
      pending = [];
    }
  }

  try {
    decoder.decode(new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: performance.now() * 1000,
      data: payload,
    }));
  } catch (e) {
    // Do NOT swallow this. A silently-eaten decode error is precisely why the canvas
    // was black with the status bar cheerfully reading "streaming".
    dot.style.background = '#f85149';
    status.textContent = 'decode error: ' + e.message;
  }
};

cv.addEventListener('click', (e) => {
  const r = cv.getBoundingClientRect();
  fetch('/tap', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ nx: (e.clientX-r.left)/r.width, ny: (e.clientY-r.top)/r.height }) });
});
function key(code) {
  fetch('/key', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ code }) });
}
</script>
`;

// ── server ───────────────────────────────────────────────────────────────────

// Handlers are named so the HTTP and HTTPS listeners below share one implementation.
const WS_HANDLERS = {
    async open(ws: any) {
      h264Viewers++;
      try {
        const s = await ensureH264();
        // Replay SPS/PPS/IDR first so a viewer joining mid-stream decodes immediately
        // instead of waiting for the next keyframe.
        for (const nal of s.initSegment()) ws.send(nal);
        const unsub = s.subscribe((nal) => {
          try { ws.send(nal); } catch { unsub(); }
        });
        (ws as any)._unsub = unsub;
      } catch (e) {
        h264Viewers--;
        try { ws.close(1011, String(e)); } catch {}
      }
    },
    close(ws: any) {
      try { (ws as any)._unsub?.(); } catch {}
      h264Viewers--;
      releaseH264();
    },
    message() {},
};

const HANDLER = async (req: Request, server: any): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/h264ws") {
      if (server.upgrade(req)) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 400 });
    }

    if (url.pathname === "/h264") {
      return new Response(H264_PAGE, { headers: { "content-type": "text/html" } });
    }

    if (url.pathname === "/inspect") {
      return new Response(INSPECT_PAGE, { headers: { "content-type": "text/html" } });
    }

    if (url.pathname === "/ui.json") {
      try {
        return Response.json(await dumpNodes());
      } catch (e) {
        return new Response(String((e as Error).message), { status: 503 });
      }
    }

    if (url.pathname === "/shot.png") {
      // ?max_age_ms=N accepts a frame the capture loop already produced within the last
      // N ms; 0 (the default) always captures fresh. A caller that wants to SEE the
      // screen right now passes nothing; a caller polling for a rough idea of state
      // passes a budget and costs the device nothing.
      const maxAge = Number(url.searchParams.get("max_age_ms") ?? 0);
      if (maxAge > 0 && lastFrame && Date.now() - lastFrame.at <= maxAge) {
        return new Response(lastFrame.png, {
          headers: { "content-type": "image/png", "cache-control": "no-store", "x-frame-age-ms": String(Date.now() - lastFrame.at) },
        });
      }
      const png = await screenshotPng();
      lastFrame = { png, at: Date.now() };
      return new Response(png, {
        headers: { "content-type": "image/png", "cache-control": "no-store", "x-frame-age-ms": "0" },
      });
    }

    if (url.pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    }

    if (url.pathname === "/devices" && req.method === "GET") {
      const devs = await listDevices();
      return Response.json(devs);
    }

    if (url.pathname === "/stream" && req.method === "GET") {
      let sub: Subscriber | null = null;
      const stream = new ReadableStream({
        start(controller) {
          sub = { controller };
          subscribers.add(sub);
          req.signal.addEventListener("abort", () => { if (sub) subscribers.delete(sub); });
          ensureCaptureLoop();
        },
        cancel() { if (sub) subscribers.delete(sub); },
      });
      return new Response(stream, {
        headers: { "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}` },
      });
    }

    if (url.pathname === "/tap" && req.method === "POST") {
      const serial = await firstDevice();
      if (!serial) return Response.json({ ok: false, error: "no device" }, { status: 503 });
      const size = await getScreenSize(serial);
      if (!size) return Response.json({ ok: false, error: "could not read screen size" }, { status: 500 });
      const body = await req.json() as { nx: number; ny: number };
      const x = Math.round(body.nx * size.w);
      const y = Math.round(body.ny * size.h);
      const { code, stderr } = await adb(["shell", "input", "tap", String(x), String(y)], serial);
      return Response.json({ ok: code === 0, x, y, stderr: stderr || undefined });
    }

    if (url.pathname === "/swipe" && req.method === "POST") {
      const serial = await firstDevice();
      if (!serial) return Response.json({ ok: false, error: "no device" }, { status: 503 });
      const size = await getScreenSize(serial);
      if (!size) return Response.json({ ok: false, error: "could not read screen size" }, { status: 500 });
      const body = await req.json() as { nx1: number; ny1: number; nx2: number; ny2: number; durMs?: number };
      const x1 = Math.round(body.nx1 * size.w), y1 = Math.round(body.ny1 * size.h);
      const x2 = Math.round(body.nx2 * size.w), y2 = Math.round(body.ny2 * size.h);
      const dur = String(body.durMs ?? 200);
      const { code, stderr } = await adb(["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), dur], serial);
      return Response.json({ ok: code === 0, stderr: stderr || undefined });
    }

    if (url.pathname === "/key" && req.method === "POST") {
      const serial = await firstDevice();
      if (!serial) return Response.json({ ok: false, error: "no device" }, { status: 503 });
      const body = await req.json() as { code: number };
      const { code, stderr } = await adb(["shell", "input", "keyevent", String(body.code)], serial);
      return Response.json({ ok: code === 0, stderr: stderr || undefined });
    }

    return new Response("not found", { status: 404 });
};

Bun.serve({ port: PORT, hostname: "0.0.0.0", websocket: WS_HANDLERS, fetch: HANDLER });

// HTTPS twin on PORT+1. Exists for exactly one reason: WebCodecs (the /h264 path) is
// secure-context only, so over plain http:// on a LAN IP `VideoDecoder` is undefined.
// Self-signed, so the browser warns once — accept it and /h264 works from any machine
// without an SSH tunnel. MJPEG needs none of this and stays fine on plain HTTP.
//
// import.meta.dir, NOT `new URL(..., import.meta.url).pathname` — this directory is
// literally named "ψ", which URL-encodes to %CF%88 and yields a path that does not
// exist. That failure is silent: the cert check just goes false and HTTPS never starts.
const certPath = `${import.meta.dir}/cert.pem`;
const keyPath = `${import.meta.dir}/key.pem`;

// Generated on first run, never committed: a checked-in TLS private key is a published
// private key. openssl is the only requirement; without it the HTTPS twin is skipped and
// MJPEG over plain HTTP still works.
if (!(await Bun.file(certPath).exists()) || !(await Bun.file(keyPath).exists())) {
  const gen = Bun.spawn([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
    "-subj", "/CN=droidread-web", "-keyout", keyPath, "-out", certPath,
  ], { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(gen.stderr).text();
  if ((await gen.exited) !== 0) console.log(`  (no https: openssl failed — ${err.trim().split("\n").pop()})`);
}

if (await Bun.file(certPath).exists() && await Bun.file(keyPath).exists()) {
  Bun.serve({
    port: PORT + 1,
    hostname: "0.0.0.0",
    tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) },
    websocket: WS_HANDLERS,
    fetch: HANDLER,
  });
  console.log(`  https (for /h264): https://0.0.0.0:${PORT + 1}  (self-signed, generated locally)`);
}

console.log(`droidread web viewer listening on 0.0.0.0:${PORT}`);
console.log(`  LAN:           http://${process.env.HOSTNAME ?? "localhost"}.local:${PORT}`);
console.log(`  endpoints:     /  /inspect  /h264  /stream  /shot.png  /ui.json`);
console.log(`  NOTE: no authentication — LAN or VPN only, never the public internet.`);
