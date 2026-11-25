// The one thing Jira's connection adds to the pass-through (src/vendor/proxy.ts): every call is pinned to the configured site
// (the jira_url secret). Atlassian's tools take the site as `cloudId`; it is dropped from the schemas agents see and set here
// on every call whose tool takes it, so an agent never passes or picks another site the owner's account can reach.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import type { Hooks } from "./vendor/proxy.js";

/** The scopes pre-selected at sign-in: who you are, a refresh token, and Jira/Confluence read and search. The owner may pick more. */
export const SCOPES = ["read:me", "read:account", "read:jira:agent-interface", "search:jira:agent-interface", "read:confluence:agent-interface", "search:confluence:agent-interface"];

const SITE_ARG = "cloudId";
const takesSite = (t: Tool) => Object.hasOwn((t.inputSchema.properties ?? {}) as object, SITE_ARG);

/**
 * The configured site's cloudId from getAccessibleAtlassianResources' result ([{id, url, name, ...}], as JSON text or
 * structured content). Undefined when the signed-in account can't reach that site.
 */
export function siteCloudId(result: { content?: unknown; structuredContent?: unknown }, siteUrl: string): string | undefined {
  const want = new URL(siteUrl).host.toLowerCase();
  const lists: unknown[] = [];
  if (result.structuredContent) lists.push(result.structuredContent);
  for (const c of (Array.isArray(result.content) ? result.content : []) as { type?: string; text?: string }[]) {
    if (c.type === "text" && c.text) try { lists.push(JSON.parse(c.text)); } catch { /* not JSON */ }
  }
  for (const l of lists) {
    // A bare list, { resources }, or (Atlassian, 2026-11) { data: { resources } }; the id is `id` or `cloudId`.
    const o = l as { resources?: unknown; data?: { resources?: unknown } };
    const sites = (Array.isArray(l) ? l : (o?.resources ?? o?.data?.resources ?? [])) as { id?: unknown; cloudId?: unknown; url?: unknown }[];
    for (const s of Array.isArray(sites) ? sites : []) {
      const id = typeof s?.id === "string" ? s.id : s?.cloudId;
      if (typeof id === "string" && typeof s.url === "string" && URL.canParse(s.url) && new URL(s.url).host.toLowerCase() === want) return id;
    }
  }
  return undefined;
}

/** The pass-through's hooks for one site: find its cloudId at each connect, hide it from the schemas, set it on each call. */
export function siteHooks(siteUrl: string, log: Logger): Hooks {
  let cloudId: string | undefined;
  let checked = false;
  return {
    async connected(client: Client) {
      const sites = await client.callTool({ name: "getAccessibleAtlassianResources", arguments: {} });
      const found = siteCloudId(sites as never, siteUrl);
      if (!found) log.warn({ sites: JSON.stringify(sites).slice(0, 500) }, `no site matching ${siteUrl} among the account's Atlassian sites`);
      // Published only when this connect becomes the session: a connect a sign-in superseded must not clear the winner's cloudId.
      return () => { cloudId = found; checked = true; };
    },
    tools: (tools) =>
      tools.map((t) => {
        if (!takesSite(t)) return t;
        const { [SITE_ARG]: _drop, ...properties } = (t.inputSchema.properties ?? {}) as Record<string, object>;
        return { ...t, inputSchema: { ...t.inputSchema, properties, required: (t.inputSchema.required ?? []).filter((r) => r !== SITE_ARG) } };
      }),
    // The caller's cloudId never passes, whatever the schema says; the configured site's is set where the tool takes one.
    args(_name, { [SITE_ARG]: _caller, ...args }, tool) {
      if (!takesSite(tool)) return args;
      if (!cloudId) throw new Error(`the signed-in Atlassian account can't reach ${siteUrl} through Atlassian's MCP server (check its Rovo access, then Reconnect on the board)`);
      return { ...args, [SITE_ARG]: cloudId };
    },
    health: () => (checked && !cloudId ? `the signed-in account can't reach ${siteUrl}` : undefined),
  };
}
