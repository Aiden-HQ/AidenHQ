// The model gateway's logic (main.ts wires it to its listeners): who a call is for, the spend caps, the pass-through to
// OpenRouter with what it billed tapped from the answer, and the ledger (kernel.db's calls) the board pulls.
//
// Routes (OpenRouter-compatible; the caller's "API key" is its own per-run credential, never the OpenRouter key):
//   POST /api/v1/responses | /api/v1/chat/completions            kind agent (or the service kind its credential fixes)
//   POST /api/v1/messages         Anthropic's format (OpenRouter's Anthropic-compatible endpoint: Claude Code with ANTHROPIC_BASE_URL
//                                 at the gateway's /api), the same caps, reservation and ledger. Only what a reservation prices goes
//                                 on: the body's MESSAGE_FIELDS (a field that buys more, such as speed, service_tier or mcp_servers,
//                                 is dropped), custom tools only (a server tool, billed per use, is refused), anthropic-version and
//                                 the ANTHROPIC_BETAS Claude Code sends. A cut-off call is trued up by OpenRouter's x-generation-id.
//   POST /advisor/api/v1/... | /fanout/api/v1/...                kind advisor | fanout, counted against the caller's run
//   POST /api/v1/chat/completions  (Bearer gateway_board_key) kind aside: the board's side chat, capped per UTC day
//   POST /usage {since}           (Bearer gateway_board_key) the ledger since then → {records} (the board's Costs tab)
//   POST /internal/caps {scope, agentId, subject, cap}  (Bearer gateway_board_key) the owner raised a cap: the new cap
//   GET /v1/spend/summary         (Bearer gateway_board_key) today (UTC) against every cap in force, as the caps count it:
//                                 {day, install: {spent, cap}, agents: [{agent_id, spent, cap}]}: every granted agent and any other
//                                 that spent today (the board's header and Costs tab)
//   GET /health
// CI listener (gateway.ts, the CI runners' bridge address; only these routes, only `ahqci_` credentials, never on the others):
//   POST /ci/token                (Bearer: a GitHub Actions OIDC token, ci.ts) -> {token, expires_at, review}: an opaque CI
//                                 token, and the instance's review model and effort (settings.ci_review_model)
//   POST /api/v1/chat/completions | /api/v1/responses  kind ci-code-review: the allowed models and fields only (ci.ts), CI's
//                                 own caps, attributed to repo and PR; streamed or not, reserved and settled like any call
//   GET /health
// Credentials: a kernel job's token `ahqj_` (token.ts, kind job: capped as its agent on its task while the job lives), a
// system token of the same format (reviewer/grader/source/check), a fast chat lane's turn token (same format, signed with
// gateway_lane_secret, agent kind only), or the source writers' key (gateway_source_key). The run key is the credential's sha256.
// Spend (spec §5.12): caps count real cost. A call goes ahead while what its caps have spent is below each cap (so one call
// can take a cap past it, never two in a row); its output is bounded to what the tightest cap's room buys at the model's
// price on OpenRouter's own models list (prices.ts: the dearest tier it lists; an id it doesn't list is refused), never under
// MIN_OUTPUT, never over the model's ceiling. One transaction checks the caps and writes a `reserved` ledger row holding the
// call's estimated input cost, so calls in flight count too. Settlement replaces the row's cost with what OpenRouter billed
// (the answer's usage.cost, which it always sends; tokens x list price only if a usage block lacks it); no usage (a stream
// cut, an upstream failure) leaves the estimate. A reservation whose kernel died (its `owner`, boot and pid) is closed as
// `unsettled` at that amount (fail closed); one whose answer had begun (OpenRouter's generation id, `gen`) is then settled
// from OpenRouter's record of that generation as `interrupted`, at what it billed. A restart lets calls in flight finish in
// the old kernel (main.ts drain), so the next kernel never closes a live peer's reservation.
// Caps: run / task / agent-day (grants caps, defaults 2/10/30 USD), always enforced; only the owner raises one (raise_cap). A
// task labelled `chat` or a routine's execution task is perpetual: its task cap counts the UTC day only. System kinds
// (reviewer, grader, source) are never capped, but a reviewer token may carry its review's own cap (`u`, main.ts). CI caps (config/gateway.json `ci`: per repo per UTC day, all CI per day) are
// never filed for raising. The install cap (config/gateway.json `install_day_usd`, settings.spend_day_usd; absent, none)
// counts every call of the UTC day, every kind and CI included; its raise_cap is filed as agent INSTALL_CAP, scope day.
// A check job's token (kind check, ../checkjobs.ts) is the reviewer eval's, capped by the eval day cap (config/gateway.json
// `eval_day_usd`, settings.eval_day_usd; absent, 0: refused) and attributed to `eval:<head>`, or a model recipe's (a code
// review), which carries its own cap (`u`): that token's run key alone, attributed to `<run>:<check>`. Neither is filed for raising.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { CI_KIND, CI_PREFIX, ciBodyProblem, githubKeys, verifyGithubOidc } from "./ci.ts";
import { createPrices, type Price } from "./prices.ts";
import { verifyToken } from "./token.ts";

type Brand<T, B extends string> = T & { readonly __brand: B };
/** A run key: the sha256 of the caller's own credential (or the board aside's day key). Run caps and the ledger key on it. */
export type RunKey = Brand<string, "RunKey">;
/**
 * Who a model call is for, settled by identify() from the credential alone (a checked token, a stored CI token): only
 * identify() makes one, and nothing in the request body ever feeds it.
 */
export type Caller = Brand<{
  runKey: RunKey; agentId: string | null; runId: string | null; issueId: string | null; perpetual: boolean; rev: string | null;
  kind: string; component: string; capped: boolean; ci?: { repo: string; subject: string }; check?: { subject: string; cap?: number }; review?: { cap: number };
}, "Caller">;
type GatewayError = Error & { status?: number; type?: string; extra?: Record<string, unknown> };
type Caps = { run_usd: number; task_usd: number; day_usd: number };
/** config/grants/grants.json `agents`, by Paperclip id (setup writes it). */
type Grants = Record<string, { rev?: string; key?: string; caps?: Partial<Caps>; member_of?: string; team?: unknown }>;
/** config/gateway.json `ci` (compile writes it from the ci module's settings). */
type CiConf = { orgs?: unknown; models?: unknown; review?: unknown; repo_day_usd?: unknown; day_usd?: unknown };
/** A run key's settled identity (the runs table), or the same fields resolved for one call. */
type RunRow = { run_key: string; agent_id: string | null; run_id: string | null; issue_id: string | null; rev: string | null; perpetual: number; at: string };
type RunIdentity = Pick<RunRow, "agent_id" | "run_id" | "issue_id" | "rev"> & { perpetual: number | boolean };
type CallRow = {
  key: string; at: string; day: string; run_key: string; run_id: string | null; agent_id: string | null; issue_id: string | null; task_subject: string | null;
  rev: string | null; kind: string; component: string; model: string; input: number; cached: number; output: number; cost_usd: number | null; ms: number | null; status: string;
};
type CiTokenRow = { hash: string; repo: string; pr: number; head: string | null; gh_run: string; attempt: string; exp: string; at: string };
type Sum = { s: number };
type Over = { scope: string; subject: string; cap: number; spent: number; install?: boolean };
/** What OpenRouter billed for one call. */
type Usage = { key: string; model: string; input: number; cached: number; output: number; costUsd: number | null };
type UsageBlock = {
  input_tokens?: number; prompt_tokens?: number; output_tokens?: number; completion_tokens?: number; cost?: unknown;
  input_tokens_details?: { cached_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number };
  /** Anthropic's format: input_tokens leaves out cache reads and writes. */
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
};
type Answer = { id?: unknown; model?: unknown; usage?: UsageBlock };
type Log = (msg: string, fields?: Record<string, unknown>) => void;

