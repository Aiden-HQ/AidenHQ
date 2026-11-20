// Prints the Atlassian MCP's Confluence tools with their input schemas, or makes one read call:
//   docker compose exec jira-mcp node dist/src/probe.js
//   docker compose exec jira-mcp node dist/src/probe.js searchConfluence '{"cql":"type = page","limit":2}'
// Reads the stored access token as is (no refresh, so it never races the running proxy: if it has expired, use any Jira tool
// through the proxy once, or Reconnect on the board, then retry). A call gets the site's cloudId added, as the proxy does.
import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { siteCloudId } from "./site.js";

const token = JSON.parse(readFileSync(`${process.env.JIRA_STATE_DIR ?? "/state"}/token.json`, "utf8")).access_token;
const client = new Client({ name: "aidenhq-jira-probe", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.ATLASSIAN_MCP_URL || "https://mcp.atlassian.com/v2/mcp?tools=all"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const [tool, args] = process.argv.slice(2);
const site = process.env.JIRA_URL_FILE && existsSync(process.env.JIRA_URL_FILE) ? readFileSync(process.env.JIRA_URL_FILE, "utf8").trim() : "";
if (!tool) {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const p = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...p.tools);
    cursor = p.nextCursor;
  } while (cursor);
  const confluence = tools.filter((t) => /confluence/i.test(t.name));
  for (const t of confluence.filter((t) => /^(searchConfluence|getConfluenceContent|listConfluenceContent|listConfluenceSpaces)$/.test(t.name)))
    console.log(JSON.stringify({ name: t.name, description: t.description?.slice(0, 400), inputSchema: t.inputSchema }, null, 1));
  console.log("all confluence tools:", confluence.map((t) => t.name).join(", "));
} else {
  const sites = await client.callTool({ name: "getAccessibleAtlassianResources", arguments: {} });
  const cloudId = siteCloudId(sites as never, site);
  if (!cloudId) throw new Error(`no site matching ${site}`);
  console.log(JSON.stringify(await client.callTool({ name: tool, arguments: { ...(args ? JSON.parse(args) : {}), cloudId } }), null, 1).slice(0, 6000));
}
await client.close();
