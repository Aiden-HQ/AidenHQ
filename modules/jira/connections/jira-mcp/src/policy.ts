import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * The Atlassian remote MCP tools AidenHQ exposes (names as of Atlassian MCP v2, support.atlassian.com/atlassian-rovo-mcp-server/
 * docs/supported-tools). They must match modules/jira/module.yaml (the test checks). Epics and their children are JQL
 * (`issuetype = Epic AND project = X`, `parent = KEY`); releases are getJiraProjectVersions; ETA and status history is
 * listJiraIssueChangelogs.
 */
export const READ_TOOLS = [
  "searchJiraIssuesUsingJql",
  "getJiraIssue",
  "listJiraIssueChangelogs",
  "listJiraIssueComments",
  "listJiraProjects",
  "getJiraProjectVersions",
  "getJiraProjectVersionRelatedWork",
  "listJiraBoards",
  "getJiraBoardConfig",
  "listJiraBoardSprints",
  "lookupJiraAccountId",
  "searchConfluence",
  "getConfluenceContent",
];
/** Defined for later; no agent is granted them by default (grants in module.yaml decide, enforced by the kernel). */
export const WRITE_TOOLS = ["addOrEditJiraIssueComment", "createJiraIssue"];
export const EXPOSED = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * OAuth scopes asked for at sign-in: who you are, a refresh token, and Jira/Confluence read and search. Writes need
 * write:jira:agent-interface added here and a Reconnect, when an agent is first granted a write tool.
 */
export const SCOPES = ["read:me", "read:account", "offline_access", "read:jira:agent-interface", "search:jira:agent-interface", "read:confluence:agent-interface", "search:confluence:agent-interface"];

/** Every exposed tool's site id is filled in here, from the jira_url setting, so agents never pass or pick one. */
const SITE_ARG = "cloudId";

/** The exposed upstream tools: cloudId removed from the schema, reads annotated read-only and closed-world. */
export function exposedTools(upstream: Tool[]): Tool[] {
  return upstream.filter((t) => EXPOSED.includes(t.name)).map((t) => {
    const { [SITE_ARG]: _drop, ...properties } = (t.inputSchema.properties ?? {}) as Record<string, object>;
    const required = (t.inputSchema.required ?? []).filter((r) => r !== SITE_ARG);
    const read = READ_TOOLS.includes(t.name);
    return {
      ...t,
      inputSchema: { ...t.inputSchema, properties, required },
      annotations: { ...(t.annotations ?? {}), readOnlyHint: read, destructiveHint: false, openWorldHint: !read },
    };
  });
}

/** Placeholders while Jira isn't connected: every call answers with how to connect it. */
export function placeholderTools(): Tool[] {
  return EXPOSED.map((name) => ({ name, description: "Jira isn't connected yet (the owner signs in from the board: Connections, Jira).", inputSchema: { type: "object" as const } }));
}

/** The arguments sent upstream: the agent's, with the configured site's cloudId. */
export function withSite(args: Record<string, unknown> | undefined, cloudId: string): Record<string, unknown> {
  return { ...(args ?? {}), [SITE_ARG]: cloudId };
}

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
