// screen.ts — a picture of the phone screen, as opposed to the accessibility tree.
//
// TWO KINDS OF SNAPSHOT, AND WHY BOTH EXIST:
//   src/snapshot.ts  -> the TREE: text, roles, coordinates, what is clickable. Cheap,
//                       greppable, and the only one you can act on by selector.
//   this file        -> the PIXELS: what a human sees. The tree cannot show you a photo,
//                       a sticker, a rendering glitch or a dialog drawn without
//                       accessibility labels. When the tree looks wrong, look at this.
//
// An MCP client pays for an image by the token, so a raw 1080x2408 PNG (~470 KB, ~630 KB
// once base64'd) is not a reasonable default. Downscaling to 540px wide JPEG costs about
// a tenth of that and is still legible. ffmpeg does the resize when present; without it
// the original PNG is returned rather than failing.

import { ADB } from "./adb.ts";

export interface Shot {
  data: Uint8Array;
  mime: "image/jpeg" | "image/png";
  width: number | null;   // null when the image was not resized
  bytes: number;
  source: "adb" | "stream";
  ageMs: number | null;   // how stale the frame was, when it came from the viewer
}

/**
 * The web viewer (web/server.ts) already runs a capture loop whenever a browser is
 * watching, and serves the last frame from /shot.png. Taking a picture from there costs
 * the phone nothing, which matters while droidread is scrolling a conversation: a second
 * `adb exec-out screencap` competes with uiautomator on the same device and slows the very
 * read you are trying to watch.
 *
 * Set DROIDREAD_STREAM_URL to the viewer's base URL to prefer it, e.g.
 *   DROIDREAD_STREAM_URL=http://127.0.0.1:8791
 * Unset, or unreachable, and this falls straight back to adb. The viewer's HTTPS twin is
 * self-signed, so https:// is only accepted for loopback and private addresses.
 */
const STREAM_URL = process.env.DROIDREAD_STREAM_URL?.replace(/\/+$/, "");
const STREAM_MAX_AGE_MS = Number(process.env.DROIDREAD_STREAM_MAX_AGE_MS ?? 1500);

function isPrivateHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    /^10\./.test(host) || /^192\.168\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

async function fromStream(): Promise<Uint8Array | { error: string }> {
  if (!STREAM_URL) return { error: "DROIDREAD_STREAM_URL not set" };
  let u: URL;
  try { u = new URL(`${STREAM_URL}/shot.png?max_age_ms=${STREAM_MAX_AGE_MS}`); }
  catch { return { error: `DROIDREAD_STREAM_URL is not a URL: ${STREAM_URL}` }; }

  // A self-signed certificate is fine on your own LAN and not fine anywhere else;
  // refusing to skip verification for a public host keeps that distinction honest.
  const selfSigned = u.protocol === "https:" && isPrivateHost(u.hostname);
  try {
    const res = await fetch(u, {
      signal: AbortSignal.timeout(5000),
      ...(selfSigned ? { tls: { rejectUnauthorized: false } } : {}),
    } as RequestInit);
    if (!res.ok) return { error: `viewer answered HTTP ${res.status}` };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.byteLength) return { error: "viewer returned an empty frame" };
    (buf as any).ageMs = Number(res.headers.get("x-frame-age-ms") ?? 0);
    return buf;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Raw PNG straight off the device. Binary — never routed through the string-returning adb(). */
export async function screencap(): Promise<Uint8Array> {
  const p = Bun.spawn([ADB, "exec-out", "screencap", "-p"], { stdout: "pipe", stderr: "pipe" });
  const [buf, err] = await Promise.all([
    new Response(p.stdout).arrayBuffer(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  if (code !== 0 || buf.byteLength === 0) {
    throw new Error(`screencap failed (exit ${code})${err.trim() ? `: ${err.trim()}` : ""}`);
  }
  return new Uint8Array(buf);
}

async function haveFfmpeg(): Promise<boolean> {
  try { return (await Bun.spawn(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0; }
  catch { return false; }
}

/**
 * Screen as a small JPEG. `width` 0 means "no resize, original PNG".
 * Quality 6 on ffmpeg's 2-31 scale: text on a chat screen stays readable.
 */
export async function screenshot(width = 540, quality = 6): Promise<Shot> {
  let source: "adb" | "stream" = "adb";
  let ageMs: number | null = null;
  let png: Uint8Array;

  const streamed = await fromStream();
  if (streamed instanceof Uint8Array) {
    png = streamed;
    source = "stream";
    ageMs = (streamed as any).ageMs ?? 0;
  } else {
    if (STREAM_URL) process.stderr.write(`screenshot: viewer unusable (${streamed.error}) — falling back to adb\n`);
    png = await screencap();
  }

  if (width <= 0 || !(await haveFfmpeg())) {
    return { data: png, mime: "image/png", width: null, bytes: png.byteLength, source, ageMs };
  }

  const p = Bun.spawn(
    ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-vf", `scale=${Math.round(width)}:-2`,
     "-q:v", String(quality), "-f", "mjpeg", "pipe:1"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  p.stdin.write(png);
  await p.stdin.end();
  const [out, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0 || out.byteLength === 0) {
    // Resizing is an optimisation; a failure here must not cost the caller their screenshot.
    process.stderr.write(`screenshot: ffmpeg resize failed, returning full PNG${err.trim() ? ` (${err.trim().split("\n")[0]})` : ""}\n`);
    return { data: png, mime: "image/png", width: null, bytes: png.byteLength, source, ageMs };
  }
  return { data: new Uint8Array(out), mime: "image/jpeg", width: Math.round(width), bytes: out.byteLength, source, ageMs };
}
