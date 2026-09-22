#!/usr/bin/env bun
// server.ts — droidread as an MCP server over stdio: one local client, no network.
//
// Runs where adb is. The phone, the database and the photos never leave the machine, and
// the MCP client only ever sees what it asks for. For agents on OTHER machines (LAN or
// VPN) see mcp/http.ts — same tools, token-gated network transport.
//
// Rule 6: AI-assisted work by Nexus (AI) with Nat Weerawan. Reads only the operator's own
// device over their own authorised adb connection.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvFile } from "../src/paths.ts";

loadEnvFile();  // ~/.droidread/.env first — src/adb.ts reads DROIDREAD_ADB at import time
const { buildServer } = await import("./tools.ts");

await buildServer().connect(new StdioServerTransport());
