// What Slack's connection adds to the pass-through (src/vendor/proxy.ts): Slack's own OAuth shapes, the draft tool's argument
// pin, and the search folded into one query (Slack drops reaction filters from `filters`). A filters-only `hasmy::`
// reaction search is answered from reactions.list instead (src/reactions.ts).
import { planReactionSearch } from "./reactions.js";

/** User token scopes the owner may grant on Connect. The reads are pre-selected; the writes let agents act as the owner. */
export const READ_SCOPES = [
  "search:read.public", "search:read.private", "search:read.im", "search:read.mpim", "search:read.users", "search:read.files",
  "channels:history", "channels:read", "groups:history", "groups:read", "im:history", "im:read", "mpim:history", "mpim:read",
  "users:read", "users:read.email", "users.profile:read", "usergroups:read", "emoji:read", "files:read", "canvases:read", "lists:read", "reactions:read",
];
export const WRITE_SCOPES = ["chat:write", "reactions:write", "channels:write", "groups:write", "im:write", "mpim:write", "files:write", "canvases:write", "lists:write"];

/** An oauth.v2.user.access answer in the standard shape: the user token sits at the top or under authed_user. */
export function slackAnswer(json: Record<string, unknown>): Record<string, unknown> {
  if (json.ok === false) return { error: String(json.error ?? "refused") };
  const src = (json.authed_user as Record<string, unknown> | undefined)?.access_token ? (json.authed_user as Record<string, unknown>) : json;
  const user = src.id ?? json.user_id;
  const team = (json.team as { id?: unknown } | undefined)?.id;
  return {
    access_token: src.access_token,
    refresh_token: src.refresh_token,
    expires_in: src.expires_in ?? json.expires_in,
    scope: src.scope,
    ...(typeof user === "string" ? { user_id: user } : {}),
    ...(typeof team === "string" ? { team_id: team } : {}),
  };
}

/** The draft tool: a draft in the owner's own Drafts & Sent. Only its documented arguments pass, so it stays a draft. */
export const DRAFT_TOOL = "slack_send_message_draft";
export const DRAFT_ARGS = ["channel_id", "message", "thread_ts"];

/** Search tools whose filters Slack parses as search modifiers. */
const SEARCH_TOOLS = new Set(["slack_search_public", "slack_search_public_and_private"]);

/**
 * The search as one query: the caller's own `query`, then `keywords`, `filters` and `natural_language_query`.
 * Slack drops `has::`/`hasmy::` from `filters`, and a modifier only qualifies the term clause it sits in, so a
 * reaction modifier lifted on its own loses the `in:<#channel>` scope it shared the `filters` string with.
 * A filters-only search is left as sent: folding it alone would leave a query with no term clause, and there is no
 * match-all term clause to give it. A filters-only `hasmy::<emoji>:` search never reaches this function: the module
 * answers it from `reactions.list` (src/reactions.ts) before the call is sent upstream.
 * The structured arguments stay exactly as the caller sent them.
 */
function searchQuery(args: Record<string, unknown>): string | undefined {
  const own = typeof args.query === "string" ? args.query : undefined;
  const keywords = Array.isArray(args.keywords) ? args.keywords.filter((k): k is string => typeof k === "string" && Boolean(k.trim())).map((k) => k.trim()) : [];
  // `filters` as the tool documents it (a string); an array is accepted too, as some clients send one, so the fold reads
  // it the same way the reaction planner does and no modifier is silently lost before it reaches Slack.
  const filters = typeof args.filters === "string" ? args.filters.trim() : Array.isArray(args.filters) ? args.filters.filter((f): f is string => typeof f === "string" && Boolean(f.trim())).map((f) => f.trim()).join(" ") : "";
  const natural = typeof args.natural_language_query === "string" ? args.natural_language_query.trim() : "";
  if (!own?.trim() && !keywords.length && !natural) return own;
  return [own?.trim(), ...keywords, filters, natural].filter(Boolean).join(" ");
}

/** The arguments passed upstream: for the draft tool, only the documented ones. */
export function upstreamArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === DRAFT_TOOL) {
    const extra = Object.keys(args).filter((k) => !DRAFT_ARGS.includes(k));
    if (extra.length) throw new Error(`refused draft arguments: ${extra.join(", ")}`);
    return args;
  }
  if (!SEARCH_TOOLS.has(name)) return args;
  // A filters-only reaction search has no term clause Slack can match, so sending it upstream is the empty, uncursored
  // page this module exists to replace. The interceptor answers it before this hook runs; anything that still reaches
  // here (a batched call, or a direct proxy call) is refused outright rather than answered with that misleading page.
  const plan = planReactionSearch(name, args);
  if (plan.kind !== "pass") throw new Error(`a filters-only ${plan.filter} search is answered from reactions.list, not sent upstream; call it on its own`);
  const query = searchQuery(args);
  // `filters` is documented as a string; an array was folded into the query above, so forward it as the same string
  // rather than leaving an array an upstream that follows the schema would refuse.
  const filters = Array.isArray(args.filters) ? args.filters.filter((f): f is string => typeof f === "string" && Boolean(f.trim())).map((f) => f.trim()).join(" ") : args.filters;
  const next = { ...args, ...(query !== undefined && query !== args.query ? { query } : {}), ...(Array.isArray(args.filters) ? { filters } : {}) };
  return Object.keys(next).every((k) => next[k as keyof typeof next] === args[k]) ? args : next;
}
