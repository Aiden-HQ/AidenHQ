// The one answer a connection gives when only the owner can fix why a call can't be served (spec 2026-11-20 connect on first
// use §1): an MCP isError result whose structuredContent is { error: "needs_owner", need }. The kernel's tool proxy reads it
// before fencing, records the connection as down, and decides who hears about it (the owner, in the conversation they asked
// in, or the daily digest); the agent gets the kernel's own fixed words, never this text. Import-free: first-party modules
// hold byte-identical copies (scripts/sync-shared.ts: edit this one and run it).

/** The causes only the owner can fix. A vendor that is down or a rate limit is a plain error, never a need. */
export const OWNER_CAUSES = ["not_connected", "expired", "scope", "sso", "restricted"] as const;
export type Cause = (typeof OWNER_CAUSES)[number];
/** `detail`: one sentence for the owner. `scope`, `org`: what a partial cause is about. `url`: the vendor's own page (sso, restricted). */
export type Need = { cause: Cause; detail: string; scope?: string; org?: string; url?: string };

/** The tool result a connection answers when only the owner can fix it. */
export function needsOwner(need: Need): { isError: true; content: [{ type: "text"; text: string }]; structuredContent: { error: "needs_owner"; need: Need } } {
  return { isError: true, content: [{ type: "text", text: need.detail }], structuredContent: { error: "needs_owner", need } };
}

/** The need in a tools/call result, if it is one; an unknown cause reads as not_connected. Only known string fields are kept. */
export function readNeed(result: unknown): Need | undefined {
  const r = result as { isError?: unknown; structuredContent?: { error?: unknown; need?: Record<string, unknown> } } | null | undefined;
  if (!r || typeof r !== "object" || r.isError !== true) return undefined;
  const s = r.structuredContent;
  if (!s || typeof s !== "object" || s.error !== "needs_owner" || !s.need || typeof s.need !== "object") return undefined;
  const n = s.need;
  const cause = (OWNER_CAUSES as readonly unknown[]).includes(n.cause) ? (n.cause as Cause) : "not_connected";
  const out: Need = { cause, detail: typeof n.detail === "string" ? n.detail : "" };
  for (const k of ["scope", "org", "url"] as const) if (typeof n[k] === "string") out[k] = n[k] as string;
  return out;
}
