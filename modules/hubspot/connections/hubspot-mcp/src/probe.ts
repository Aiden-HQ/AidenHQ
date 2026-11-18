// Prints HubSpot's MCP tools with their annotations and input schemas, or makes one read call (the real shapes, for
// src/adapter.ts and the tags in module.yaml):
//   docker compose exec hubspot-mcp node dist/src/probe.js
//   docker compose exec hubspot-mcp node dist/src/probe.js search_crm_objects '{"objectType":"deals","limit":2}'
// Reads the stored access token as is (no refresh, so it never races the running proxy: if it has expired, use any HubSpot
// tool through the proxy once, or Reconnect on the board, then retry). Only tools HubSpot marks read-only may be called.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const token = JSON.parse(readFileSync(`${process.env.HUBSPOT_STATE_DIR ?? "/state"}/token.json`, "utf8")).access_token;
const client = new Client({ name: "aidenhq-hubspot-probe", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.HUBSPOT_MCP_URL || "https://mcp.hubspot.com"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const tools: Tool[] = [];
let cursor: string | undefined;
do {
  const p = await client.listTools(cursor ? { cursor } : undefined);
  tools.push(...p.tools);
  cursor = p.nextCursor;
} while (cursor);
const [tool, args] = process.argv.slice(2);
if (!tool) {
  for (const t of tools) console.log(JSON.stringify({ name: t.name, annotations: t.annotations, description: t.description?.slice(0, 600), inputSchema: t.inputSchema }, null, 1));
  console.log("all tools:", tools.map((t) => t.name).join(", "));
} else {
  if (tools.find((t) => t.name === tool)?.annotations?.readOnlyHint !== true) throw new Error(`${tool} isn't marked read-only`);
  console.log(JSON.stringify(await client.callTool({ name: tool, arguments: args ? JSON.parse(args) : {} }), null, 1).slice(0, 8000));
}
await client.close();
