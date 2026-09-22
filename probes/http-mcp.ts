#!/usr/bin/env bun
// http-mcp.ts — exercise the HTTP MCP transport end to end, the way a remote agent would.
//
// WHY A PROBE AND NOT curl: a Streamable HTTP response is SSE, and an `data:` frame whose
// JSON contains newlines is split across several `data:` lines. A naive
// `grep ^data: | cut -c7- | jq` therefore parses fine for a short reply and fails for a
// long one — which is exactly what happened the first time this was tested by hand, and
// it looked like a server bug rather than a shell bug.
//
// Checks, in order: /health without a token, a missing token, a wrong token, the
// initialize handshake, tools/list, a couple of tool calls, and session teardown.
//
//   bun probes/http-mcp.ts [http://10.20.0.7:7373/mcp]

import { loadEnvFile } from "../src/paths.ts";

loadEnvFile();
const URL_ = process.argv[2] ?? `http://127.0.0.1:${process.env.DROIDREAD_MCP_PORT ?? 7373}/mcp`;
const TOKEN = process.env.DROIDREAD_MCP_TOKEN ?? "";
if (!TOKEN) { console.error("no DROIDREAD_MCP_TOKEN in env or ~/.droidread/.env"); process.exit(2); }

let sid = "";
let id = 0;
const ok = (b: boolean) => (b ? "PASS" : "FAIL");
let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`${ok(pass).padEnd(5)} ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Parse an SSE body into JSON messages, joining multi-line data frames properly. */
function parseSse(body: string): any[] {
  const out: any[] = [];
  for (const frame of body.split(/\n\n+/)) {
    const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (data) { try { out.push(JSON.parse(data)); } catch { /* keep-alive comment frames */ } }
  }
  return out;
}

async function rpc(method: string, params?: unknown, token = TOKEN): Promise<{ status: number; msgs: any[]; headers: Headers }> {
  const isNotification = method.startsWith("notifications/");
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!isNotification) body.id = ++id;
  if (params) body.params = params;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sid) headers["Mcp-Session-Id"] = sid;

  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify(body) });
  const got = res.headers.get("mcp-session-id");
  if (got) sid = got;
  const txt = await res.text();
  // A rejection (401) is plain text, not JSON — parse defensively or the probe dies
  // before it can report the failure it was written to catch.
  let msgs: any[] = [];
  if (res.headers.get("content-type")?.includes("event-stream")) msgs = parseSse(txt);
  else if (txt.trim()) { try { msgs = [JSON.parse(txt)]; } catch { msgs = [{ raw: txt.trim() }]; } }
  return { status: res.status, msgs, headers: res.headers };
}

const base = URL_.replace(/\/mcp$/, "");
console.log(`target: ${URL_}\n`);

// --- unauthenticated surface -------------------------------------------------
const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
check("/health answers without a token", health?.ok === true, JSON.stringify(health));

const noTok = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
check("no token is refused", noTok.status === 401, `HTTP ${noTok.status}`);

const badTok = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } }, "x".repeat(64));
check("wrong token is refused", badTok.status === 401, `HTTP ${badTok.status}`);

// --- handshake ---------------------------------------------------------------
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
const info = init.msgs[0]?.result;
check("initialize", info?.serverInfo?.name === "droidread", `${info?.serverInfo?.name} ${info?.serverInfo?.version}, proto ${info?.protocolVersion}`);
check("session id issued", sid.length === 36, sid.slice(0, 8));
await rpc("notifications/initialized");

// --- tools -------------------------------------------------------------------
const list = await rpc("tools/list");
const tools: { name: string }[] = list.msgs[0]?.result?.tools ?? [];
check("tools/list", tools.length > 0, `${tools.length} tools`);
console.log("      " + tools.map((t) => t.name.replace("droidread_", "")).join(" "));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  return r.msgs[0]?.result;
}

const where = await call("droidread_where");
check("tools/call droidread_where", typeof where?.content?.[0]?.text === "string");
console.log(String(where?.content?.[0]?.text ?? "").split("\n").map((l: string) => "      " + l).join("\n"));

const status = await call("droidread_control_status");
check("tools/call droidread_control_status", typeof status?.content?.[0]?.text === "string", status?.content?.[0]?.text);

// Phone-touching, and the reason for the device lock. Skipped unless --device is passed,
// so the probe stays safe to run while a long read is in progress.
if (process.argv.includes("--device")) {
  const shot = await call("droidread_screenshot", { width: 360 });
  const img = shot?.content?.find((c: any) => c.type === "image");
  check("tools/call droidread_screenshot returns an image", !!img,
    img ? `${img.mimeType}, ${Math.round((img.data.length * 3) / 4 / 1024)} KB decoded` : "no image content");
  console.log(`      ${shot?.content?.find((c: any) => c.type === "text")?.text ?? ""}`);
}

// --- teardown ----------------------------------------------------------------
const del = await fetch(URL_, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": sid } });
check("session deletes cleanly", del.status === 200, `HTTP ${del.status}`);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
