// Lane C fills this in (the agent tools). Lane B's main.ts imports this exact signature.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Me, TdClient } from "./td.js";
import type { Store } from "./store.js";

export function buildServer(_d: { td: TdClient | undefined; store: Store; me: () => Me | undefined; caller?: { key: string } }): McpServer {
  return new McpServer({ name: "telegram-live", version: "0.1.0" });
}
