#!/usr/bin/env bun
// http.ts — droidread as an MCP server over Streamable HTTP, for agents on OTHER machines.
//
// WHAT THIS OPENS: whoever reaches this port with the token can read every indexed chat,
// read the phone's screen, and — only if DROIDREAD_ALLOW_CONTROL=1 is set on THIS
// process — tap, swipe and type on it. Hence:
//
//   - a bearer token is REQUIRED on every request; the server refuses to start without one
//   - it binds to 127.0.0.1 unless you name interfaces explicitly (DROIDREAD_MCP_HOST),
//     so "I started it" never silently means "the whole wifi can drive my phone"
//   - prefer a VPN interface (WireGuard, Tailscale) over the LAN: the tunnel encrypts the
//     traffic, while plain HTTP on a LAN sends the token in clear to anyone sniffing
//   - the control gate is server-side; a remote client cannot switch it on
//   - /health answers without a token but says only {"ok":true}
//
// Sessions: each MCP client gets its own McpServer + transport (the SDK's model). The
// phone is shared and protected by the device lock in tools.ts, so several agents can be
// connected at once but only one drives the phone at a time; the others wait their turn.
//
//   bun mcp/http.ts [--host=10.20.0.7,10.10.0.7] [--port=7373]
//
// Rule 6: AI-assisted work by Nexus (AI) with Nat Weerawan.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadEnvFile } from "../src/paths.ts";

const envPath = loadEnvFile();  // before tools.ts: src/adb.ts reads DROIDREAD_ADB at import time
const { buildServer } = await import("./tools.ts");

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const HOSTS = (arg("host") ?? process.env.DROIDREAD_MCP_HOST ?? "127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = Number(arg("port") ?? process.env.DROIDREAD_MCP_PORT ?? 7373);
const TOKEN = (process.env.DROIDREAD_MCP_TOKEN ?? "").trim();
const log = (s: string) => process.stderr.write(`[droidread-http ${new Date().toISOString().slice(11, 19)}] ${s}\n`);

if (TOKEN.length < 32) {
  console.error(`DROIDREAD_MCP_TOKEN is missing or shorter than 32 characters — refusing to listen.
Generate one and keep it in ${envPath ?? "~/.droidread/.env"} (mode 600), never in a repo:

  echo "DROIDREAD_MCP_TOKEN=$(openssl rand -hex 32)" >> ~/.droidread/.env`);
  process.exit(2);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`bad port: ${PORT}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Auth: constant-time compare of the bearer token. Length is checked first (the
// comparison needs equal lengths); leaking the token's length is acceptable.
// ---------------------------------------------------------------------------
const tokenBuf = Buffer.from(TOKEN);
function authorized(req: Request): boolean {
  const h = req.headers.get("authorization") ?? "";
  if (!/^bearer /i.test(h)) return false;
  const given = Buffer.from(h.slice(7).trim());
  return given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf);
}

// ---------------------------------------------------------------------------
// Sessions: one transport + one McpServer per client, keyed by the SDK's session id.
// ---------------------------------------------------------------------------
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

async function newSession(): Promise<WebStandardStreamableHTTPServerTransport> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    keepAliveMs: 15_000,  // SSE pings so a minutes-long droidread_read never looks like a dead socket
    onsessioninitialized: (id) => { sessions.set(id, transport); log(`session open  ${id.slice(0, 8)}  (${sessions.size} live)`); },
    onsessionclosed: (id) => { sessions.delete(id); log(`session close ${id.slice(0, 8)}  (${sessions.size} live)`); },
  });
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  await buildServer().connect(transport);
  return transport;
}

const rpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (url.pathname !== "/mcp") return new Response("not found\n", { status: 404 });
  if (!authorized(req)) return new Response("unauthorized\n", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

  const sid = req.headers.get("mcp-session-id");
  if (sid) {
    const t = sessions.get(sid);
    if (!t) return rpcError(404, -32001, "session not found — initialize again");
    return t.handleRequest(req);
  }

  // No session yet: only an initialize request may create one.
  if (req.method !== "POST") return rpcError(400, -32000, "mcp-session-id header required");
  const body: unknown = await req.json().catch(() => null);
  if (!isInitializeRequest(body)) return rpcError(400, -32000, "first request must be initialize");
  const t = await newSession();
  return t.handleRequest(req, { parsedBody: body });
}

// ---------------------------------------------------------------------------
// One Bun.serve per interface. An interface that is down (VPN not up) is reported and
// skipped rather than taking the whole server down with it.
// ---------------------------------------------------------------------------
const bound: ReturnType<typeof Bun.serve>[] = [];
for (const hostname of HOSTS) {
  try {
    // idleTimeout 0: a droidread_read can legitimately hold a request open for minutes.
    bound.push(Bun.serve({ hostname, port: PORT, fetch: handle, idleTimeout: 0 }));
  } catch (e) {
    log(`cannot bind ${hostname}:${PORT} — ${(e as Error).message}`);
  }
}
if (!bound.length) { console.error("nothing bound — exiting"); process.exit(1); }

let controlOn = false;
try { const { assertControlAllowed } = await import("../src/control.ts"); assertControlAllowed(); controlOn = true; } catch {}

console.error(`droidread MCP over HTTP`);
for (const s of bound) console.error(`  listening : http://${s.hostname}:${s.port}/mcp`);
console.error(`  auth      : bearer token (DROIDREAD_MCP_TOKEN from ${envPath ?? "environment"})`);
console.error(`  control   : ${controlOn ? "ENABLED — remote callers can tap/swipe/type" : "disabled (DROIDREAD_ALLOW_CONTROL=1 on this process to enable)"}`);
console.error(`  register  : claude mcp add --transport http --scope user droidread http://${bound[0]!.hostname}:${PORT}/mcp --header "Authorization: Bearer <token>"`);

async function shutdown(signal: string) {
  log(`${signal} — closing ${sessions.size} session(s)`);
  await Promise.allSettled([...sessions.values()].map((t) => t.close()));
  for (const s of bound) s.stop(true);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
