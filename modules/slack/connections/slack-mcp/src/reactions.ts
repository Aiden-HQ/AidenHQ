// A filters-only `hasmy::<emoji>:` search, answered from Slack's Web API `reactions.list` instead of the search tool.
//
// Slack's search has no term clause to pair a reaction modifier with, and "modifiers only affect term clauses", so a
// filters-only reaction search is empty and uncursored however it is spelled: `hasmy::pushpin:` alone, hoisted into
// `query`, and `hasmy::pushpin: has:reaction` (itself a modifier) all fail the same way (#1044, #1045, #1535).
// `reactions.list` with the sign-in's own user token is exactly the set `hasmy::<emoji>:` names, so this module plans
// that call, scans every page and answers in the search tool's result shape. Anything it cannot answer is an explicit
// error that says the set is unknown, never an empty successful page a caller could read as "no matches".
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { needsOwner, signedIn } from "./vendor/needs.js";

/** Search tools whose `filters` Slack parses as search modifiers. */
export const SEARCH_TOOLS = new Set(["slack_search_public", "slack_search_public_and_private"]);

/** Slack's own maximum for a page of `reactions.list`; the page size when the caller gives none. */
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;
/** A runaway guard: past this many pages the answer says which cursor continues, rather than looping forever. */
const MAX_PAGES = 200;
/** A scan that runs longer than this answers "unknown" rather than outliving the kernel's call timeout. */
const DEFAULT_DEADLINE_MS = 120_000;
const BODY_LIMIT = 8 * 1024 * 1024;
// Slack's errors that mean the sign-in itself is refused, not the read.
const AUTH_ERROR = /invalid_auth|not_authed|token_expired|token_revoked|account_inactive|missing_scope/;
// A conversation that is gone or that this sign-in can't reach: not shown, rather than failing the whole scan.
const UNREACHABLE = /channel_not_found|not_in_channel|is_archived|access_denied/;

// `hasmy::emoji:` (the signed-in user's reaction) or `has::emoji:` (anyone's), as one whitespace-delimited token.
const REACTION_FILTER = /^has(my)?::([^:\s]+):$/;
// A token that opens like a reaction filter: matched strictly, or reported, never silently passed through.
const REACTION_PREFIX = /^has(my)?::/;
// A whitespace-delimited token that is a search modifier rather than a term clause.
const MODIFIER = /^(?:in|from|to|with|creator|is|has|hasmy|before|after|on|during|type|content_type):/;

/** One message carrying the reaction, in the search tool's per-message shape. */
export interface ReactionMessage {
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  permalink?: string;
}

/**
 * What to do with a search call: `pass` sends it upstream as it always was; `mine` answers it from `reactions.list`;
 * `unsupported` is a filters-only reaction search this path cannot compute, and must answer an error.
 */
export type ReactionPlan =
  | { kind: "pass" }
  | { kind: "mine"; emoji: string; filter: string; publicOnly: boolean; limit?: number; cursor?: string }
  | { kind: "unsupported"; filter: string; reason: string };

/** A conversation's kind, as the search tool's own scopes split them. */
export type ChannelKind = "public" | "private" | "im" | "mpim";
/** The search scope each kind needs; the same split the tool's own visibility follows. */
export const SEARCH_SCOPE: Record<ChannelKind, string> = { public: "search:read.public", private: "search:read.private", im: "search:read.im", mpim: "search:read.mpim" };

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
/** `filters` as the tool documents it (a string); an array is accepted too, as some clients send one. */
const filterText = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join(" ") : "").trim();

/**
 * The plan for one search call. Only a call with no term clause at all and exactly one `hasmy::<emoji>:` filter (and
 * nothing else) is answerable from `reactions.list`; every other filters-only reaction search names the filter it cannot
 * compute so the caller learns the set is unknown instead of reading an empty page as "none".
 */
