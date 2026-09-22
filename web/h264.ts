// h264.ts — low-latency transport: phone hardware encoder -> browser hardware decoder.
//
// The MJPEG path in server.ts re-encodes a full PNG per frame ON THE PHONE'S CPU
// (~300-400ms, 180KB-4.4MB/frame measured). This path asks the phone's MediaCodec
// hardware encoder for an H.264 stream instead: ~5KB/frame measured on the same device,
// 40-900x less data, and no per-frame process spawn.
//
// White does NOT transcode. It copies bytes from the adb socket to a WebSocket; the
// browser's WebCodecs VideoDecoder does the decode in hardware. The host GPU is
// deliberately uninvolved — it was never the bottleneck.
//
// PROTOCOL (scrcpy-server 3.1, tunnel_forward=true), verified live against SM-A146P:
//   1 byte   dummy readiness byte           (0x00)
//   64 bytes device name, NUL-padded        ("SM-A146P")
//   12 bytes codec id + width + height      (h264 456x1024)
//   then repeating:
//     12 bytes  pts(u64) + size(u32)
//     size      Annex-B payload             (SPS 0x67, PPS 0x68, IDR 0x65, ...)
//
// TRAP (cost an hour): closing the video socket early makes the server die with
// `EPIPE (Broken pipe)` and every subsequent launch aborts before printing its banner,
// until the jar is re-pushed. Always drain/close cleanly; never half-read and drop.

import { spawn } from "bun";

const ADB = process.env.DROIDREAD_ADB ?? process.env.DROIDCAST_ADB ?? "adb";
const JAR_REMOTE = "/data/local/tmp/scrcpy-server.jar";
const JAR_LOCAL = "scrcpy-server-v3.1";
const SCRCPY_VERSION = "3.1";

export interface H264Config {
  maxSize?: number;
  bitRate?: number;
  maxFps?: number;
}

export interface H264Stream {
  /** Codec metadata from the handshake. */
  meta: { codec: string; width: number; height: number };
  /** Every subscriber gets each NAL unit as it arrives. */
  subscribe(fn: (nal: Uint8Array, isKeyframe: boolean) => void): () => void;
  /** Most recent SPS/PPS/IDR, so a late joiner can start decoding immediately. */
  initSegment(): Uint8Array[];
  stop(): void;
}

