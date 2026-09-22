#!/usr/bin/env bun
// mcp-client.ts — a minimal MCP client, so the tools can be exercised the way an agent
// uses them rather than the way the library calls them.
//
// WHY THIS EXISTS: a tool that works when called directly can still be unusable over MCP —
// wrong argument shape, a reply too large, a call that blocks long enough to time out. The
// only way to know is to speak the protocol. This is also how the loop-free read design is
// demonstrated: open a chat, then read/swipe/read, with the CLIENT deciding when to stop.
//
//   bun probes/mcp-client.ts tools
//   bun probes/mcp-client.ts call droidread_where
//   bun probes/mcp-client.ts call droidread_read_screen '{"chat":"Team"}'
//   bun probes/mcp-client.ts read-chat "floodboy" 6      # open, then up to 6 screens
//
// Talks to DROIDREAD_MCP_URL or http://127.0.0.1:7373/mcp, with the token from
// ~/.droidread/.env.

import { loadEnvFile } from "../src/paths.ts";

loadEnvFile();

const URL_ = process.env.DROIDREAD_MCP_URL ?? `http://127.0.0.1:${process.env.DROIDREAD_MCP_PORT ?? 7373}/mcp`;
const TOKEN = process.env.DROIDREAD_MCP_TOKEN ?? "";
if (!TOKEN) { console.error("no DROIDREAD_MCP_TOKEN — is ~/.droidread/.env set up?"); process.exit(2); }

let sid = "";
let id = 0;

/** SSE frames split JSON containing newlines across several `data:` lines; rejoin them. */
function parseSse(body: string): any[] {
  const out: any[] = [];
  for (const frame of body.split(/\n\n+/)) {
    const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (data) { try { out.push(JSON.parse(data)); } catch { /* keep-alive */ } }
  }
  return out;
}

async function rpc(method: string, params?: unknown): Promise<any> {
  const notification = method.startsWith("notifications/");
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!notification) body.id = ++id;
  if (params) body.params = params;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${TOKEN}`,
  };
  if (sid) headers["Mcp-Session-Id"] = sid;

  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify(body) });
  const got = res.headers.get("mcp-session-id");
  if (got) sid = got;
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.trim().slice(0, 200)}`);
  if (notification) return null;

  const msgs = res.headers.get("content-type")?.includes("event-stream") ? parseSse(txt) : (txt.trim() ? [JSON.parse(txt)] : []);
  const reply = msgs.find((m) => m.id === id);
  if (reply?.error) throw new Error(`${reply.error.message} (code ${reply.error.code})`);
  return reply?.result;
}

async function connect(): Promise<void> {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "droidread-probe", version: "0" },
  });
  await rpc("notifications/initialized");
  console.error(`connected to ${init.serverInfo.name} ${init.serverInfo.version}\n`);
}

const textOf = (r: any): string =>
  (r?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r?.isError) throw new Error(textOf(r));
  return textOf(r);
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
await connect();

if (cmd === "tools") {
  const { tools } = await rpc("tools/list");
  console.log(`${tools.length} tools\n`);
  for (const t of tools) console.log(`${t.name}\n  ${t.description.slice(0, 150)}...\n`);

} else if (cmd === "call") {
  const [name, json] = rest;
  console.log(await call(name!, json ? JSON.parse(json) : {}));

} else if (cmd === "read-chat") {
  // The point of the exercise: the CLIENT owns the loop. Each screen is one short call,
  // every screen is indexed as it is read, and the loop stops the moment a screen brings
  // nothing new — no tool call ever runs for minutes.
  const chat = rest[0] ?? "";
  const maxScreens = Number(rest[1] ?? 8);
  if (!chat) { console.error("usage: bun probes/mcp-client.ts read-chat <chat> [screens]"); process.exit(2); }

  console.log(await call("messenger_open_chat", { chat }));
  let empty = 0;
  for (let i = 0; i < maxScreens; i++) {
    const t0 = Date.now();
    const out = await call("messenger_read_screen", { chat });
    console.log(`\n--- screen ${i + 1} (${Math.round((Date.now() - t0) / 1000)}s) ---\n${out}`);

    const fresh = Number(/·\s*(\d+) new/.exec(out)?.[1] ?? 0);
    if (/START OF CONVERSATION/.test(out)) { console.log("\nreached the start of the conversation"); break; }
    empty = fresh === 0 ? empty + 1 : 0;
    if (empty >= 2) { console.log("\ntwo screens with nothing new — stopping"); break; }

    await call("droidread_swipe", { direction: "up", durationMs: 300 });
  }

} else {
  console.error("commands: tools | call <name> [jsonArgs] | read-chat <chat> [screens]");
  process.exit(2);
}