export const DEFAULT_CAPS: Caps = { run_usd: 2, task_usd: 10, day_usd: 30 };
/** The install-wide cap's "agent" in the caps and filed tables and on its raise_cap card (never a Paperclip id). */
export const INSTALL_CAP = "install";
const SYSTEM: { source: string } & Record<string, string> = { reviewer: "AI reviewer", grader: "Grader", source: "Source writers" };
const ROUTE = /^\/(?:(advisor|fanout)\/)?api\/v1\/(responses|chat\/completions|messages)$/;
const MAX_BODY = 32 * 1024 * 1024;
/** The Anthropic-format body fields a call may carry (what Claude Code sends); any other is dropped before it goes upstream. */
const MESSAGE_FIELDS = new Set(["model", "messages", "system", "tools", "tool_choice", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream", "stop_sequences", "temperature", "top_p", "top_k", "provider"]);
/** The anthropic-beta values passed upstream (Claude Code's; none changes the price); any other is dropped. */
const ANTHROPIC_BETAS = new Set(["interleaved-thinking-2025-05-14", "context-management-2025-06-27", "claude-code-20250219", "mid-conversation-tool-changes-2026-07-01", "thinking-token-count-2026-05-13", "effort-2025-11-24", "thinking-display-updates-2026-08-18"]);
const DAY_MS = 864e5;
// The fewest output tokens a call is cut to near a cap (below the cap a call always goes ahead).
const MIN_OUTPUT = 1024;
// CI: a token lives 2 h (the job's timeout is 90 min); a repo gets at most 200 a day. Calls in flight need no limit of their
// own: each holds its reservation against CI's caps until it settles.
const CI_TTL_MS = 2 * 3600_000;
const CI_TOKENS_PER_DAY = 200;
const CI_MAX_BODY = 8 * 1024 * 1024;
// CI tokens a repo may be issued a minute. Only verified exchanges count (ci.ts checks the claims, then GitHub's signature,
// about 20 microseconds), so a flood of forged or foreign tokens never uses up a real job's budget; one repo's flood of
// genuine ones only uses its own. Refusals on the CI listener are logged at most CI_REFUSALS_LOGGED a minute.
const CI_TOKENS_PER_MIN = 20;
const CI_REFUSALS_LOGGED = 20;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return Boolean(a && b) && x.length === y.length && timingSafeEqual(x, y);
};
const fail = (status: number, type: string, message: string, extra: Record<string, unknown> = {}): GatewayError => Object.assign(new Error(message), { status, type, extra });

/** A JSON file re-read when it changes; `fallback` when it's missing or unreadable. */
export function watched<T>(file: string, pick: (j: Record<string, unknown>) => T, fallback: T): () => T {
  let cache: { mtimeMs: number; size: number; v: T } | undefined;
  return () => {
    let st;
    try { st = statSync(file); } catch { return fallback; }
    if (!cache || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
      let v = fallback;
      try { v = pick(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>); } catch {}
      cache = { mtimeMs: st.mtimeMs, size: st.size, v };
    }
    return cache.v;
  };
}

/** The ledger's tables in kernel.db; `legacy` (the gateway's old data/gateway/usage.db) is merged in first (moveLedger). */
export function openLedger(file: string, legacy?: string): { db: DatabaseSync; moved: number } {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS calls (key TEXT PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, run_key TEXT NOT NULL, run_id TEXT, agent_id TEXT,
      issue_id TEXT, task_subject TEXT, rev TEXT, kind TEXT NOT NULL, component TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cost_usd REAL, ms INTEGER, status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS calls_run ON calls (run_key);
    CREATE INDEX IF NOT EXISTS calls_task ON calls (agent_id, task_subject);
    CREATE INDEX IF NOT EXISTS calls_day ON calls (agent_id, day);
    CREATE INDEX IF NOT EXISTS calls_all_day ON calls (day);
    CREATE INDEX IF NOT EXISTS calls_at ON calls (at);
    CREATE INDEX IF NOT EXISTS calls_status ON calls (status);
    -- Who a run key is: settled at its first call (a gateway restart or the JWT's expiry never re-derives it), with its rev.
    CREATE TABLE IF NOT EXISTS runs (run_key TEXT PRIMARY KEY, agent_id TEXT, run_id TEXT, issue_id TEXT, rev TEXT, perpetual INTEGER NOT NULL, at TEXT NOT NULL);
    -- Caps the owner raised (board → POST /internal/caps): the cap in force for that scope and subject.
    CREATE TABLE IF NOT EXISTS caps (scope TEXT NOT NULL, agent_id TEXT NOT NULL, subject TEXT NOT NULL, cap REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY (scope, agent_id, subject));
    -- raise_cap requests filed: one per scope, subject and cap value.
    CREATE TABLE IF NOT EXISTS filed (scope TEXT NOT NULL, agent_id TEXT NOT NULL, subject TEXT NOT NULL, cap REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY (scope, agent_id, subject, cap));
    -- CI tokens issued (POST /ci/token): only the token's sha256, the repo, PR and run attempt GitHub's OIDC token named, the
    -- head the job sent (advisory) and when it expires. Deleting a row revokes that token. One per run attempt, enforced
    -- here, so a replayed OIDC token gets nothing, across restarts too (a re-run is a new attempt).
    CREATE TABLE IF NOT EXISTS ci_tokens (hash TEXT PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL, head TEXT, gh_run TEXT NOT NULL, attempt TEXT NOT NULL,
      exp TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (repo, gh_run, attempt));
  `);
  // A call's kernel process (`<boot id>:<pid>`) and OpenRouter's generation id (the true-up's handle on a cut-off call).
  const have = new Set((db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map((c) => c.name));
  for (const c of ["owner", "gen"]) if (!have.has(c)) db.exec(`ALTER TABLE calls ADD COLUMN ${c} TEXT`);
  return { db, moved: moveLedger(db, legacy) };
}

/**
 * Copies every row of the old ledger file into kernel.db in one transaction, keyed by each table's primary key (INSERT OR
 * IGNORE), so a partial or repeated move never counts a call twice or loses one; run at every start while the old file is
 * there, which also picks up what a rolled-back kernel wrote to it. The old file is left as it is. Returns the rows added.
 */
export function moveLedger(db: DatabaseSync, legacy?: string): number {
  if (!legacy || !existsSync(legacy)) return 0;
  db.prepare("ATTACH DATABASE ? AS legacy").run(legacy);
  try {
    const has = new Set((db.prepare("SELECT name FROM legacy.sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    db.exec("BEGIN IMMEDIATE");
    let n = 0;
    // Columns by name, whatever order the old file's tables have.
    // Only the columns both have: columns added since (owner, gen) stay empty on the moved rows.
    const names = (s: string, t: string) => (db.prepare(`PRAGMA ${s}.table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    const cols = (t: string) => { const old = new Set(names("legacy", t)); return names("main", t).filter((c) => old.has(c)).join(", "); };
    for (const t of ["calls", "runs", "caps", "filed", "ci_tokens"]) if (has.has(t)) n += Number(db.prepare(`INSERT OR IGNORE INTO main.${t} (${cols(t)}) SELECT ${cols(t)} FROM legacy.${t}`).run().changes);
    db.exec("COMMIT");
    return n;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  } finally {
    db.exec("DETACH DATABASE legacy");
  }
}

/** An SSE line's `data` field (the space after the colon is optional, a trailing CR dropped), or undefined for any other line. */
export const sseData = (line: string): string | undefined => (line.startsWith("data:") ? line.slice(line[5] === " " ? 6 : 5).replace(/\r$/, "") : undefined);

/** Error codes and types that name a passing upstream condition (overload, rate limit, provider fault): worth another attempt. */
const TRANSIENT_ERRORS = new Set(["server_error", "api_error", "overloaded_error", "rate_limit_error", "rate_limit_exceeded", "timeout"]);

/**
 * Whether an SSE `data` field reports a failure: OpenRouter's error chunk (a top-level `error`), an `error` event (Responses,
 * Anthropic) or `response.failed`. Only top-level fields count (a response's own `error: null`, a delta's text never do).
 * → its reason (the error's code, else its type: a short word, never the message) and whether it is transient (a code in
 * RETRY_STATUS or TRANSIENT_ERRORS); undefined when the field is no failure.
 */
export function streamError(data: string): { reason: string; transient: boolean } | undefined {
  if (!data.includes('"error"') && !data.includes("response.failed")) return undefined;
  try {
    const j = JSON.parse(data) as { error?: { code?: unknown; type?: unknown }; type?: unknown; code?: unknown; response?: { error?: { code?: unknown; type?: unknown } } } | null;
    if (!j || typeof j !== "object" || !(j.error || j.type === "error" || j.type === "response.failed")) return undefined;
    const e = (typeof j.error === "object" && j.error) || j.response?.error || { code: j.code }; // a Responses `error` event carries its code at the top
    const raw = String(e.code ?? e.type ?? "");
    const reason = /^[\w.-]{1,60}$/.test(raw) ? raw : "unknown";
    return { reason, transient: RETRY_STATUS.has(Number(raw)) || TRANSIENT_ERRORS.has(raw) };
  } catch { return undefined; }
}

/** An SSE `data:` line that ends an answer: a chat chunk's finish_reason (but `error`), a response's completion, Anthropic's message_stop. */
const FINISHED = /"finish_reason"\s*:\s*"(?!error")[^"]+"|"type"\s*:\s*"(?:response\.completed|response\.incomplete|message_stop)"/;
/** An SSE `data` field's event type (its first `type`, a short word), or undefined (a chat chunk has none). */
const eventType = (data: string) => /"type"\s*:\s*"([\w.]{1,60})"/.exec(data.slice(0, 200))?.[1];
/** An SSE event's data: its `data` fields joined by newlines (empty for a comment-only event). */
const eventData = (ev: string) => ev.split(/\r?\n/).map(sseData).filter((d) => d !== undefined).join("\n");
/** Events that only open an answer, before any output: Responses' created and in_progress, Anthropic's message_start and ping. */
const OPENING = new Set(["response.created", "response.in_progress", "message_start", "ping"]);
/** Whether an event (not a failure) only opens an answer: an OPENING type, or a chat chunk whose deltas name only the role. */
function opening(data: string): boolean {
  if (OPENING.has(eventType(data) ?? "")) return true;
  if (!data.includes('"choices"') || data.includes('"usage":{')) return false;
  try {
    const j = JSON.parse(data) as { choices?: { delta?: Record<string, unknown>; finish_reason?: unknown }[] } | null;
    return Array.isArray(j?.choices) && j.choices.length > 0 && j.choices.every((c) => !c.finish_reason && Object.entries(c.delta ?? {}).every(([k, v]) => k === "role" || v === "" || v == null));
  } catch { return false; }
}

/**
 * What OpenRouter billed for one call, read as the answer passes: the last SSE `data:` line with a usage block (a chat
 * completion's final chunk, or `response.completed`), or the whole JSON body. done() → { key, model, input (uncached),
 * cached, output, costUsd } or undefined. The model is the one OpenRouter answered with. failure() (a stream, after done())
 * → why an answer that never completed (neither final usage nor a finish event) failed: its first error event's reason,
 * else its last event's type; undefined for an answer that completed. `[DONE]` is only the transport's end, never a finish.
 * Never model text: the reason is safe to log.
 */
export function usageTap(sse: boolean): { feed(text: string): void; done(): Usage | undefined; failure(): string | undefined } {
  let tail = "", body = "", event: string[] = [], held = 0, last = "none", error: string | undefined, finished = false, final = false, found: (Answer & { id: string; usage: UsageBlock }) | undefined;
  const line = (data: string) => {
    if (data !== "[DONE]") last = eventType(data) ?? "chunk";
    const err = streamError(data);
    if (err) error ??= `error event: ${err.reason}`;
    else if (FINISHED.test(data)) finished = true;
    const was = final;
    take(data);
    if (err) final = was; // a usage block on an error event is kept for billing, never taken as completion
  };
  const field = (l: string) => {
    const d = sseData(l);
    if (d !== undefined) { if ((held += d.length) <= MAX_BODY) event.push(d); return; }
    if (l.replace(/\r$/, "") !== "") return;
    if (event.length && held <= MAX_BODY) line(event.join("\n"));
    event = []; held = 0;
  };
  const take = (text: string) => {
    if (!text.includes('"usage"')) return;
    try {
      const j = JSON.parse(text) as (Answer & { type?: unknown; response?: Answer; message?: Answer }) | null;
      // Anthropic's stream: the id and input in message_start, the final usage (and OpenRouter's cost) in message_delta.
      if (j?.type === "message_delta" && j.usage && found) { found.usage = { ...found.usage, ...j.usage }; final = true; return; }
      const r = j?.type === "response.completed" || j?.type === "response.incomplete" ? j.response : j?.type === "message_start" ? j.message : j; // an answer cut at its output limit is billed too
      if (r?.usage && typeof r.id === "string") { found = r as Answer & { id: string; usage: UsageBlock }; final = j?.type !== "message_start"; }
    } catch {}
  };
  return {
    feed(text) {
      if (!sse) { if (body.length < MAX_BODY) body += text; return; }
      // Line by line, comments dropped; an event's data fields are joined at its blank line, as the peek reads them (held
      // to MAX_BODY: past it the event is dropped).
      const lines = (tail + text).split("\n");
      tail = lines.pop()!;
      for (const l of lines) field(l);
    },
    failure() {
      return finished || final ? undefined : (error ?? `no usage or finish; last event: ${last}`);
    },
    done() {
      if (sse) { field(tail); field(""); tail = ""; } else take(body);
      if (!found) return undefined;
      const u = found.usage;
      const anthropic = u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined;
      const cached = (anthropic ? u.cache_read_input_tokens : u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens) ?? 0;
      const input = (u.input_tokens ?? u.prompt_tokens ?? 0) + (anthropic ? cached + (u.cache_creation_input_tokens ?? 0) : 0);
      return {
        key: found.id.slice(0, 200),
        model: typeof found.model === "string" ? found.model.slice(0, 120) : "",
        input: Math.max(0, input - cached),
        cached,
        output: u.output_tokens ?? u.completion_tokens ?? 0, // reasoning included, as billed
        costUsd: typeof u.cost === "number" ? u.cost : null,
      };
    },
  };
}

const BOOT = (() => { try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return ""; } })();
/** A kernel process's mark on the reservations it holds: this boot and its pid. */
export const ownerOf = (pid: number) => `${BOOT}:${pid}`;
/** Whether the process that marked a reservation still runs (a pid from another boot never does). */
function alive(owner: string | null): boolean {
  const [boot, pid] = String(owner ?? "").split(":");
  if (boot !== BOOT || !Number(pid)) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
/** How long after a call was cut off OpenRouter's record of it is looked for (it appears with a delay). */
const TRUE_UP_MS = 30 * 60_000;

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 524]);
const RETRY_DELAYS_MS = [1000, 3000, 9000, 20000];
/** How much of a stream, and for how long, is held back while looking for its first output before it is passed through. */
const PEEK_BYTES = 64 * 1024;
const FIRST_EVENT_MS = 10_000;
/** A stream that ended before any output: incomplete, worth one more attempt. */
const NO_OUTPUT = { reason: "ended before any output", transient: true };