async function adbRun(args: string[]): Promise<string> {
  const p = spawn([ADB, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

/**
 * Read exactly n bytes or throw. A socket delivering fewer bytes than asked for is
 * normal, not an error — every read must loop until satisfied.
 */
async function readExact(
  next: () => Promise<Uint8Array | null>,
  n: number,
  carry: { buf: Uint8Array },
): Promise<Uint8Array> {
  while (carry.buf.length < n) {
    const chunk = await next();
    if (!chunk) throw new Error("socket closed mid-read");
    const merged = new Uint8Array(carry.buf.length + chunk.length);
    merged.set(carry.buf);
    merged.set(chunk, carry.buf.length);
    carry.buf = merged;
  }
  const out = carry.buf.slice(0, n);
  carry.buf = carry.buf.slice(n);
  return out;
}

export async function startH264(cfg: H264Config = {}): Promise<H264Stream> {
  const { maxSize = 1024, bitRate = 4_000_000, maxFps = 30 } = cfg;
  // Fresh scid per run: a stale abstract socket from a crashed server is otherwise
  // indistinguishable from a live one, and the connect silently hangs.
  const scid = Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, "0");
  const port = 27200 + Math.floor(Math.random() * 300);

  // import.meta.dir, NOT `new URL(..., import.meta.url).pathname`: this directory is
  // named "ψ", which URL-encodes to %CF%88 and produces a nonexistent path. adb push
  // would fail on a file it cannot find, with the real cause buried.
  // The scrcpy server is third-party (Genymobile/scrcpy, Apache-2.0) and is NOT bundled
  // here: shipping someone else's binary inside an MIT repo is a licensing question this
  // project does not need to answer. Fetch the matching release jar yourself and drop it
  // next to this file. Everything except /h264 works without it.
  const jar = `${import.meta.dir}/${JAR_LOCAL}`;
  if (!(await Bun.file(jar).exists())) {
    throw new Error(
      `${JAR_LOCAL} not found in web/. The H.264 path needs scrcpy's server jar:\n` +
      `  curl -Lo web/${JAR_LOCAL} https://github.com/Genymobile/scrcpy/releases/download/v3.1/scrcpy-server-v3.1\n` +
      `The MJPEG viewer at / needs none of this.`,
    );
  }
  await adbRun(["push", jar, JAR_REMOTE]);

  const server = spawn([
    ADB, "shell",
    `CLASSPATH=${JAR_REMOTE} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} ` +
    `scid=${scid} tunnel_forward=true audio=false control=false ` +
    `video_codec=h264 max_size=${maxSize} video_bit_rate=${bitRate} max_fps=${maxFps}`,
  ], { stdout: "pipe", stderr: "pipe" });

  await Bun.sleep(2500); // server must be listening before the forward is useful
  await adbRun(["forward", `tcp:${port}`, `localabstract:scrcpy_${scid}`]);

  // Bun fixes socket handlers AT CONNECT TIME. Assigning sock.data afterwards is a
  // silent no-op: the socket happily receives bytes and drops them, readExact() blocks
  // on a handshake that never completes, and the WebSocket stays open sending nothing.
  // So the queue is wired up here, in the handlers Bun actually uses.
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let socketClosed = false;

  const sock = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, d: Uint8Array) { queue.push(d); wake?.(); wake = null; },
      close() { socketClosed = true; wake?.(); wake = null; },
      error() { socketClosed = true; wake?.(); wake = null; },
    },
  });

  /** Next chunk from the socket, or null once it closes. */
  async function nextChunk(): Promise<Uint8Array | null> {
    while (queue.length === 0) {
      if (socketClosed) return null;
      await new Promise<void>((r) => { wake = r; });
    }
    return queue.shift()!;
  }

  const carry = { buf: new Uint8Array(0) };

  await readExact(nextChunk, 1, carry);                    // dummy byte
  const nameBuf = await readExact(nextChunk, 64, carry);   // device name
  const metaBuf = await readExact(nextChunk, 12, carry);   // codec/w/h
  const dv = new DataView(metaBuf.buffer, metaBuf.byteOffset);
  const codecId = dv.getUint32(0);
  const meta = {
    codec: String.fromCharCode(...[24, 16, 8, 0].map((s) => (codecId >> s) & 0xff)).trim(),
    width: dv.getUint32(4),
    height: dv.getUint32(8),
  };

  const subs = new Set<(n: Uint8Array, k: boolean) => void>();
  let init: Uint8Array[] = [];
  let running = true;

  (async () => {
    while (running) {
      try {
        const hdr = await readExact(nextChunk, 12, carry);
        const h = new DataView(hdr.buffer, hdr.byteOffset);
        const size = h.getUint32(8);
        const payload = await readExact(nextChunk, size, carry);
        // NAL type lives in the low 5 bits of the byte after the 4-byte start code.
        const nalType = payload[4] & 0x1f;
        const isParam = nalType === 7 || nalType === 8; // SPS / PPS
        const isKey = nalType === 5;                    // IDR
        // Keep SPS/PPS/IDR so a viewer joining mid-stream can decode without waiting
        // for the next keyframe (which at max_fps=30 can be seconds away).
        if (isParam) init = [...init.filter((p) => (p[4] & 0x1f) !== nalType), payload];
        else if (isKey) init = [...init.filter((p) => (p[4] & 0x1f) !== 5), payload];
        for (const fn of subs) { try { fn(payload, isKey); } catch {} }
      } catch { break; }
    }
  })();

  return {
    meta,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    initSegment() { return init; },
    stop() {
      running = false;
      try { sock.end(); } catch {}
      try { server.kill(); } catch {}
      adbRun(["forward", "--remove", `tcp:${port}`]).catch(() => {});
    },
  };
}