export function planReactionSearch(name: string, args: Record<string, unknown>): ReactionPlan {
  if (!SEARCH_TOOLS.has(name)) return { kind: "pass" };
  const publicOnly = name === "slack_search_public";
  const keywords = Array.isArray(args.keywords) ? args.keywords.filter((k): k is string => typeof k === "string" && Boolean(k.trim())) : [];
  if (keywords.length || text(args.natural_language_query)) return { kind: "pass" };

  // A caller may put the modifier in `query` rather than `filters` (the intake scan has done both). That is still a
  // filters-only search when every token in it is a modifier: no term clause, so the search can't match anything.
  const query = text(args.query);
  const filters = filterText(args.filters);
  let source = filters;
  if (query) {
    const tokens = query.split(/\s+/).filter(Boolean);
    if (!tokens.every((t) => MODIFIER.test(t))) return { kind: "pass" }; // a term clause: the search tool's job
    // Both filled with modifiers only: two modifier sets, which reactions.list can't reconcile into one scope.
    if (filters && (tokens.some((t) => REACTION_PREFIX.test(t)) || filters.split(/\s+/).some((t) => REACTION_PREFIX.test(t)))) {
      return { kind: "unsupported", filter: `${query} ${filters}`, reason: `a modifier-only query combined with filters:${filters} is ambiguous` };
    }
    if (filters) return { kind: "pass" }; // modifiers on both sides and no reaction among them: the search tool's
    source = query;
  }
  if (!source) return { kind: "pass" };

  const tokens = source.split(/\s+/).filter(Boolean);
  const reactions = tokens.filter((t) => REACTION_PREFIX.test(t));
  if (!reactions.length) return { kind: "pass" };
  if (reactions.length > 1) return { kind: "unsupported", filter: reactions.join(" "), reason: "more than one reaction filter cannot be answered as one set" };
  const only = reactions[0]!;
  const match = REACTION_FILTER.exec(only);
  if (!match) return { kind: "unsupported", filter: only, reason: `${only} isn't a plain hasmy::<emoji>: filter` };
  if (!match[1]) return { kind: "unsupported", filter: only, reason: `${only} is anyone's reaction; reactions.list lists only the signed-in user's reactions` };
  const extra = tokens.filter((t) => t !== only);
  if (extra.length) return { kind: "unsupported", filter: source, reason: `${only} combined with ${extra.join(" ")} is a scoped search, not a filters-only reaction set` };
  // A bound outside the filter text would narrow the set in a way reactions.list can't repeat: answer it, don't widen it.
  const bounds = ["after", "before"].filter((k) => text(args[k]));
  if (bounds.length) return { kind: "unsupported", filter: only, reason: `${only} with ${bounds.map((k) => `${k}:${text(args[k])}`).join(" ")} is a date-scoped search` };
  // A channel-type scope (im,mpim,public,private) narrows the set in a way this path can't reproduce: answer it.
  const channelTypes = filterText(args.channel_types);
  if (channelTypes) return { kind: "unsupported", filter: only, reason: `${only} with channel_types:${channelTypes} is a channel-type-scoped search` };
  // reactions.list's message items are messages; a search that also asks for files would come back short.
  const types = filterText(args.content_types);
  if (types && types.split(",").map((t) => t.trim()).some((t) => t && t !== "messages")) return { kind: "unsupported", filter: only, reason: `${only} with content_types:${types} also asks for non-message content` };

  const n = Number(args.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LIMIT) : undefined;
  const cursor = text(args.cursor) || undefined;
  return { kind: "mine", emoji: match[2]!, filter: only, publicOnly, ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) };
}

/** The signed-in user's id from the OAuth flow's token.json; undefined when it isn't there (an old or absent sign-in). */
export function readUserId(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const t = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return typeof t.user_id === "string" && t.user_id ? t.user_id : undefined;
  } catch {
    return undefined;
  }
}

/** The scopes the sign-in granted (token.json's `scope`), so a reaction read never exceeds what the search tool may see. */
export function readScopes(file: string): Set<string> | undefined {
  try {
    const t = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof t.scope !== "string") return undefined;
    return new Set(t.scope.split(/[,\s]+/).filter(Boolean));
  } catch {
    return undefined;
  }
}

/** A `conversations.info` channel as the kind its search scope names; undefined when Slack's flags don't say. */
export function channelKind(c: Record<string, any>): ChannelKind | undefined {
  if (c.is_im === true) return "im";
  if (c.is_mpim === true) return "mpim";
  if (c.is_private === true || c.is_group === true) return "private";
  if (c.is_channel === true) return "public";
  return undefined;
}

/**
 * The kind a `missing_scope` answer names, from the `needed` field Slack fills in. A sign-in without `im:read` can't
 * describe a DM, but it can still say the conversation is one: that is enough to keep it out of a public-only search.
 * More than one kind named is ambiguous, so it stays unknown rather than being guessed.
 */