/**
 * The gateway: handle(req, res). `secret(name)` reads a secret file (fresh each time, so a rotation needs no restart);
 * `upstream` is OpenRouter's API base; Paperclip and the board's internal API as URLs.
 */
export function createGateway({ dbFile, legacyDbFile, grantsFile, settingsFile, asCaller, secret, upstream = "https://openrouter.ai/api/v1", modelsUrl = `${upstream}/models`, priceRetryMs, paperclipUrl, fileRaiseCap, githubJwksUrl, jobLive = () => false, log = () => {}, now = Date.now, retryDelaysMs = RETRY_DELAYS_MS, streamIdleMs = 120_000, taskRetryMs = [500, 2_000] }: {
  /** Whether a kernel job (a job token's id) is still admitted or running: an ended job's token buys nothing. */
  jobLive?: (id: string) => boolean;
  dbFile: string; legacyDbFile?: string; grantsFile: string; settingsFile: string;
  /** A module's model call for the agent whose tool call it serves (module token + caller assertion): that caller's own credential. */
  asCaller?: (req: IncomingMessage) => Promise<string | undefined>; secret: (name: string) => string; upstream?: string; paperclipUrl?: string;
  /** OpenRouter's public models list (prices.ts), and the waits between its fetches on a cold start. */
  modelsUrl?: string; priceRetryMs?: number[];
  githubJwksUrl?: string; log?: Log; now?: () => number;
  /** Waits between attempts at a transient OpenRouter failure (tests pass zeros). */
  retryDelaysMs?: number[];
  /** How long an answer's stream may go quiet before it is cut (OpenRouter sends keep-alives while a model thinks). */
  streamIdleMs?: number;
  /** Waits between tries of a job's task read when the control plane doesn't answer. */
  taskRetryMs?: number[];
  /** Files a kernel.raise_cap record (writes.ts fileNative): the owner's, after the AI reviewer. No task: the install cap's. */
  fileRaiseCap?: (b: { task: string | null; scope: string; agentId: string; subject: string; cap: number; spent: number }) => Promise<void>;
}) {
  const { db, moved } = openLedger(dbFile, legacyDbFile);
  if (moved) log("ledger rows moved into kernel.db", { rows: moved });
  const me = ownerOf(process.pid);
  /**
   * Reservations whose kernel is gone are closed at their reserved amount (fail closed): at start, and each minute (a draining
   * peer that hit its deadline). A live peer's (a kernel still draining) are left to it; at start, rows under this process's own
   * mark are a dead one's whose pid came round again.
   */
  const sweep = (start = false) => {
    for (const { owner } of db.prepare("SELECT DISTINCT owner FROM calls WHERE status = 'reserved'").all() as { owner: string | null }[]) {
      if (owner === me ? !start : alive(owner)) continue;
      db.prepare("UPDATE calls SET status = 'unsettled', at = ? WHERE status = 'reserved' AND owner IS ?").run(new Date(now()).toISOString(), owner);
    }
  };
  sweep(true);
  const grants = watched(grantsFile, (j) => (j.agents ?? {}) as Grants, {});
  const prices = createPrices({ url: modelsUrl, now, log, ...(priceRetryMs ? { retryMs: priceRetryMs } : {}) });
  // CI code review (compile writes it from the ci module's settings): { orgs, models, repo_day_usd, day_usd } or null.
  const ciConf = watched<CiConf | null>(settingsFile, (j) => (j.ci && typeof j.ci === "object" ? (j.ci as CiConf) : null), null);
  // The install-wide daily cap (settings.spend_day_usd); 0: none.
  const installDay = watched(settingsFile, (j) => (Number(j.install_day_usd) > 0 ? Number(j.install_day_usd) : 0), 0);
  const evalDay = watched(settingsFile, (j) => (Number(j.eval_day_usd) > 0 ? Number(j.eval_day_usd) : 0), 0);
  const keyFor = githubKeys(githubJwksUrl, now);
  const q = {
    run: db.prepare("SELECT * FROM runs WHERE run_key = ?"),
    addRun: db.prepare("INSERT OR IGNORE INTO runs (run_key, agent_id, run_id, issue_id, rev, perpetual, at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    add: db.prepare("INSERT OR IGNORE INTO calls (key, at, day, run_key, run_id, agent_id, issue_id, task_subject, rev, kind, component, model, input, cached, output, cost_usd, ms, status, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    spentRun: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE run_key = ?"),
    tokensRun: db.prepare("SELECT COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached, COALESCE(SUM(output), 0) AS output FROM calls WHERE run_key = ?"),
    spentTask: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE agent_id = ? AND task_subject = ?"),
    spentDay: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE agent_id = ? AND day = ?"),
    spentAll: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE day = ?"),
    spenders: db.prepare("SELECT DISTINCT agent_id FROM calls WHERE day = ? AND agent_id IS NOT NULL"),
    cap: db.prepare("SELECT cap FROM caps WHERE scope = ? AND agent_id = ? AND subject = ?"),
    setCap: db.prepare("INSERT INTO caps (scope, agent_id, subject, cap, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (scope, agent_id, subject) DO UPDATE SET cap = excluded.cap, at = excluded.at"),
    file: db.prepare("INSERT OR IGNORE INTO filed (scope, agent_id, subject, cap, at) VALUES (?, ?, ?, ?, ?)"),
    unfile: db.prepare("DELETE FROM filed WHERE scope = ? AND agent_id = ? AND subject = ? AND cap = ?"),
    since: db.prepare("SELECT * FROM calls WHERE at >= ? AND status != 'reserved' ORDER BY at LIMIT 20000"),
    settle: db.prepare("UPDATE calls SET key = ?, at = ?, model = ?, input = ?, cached = ?, output = ?, cost_usd = ?, ms = ?, status = ? WHERE key = ? AND status = 'reserved'"),
    inflight: db.prepare("SELECT COUNT(*) AS n FROM calls WHERE status = 'reserved'"),
    gen: db.prepare("UPDATE calls SET gen = ? WHERE key = ? AND status = 'reserved'"),
    cutOff: db.prepare("SELECT key, gen FROM calls WHERE status = 'unsettled' AND gen IS NOT NULL AND at >= ? LIMIT 100"),
    trueUp: db.prepare("UPDATE calls SET status = 'interrupted', at = ?, model = ?, input = ?, cached = ?, output = ?, cost_usd = ? WHERE key = ? AND status = 'unsettled'"),
    ciToken: db.prepare("SELECT * FROM ci_tokens WHERE hash = ?"),
    addCiToken: db.prepare("INSERT OR IGNORE INTO ci_tokens (hash, repo, pr, head, gh_run, attempt, exp, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    ciIssued: db.prepare("SELECT COUNT(*) AS n FROM ci_tokens WHERE repo = ? AND substr(at, 1, 10) = ?"),
    // A CI call's task_subject is `<owner>/<repo>#<pr>`.
    ciSpentRepo: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE kind = 'ci-code-review' AND day = ? AND substr(task_subject, 1, length(?)) = ?"),
    ciSpent: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE kind = 'ci-code-review' AND day = ?"),
    checkSpent: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE kind = 'check' AND day = ? AND task_subject LIKE 'eval:%'"),
  };
  const prune = () => {
    const cut = new Date(now() - 40 * DAY_MS).toISOString();
    db.prepare("DELETE FROM calls WHERE at < ?").run(cut);
    db.prepare("DELETE FROM filed WHERE at < ?").run(cut);
    db.prepare("DELETE FROM runs WHERE at < ?").run(new Date(now() - 7 * DAY_MS).toISOString());
    db.prepare("DELETE FROM ci_tokens WHERE exp < ?").run(new Date(now() - 2 * DAY_MS).toISOString());
  };
  prune();
  // A timer's throw would exit the kernel: a failed prune or true-up is logged, and the next one tries again.
  const pruner = setInterval(() => { try { prune(); } catch (e) { log("ledger prune failed", { err: String((e as Error).message).slice(0, 200) }); } }, 3600_000);
  pruner.unref();

  /**
   * Cut-off calls whose answer had begun are settled from OpenRouter's record of the generation (GET /generation: what it
   * billed and the native tokens) as `interrupted`; tried each minute until TRUE_UP_MS after the cut, since the record appears
   * with a delay. Without a record they keep the reserved amount.
   */
  async function trueUp() {
    sweep();
    const key = secret("openrouter_key");
    if (!key) return;
    for (const row of q.cutOff.all(new Date(now() - TRUE_UP_MS).toISOString()) as { key: string; gen: string }[]) {
      try {
        const res = await fetch(`${upstream}/generation?id=${encodeURIComponent(row.gen)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) continue;
        const g = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
        if (typeof g.total_cost !== "number") continue;
        const n = (k: string) => (Number.isFinite(Number(g[k])) ? Number(g[k]) : 0);
        const cached = n("native_tokens_cached");
        q.trueUp.run(new Date(now()).toISOString(), String(g.model ?? "").slice(0, 120) || "unknown", Math.max(0, n("native_tokens_prompt") - cached), cached, n("native_tokens_completion"), g.total_cost, row.key);
        log("cut-off call settled from OpenRouter", { gen: row.gen, usd: g.total_cost });
      } catch (e) {
        log("true-up failed", { gen: row.gen, err: String((e as Error).message).slice(0, 200) });
      }
    }
  }
  const trueUps = setInterval(() => void trueUp().catch((e: Error) => log("true-up failed", { err: String(e?.message ?? e).slice(0, 200) })), 60_000);
  trueUps.unref();
  let live = 0; // this process's model calls in flight (main.ts drains on them)

  async function paperclip(path: string, token: string): Promise<unknown> {
    const res = await fetch(new URL(path, paperclipUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw Object.assign(new Error(`Paperclip ${path.split("/")[2]} answered ${res.status}`), { status: res.status });
    return res.json();
  }

  /**
   * A job's task and whether that task is perpetual (a chat task, or a routine's execution task). It is settled once for the
   * run, so a control plane that doesn't answer is never read as "not perpetual": tried again briefly, then the call is
   * refused with a 503 (the engine retries it) and nothing is settled. A task it refuses (gone, say) is not perpetual.
   */
  async function taskOf(issueId: string | null) {
    let issue: { labels?: ({ name?: string } | null)[]; originKind?: string } | undefined;
    for (let n = 0; issueId && paperclipUrl; n++) {
      try {
        issue = (await paperclip(`/api/issues/${encodeURIComponent(issueId)}`, secret("paperclip_board_key"))) as typeof issue;
        break;
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (st !== undefined && st >= 400 && st < 500 && st !== 429) break;
        if (n >= taskRetryMs.length) throw fail(503, "control_plane_unavailable", "the control plane didn't answer for this job's task; try again");
        await new Promise((r) => setTimeout(r, taskRetryMs[n]));
      }
    }
    return { issueId, perpetual: Boolean(issue && ((issue.labels ?? []).some((l) => l?.name === "chat") || issue.originKind === "routine_execution")) };
  }

  /** A run key's identity, settled once: the agent, a run id, its task and whether that task is perpetual, the rev. */
  function settle(runKey: RunKey, { agentId = null, runId = null, issueId = null, perpetual = false }: { agentId?: string | null; runId?: string | null; issueId?: string | null; perpetual?: boolean }): RunRow {
    q.addRun.run(runKey, agentId, runId, issueId, (agentId && grants()[agentId]?.rev) || null, perpetual ? 1 : 0, new Date(now()).toISOString());
    return q.run.get(runKey) as RunRow;
  }

  /** Who the call is for: { runKey, agentId, runId, issueId, perpetual, rev, kind, component, capped }. Throws 401 otherwise. */
  async function identify(cred: string, routeKind: string, ci = false): Promise<Caller> {
    if (!cred) throw fail(401, "unauthorized", "no credential: the API key must be this run's own credential");
    const runKey = sha256(cred) as RunKey;
    // The CI listener takes CI tokens only, and CI tokens work nowhere else: no other credential is even looked at there.
    if (ci !== cred.startsWith(CI_PREFIX)) throw fail(401, "unauthorized", ci ? "this address takes CI tokens only (POST /ci/token)" : "not a credential this gateway knows");
    if (ci) {
      ciOn();
      const t = q.ciToken.get(runKey) as CiTokenRow | undefined;
      if (!t || Date.parse(t.exp) <= now()) throw fail(401, "unauthorized", "this CI token is invalid or expired");
      return { runKey, agentId: null, runId: null, issueId: null, perpetual: false, rev: t.head ?? null, kind: CI_KIND, component: CI_KIND, capped: false, ci: { repo: t.repo, subject: `${t.repo}#${t.pr}` } } as Caller;
    }
    const as = (row: RunIdentity | null | undefined, kind: string, component: string, capped: boolean) => ({ runKey, agentId: row?.agent_id ?? null, runId: row?.run_id ?? null, issueId: row?.issue_id ?? null, perpetual: Boolean(row?.perpetual), rev: row?.rev ?? null, kind, component, capped }) as Caller;
    if (same(cred, secret("gateway_source_key"))) return as(null, "source", SYSTEM.source, false);
    if (same(cred, secret("gateway_board_key"))) {
      // The board's side chat ("ask about this task"): no agent and no task run, so its "run" is the UTC day, capped.
      return { ...as(null, "aside", "Board side chat", true), runKey: `board-aside:${day(now())}` as RunKey } as Caller;
    }
    if (cred.startsWith("ahqj_")) {
      // A fast chat lane's turn token (slack-live-mcp) is signed with gateway_lane_secret: an agent's capped call only, so a
      // holder of the lane secret can never mint a system (uncapped) token.
      const lane = verifyToken(secret("gateway_lane_secret"), cred, now());
      if (lane?.k === "agent" && lane.a) {
        const row = (q.run.get(runKey) as RunRow | undefined) ?? settle(runKey, { agentId: lane.a, issueId: null });
        return as(row, routeKind, `Fast lane: ${String(lane.c ?? lane.a)}`.slice(0, 80), true);
      }
      const p = verifyToken(secret("gateway_job_secret"), cred, now());
      if (!p) throw fail(401, "unauthorized", "this run's model credential is invalid or expired");
      if (p.k === "job") {
        // A kernel job (boxes.ts): its run is the job; capped as its agent on its task (a chat or routine task by the day), while
        // the job lives.
        if (!jobLive(String(p.id))) throw fail(401, "unauthorized", "this job has ended");
        const row = (q.run.get(runKey) as RunRow | undefined) ?? settle(runKey, { agentId: p.a, runId: String(p.id), ...(await taskOf(p.i)) });
        return as(row, routeKind, "agent", true);
      }
      if (p.k === "check") return { ...as(null, "check", "Check jobs", true), check: { subject: String(p.c ?? "").slice(0, 80), ...(Number(p.u) > 0 ? { cap: Number(p.u) } : {}) } } as Caller;
      // An agent's model calls come only with a kernel job's token or a lane's: an agent-kind token under the job secret is no one's.
      if (!SYSTEM[p.k]) throw fail(401, "unauthorized", "this run's model credential is invalid or expired");
      const row = (q.run.get(runKey) as RunRow | undefined) ?? settle(runKey, { agentId: p.a, issueId: p.i });
      // A grader token that names an agent (the grading module's, minted per held task) is capped as that agent's; the reviewer's
      // and the others name none and stay system calls.
      // A reviewer token carries its review's own spend cap (`u`, main.ts): that token's run key alone, never filed for raising.
      const who = as(row, p.k, String(p.c ?? SYSTEM[p.k]).slice(0, 80), p.k === "grader" && Boolean(p.a));
      return (p.k === "reviewer" && Number(p.u) > 0 ? { ...who, review: { cap: Number(p.u) } } : who) as Caller;
    }
    throw fail(401, "unauthorized", "not a credential this gateway knows");
  }

  /**
   * Whose day cap an agent spends against, and every agent spending it: a team member's is its team record's (teams.<t>.caps),
   * shared by all the team's members; anyone else's is its own. The router reads the same (wakes.ts, via exhausted).
   */
  const dayHolder = (agentId: string): { holder: string; spenders: string[] } => {
    const team = grants()[agentId]?.member_of;
    if (!team) return { holder: agentId, spenders: [agentId] };
    const all = Object.entries(grants());
    return { holder: all.find(([, g]) => g.key === team && g.team)?.[0] ?? agentId, spenders: all.filter(([, g]) => g.member_of === team).map(([id]) => id) };
  };
  const daySpent = (agentId: string, today: string) => dayHolder(agentId).spenders.reduce((s, id) => s + (q.spentDay.get(id, today) as Sum).s, 0);
  const capOf = (who: { agentId: string | null }, scope: string, subject: string): number => {
    const holder = scope === "day" && who.agentId ? dayHolder(who.agentId).holder : who.agentId;
    const own = ({ ...DEFAULT_CAPS, ...((holder && grants()[holder]?.caps) || {}) } as Record<string, number>)[`${scope}_usd`]!; // scope: run, task or day
    return (q.cap.get(scope, holder ?? "", subject) as { cap: number } | undefined)?.cap ?? own;
  };
  const taskSubject = (who: { issueId: string | null; perpetual: boolean }, t: number) => (who.issueId ? (who.perpetual ? `${who.issueId}:${day(t)}` : who.issueId) : null);

  /** The install cap in force today (the setting, or what the owner raised it to), with everything spent today; or none. */
  function installScope(today: string): Over[] {
    const set = installDay();
    if (!set) return [];
    const cap = (q.cap.get("day", INSTALL_CAP, today) as { cap: number } | undefined)?.cap ?? set;
    return [{ scope: "day", subject: today, cap, spent: (q.spentAll.get(today) as Sum).s, install: true }];
  }

  /** The caps this call counts against, each with what is spent on it (settled + reserved): only the install cap for an uncapped kind. */
  function capScopes(who: Caller, t: number): Over[] {
    const today = day(t);
    if (who.ci) {
      const c = ciOn(), prefix = `${who.ci.repo}#`;
      return [
        { scope: "repo-day", subject: who.ci.repo, cap: Number(c.repo_day_usd) > 0 ? Number(c.repo_day_usd) : 0, spent: (q.ciSpentRepo.get(today, prefix, prefix) as Sum).s },
        { scope: "day", subject: today, cap: Number(c.day_usd) > 0 ? Number(c.day_usd) : 0, spent: (q.ciSpent.get(today) as Sum).s },
        ...installScope(today),
      ];
    }
    if (who.check?.cap) return [{ scope: "check-run", subject: who.check.subject, cap: who.check.cap, spent: (q.spentRun.get(who.runKey) as Sum).s }, ...installScope(today)];
    if (who.check) return [{ scope: "eval-day", subject: today, cap: evalDay(), spent: (q.checkSpent.get(today) as Sum).s }, ...installScope(today)];
    if (who.review) return [{ scope: "run", subject: who.runKey, cap: who.review.cap, spent: (q.spentRun.get(who.runKey) as Sum).s }, ...installScope(today)];
    if (!who.capped) return installScope(today);
    const subject = taskSubject(who, t);
    const scopes: [string, string, number][] = [["run", who.runKey, (q.spentRun.get(who.runKey) as Sum).s]];
    if (who.agentId && subject) scopes.push(["task", subject, (q.spentTask.get(who.agentId, subject) as Sum).s]);
    if (who.agentId) scopes.push(["day", today, daySpent(who.agentId, today)]);
    return [...scopes.map(([scope, subj, spent]) => ({ scope, subject: subj, cap: capOf(who, scope, subj), spent })), ...installScope(today)];
  }

  /**
   * The prices a call is reserved at: its model's on OpenRouter's list, the dearest of any fallback `models`. A 403 for an id
   * OpenRouter doesn't list; a 503 (the caller retries) when no list could be read at all.
   */
  async function priceOf(body: Record<string, unknown>): Promise<Price> {
    const ids = [body.model, ...(Array.isArray(body.models) ? body.models : [])].map(String);
    const r = await prices.lookup(ids);
    if ("unavailable" in r) throw fail(503, "prices_unavailable", "OpenRouter's models list couldn't be read to price this call; try again");
    if ("missing" in r) throw fail(403, "not_priced", `OpenRouter lists no model ${r.missing.join(", ").slice(0, 200)}`);
    const most = (k: keyof Price, pick = Math.max) => pick(...r.prices.map((p) => p[k]));
    return { in: most("in"), cached_in: most("cached_in"), out: most("out"), max_output: most("max_output", Math.min) };
  }

  /**
   * One transaction: refused when a cap's spend has reached it; else the output tokens the tightest cap's room buys (at least
   * MIN_OUTPUT, at most `want`) and a `reserved` ledger row holding the estimated input cost. Synchronous, so a call is
   * always checked against every call settled or in flight before it.
   */
  function reserve(who: Caller, t: number, key: string, model: string, inUsd: number, perOut: number, want: number): { usd: number; maxOutput: number } | { over: Over } {
    db.exec("BEGIN IMMEDIATE");
    try {
      const scopes = capScopes(who, t);
      const tightest = scopes.reduce<Over | undefined>((a, b) => (!a || b.cap - b.spent < a.cap - a.spent ? b : a), undefined);
      if (tightest && tightest.spent >= tightest.cap) {
        db.exec("ROLLBACK");
        return { over: tightest };
      }
      const room = tightest ? tightest.cap - tightest.spent - inUsd : Infinity;
      const maxOutput = Math.min(want, perOut > 0 ? Math.max(MIN_OUTPUT, Math.floor(room / perOut)) : want);
      const usd = inUsd;
      record(who, { key, model, costUsd: usd, status: "reserved", t, ms: null });
      db.exec("COMMIT");
      return { usd, maxOutput };
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The CI settings, when CI is on; else a 403 (taking the module out refuses every CI token at once). */
  function ciOn(): CiConf {
    const c = ciConf();
    if (!c) throw fail(403, "ci_off", "CI code review through the model gateway is off on this instance");
    return c;
  }

  /**
   * POST /ci/token: a GitHub Actions OIDC token in, an opaque CI token bound to the repo and PR it names out. Everything after
   * the body is read is synchronous, so two exchanges for one run attempt can't both pass: the row's UNIQUE (repo, run,
   * attempt) decides, and once written it stays, whatever happens to the answer (fail closed).
   */
  let issued = { minute: 0, byRepo: new Map<string, number>() };
  async function ciToken(req: IncomingMessage, res: ServerResponse) {
    const c = ciOn();
    const claims = await verifyGithubOidc(bearer(req), { orgs: Array.isArray(c.orgs) ? c.orgs : [], keyFor, now });
    let body: { head?: unknown } = {};
    try { body = JSON.parse((await readBody(req, 4096)) || "{}") ?? {}; } catch (e) { if ((e as GatewayError).status) throw e; }
    // No await from here on.
    const minute = Math.floor(now() / 60_000);
    if (issued.minute !== minute) issued = { minute, byRepo: new Map() };
    const n = (issued.byRepo.get(claims.repo) ?? 0) + 1;
    issued.byRepo.set(claims.repo, n);
    if (n > CI_TOKENS_PER_MIN) throw fail(429, "too_many_tokens", `${claims.repo} has had ${CI_TOKENS_PER_MIN} CI tokens this minute`);
    const t = now();
    if ((q.ciIssued.get(claims.repo, day(t)) as { n: number }).n >= CI_TOKENS_PER_DAY) throw fail(429, "too_many_tokens", `${claims.repo} has had ${CI_TOKENS_PER_DAY} CI tokens today`);
    const token = `${CI_PREFIX}${randomBytes(32).toString("base64url")}`;
    const head = /^[0-9a-f]{40}$/.test(String(body.head ?? "")) ? (body.head as string) : null; // advisory: the job says so
    const exp = new Date(t + CI_TTL_MS).toISOString();
    if (!q.addCiToken.run(sha256(token), claims.repo, claims.pr, head, claims.runId, claims.attempt, exp, new Date(t).toISOString()).changes) {
      throw fail(401, "unauthorized", "this run attempt has already traded its GitHub token");
    }
    log("ci token issued", { repo: claims.repo, pr: claims.pr, run: claims.runId });
    send(res, 200, { token, expires_at: exp, review: c.review ?? null });
  }

  /**
   * One raise_cap per scope, subject and cap value, filed as a kernel.raise_cap record (needs the run's task). The install
   * cap's is filed whoever hit it, with no task (main.ts gives it one of the owner's own).
   */
  async function fileRaise(who: Caller, over: Over): Promise<boolean> {
    // A run cap is on the credential's hash: the next run has a new one, so a raised run cap would never be used.
    if (!fileRaiseCap || (!over.install && (over.scope === "run" || !who.agentId || !who.issueId))) return false;
    const agentId = over.install ? INSTALL_CAP : over.scope === "day" ? dayHolder(who.agentId!).holder : who.agentId!;
    const args = [over.scope, agentId, over.subject, over.cap];
    if (!q.file.run(...args, new Date(now()).toISOString()).changes) return true;
    try {
      await fileRaiseCap({ task: over.install ? null : who.issueId, scope: over.scope, agentId, subject: over.subject, cap: over.cap, spent: Math.round(over.spent * 1e4) / 1e4 });
      log("raise_cap filed", { scope: over.scope, agent: agentId, subject: over.subject, cap: over.cap });
      return true;
    } catch (e) {
      q.unfile.run(...args); // the next refused call files it again
      log("raise_cap filing failed", { err: String((e as Error).message).slice(0, 300) });
      return false;
    }
  }

  // Stamped when the call ends (the board pulls by that time); counted on the UTC day it started.
  function record(who: Caller, r: Partial<Usage> & { key?: string; t?: number; model?: unknown; costUsd?: number | null; ms?: number | null; status: string }) {
    const t = r.t ?? now();
    q.add.run(r.key ?? `gw:${randomUUID()}`, new Date(now()).toISOString(), day(t), who.runKey, who.runId, who.agentId, who.issueId, who.ci?.subject ?? who.check?.subject ?? taskSubject(who, t), who.rev, who.kind, who.component, String(r.model ?? "").slice(0, 120) || "unknown", r.input ?? 0, r.cached ?? 0, r.output ?? 0, r.costUsd ?? null, r.ms ?? null, r.status, me);
  }

  const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const bearer = (req: IncomingMessage) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > max) throw fail(413, "too_large", "request too large");
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function model(req: IncomingMessage, res: ServerResponse, routeKind: string, path: string, ci = false) {
    const t0 = now();
    const who = await identify((!ci && (await asCaller?.(req))) || bearer(req), routeKind, ci);
    let body: Record<string, unknown>, raw = "";
    try { body = JSON.parse((raw = await readBody(req, ci ? CI_MAX_BODY : MAX_BODY))); } catch (e) { throw (e as GatewayError).status ? e : fail(400, "bad_request", "the body must be JSON"); }
    if (!body || typeof body !== "object" || typeof body.model !== "string") throw fail(400, "bad_request", "a model call needs a model");
    if (who.ci) {
      // CI's own gates: the models and fields it may use. A refusal is a 403 or 402 (codegenie and the workflow read those as
      // permanent: no retry).
      const c = ciOn();
      const problem = ciBodyProblem(body, Array.isArray(c.models) ? c.models : [], path);
      if (problem) throw fail(403, "not_allowed", problem);
    }
    if (path === "messages") {
      for (const k of Object.keys(body)) if (!MESSAGE_FIELDS.has(k)) delete body[k];
      // A tool with a type is Anthropic's (a server tool is billed per use, outside any reservation): custom tools only.
      if (Array.isArray(body.tools) && body.tools.some((t) => !t || typeof t !== "object" || ((t as { type?: unknown }).type ?? "custom") !== "custom")) throw fail(403, "not_allowed", "only custom tools may be sent: a server tool is billed outside the call's reservation");
    }
    const price = await priceOf(body);
    const upKey = secret("openrouter_key");
    if (!upKey) throw fail(503, "no_upstream_key", "the gateway has no OpenRouter key");
    // Bounded output: the request's own limit, the model's ceiling, and what the tightest cap's room buys (reserve).
    const field = path === "responses" ? "max_output_tokens" : "max_tokens";
    const asked = [body[field], body.max_completion_tokens].filter((n): n is number => Number.isInteger(n) && (n as number) > 0);
    const id = `gw:${randomUUID()}`;
    const r = reserve(who, t0, id, body.model, (Math.ceil(Buffer.byteLength(raw) / 3) * price.in) / 1e6, price.out / 1e6, Math.min(price.max_output, ...asked));
    if ("over" in r) {
      const over = r.over;
      if (over.install) {
        // Every call stops at the install cap; one raise_cap for today and this cap, whoever hit it.
        const filed = await fileRaise(who, over);
        record(who, { key: `cap:${who.runKey}:install:${over.cap}`, model: body.model, status: "cap_reached", t: t0, ms: 0 });
        throw fail(402, "cap_reached", `spend cap reached: the install's daily $${over.spent.toFixed(2)} of $${over.cap.toFixed(2)}; ${filed ? "the owner has been asked to raise it" : "the owner must raise it"}`, { scope: "install", cap: over.cap, spent: over.spent });
      }
      if (who.ci) {
        record(who, { key: `cap:${who.ci.repo}:${over.scope}:${day(t0)}:${over.cap}`, model: body.model, status: "cap_reached", t: t0, ms: 0 });
        throw fail(402, "cap_reached", `spend cap reached: CI ${over.scope} $${over.spent.toFixed(2)} of $${over.cap.toFixed(2)}; the owner can raise it in settings`, { scope: over.scope, cap: over.cap, spent: over.spent });
      }
      const filed = await fileRaise(who, over);
      // One ledger row per run, scope and cap: a refused turn arrives several times (Codex retries a 402 five times).
      record(who, { key: `cap:${who.runKey}:${over.scope}:${over.cap}`, model: body.model, status: "cap_reached", t: t0, ms: 0 });
      const what = over.scope === "day" ? "agent-day" : over.scope; // no date or time: Paperclip reads one as a retry time
      // Worded to match none of Paperclip's retry/quota patterns (no automatic re-run).
      const next = over.scope === "run" ? "this run stops here; the next run starts with a fresh run cap" : filed ? "the owner has been asked to raise it" : "the owner must raise it";
      throw fail(402, "cap_reached", `spend cap reached: ${what} $${over.spent.toFixed(2)} of $${over.cap.toFixed(2)}; ${next}`, { scope: over.scope, cap: over.cap, spent: over.spent });
    }
    body[field] = r.maxOutput;
    if (body.max_completion_tokens !== undefined) body.max_completion_tokens = r.maxOutput;
    body.provider = { ...(body.provider && typeof body.provider === "object" ? body.provider : {}), zdr: true };
    // Settled once, however the call ends: at what OpenRouter billed (usage.cost; tokens x list price if a usage block lacks it,
    // never 0); nothing when the upstream refused before any output or a stream failed in-band (`free`: OpenRouter bills
    // neither; the latter as `stream_error`, so it stays visible); else the reservation (a stream cut, no usage, a restart).
    live++;
    const settle = (status: string, u?: Usage, free = false) => {
      live--;
      const billed = u ? (u.costUsd ?? (u.input * price.in + u.cached * price.cached_in + u.output * price.out) / 1e6) : free ? 0 : r.usd;
      const row = [new Date(now()).toISOString(), String(u?.model || body.model).slice(0, 120), u?.input ?? 0, u?.cached ?? 0, u?.output ?? 0, billed, now() - t0, status, id];
      try { q.settle.run(u?.key ?? id, ...row); } catch { q.settle.run(id, ...row); } // a generation id already used keeps the reservation's key
    };
    let up: Response;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let peeked: Peeked | undefined;
    let gen = "";
    let attempt = new AbortController();
    const betas = String(req.headers["anthropic-beta"] ?? "").split(",").map((b) => b.trim()).filter((b) => ANTHROPIC_BETAS.has(b));
    const anthropic = path !== "messages" ? {} : { ...(typeof req.headers["anthropic-version"] === "string" ? { "anthropic-version": req.headers["anthropic-version"] } : {}), ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}) };
    const post = () => (attempt = new AbortController(), fetch(`${upstream}/${path}`, { method: "POST", headers: { "content-type": "application/json", accept: req.headers.accept ?? "*/*", authorization: `Bearer ${upKey}`, ...anthropic }, body: JSON.stringify(body), signal: attempt.signal }));
    const isSse = (u: Response) => String(u.headers.get("content-type") ?? "").includes("event-stream");
    // OpenRouter's generation id: its header, else the first event's id (a chat chunk's id, a response's response.id).
    const genOf = (u: Response, text: string) => { const h = u.headers.get("x-generation-id") ?? ""; return /^gen-[\w-]{1,190}$/.test(h) ? h : (/"id"\s*:\s*"(gen-[\w-]{1,190})"/.exec(text)?.[1] ?? ""); };
    // A stream that goes quiet for streamIdleMs is cut: its reservation is settled instead of held for minutes. Armed from the
    // first read, so a stream that stalls before its first event is cut too.
    let idle: NodeJS.Timeout | undefined;
    const poke = () => { clearTimeout(idle); idle = setTimeout(() => attempt.abort(new Error("the answer's stream went quiet")), streamIdleMs); };
    // A stream is read up to its first output event before any byte reaches the caller (comments such as OpenRouter's
    // keep-alives and the OPENING events held back too), so an answer that failed before any output can be re-run: its chunks
    // and text (replayed to the caller) and its failure, if it failed. Bounded: past firstEventMs (well inside the idle cut) or
    // PEEK_BYTES beyond what the opening events take (each echoes the request: its instructions and tools) it stops looking
    // (`pending`: the read in flight) and the stream is passed through.
    type Peeked = { chunks: Uint8Array[]; text: string; failed?: { reason: string; transient: boolean }; pending?: Promise<ReadableStreamReadResult<Uint8Array>> };
    const peek = async (rd: ReadableStreamDefaultReader<Uint8Array>): Promise<Peeked> => {
      const chunks: Uint8Array[] = [], dec = new TextDecoder();
      let text = "", buf = "", timer: NodeJS.Timeout | undefined;
      const firstEventMs = Math.min(FIRST_EVENT_MS, streamIdleMs / 4);
      const late = new Promise<"late">((ok) => { timer = setTimeout(() => ok("late"), firstEventMs); });
      try {
        for (poke(); ; ) {
          const read = rd.read();
          // A cut (or the idle cut) while looking is passed through like a late first output: the stream loop settles it.
          const got = await Promise.race([read, late]).catch(() => "late" as const);
          if (got === "late") return { chunks, text, pending: read };
          if (got.done) {
            const d = eventData(buf); // a last event without its blank line
            return { chunks, text, failed: (d && streamError(d)) || (d && d !== "[DONE]" && !opening(d) ? undefined : NO_OUTPUT) };
          }
          poke();
          chunks.push(got.value);
          const s = dec.decode(got.value, { stream: true });
          text += s;
          const events = (buf + s).split(/\r?\n\r?\n/);
          buf = events.pop()!;
          for (const ev of events) {
            const d = eventData(ev);
            if (d === "[DONE]") return { chunks, text, failed: NO_OUTPUT };
            const failed = d ? streamError(d) : undefined;
            if (failed || (d && !opening(d))) return { chunks, text, failed };
          }
          if (text.length > PEEK_BYTES + 4 * raw.length) return { chunks, text };
        }
      } finally { clearTimeout(timer); }
    };
    try {
      // A transient refusal (rate limit, "high demand" 502, a reset) is retried with backoff before any byte reaches the caller;
      // an answer that failed before any output (incomplete, nothing sent yet) once, when its error is transient.
      let rerun = false;
      for (let n = 0; ; n++) {
        let err: unknown;
        up = undefined as unknown as Response;
        reader = undefined;
        peeked = undefined;
        try {
          up = await post();
          reader = up.body?.getReader();
          if (up.ok && reader && isSse(up)) peeked = await peek(reader);
        } catch (e) { err = e; }
        clearTimeout(idle);
        const failed = peeked?.failed;
        const transient = err ? !["ECONNREFUSED", "ENOTFOUND"].includes(String(((err as Error).cause as { code?: string } | undefined)?.code)) : failed ? failed.transient && !rerun : RETRY_STATUS.has(up.status);
        if (!transient || n >= retryDelaysMs.length) { if (err) throw err; break; }
        if (failed) {
          // The re-run is cap-checked like any call (refused: this attempt goes to the caller and settles on the call's own
          // row); the discarded attempt keeps its own free `stream_error` row.
          const held = `gw:${randomUUID()}`;
          if ("over" in reserve(who, now(), held, body.model, 0, 0, 1)) break;
          rerun = true;
          q.settle.run(held, new Date(now()).toISOString(), String(body.model).slice(0, 120), 0, 0, 0, 0, now() - t0, "stream_error", held);
        }
        const after = Number(up?.headers.get("retry-after"));
        const wait = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : retryDelaysMs[n]! * (0.75 + Math.random() / 2), 20_000);
        log("upstream retry", { model: body.model, attempt: n + 1, ...(failed ? { stream_error: failed.reason } : { status: up?.status ?? String((err as Error).message).slice(0, 100) }), wait_ms: Math.round(wait) });
        await reader?.cancel().catch(() => {});
        await new Promise((r) => setTimeout(r, wait));
      }
    } catch (e) {
      // Refused before the request left (nothing reached OpenRouter): free. Any other failure may have been billed.
      settle("upstream_error", undefined, ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(String(((e as Error).cause as { code?: string } | undefined)?.code)));
      throw fail(502, "upstream_error", `OpenRouter unreachable (${(e as Error).message})`);
    }
    // The generation id is a cut-off call's handle (an Anthropic-format answer's own id is a `msg_` one: the header names it).
    if ((gen = genOf(up, peeked?.text ?? ""))) q.gen.run(gen, id);
    const sse = isSse(up);
    const tap = usageTap(sse);
    const text = new TextDecoder();
    const rd = reader, head = peeked?.chunks ?? [], pending = peeked?.pending;
    // The answer's chunks: the peeked ones, then the rest. Leaving early (a throw below) cancels the upstream body.
    const chunks = async function* () {
      let ended = !rd;
      try {
        yield* head;
        if (pending) { const x = await pending; if (x.done) return void (ended = true); yield x.value; }
        while (!ended) { const x = await rd!.read(); if (x.done) return void (ended = true); yield x.value; }
      } finally { if (!ended) await rd!.cancel().catch(() => {}); }
    };
    // Read to the end even if the caller hung up, so what OpenRouter billed still lands in the ledger.
    let status = "upstream_aborted";
    try {
      res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k))));
      if (sse) poke();
      for await (const c of chunks()) {
        if (sse) poke();
        if (!res.destroyed) res.write(c);
        const s = text.decode(c, { stream: true });
        tap.feed(s);
        if (!gen && (gen = /"id"\s*:\s*"(gen-[\w-]{1,190})"/.exec(s)?.[1] ?? "")) q.gen.run(gen, id);
      }
      status = up.ok ? "ok" : `upstream_${up.status}`;
    } finally {
      clearTimeout(idle);
      const u = tap.done();
      const failed = status === "ok" && sse ? tap.failure() : undefined;
      if (failed) {
        log("upstream stream error", { model: body.model, gen, reason: failed });
        settle("stream_error", u && { ...u, costUsd: 0 }, true);
      } else settle(status, u, !up.ok && !sse && status !== "upstream_aborted"); // free: a definite error answer, no stream started
    }
    if (!res.destroyed) res.end();
  }

  function boardKeyed(req: IncomingMessage) {
    if (!same(bearer(req), secret("gateway_board_key"))) throw fail(401, "unauthorized", "unauthorized");
  }

  let refusals = { minute: 0, n: 0 };
  /** Whether a CI listener refusal may still be logged this minute (a flood of junk must not flood the journal). */
  function ciRefusalLogged() {
    const minute = Math.floor(now() / 60_000);
    if (refusals.minute !== minute) refusals = { minute, n: 0 };
    return ++refusals.n <= CI_REFUSALS_LOGGED;
  }

  /**
   * Prometheus text for the monitoring module (gateway.ts writes it as a node-exporter textfile; no route): today's spend and
   * cap per agent, cap refusals, CI review spend and cap, calls in flight. Labels are agent keys, never ids or secrets.
   */
  function metricsText() {
    const today = day(now());
    const keyOf = (id: string | null) => (id ? String(grants()[id]?.key ?? "unknown") : "none");
    const esc = (v: unknown) => String(v).replace(/["\\\n]/g, "_");
    const out: string[] = [];
    const metric = (name: string, help: string, rows: [Record<string, unknown>, number][]) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const [labels, v] of rows) out.push(`${name}${Object.keys(labels).length ? `{${Object.entries(labels).map(([k, x]) => `${k}="${esc(x)}"`).join(",")}}` : ""} ${Math.round(v * 1e4) / 1e4}`);
    };
    const spend = db.prepare("SELECT agent_id, kind, COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE day = ? AND status NOT IN ('cap_reached', 'reserved') GROUP BY agent_id, kind").all(today) as { agent_id: string | null; kind: string; s: number }[];
    metric("aidenhq_gateway_spend_usd_today", "Billed model spend since 00:00 UTC, by agent key and call kind.", spend.map((r) => [{ agent: keyOf(r.agent_id), kind: r.kind }, r.s]));
    const agents = [...new Set(spend.filter((r) => r.agent_id && !SYSTEM[r.kind] && r.kind !== CI_KIND).map((r) => r.agent_id!))];
    metric("aidenhq_gateway_agent_day_spend_usd", "An agent's spend counted against its agent-day cap, since 00:00 UTC.", agents.map((id) => [{ agent: keyOf(id) }, (q.spentDay.get(id, today) as Sum).s]));
    metric("aidenhq_gateway_agent_day_cap_usd", "An agent's agent-day cap in force today.", agents.map((id) => [{ agent: keyOf(id) }, capOf({ agentId: id }, "day", today)]));
    const refused = db.prepare("SELECT agent_id, kind, COUNT(*) AS n FROM calls WHERE day = ? AND status = 'cap_reached' GROUP BY agent_id, kind").all(today) as { agent_id: string | null; kind: string; n: number }[];
    metric("aidenhq_gateway_cap_refusals_today", "Runs or CI reviews refused over a spend cap since 00:00 UTC (one per run, scope and cap).", refused.map((r) => [{ agent: keyOf(r.agent_id), kind: r.kind }, r.n]));
    const ci = ciConf();
    metric("aidenhq_gateway_ci_spend_usd_today", "App CI code review spend since 00:00 UTC.", [[{}, (q.ciSpent.get(today) as Sum).s]]);
    metric("aidenhq_gateway_ci_day_cap_usd", "App CI code review's all-repos day cap (0: CI review off).", [[{}, ci ? Number(ci.day_usd) || 0 : 0]]);
    metric("aidenhq_gateway_inflight", "Model calls in flight.", [[{}, (q.inflight.get() as { n: number }).n]]);
    return out.join("\n") + "\n";
  }

  /** `ci`: the request came in on the CI listener (gateway.ts), which serves the CI routes only. */
  async function handle(req: IncomingMessage, res: ServerResponse, { ci = false } = {}) {
    try {
      const path = String(req.url ?? "").split("?")[0]!;
      if (req.method === "GET" && path === "/health") return send(res, 200, ci ? { ok: true } : { ok: true, inflight: (q.inflight.get() as { n: number }).n });
      if (ci) {
        if (req.method === "POST" && path === "/ci/token") return await ciToken(req, res);
        const m = /^\/api\/v1\/(chat\/completions|responses)$/.exec(path);
        if (req.method === "POST" && m) return await model(req, res, "agent", m[1]!, true);
        return send(res, 404, { error: { code: 404, type: "not_found", message: "no such route" } });
      }
      const m = ROUTE.exec(path);
      if (req.method === "POST" && m) return await model(req, res, m[1] ?? "agent", m[2]!);
      if (req.method === "POST" && path === "/usage") {
        boardKeyed(req);
        const { since } = JSON.parse((await readBody(req)) || "{}") as { since?: unknown };
        const records = (q.since.all(String(since ?? "")) as CallRow[]).map((r) => ({ key: r.key, at: r.at, agentId: r.agent_id, component: r.component, model: r.model, input: r.input, cached: r.cached, output: r.output, costUsd: r.cost_usd, runKey: r.run_key, runId: r.run_id, issueId: r.issue_id, rev: r.rev, kind: r.kind, ms: r.ms, status: r.status, ...(r.kind === CI_KIND ? { subject: r.task_subject } : {}) }));
        return send(res, 200, { records });
      }
      if (req.method === "GET" && path === "/v1/spend/summary") {
        // Today's spend (settled and in flight) against the caps in force, the owner's raises included: the install's, and each
        // agent's day (every granted agent, and any other that spent today), nearest its cap first.
        boardKeyed(req);
        const today = day(now()), [inst] = installScope(today), usd = (n: number) => Math.round(n * 1e4) / 1e4;
        const ids = new Set([...Object.keys(grants()), ...(q.spenders.all(today) as { agent_id: string }[]).map((r) => r.agent_id)]);
        const agents = [...ids].map((agent_id) => ({ agent_id, spent: usd(daySpent(agent_id, today)), cap: capOf({ agentId: agent_id }, "day", today) }));
        return send(res, 200, { day: today, install: { spent: usd((q.spentAll.get(today) as Sum).s), cap: inst?.cap ?? null }, agents: agents.sort((a, b) => (b.cap > 0 ? b.spent / b.cap : 0) - (a.cap > 0 ? a.spent / a.cap : 0)) });
      }
      if (req.method === "POST" && path === "/internal/caps") {
        boardKeyed(req);
        const b = JSON.parse((await readBody(req)) || "{}") as { scope: string; agentId: string; subject: string; cap: number }; // checked next
        if (!["run", "task", "day"].includes(b.scope) || typeof b.agentId !== "string" || !b.agentId || !/^[\w:.-]{1,128}$/.test(String(b.subject)) || !(b.cap > 0 && b.cap <= 1000)) throw fail(400, "bad_request", "send {scope: run|task|day, agentId, subject, cap (USD, 0-1000]}");
        q.setCap.run(b.scope, b.agentId, b.subject, b.cap, new Date(now()).toISOString());
        log("cap set", { scope: b.scope, agent: b.agentId, subject: b.subject, cap: b.cap });
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: { code: 404, type: "not_found", message: "no such route" } });
    } catch (err) {
      const e = err as GatewayError;
      const status = e.status ?? 500;
      if ((status >= 500 || status === 401) && (!ci || ciRefusalLogged())) log("refused", { url: req.url, status, err: String(e.message).slice(0, 300) });
      if (!res.headersSent) send(res, status, { error: { code: status, type: e.type ?? "error", message: e.message, ...(e.extra ?? {}) } });
      else res.destroy();
    }
  }

  /** An approved raise_cap: the cap for that scope and subject becomes `cap`. */
  const setCap = (scope: string, agentId: string, subject: string, cap: number) => {
    q.setCap.run(scope, agentId, subject, cap, new Date(now()).toISOString());
    log("cap set", { scope, agent: agentId, subject, cap });
  };
  /** The caps a new job of this agent on this task would start over (admission.ts): its task, its day and the install's. */
  const exhausted = (agentId: string, task: string) =>
    capScopes({ runKey: "admission", agentId, issueId: task, perpetual: false, capped: true } as unknown as Caller, now()).filter((o) => o.scope !== "run" && o.cap > 0 && o.spent >= o.cap);
  /** What a credential has spent so far (settled and in flight), by its run key: a check token's whole run. */
  /** What a run key (a credential's sha256) has spent; spentBy: the same, by the credential. */
  const spentByKey = (runKey: string) => (q.spentRun.get(runKey) as Sum).s;
  const spentBy = (cred: string) => spentByKey(sha256(cred));
  /** A run key's tokens (settled calls' input, cached input and output). */
  const tokensByKey = (runKey: string) => ({ ...(q.tokensRun.get(runKey) as { input: number; cached: number; output: number }) });
  return { handle, db, metricsText, setCap, exhausted, trueUp, spentBy, spentByKey, tokensByKey, inflight: () => live, ciEnabled: () => Boolean(ciConf()), close: () => { clearInterval(pruner); clearInterval(trueUps); prices.close(); db.close(); } };
}
