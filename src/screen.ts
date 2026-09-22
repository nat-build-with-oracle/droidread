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
  const png = await screencap();
  if (width <= 0 || !(await haveFfmpeg())) {
    return { data: png, mime: "image/png", width: null, bytes: png.byteLength };
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
    return { data: png, mime: "image/png", width: null, bytes: png.byteLength };
  }
  return { data: new Uint8Array(out), mime: "image/jpeg", width: Math.round(width), bytes: out.byteLength };
}