const KIND_SCOPE: Record<string, ChannelKind> = { "channels:read": "public", "groups:read": "private", "im:read": "im", "mpim:read": "mpim" };
export function kindFromNeeded(needed: unknown): ChannelKind | undefined {
  const scopes = (typeof needed === "string" ? needed : Array.isArray(needed) ? needed.filter((s): s is string => typeof s === "string").join(",") : "").split(/[,\s]+/).filter(Boolean);
  const kinds = new Set<ChannelKind>();
  for (const scope of scopes) {
    const kind = KIND_SCOPE[scope];
    if (kind) kinds.add(kind);
  }
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

export interface ScanOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
  deadlineMs?: number;
  now?: () => number;
}

/** The scan's outcome: the whole set (`nextCursor: null`), or what stopped it from computing one. */
export type ScanResult = { ok: true; messages: ReactionMessage[]; nextCursor: string | null } | { ok: false; detail: string };

const messageOf = (item: Record<string, any>, emoji: string, userId: string): ReactionMessage | undefined => {
  if (item?.type !== "message") return undefined;
  const m = item.message;
  if (!m || typeof m !== "object") return undefined;
  const channel = typeof item.channel === "string" ? item.channel : "";
  const ts = typeof m.ts === "string" ? m.ts : "";
  if (!channel || !ts) return undefined;
  const reaction = Array.isArray(m.reactions) ? m.reactions.find((r: any) => r?.name === emoji) : undefined;
  // A `full=true` list carries the complete user array; without the signed-in user in it the reaction isn't theirs.
  if (!reaction || !Array.isArray(reaction.users) || !reaction.users.includes(userId)) return undefined;
  return {
    channel,
    ts,
    ...(typeof m.thread_ts === "string" ? { thread_ts: m.thread_ts } : {}),
    ...(typeof m.text === "string" ? { text: m.text } : {}),
    ...(typeof m.user === "string" ? { user: m.user } : {}),
    ...(typeof m.permalink === "string" ? { permalink: m.permalink } : {}),
  };
};

/**
 * Every page of the signed-in user's reactions, filtered to one emoji and deduplicated by channel + message ts (Slack
 * lists a message once per reaction). A failed or refused page is not a partial set: it returns `ok: false` so the
 * caller can say the set is unknown. `publicOnly` drops what a public-only search may not show (a private channel, a
 * DM, a group DM), classified through `conversations.info`; a channel it can't classify fails the scan rather than
 * being guessed either way.
 */
