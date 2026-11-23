// The one answer a connection gives when only the owner can fix why a call can't be served (spec 2026-11-20 connect on first
// use §1): an MCP isError result whose structuredContent is { error: "needs_owner", need }. The kernel's tool proxy reads it
// before fencing, records the connection as down, and decides who hears about it (the owner, in the conversation they asked
// in, or the daily digest); the agent gets the kernel's own fixed words, never this text. Import-free: first-party modules
// hold byte-identical copies (scripts/sync-shared.ts: edit this one and run it).

/** The causes only the owner can fix. A vendor that is down or a rate limit is a plain error, never a need. */
export const OWNER_CAUSES = ["not_connected", "expired", "scope", "sso", "restricted"] as const;
export type Cause = (typeof OWNER_CAUSES)[number];
/** `detail`: one sentence for the owner. `scope`, `org`: what a partial cause is about. `url`: the vendor's own page (sso, restricted). */
export type Need = { cause: Cause; detail: string; scope?: string; org?: string; url?: string; account?: string };

/** The tool result a connection answers when only the owner can fix it. */
export function needsOwner(need: Need): { isError: true; content: [{ type: "text"; text: string }]; structuredContent: { error: "needs_owner"; need: Need } } {
  return { isError: true, content: [{ type: "text", text: need.detail }], structuredContent: { error: "needs_owner", need } };
}

/**
 * The `_meta` key a connection sets on a successful answer its sign-in served. Only such an answer clears the connection's down
 * state in the kernel: a tool that works signed out (a prefilled link) proves nothing about the sign-in.
 */
export const SIGNED_IN = "aidenhq/signed_in";

/**
 * The `_meta` key naming the orgs (logins) a served answer proved: each is an org one of its calls answered. The kernel clears
 * those orgs' `sso`/`restricted` rows, and only those, so a grant the owner made on the org's own page stops the digest.
 */
export const PROVED_ORGS = "aidenhq/proved_orgs";

/** Who a served answer proves: `account` (a multi-account connection's) and/or the orgs its calls proved. */
export type Served = { account?: string; orgs?: string[] };

/** Marks a result as served by the connection's sign-in (SIGNED_IN); `who` names the account and the orgs it proved. */
export function signedIn<T extends object>(result: T, who?: string | Served): T & { _meta: Record<string, unknown> } {
  const { account, orgs } = typeof who === "string" ? { account: who } : who ?? {};
  const meta = (result as { _meta?: Record<string, unknown> })._meta;
  // Proof is the connection's own evidence: an upstream's `_meta` (a vendor proxy relays one) can never claim it.
  const { [PROVED_ORGS]: _upstream, ...inherited } = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
  const proved = orgs?.filter(Boolean) ?? [];
  return {
    ...result,
    _meta: {
      ...inherited,
      [SIGNED_IN]: account || true,
      ...(proved.length ? { [PROVED_ORGS]: proved } : {}),
    },
  };
}

/** The orgs a served answer proved (PROVED_ORGS): each a login the kernel may clear an sso/restricted need for. */
export function provedOrgs(result: unknown): string[] {
  const r = result as { _meta?: Record<string, unknown> } | null | undefined;
  const v = r && typeof r === "object" && r._meta && typeof r._meta === "object" ? r._meta[PROVED_ORGS] : undefined;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
}

/** Whether a tools/call result is a success the connection's sign-in served. */
export function servedSignedIn(result: unknown): boolean {
  const r = result as { isError?: unknown; _meta?: Record<string, unknown> } | null | undefined;
  const v = r && typeof r === "object" && r.isError !== true && r._meta && typeof r._meta === "object" ? r._meta[SIGNED_IN] : undefined;
  return v === true || (typeof v === "string" && !!v);
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
  for (const k of ["scope", "org", "url", "account"] as const) if (typeof n[k] === "string") out[k] = n[k] as string;
  return out;
}
