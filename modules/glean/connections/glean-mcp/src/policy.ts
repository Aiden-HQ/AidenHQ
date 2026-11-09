import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Glean tools that only read the user's company knowledge: search, a document, people, meetings,
 * code, and Glean's own answer over those (chat). Everything else is hidden and refused.
 */
export const READ_TOOLS = ["search", "read_document", "employee_search", "meeting_lookup", "code_search", "chat"];

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed.
// Glean servers can carry write tools (artifacts, images, memory) and gateway tools that act in
// other apps (Slack sends, Jira edits); none belong to AidenHQ.
const NEVER = /(create|edit|update|upload|share|delete|remove|send|post|write|memory|artifact|image|schedule|invite|token)/i;

// Agents reached for each system's own tools and skipped Glean (2026-11-11): the two entry points say what they're for.
const INDEX = "The company-wide index (Slack, Google Drive, Confluence, Jira, GitHub, meeting transcripts, people), ranked by relevance.";
const LEAD: Record<string, string> = {
  search: `${INDEX} Start here to find anything about the company before searching each system on its own.`,
  chat: `${INDEX} Start here for a summarized, cited answer to a question that spans several systems.`,
};

/** Allowlisted upstream tools, annotated read-only and closed-world so Codex runs them unattended. */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) => ({ ...t, ...(LEAD[t.name] ? { description: `${LEAD[t.name]} ${t.description ?? ""}`.trim() } : {}), annotations: { ...(t.annotations ?? {}), readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
}

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  return allowlist.has(name) && !NEVER.test(name);
}