export async function scanMyReactions(plan: { emoji: string; publicOnly?: boolean; scopes?: Set<string>; limit?: number; cursor?: string }, signIn: { authorization: string; userId: string }, o: ScanOptions = {}): Promise<ScanResult> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const deadline = now() + (o.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const maxPages = o.maxPages ?? MAX_PAGES;
  const messages: ReactionMessage[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  const visibility = new Map<string, boolean>();
  let cursor = plan.cursor ?? "";

  const get = async (method: string, params: Record<string, string>): Promise<{ ok: true; json: Record<string, any> } | { ok: false; detail: string; error?: string; needed?: unknown }> => {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - now();
      if (remaining <= 0) return { ok: false, detail: `${method} ran past the scan's deadline` };
      try {
        res = await fetchImpl(url, { headers: { authorization: signIn.authorization }, signal: AbortSignal.timeout(Math.min(remaining, 30_000)) });
      } catch (err) {
        return { ok: false, detail: `${method} couldn't be reached (${String((err as Error).message).slice(0, 200)})` };
      }
      if (res.status !== 429 || attempt >= 2) break;
      await sleep(Math.min((Number(res.headers.get("retry-after")) || 30) * 1000, Math.max(0, deadline - now())));
    }
    if (!res.ok) return { ok: false, detail: `${method} answered HTTP ${res.status}` };
    const json = (await res.json().catch(() => undefined)) as Record<string, any> | undefined;
    if (!json || json.ok !== true) return { ok: false, detail: `${method} refused the read (${String(json?.error ?? "no answer")})`, ...(json ? { error: String(json.error ?? ""), needed: json.needed } : {}) };
    return { ok: true, json };
  };

  /**
   * Whether this search may show the channel: `slack_search_public` shows public channels only, and
   * `slack_search_public_and_private` shows a kind only when the sign-in granted that kind's search scope, so a
   * reaction read never returns what the tool itself is not allowed to. A channel Slack can't describe fails the scan,
   * unless its `missing_scope` answer names the kind: that is still enough to scope it correctly.
   */
  const visible = async (channel: string): Promise<boolean | string> => {
    const known = visibility.get(channel);
    if (known !== undefined) return known;
    const r = await get("conversations.info", { channel });
    // A channel that is gone or that this sign-in can't see is simply not shown. Any other failure means we can't tell
    // whether it is in scope at all: the set is unknown, never silently short. A `missing_scope` that names the kind
    // (Slack's `needed` field) still says what the conversation is, so it can be scoped like a described one.
    if (!r.ok && UNREACHABLE.test(r.detail)) return visibility.set(channel, false), false;
    const kind = r.ok ? channelKind(r.json.channel ?? {}) : r.error === "missing_scope" ? kindFromNeeded(r.needed) : undefined;
    if (!r.ok && !kind) return r.detail;
    if (!kind) return `Slack didn't say what kind of conversation ${channel} is`;
    const ok = (plan.publicOnly ? kind === "public" : true) && (plan.scopes === undefined ? true : plan.scopes.has(SEARCH_SCOPE[kind]));
    visibility.set(channel, ok);
    return ok;
  };

  // Slack answers with cursors or, on some deployments, with numbered pages: follow whichever the page gives.
  let numbered = plan.cursor ? undefined : 1;
  for (let page = 0; page < maxPages; page++) {
    if (cursor) cursors.add(cursor);
    const r = await get("reactions.list", { full: "true", limit: String(plan.limit ?? DEFAULT_LIMIT), ...(cursor ? { cursor } : {}), ...(numbered ? { page: String(numbered) } : {}) });
    if (!r.ok) return r;
    const { json } = r;
    for (const item of Array.isArray(json.items) ? json.items : []) {
      const message = messageOf(item, plan.emoji, signIn.userId);
      if (!message) continue;
      if (plan.publicOnly || plan.scopes) {
        const show = await visible(message.channel);
        if (typeof show === "string") return { ok: false, detail: `couldn't tell what ${message.channel} is (${show})` };
        if (!show) continue;
      }
      const key = `${message.channel}\u0000${message.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(message);
    }
    const next = typeof json.response_metadata?.next_cursor === "string" ? json.response_metadata.next_cursor : "";
    if (next) {
      // A cursor already visited can't advance: the set is incomplete, and handing the same cursor back would loop.
      if (cursors.has(next)) return { ok: false, detail: "reactions.list returned a cursor this scan had already followed" };
      cursor = next;
      numbered = undefined;
      continue;
    }
    // No cursor: Slack's other shape is numbered pages. More of them is not the end of the set.
    const pages = Number(json.paging?.pages), current = Number(json.paging?.page);
    if (Number.isFinite(pages) && pages > current) {
      if (numbered === undefined) numbered = Number.isFinite(current) ? current + 1 : 2;
      else numbered++;
      continue;
    }
    return { ok: true, messages, nextCursor: null };
  }
  // The cap: a cursor continues the set, but numbered paging has none to hand back, so the set is unknown.
  if (numbered !== undefined) return { ok: false, detail: `reactions.list's numbered pages ran past the scan's ${maxPages}-page limit` };
  return { ok: true, messages, nextCursor: cursor };
}

/** The search tool's result shape, with the end-of-set marker the scan reads: `next_cursor: null` only when complete. */
export function reactionResult(scan: { messages: ReactionMessage[]; nextCursor: string | null }): CallToolResult {
  return signedIn({ content: [{ type: "text", text: JSON.stringify({ messages: scan.messages, next_cursor: scan.nextCursor }) }] });
}

/** A tool error that names why the set is unknown, so a caller never mistakes it for an empty set. */
export function reactionError(error: string, detail: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error, set: "unknown", detail, ...extra }) }] };
}

const bearer = (req: IncomingMessage, token: string): boolean => {
  const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

/**
 * The JSON-RPC message once its body is complete, with the bytes handed back to the stream for the proxy to read.
 * `pass` hands the request on untouched; `invalid` is a body the proxy would itself fail to parse (it answers 500).
 * The body is always handed back before the stream ends: a stream that has ended can't be replayed, so this settles
 * the moment a complete JSON value parses, which is at or before the last chunk.
 */
type Peeked = { kind: "message"; message: Record<string, any> } | { kind: "pass" } | { kind: "invalid" };

function peekJson(req: IncomingMessage, limit: number): Promise<Peeked> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (out: Peeked) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.pause();
      try {
        if (chunks.length) req.unshift(Buffer.concat(chunks));
      } catch {
        /* nothing read yet: the proxy reads the stream as it is */
      }
      resolve(out);
    };
    const parse = (): Peeked | undefined => {
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return undefined;
      }
      return value && typeof value === "object" && !Array.isArray(value) ? { kind: "message", message: value as Record<string, any> } : { kind: "pass" };
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      // Too large: hand it to the proxy, which refuses it on its own limit.
      if (size > limit) return settle({ kind: "pass" });
      // A whole JSON value ends at a `}` (an object) or `]` (a batch array), trailing whitespace aside.
      const body = Buffer.concat(chunks);
      let end = body.length - 1;
      while (end >= 0 && (body[end] === 0x20 || body[end] === 0x0a || body[end] === 0x0d || body[end] === 0x09)) end--;
      if (end < 0 || (body[end] !== 0x7d && body[end] !== 0x5d)) return;
      const out = parse();
      if (out) settle(out);
    };
    const onEnd = () => {
      if (settled) return;
      if (!chunks.length) return settle({ kind: "pass" }); // no body: the proxy answers it as it always has
      settle(parse() ?? { kind: "invalid" });
    };
    // No pause first: an explicitly paused stream doesn't flow when a `data` listener is added.
    req.on("data", onData);
    req.on("end", onEnd);
  });
}

export interface InterceptOptions {
  /** token.json: the sign-in's user id (the token comes from `headers`, which refreshes it). */
  tokenFile: string;
  /** The sign-in's request headers (src/vendor/oauth.ts `headers()`), so an expiring token is refreshed like any other call. */
  headers: () => Promise<Record<string, string>>;
  /** The sign-in's state, as the proxy reads it: a transient refresh failure is not the owner's to fix. */
  authState: () => string;
  /**
   * Whether the proxy serves `name` on `/mcp/read` (the manifest tag *and* the upstream's read-only hint). Asked of the
   * proxy itself, so the reaction path can't answer where the proxy would refuse.
   */
  servedRead?: (name: string) => Promise<boolean>;
  /** The kernel's bearer on /mcp. */
  serviceKey?: string;
  /** The kernel's read bearer on /mcp/read. */
  readKey?: string;
  /** The kernel's signed caller assertion on /mcp (the proxy verifies the same one). */
  caller: (req: IncomingMessage) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
  deadlineMs?: number;
  log?: (event: Record<string, unknown>, msg: string) => void;
}

const send = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const answer = (id: unknown, result: CallToolResult) => ({ jsonrpc: "2.0", id: id ?? null, result });

/**
 * Answers one filters-only `hasmy::<emoji>:` search call from `reactions.list`, before the proxy would send it upstream;
 * false hands the untouched request to the proxy. It sits on the proxy's `routes` hook, so it repeats that hook's own
 * admission (the endpoint's bearer, `/mcp/read`'s manifest allowlist, and the kernel's caller assertion on /mcp).
 */
export async function interceptReactionSearch(req: IncomingMessage, res: ServerResponse, o: InterceptOptions): Promise<boolean> {
  if (req.method !== "POST") return false;
  let path: string;
  try {
    path = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  const readOnly = path === "/mcp/read";
  if (!readOnly && path !== "/mcp") return false;
  const key = readOnly ? o.readKey : o.serviceKey;
  if (!key || !bearer(req, key)) return false; // the proxy answers 404/401 itself

  const peeked = await peekJson(req, BODY_LIMIT);
  // A body the proxy can't parse either: answer as the proxy would, since its bytes are spent.
  if (peeked.kind === "invalid") return (send(res, 500, { error: "bad request" }), true);
  // Only a single tools/call is intercepted. A batch (no caller here sends one) is the proxy's, unchanged.
  if (peeked.kind === "pass" || peeked.message.method !== "tools/call") return false;
  const message = peeked.message;
  const name = nameOf(message);
  const plan = planReactionSearch(name, argsOf(message));
  if (plan.kind === "pass") return false;

  // The proxy's own admission, in its order: nothing is answered before the caller is the kernel's.
  if (!readOnly) {
    try {
      await o.caller(req);
    } catch (err) {
      const reason = (err as Error).message;
      o.log?.({ tool: name, reason }, "tool call refused");
      send(res, 200, answer(message.id, reactionError("refused", `Refused: ${reason}.`)));
      return true;
    }
  }

  send(res, 200, answer(message.id, await serveReaction(name, plan, readOnly, o)));
  return true;
}

const nameOf = (m: Record<string, any>): string => (typeof m.params?.name === "string" ? m.params.name : "");
const argsOf = (m: Record<string, any>): Record<string, unknown> => (m.params?.arguments && typeof m.params.arguments === "object" && !Array.isArray(m.params.arguments) ? (m.params.arguments as Record<string, unknown>) : {});

/** One reaction search as a tool result: the set, or the explicit error that says it is unknown. */
async function serveReaction(name: string, plan: Exclude<ReactionPlan, { kind: "pass" }>, readOnly: boolean, o: InterceptOptions): Promise<CallToolResult> {
  // /mcp/read serves only what the proxy itself would: the manifest's read tag and the upstream's read-only hint.
  if (readOnly && o.servedRead && !(await o.servedRead(name).catch(() => false))) {
    // Signed out, the proxy lists no read tools at all: that is a sign-in to fix, not a tool that isn't a read.
    if (o.authState() !== "ok") return needsOwner({ cause: "not_connected", detail: "The reaction set is unknown: Slack isn't signed in, so reactions.list can't be read." });
    return reactionError("refused", `Tool ${name} is not a read: the read endpoint serves reads only.`);
  }
  if (plan.kind === "unsupported") {
    o.log?.({ tool: name, filter: plan.filter }, "refused a reaction search reactions.list cannot compute");
    return reactionError("unsupported_reaction_filter", `The reaction set is unknown: ${plan.reason}.`, { filter: plan.filter });
  }
  // Only the owner can fix a sign-in: the same needs_owner answer every other call gives, so the kernel routes it.
  const need = (detail: string): CallToolResult => needsOwner({ cause: "not_connected", detail });
  const userId = readUserId(o.tokenFile);
  if (!userId) return need("The reaction set is unknown: Slack's sign-in has no stored user id, so reactions.list can't be read.");
  let authorization: string | undefined;
  try {
    authorization = (await o.headers()).authorization;
  } catch (err) {
    // The proxy's own rule: only an expired sign-in is the owner's; a vendor hiccup on refresh stays a plain error.
    const detail = `The reaction set is unknown: Slack's sign-in couldn't be read (${String((err as Error).message).slice(0, 200)}).`;
    return o.authState() === "expired" ? need(detail) : reactionError("reactions_list_failed", detail, { filter: plan.filter });
  }
  if (!authorization) return need("The reaction set is unknown: Slack's sign-in has no user token.");
  // The tool's own scope split: a public-only search shows public channels (and needs search:read.public); the
  // all-channels one shows only the kinds the sign-in granted a search scope for. Without the stored scopes there is no
  // honest answer.
  const scopes = readScopes(o.tokenFile);
  if (!scopes) return reactionError("scopes_unknown", "The reaction set is unknown: the sign-in's granted scopes couldn't be read (Reconnect on the board).", { filter: plan.filter });
  if (plan.publicOnly && !scopes.has(SEARCH_SCOPE.public)) {
    return reactionError("scope", "The reaction set is unknown: the sign-in has no search:read.public scope, so public search isn't granted (Reconnect on the board and allow it).", { filter: plan.filter });
  }
  const scan = await scanMyReactions({ ...plan, scopes }, { authorization, userId }, { fetchImpl: o.fetchImpl, sleep: o.sleep, maxPages: o.maxPages, deadlineMs: o.deadlineMs });
  if (!scan.ok) {
    o.log?.({ tool: name, filter: plan.filter, detail: scan.detail }, "reactions.list could not compute the set");
    // Slack refusing the token is the owner's to fix; anything else is a plain error the caller retries or reports.
    if (AUTH_ERROR.test(scan.detail)) return need(`The reaction set is unknown: Slack refused the sign-in (${scan.detail}).`);
    return reactionError("reactions_list_failed", `The reaction set is unknown: ${scan.detail}.`, { filter: plan.filter });
  }
  o.log?.({ tool: name, filter: plan.filter, messages: scan.messages.length, complete: scan.nextCursor === null }, "answered a reaction search from reactions.list");
  return reactionResult(scan);
}
