// The model gateway's logic (main.ts wires it to its listeners): who a call is for, the install's spend limit, the pass-through to
// OpenRouter with what it billed tapped from the answer, and the ledger (kernel.db's calls) the board pulls.
//
// Routes (OpenRouter-compatible; the caller's "API key" is its own per-run credential, never the OpenRouter key):
//   POST /api/v1/responses | /api/v1/chat/completions            kind agent (or the service kind its credential fixes)
//   POST /api/v1/messages         Anthropic's format (OpenRouter's Anthropic-compatible endpoint: Claude Code with ANTHROPIC_BASE_URL
//                                 at the gateway's /api), the same limit, reservation and ledger. Only what a reservation prices goes
//                                 on: the body's MESSAGE_FIELDS (a field that buys more, such as speed, service_tier or mcp_servers,
//                                 is dropped), custom tools only (a server tool, billed per use, is refused), anthropic-version and
//                                 the ANTHROPIC_BETAS Claude Code sends. A cut-off call is trued up by OpenRouter's x-generation-id.
//   POST /advisor/api/v1/... | /fanout/api/v1/...                kind advisor | fanout, counted against the caller's run
//   POST /api/v1/embeddings       an embedding call (no output to bound: its input is its price)
//   POST /api/v1/chat/completions  (Bearer gateway_board_key) kind aside: the board's side chat
//   POST /usage {since}           (Bearer gateway_board_key) the ledger since then → {records} (the board's Costs tab)
//   GET /v1/spend/summary         (Bearer gateway_board_key) the install's spend against its limits, as the gateway counts it:
//                                 {day, month, install: {day: {spent, cap}, month: {spent, cap}}, agents: [{agent_id, spent}]}:
//                                 every granted agent and any other that spent today (the board's header and Costs tab)
//   GET /v1/models/catalog        (Bearer gateway_board_key) the text models of OpenRouter's list the gateway already holds, for the
//                                 board's model picker: {models: [{id, name, provider, created, context, in, out, tools, reasoning}]}
//   GET /api/v1/models?ids=a,b    (a job's or check's own credential) the same list for an engine to size its context window from:
//                                 {object: "list", data: [{id, object: "model", context_length, max_completion_tokens}]}; an id the
//                                 list lacks is looked up again first (at most once a minute, as a call's is)
//   GET /health
// CI listener (gateway.ts, the CI runners' bridge address; only these routes, only `ahqci_` credentials, never on the others):
//   POST /ci/token                (Bearer: a GitHub Actions OIDC token, ci.ts) -> {token, expires_at, review}: an opaque CI
//                                 token, the instance's review model and effort (settings.ci_review_model) and the repo's risk tier rules
//   POST /api/v1/chat/completions | /api/v1/responses  kind ci-code-review: the allowed models and fields only (ci.ts),
//                                 attributed to repo and PR; streamed or not, reserved and settled like any call
//   GET /health
// Credentials: a kernel job's token `ahqj_` (token.ts, kind job: its agent on its task while the job lives), a
// system token of the same format (reviewer/grader/source/check), a fast chat lane's turn token (same format, signed with
// gateway_lane_secret, agent kind only), or the source writers' key (gateway_source_key). The run key is the credential's sha256.
// Spend (spec §5.12): one limit for the whole install, on every call of every kind (agents, checks, the reviewer, the grader,
// CI, sources): a UTC day's and a UTC calendar month's real cost (config/gateway.json `install_day_usd` and
// `install_month_usd`, from settings.spend_day_usd and spend_month_usd). A call goes ahead while what is spent is below both
// (so one call can take a limit past it, never two in a row); its output is bounded to what the tighter limit's room buys at
// the model's price on OpenRouter's own models list (prices.ts: the dearest tier it lists; an id it doesn't list is refused),
// never under MIN_OUTPUT, never over the model's ceiling. One transaction checks the limits and writes a `reserved` ledger row
// holding the call's estimated input cost plus its granted output (output price x the bound it got), so calls in flight
// count in full: concurrent calls share one room instead of each buying all of it. Settlement replaces the row's cost with what
// OpenRouter billed (the answer's usage.cost, which it always sends; tokens x list price only if a usage block lacks it). No
// final usage (a stream cut or ended without one, an upstream failure) leaves the estimate; an answer that began without one
// is closed as `unsettled` (a hold, not a bill, for the board) and, with a generation id (`gen`), settled from OpenRouter's
// record of that generation as `interrupted`, at what it billed. A reservation whose kernel died (its `owner`, boot and pid)
// is closed as `unsettled` at that amount (fail closed) and trued up the same way. A restart lets calls in flight finish in
// the old kernel (main.ts drain), so the next kernel never closes a live peer's reservation. Past a limit (settled spend)
// every call is refused, and the owner is told once per limit, period and value (`notifyOwner`); a limit filled only by
// calls in flight answers a retryable 503 (`spend_held`) instead, recording and telling nothing.
// Besides those, one cap per task (config/gateway.json `task_usd`, settings.task_usd): what an agent's calls on one task have
// spent (a chat or routine task's, by the UTC day). Past it that task's calls are refused and whoever asked for the task is
// told once per task and value (`tellDelegator`); nothing is filed for the owner.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { CI_KIND, CI_PREFIX, ciBodyProblem, githubKeys, verifyGithubOidc } from "./ci.ts";
import { createPrices, type Price } from "./prices.ts";
import { MODEL_BODY_MAX, verifyToken } from "./token.ts";

type Brand<T, B extends string> = T & { readonly __brand: B };
/** A run key: the sha256 of the caller's own credential (or the board aside's day key). The ledger keys on it. */
export type RunKey = Brand<string, "RunKey">;
/**
 * Who a model call is for, settled by identify() from the credential alone (a checked token, a stored CI token): only
 * identify() makes one, and nothing in the request body ever feeds it.
 */
export type Caller = Brand<{
  runKey: RunKey; agentId: string | null; runId: string | null; issueId: string | null; perpetual: boolean; rev: string | null;
  kind: string; component: string; ci?: { repo: string; subject: string }; check?: { subject: string };
}, "Caller">;
type GatewayError = Error & { status?: number; type?: string; extra?: Record<string, unknown> };
/** config/grants/grants.json `agents`, by Paperclip id (setup writes it). */
type Grants = Record<string, { rev?: string; key?: string; profile?: string }>;
/** config/gateway.json `ci` (compile writes it from the ci module's settings). */
type CiConf = { orgs?: unknown; models?: unknown; review?: unknown; tiers?: Record<string, unknown> };
/** A run key's settled identity (the runs table), or the same fields resolved for one call. */
type RunRow = { run_key: string; agent_id: string | null; run_id: string | null; issue_id: string | null; rev: string | null; perpetual: number; at: string };
type RunIdentity = Pick<RunRow, "agent_id" | "run_id" | "issue_id" | "rev"> & { perpetual: number | boolean };
type CallRow = {
  key: string; at: string; day: string; run_key: string; run_id: string | null; agent_id: string | null; issue_id: string | null; task_subject: string | null;
  rev: string | null; kind: string; component: string; model: string; input: number; cached: number; output: number; cost_usd: number | null; ms: number | null; status: string;
};
type CiTokenRow = { hash: string; repo: string; pr: number; head: string | null; gh_run: string; attempt: string; exp: string; at: string };
type Sum = { s: number };
type Nano = { n: number };
/** A limit a call counts against: the install's day or month (subject: that day or month), or its task's cap (subject: the task), with what is spent on it. */
type Limit = { scope: "day" | "month" | "task"; subject: string; cap: number; spent: number };
/** What OpenRouter billed for one call. */
type Usage = { key?: string; model: string; input: number; cached: number; output: number; costUsd: number | null };
type UsageBlock = {
  input_tokens?: number; prompt_tokens?: number; output_tokens?: number; completion_tokens?: number; cost?: unknown;
  input_tokens_details?: { cached_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number };
  /** Anthropic's format: input_tokens leaves out cache reads and writes. */
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
};
type Answer = { id?: unknown; model?: unknown; usage?: UsageBlock };
type Log = (msg: string, fields?: Record<string, unknown>) => void;

const SYSTEM: { source: string } & Record<string, string> = { reviewer: "AI reviewer", grader: "Grader", source: "Source writers" };
const ROUTE = /^\/(?:(advisor|fanout)\/)?api\/v1\/(responses|chat\/completions|messages|embeddings)$/;
const MAX_BODY = MODEL_BODY_MAX;
/** The Anthropic-format body fields a call may carry (what Claude Code sends); any other is dropped before it goes upstream. */
const MESSAGE_FIELDS = new Set(["model", "messages", "system", "tools", "tool_choice", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream", "stop_sequences", "temperature", "top_p", "top_k", "provider"]);
/** The anthropic-beta values passed upstream (Claude Code's; none changes the price); any other is dropped. */
const ANTHROPIC_BETAS = new Set(["interleaved-thinking-2025-05-14", "context-management-2025-06-27", "claude-code-20250219", "mid-conversation-tool-changes-2026-07-01", "thinking-token-count-2026-05-13", "effort-2025-11-24", "thinking-display-updates-2026-08-18"]);
const DAY_MS = 864e5;
/** The limits' defaults (kernel/settings.json), for a config/gateway.json that lacks one. */
const SPEND_DEFAULTS = (() => {
  const k = JSON.parse(readFileSync(new URL("../../settings.json", import.meta.url), "utf8")) as Record<string, { default: number }>;
  return { day: k.spend_day_usd!.default, month: k.spend_month_usd!.default, task: k.task_usd!.default };
})();
// The fewest output tokens a call is cut to near a limit (below it a call always goes ahead).
const MIN_OUTPUT = 1024;
// The most ledger rows one /usage answer carries; a full one names the next page (`next`).
const USAGE_PAGE = 20_000;
// CI: a token lives 2 h (the job's timeout is 90 min); a repo gets at most 200 a day.
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
const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);
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

/** A held call: in flight (`reserved`) or cut off (`unsettled`). Queries on held rows name this verbatim, so the planner uses calls_held. */
const HELD = "status IN ('reserved', 'unsettled')";
/** A row's cost in whole nano-dollars: totals add and subtract integers, so they never drift and meet a cap exactly. */
const NANO = (r: "NEW" | "OLD" | "") => `CAST(ROUND(COALESCE(${r ? `${r}.` : ""}cost_usd, 0) * 1e9) AS INTEGER)`;
/** A row's billed share (what the metrics count as spend): not a hold, not a refusal. */
const BILLED = (r: "NEW" | "OLD" | "") => `CASE WHEN ${r ? `${r}.` : ""}status NOT IN ('reserved', 'unsettled', 'cap_reached') THEN ${NANO(r)} ELSE 0 END`;
const REFUSED = (r: "NEW" | "OLD" | "") => `CASE WHEN ${r ? `${r}.` : ""}status = 'cap_reached' THEN 1 ELSE 0 END`;
const addDay = (r: "NEW" | "OLD") => `INSERT INTO spend_day (day, agent, kind, n, nano, billed, refused) VALUES (${r}.day, COALESCE(${r}.agent_id, ''), ${r}.kind, 1, ${NANO(r)}, ${BILLED(r)}, ${REFUSED(r)})
  ON CONFLICT (day, agent, kind) DO UPDATE SET n = n + 1, nano = nano + excluded.nano, billed = billed + excluded.billed, refused = refused + excluded.refused;`;
const addTask = (r: "NEW" | "OLD") => `INSERT INTO spend_task (subject, n, nano) SELECT ${r}.task_subject, 1, ${NANO(r)} WHERE ${r}.agent_id IS NOT NULL AND ${r}.task_subject IS NOT NULL
  ON CONFLICT (subject) DO UPDATE SET n = n + 1, nano = nano + excluded.nano;`;
// A row leaving a total is a plain update (never an upsert, so a late prune can't recreate a total), and a total with no row left goes.
const subDay = `UPDATE spend_day SET n = n - 1, nano = nano - ${NANO("OLD")}, billed = billed - ${BILLED("OLD")}, refused = refused - ${REFUSED("OLD")} WHERE day = OLD.day AND agent = COALESCE(OLD.agent_id, '') AND kind = OLD.kind;
  DELETE FROM spend_day WHERE day = OLD.day AND agent = COALESCE(OLD.agent_id, '') AND kind = OLD.kind AND n = 0;`;
const subTask = `UPDATE spend_task SET n = n - 1, nano = nano - ${NANO("OLD")} WHERE subject = OLD.task_subject AND OLD.agent_id IS NOT NULL;
  DELETE FROM spend_task WHERE subject = OLD.task_subject AND n = 0;`;

/** The ledger's tables in kernel.db; `legacy` (the gateway's old data/gateway/usage.db) is merged in first (moveLedger). */
export function openLedger(file: string, legacy?: string): { db: DatabaseSync; moved: number } {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  // This connection's own tuning. synchronous FULL: an acknowledged reservation, settle or CI token survives a power loss. Its
  // page cache is 16 MB of the kernel's heap; the mmap window maps the OS page cache every handle on the file shares, so it
  // costs no extra memory per handle.
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA cache_size = -16384;
    PRAGMA mmap_size = 268435456; PRAGMA temp_store = MEMORY; PRAGMA journal_size_limit = 67108864;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (key TEXT PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, run_key TEXT NOT NULL, run_id TEXT, agent_id TEXT,
      issue_id TEXT, task_subject TEXT, rev TEXT, kind TEXT NOT NULL, component TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cost_usd REAL, ms INTEGER, status TEXT NOT NULL);
    -- Who a run key is: settled at its first call (a gateway restart or the JWT's expiry never re-derives it), with its rev.
    CREATE TABLE IF NOT EXISTS runs (run_key TEXT PRIMARY KEY, agent_id TEXT, run_id TEXT, issue_id TEXT, rev TEXT, perpetual INTEGER NOT NULL, at TEXT NOT NULL);
    -- A limit's notice sent: one per limit (scope), period or task (subject) and value; agent_id 'install', or the task's agent.
    CREATE TABLE IF NOT EXISTS filed (scope TEXT NOT NULL, agent_id TEXT NOT NULL, subject TEXT NOT NULL, cap REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY (scope, agent_id, subject, cap));
    -- CI tokens issued (POST /ci/token): only the token's sha256, the repo, PR and run attempt GitHub's OIDC token named, the
    -- head the job sent (advisory) and when it expires. Deleting a row revokes that token. One per run attempt, enforced
    -- here, so a replayed OIDC token gets nothing, across restarts too (a re-run is a new attempt).
    CREATE TABLE IF NOT EXISTS ci_tokens (hash TEXT PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL, head TEXT, gh_run TEXT NOT NULL, attempt TEXT NOT NULL,
      exp TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (repo, gh_run, attempt));
    -- A model's rate-limit cooldown, shared by every kernel on the file (a draining one too): no new call to it before \`until\`
    -- (ms); \`step\` is the backoff ladder's rung.
    CREATE TABLE IF NOT EXISTS model_cooldown (model TEXT PRIMARY KEY, until INTEGER NOT NULL, step INTEGER NOT NULL);
  `);
  // A call's kernel process (`<boot id>:<pid>`), OpenRouter's generation id (the true-up's handle on a cut-off call) and when a
  // true-up changed it (`changed`: the board's pull reads it; `at` stays the call's time).
  const have = new Set((db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map((c) => c.name));
  for (const c of ["owner", "gen", "changed"]) if (!have.has(c)) db.exec(`ALTER TABLE calls ADD COLUMN ${c} TEXT`);
  // The indexes a query reads: a run key's calls (spentRun, tokensRun, refusedRun), the prune and work.ts's window (at), the
  // board's pull, a job's calls (jobs.ts at its end), and the held rows (sweep, inflight, true-ups, holds). Totals come from
  // spend_day and spend_task below, so no index serves a day or a task.
  db.exec(`
    CREATE INDEX IF NOT EXISTS calls_run ON calls (run_key);
    CREATE INDEX IF NOT EXISTS calls_issue ON calls (issue_id) WHERE issue_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS calls_at ON calls (at);
    DROP INDEX IF EXISTS calls_changed; CREATE INDEX IF NOT EXISTS calls_pull ON calls (COALESCE(changed, at), key);
    CREATE INDEX IF NOT EXISTS calls_job ON calls (run_id) WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS calls_held ON calls (status, task_subject) WHERE ${HELD};
    DROP INDEX IF EXISTS calls_task; DROP INDEX IF EXISTS calls_subject; DROP INDEX IF EXISTS calls_day; DROP INDEX IF EXISTS calls_all_day; DROP INDEX IF EXISTS calls_status;
  `);
  // calls_final and calls_open belonged to the month counters this replaced: gone once the kernel that read them had drained.
  db.exec(`DROP TRIGGER IF EXISTS calls_final_add; DROP TRIGGER IF EXISTS calls_final_set; DROP INDEX IF EXISTS calls_open; DROP TABLE IF EXISTS calls_final;`);
  spendTotals(db);
  return { db, moved: moveLedger(db, legacy) };
}

/**
 * The spend totals, kept by the database for every connection and process (a draining peer kernel's too, whatever code it
 * runs): per UTC day (the call's start day), agent ('' for none) and kind, every call's cost (`nano`), its billed part and
 * its refusals; and per task subject, an agent's calls only. Integer nano-dollars, NEW − OLD on every insert, update and
 * delete (the prune included), with a row count so a total with no call left goes. Made and filled from the ledger once,
 * in one write transaction with its triggers, so no call is counted twice or missed.
 */
function spendTotals(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spend_task'").get()) {
      db.exec(`
        CREATE TABLE spend_day (day TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, nano INTEGER NOT NULL,
          billed INTEGER NOT NULL, refused INTEGER NOT NULL, PRIMARY KEY (day, agent, kind));
        CREATE TABLE spend_task (subject TEXT PRIMARY KEY, n INTEGER NOT NULL, nano INTEGER NOT NULL);
        INSERT INTO spend_day SELECT day, COALESCE(agent_id, ''), kind, COUNT(*), SUM(${NANO("")}), SUM(${BILLED("")}),
          SUM(${REFUSED("")}) FROM calls GROUP BY 1, 2, 3;
        INSERT INTO spend_task SELECT task_subject, COUNT(*), SUM(${NANO("")}) FROM calls WHERE agent_id IS NOT NULL AND task_subject IS NOT NULL GROUP BY 1;
        CREATE TRIGGER spend_add AFTER INSERT ON calls BEGIN ${addDay("NEW")} ${addTask("NEW")} END;
        CREATE TRIGGER spend_del AFTER DELETE ON calls BEGIN ${subDay} ${subTask} END;
        CREATE TRIGGER spend_set AFTER UPDATE OF cost_usd, status, day, agent_id, kind, task_subject ON calls BEGIN ${subDay} ${subTask} ${addDay("NEW")} ${addTask("NEW")} END;
      `);
    }
    db.exec("COMMIT");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Spend from the totals (spendTotals), in USD: `spent` is every call's cost, holds included; `settled` leaves out the holds
 * that may still shrink, read at decision time from the held rows (calls_held), since a hold ages out of the true-up window
 * with no write: calls in flight (`reserved`) and cut-off ones a true-up may still settle (`unsettled` with a generation id,
 * closed at or after `open`). task: an agent's calls on one task subject, whoever held it (a hand-off or a re-route keeps what
 * it spent). days: the install's from `from` to `to` (one day, or a month: at most 31 days of rows).
 */
export function spendOf(db: DatabaseSync) {
  const q = {
    task: db.prepare("SELECT COALESCE(SUM(nano), 0) AS n FROM spend_task WHERE subject = ?"),
    days: db.prepare("SELECT COALESCE(SUM(nano), 0) AS n FROM spend_day WHERE day >= ? AND day <= ?"),
    heldTask: db.prepare(`SELECT COALESCE(SUM(${NANO("")}), 0) AS n FROM calls WHERE ${HELD} AND task_subject = ? AND agent_id IS NOT NULL AND (status = 'reserved' OR (gen IS NOT NULL AND at >= ?))`),
    heldDays: db.prepare(`SELECT COALESCE(SUM(${NANO("")}), 0) AS n FROM calls WHERE ${HELD} AND day >= ? AND day <= ? AND (status = 'reserved' OR (gen IS NOT NULL AND at >= ?))`),
  };
  const n = (s: StatementSync, ...a: string[]) => (s.get(...a) as Nano).n;
  const of = (total: number, held: number) => ({ spent: total / 1e9, settled: (total - held) / 1e9 });
  return {
    task: (subject: string, open: string) => of(n(q.task, subject), n(q.heldTask, subject, open)),
    days: (from: string, to: string, open: string) => of(n(q.days, from, to), n(q.heldDays, from, to, open)),
  };
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
    for (const t of ["calls", "runs", "filed", "ci_tokens"]) if (has.has(t)) n += Number(db.prepare(`INSERT OR IGNORE INTO main.${t} (${cols(t)}) SELECT ${cols(t)} FROM legacy.${t}`).run().changes);
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

/** An SSE `data:` line that ends an answer: a chat chunk's finish_reason (but `error`), a response's completion, Anthropic's message_stop.
 * The pattern is only a cheap filter: the parsed top-level fields decide (an echoed schema may contain the same words). */
const FINISHED = /"finish_reason"\s*:\s*"(?!error")[^"]+"|"type"\s*:\s*"(?:response\.completed|response\.incomplete|message_stop)"/;
function finishes(data: string): boolean {
  if (!FINISHED.test(data)) return false;
  try {
    const j = JSON.parse(data) as { type?: unknown; choices?: { finish_reason?: unknown }[] } | null;
    return ["response.completed", "response.incomplete", "message_stop"].includes(String(j?.type)) || (Array.isArray(j?.choices) && j.choices.some((c) => typeof c?.finish_reason === "string" && c.finish_reason !== "error"));
  } catch { return false; }
}
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
 * → why an answer that has no final usage failed: its first error event's reason (`inBand`), else its last event's type
 * (a finish event without final usage included: what it billed is unknown); undefined for an answer with final usage. `[DONE]` is only the transport's end, never a finish.
 * Never model text: the reason is safe to log.
 */
export function usageTap(sse: boolean): { feed(text: string): void; done(): Usage | undefined; failure(): { reason: string; inBand: boolean } | undefined } {
  let tail = "", body = "", event: string[] = [], held = 0, last = "none", error: string | undefined, finished = false, final = false, found: (Answer & { usage: UsageBlock }) | undefined;
  const line = (data: string) => {
    if (data !== "[DONE]") last = eventType(data) ?? "chunk";
    const err = streamError(data);
    if (err) error ??= `error event: ${err.reason}`;
    else if (finishes(data)) finished = true;
    // Completed usage stays authoritative; an error event's usage is kept for billing only when the answer had none, and never counts as completion.
    if (err && final) return;
    const was = final;
    take(data);
    if (err) final = was;
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
      // A whole JSON body is the answer itself, so its usage counts without an id (an embedding's may carry none).
      if (r?.usage && (typeof r.id === "string" || !sse)) { found = r as Answer & { usage: UsageBlock }; final = j?.type !== "message_start"; }
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
      if (final) return undefined;
      return { reason: error ?? (finished ? `a finish without final usage; last event: ${last}` : `no usage or finish; last event: ${last}`), inBand: error !== undefined };
    },
    done() {
      if (sse) { field(tail); field(""); tail = ""; } else take(body);
      if (!found) return undefined;
      const u = found.usage;
      const anthropic = u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined;
      const cached = (anthropic ? u.cache_read_input_tokens : u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens) ?? 0;
      const input = (u.input_tokens ?? u.prompt_tokens ?? 0) + (anthropic ? cached + (u.cache_creation_input_tokens ?? 0) : 0);
      return {
        key: typeof found.id === "string" ? found.id.slice(0, 200) : undefined, // none: the call's own ledger key
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
/** An in-band error reason (streamError) that is a rate limit. */
const RATE_LIMITED = /^(?:429|rate_limit_error|rate_limit_exceeded)$|error event: (?:429|rate_limit_error|rate_limit_exceeded)$/;
/** The longest a model's cooldown runs from one rate limit, and the longest a new call waits one out. */
const COOLDOWN_MAX_MS = 60_000;
/** A Retry-After header in ms from `t`: delay-seconds or an HTTP-date; undefined when absent, unreadable or not in the future. */
const retryAfterMs = (h: string | null, t: number): number | undefined => {
  if (!h) return undefined;
  const ms = /^\s*\d+(?:\.\d+)?\s*$/.test(h) ? Number(h) * 1000 : Date.parse(h) - t;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
};
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
export function createGateway({ dbFile, legacyDbFile, grantsFile, settingsFile, asCaller, secret, upstream = "https://openrouter.ai/api/v1", modelsUrl = `${upstream}/models`, embeddingModelsUrl = `${upstream}/embeddings/models`, priceRetryMs, paperclipUrl, notifyOwner, tellDelegator, githubJwksUrl, appLogin = () => undefined, jobLive = () => false, jobProfile = () => undefined, log = () => {}, now = Date.now, retryDelaysMs = RETRY_DELAYS_MS, cooldownMs = retryDelaysMs, streamIdleMs = 120_000, taskRetryMs = [500, 2_000] }: {
  /** Whether a kernel job (a job token's id) is still admitted or running: an ended job's token buys nothing. */
  jobLive?: (id: string) => boolean;
  /** A job's profile as frozen at its admission (its row's), never its agent's current grants. */
  jobProfile?: (id: string) => string | null | undefined;
  /** This instance's own GitHub App's bot login (`<slug>[bot]`), whose PRs the CI tier rules count as a member's. */
  appLogin?: () => string | undefined;
  dbFile: string; legacyDbFile?: string; grantsFile: string; settingsFile: string;
  /** A module's model call for the agent whose tool call it serves (module token + caller assertion): that caller's own credential. */
  asCaller?: (req: IncomingMessage) => Promise<string | undefined>; secret: (name: string) => string; upstream?: string; paperclipUrl?: string;
  /** OpenRouter's public models list (prices.ts), and the waits between its fetches on a cold start. */
  modelsUrl?: string; embeddingModelsUrl?: string; priceRetryMs?: number[];
  githubJwksUrl?: string; log?: Log; now?: () => number;
  /** Waits between attempts at a transient OpenRouter failure (tests pass zeros). */
  retryDelaysMs?: number[];
  /** A rate-limited model's cooldown ladder without Retry-After (cool): the retry waits by default. */
  cooldownMs?: number[];
  /** How long an answer's stream may go quiet before it is cut (OpenRouter sends keep-alives while a model thinks). */
  streamIdleMs?: number;
  /** Waits between tries of a job's task read when the control plane doesn't answer. */
  taskRetryMs?: number[];
  /** Tells the owner a limit was reached (main.ts: notify, no model call); once per limit, period and value. */
  notifyOwner?: (text: string) => Promise<void> | void;
  /** Tells whoever asked for a task (its parent's holder, else the owner) that the task's spend cap stopped it. */
  tellDelegator?: (task: string, text: string) => Promise<void>;
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
    for (const { owner } of db.prepare(`SELECT DISTINCT owner FROM calls WHERE ${HELD} AND status = 'reserved'`).all() as { owner: string | null }[]) {
      if (owner === me ? !start : alive(owner)) continue;
      db.prepare(`UPDATE calls SET status = 'unsettled', at = ? WHERE ${HELD} AND status = 'reserved' AND owner IS ?`).run(new Date(now()).toISOString(), owner);
    }
  };
  sweep(true);
  const grants = watched(grantsFile, (j) => (j.agents ?? {}) as Grants, {});
  const prices = createPrices({ url: modelsUrl, now, log, ...(priceRetryMs ? { retryMs: priceRetryMs } : {}) });
  // Embedding models are listed apart (OpenRouter's /embeddings/models): their own catalog, read only by embedding calls.
  const embeddingPrices = createPrices({ url: embeddingModelsUrl, now, log, ...(priceRetryMs ? { retryMs: priceRetryMs } : {}) });
  // CI code review (compile writes it from the ci module's settings): { orgs, models, review } or null.
  const ciConf = watched<CiConf | null>(settingsFile, (j) => (j.ci && typeof j.ci === "object" ? (j.ci as CiConf) : null), null);
  // The limits (settings.spend_day_usd, spend_month_usd, task_usd; compile writes all three). One missing or unreadable is its
  // kernel default (kernel/settings.json), never no limit.
  const usd = (v: unknown, d: number) => (Number(v) > 0 ? Number(v) : d);
  const limitsSet = watched(settingsFile, (j) => ({ day: usd(j.install_day_usd, SPEND_DEFAULTS.day), month: usd(j.install_month_usd, SPEND_DEFAULTS.month), task: usd(j.task_usd, SPEND_DEFAULTS.task) }), SPEND_DEFAULTS);
  const keyFor = githubKeys(githubJwksUrl, now);
  const q = {
    run: db.prepare("SELECT * FROM runs WHERE run_key = ?"),
    addRun: db.prepare("INSERT OR IGNORE INTO runs (run_key, agent_id, run_id, issue_id, rev, perpetual, at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    add: db.prepare("INSERT OR IGNORE INTO calls (key, at, day, run_key, run_id, agent_id, issue_id, task_subject, rev, kind, component, model, input, cached, output, cost_usd, ms, status, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    spentRun: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE run_key = ?"),
    tokensRun: db.prepare("SELECT COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached, COALESCE(SUM(output), 0) AS output FROM calls WHERE run_key = ?"),
    // Each agent's spend on a day (the totals, nano-dollars). And one call's hold.
    agentsDay: db.prepare("SELECT agent, SUM(nano) AS n FROM spend_day WHERE day = ? AND agent != '' GROUP BY agent"),
    holdOf: db.prepare("SELECT cost_usd AS s FROM calls WHERE key = ? AND status = 'reserved'"),
    rehold: db.prepare("UPDATE calls SET cost_usd = ? WHERE key = ? AND status = 'reserved'"),
    file: db.prepare("INSERT OR IGNORE INTO filed (scope, agent_id, subject, cap, at) VALUES (?, ?, ?, ?, ?)"),
    unfile: db.prepare("DELETE FROM filed WHERE scope = ? AND agent_id = ? AND subject = ? AND cap = ?"),
    // A row changes after its call ends only by a true-up (`changed`), which keeps the call's own time (`at`).
    // In (time, key) order, from after a cursor: a page boundary never splits or repeats rows of one time.
    since: db.prepare(`SELECT * FROM calls WHERE COALESCE(changed, at) >= ?1 AND (COALESCE(changed, at), key) > (?1, ?2) AND status != 'reserved' ORDER BY COALESCE(changed, at), key LIMIT ${USAGE_PAGE}`),
    // The generation id rides along (a non-streamed answer's, a discarded attempt's): one write per call, not two.
    settle: db.prepare("UPDATE calls SET key = ?, at = ?, model = ?, input = ?, cached = ?, output = ?, cost_usd = ?, ms = ?, status = ?, gen = COALESCE(?, gen) WHERE key = ? AND status = 'reserved'"),
    inflight: db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE ${HELD} AND status = 'reserved'`),
    gen: db.prepare("UPDATE calls SET gen = ? WHERE key = ? AND status = 'reserved'"),
    cutOff: db.prepare(`SELECT key, gen FROM calls WHERE ${HELD} AND status = 'unsettled' AND gen IS NOT NULL AND at >= ? LIMIT 100`),
    trueUp: db.prepare("UPDATE calls SET status = 'interrupted', changed = ?, model = ?, input = ?, cached = ?, output = ?, cost_usd = ? WHERE key = ? AND status = 'unsettled'"),
    ciToken: db.prepare("SELECT * FROM ci_tokens WHERE hash = ?"),
    addCiToken: db.prepare("INSERT OR IGNORE INTO ci_tokens (hash, repo, pr, head, gh_run, attempt, exp, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    ciIssued: db.prepare("SELECT COUNT(*) AS n FROM ci_tokens WHERE repo = ? AND substr(at, 1, 10) = ?"),
    ciSpent: db.prepare("SELECT COALESCE(SUM(nano), 0) AS n FROM spend_day WHERE kind = 'ci-code-review' AND day = ?"),
    // Today's billed spend and refusals by agent and kind (the metrics).
    dayRows: db.prepare("SELECT agent, kind, billed, refused FROM spend_day WHERE day = ?"),
    cooldown: db.prepare("SELECT until, step FROM model_cooldown WHERE model = ?"),
    setCooldown: db.prepare("INSERT INTO model_cooldown (model, until, step) VALUES (?, ?, ?) ON CONFLICT (model) DO UPDATE SET until = excluded.until, step = excluded.step"),
    // A cap refusal's ledger row: its key is `cap:<run key>:<scope>:<subject>:<cap>`.
    refusedRun: db.prepare("SELECT key, rowid AS n FROM calls WHERE run_key = ? AND status = 'cap_reached' ORDER BY rowid"),
  };
  const spend = spendOf(db);
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
      // A drain ends the pass: what is left is the next kernel's (its true-ups read the same rows).
      if (stopping.signal.aborted) return;
      try {
        const res = await fetch(`${upstream}/generation?id=${encodeURIComponent(row.gen)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.any([AbortSignal.timeout(15_000), stopping.signal]) });
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
  // One true-up at a time; stop() waits for the one in flight before the ledger closes.
  let truing: Promise<void> | undefined;
  const trueUps = setInterval(() => { truing ??= trueUp().catch((e: Error) => log("true-up failed", { err: String(e?.message ?? e).slice(0, 200) })).finally(() => (truing = undefined)); }, 60_000);
  trueUps.unref();
  let live = 0; // this process's model calls in flight, those waiting out a cooldown included (main.ts drains on them)
  // A drain: calls still waiting out a cooldown are answered (retryable) so the next kernel takes them.
  const stopping = new AbortController();

  /**
   * A rate limit (an HTTP 429, or an in-band rate-limit error) on `model`: no new call to it until the cooldown ends, for
   * every kernel on the file. Retry-After when OpenRouter sends one, else the backoff ladder's rung: the rung climbs when the
   * model is limited again within a minute of its last cooldown ending, holds while one runs, and restarts after a quiet
   * minute. The deadline only ever moves later.
   */
  function cool(model: string, retryAfter: string | null) {
    const t = now(), after = retryAfterMs(retryAfter, t);
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = q.cooldown.get(model) as { until: number; step: number } | undefined;
      const step = !row || row.until <= t - 60_000 ? 0 : row.until > t ? row.step : Math.min(row.step + 1, cooldownMs.length - 1);
      const wait = after ?? cooldownMs[step] ?? 0;
      q.setCooldown.run(model, Math.max(row?.until ?? 0, t + Math.min(wait, COOLDOWN_MAX_MS)), step);
      db.exec("COMMIT");
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      log("cooldown not recorded", { model, err: String((e as Error).message).slice(0, 200) });
    }
  }
  /** Waits out `model`'s cooldown (re-read after each wait: a peer may extend it), at most COOLDOWN_MAX_MS; a caller that hangs
   *  up or a drain ends the wait. → whether it waited (the call then takes a fresh time for its periods). */
  async function cooledDown(model: string, res: ServerResponse): Promise<boolean> {
    const gone = new AbortController();
    const hangUp = () => gone.abort();
    res.once("close", hangUp);
    const signal = AbortSignal.any([gone.signal, stopping.signal]);
    let waited = 0;
    live++;
    try {
      for (;;) {
        const left = ((q.cooldown.get(model) as { until: number } | undefined)?.until ?? 0) - now();
        if (left <= 0) return waited > 0;
        if (waited >= COOLDOWN_MAX_MS) throw fail(429, "rate_limited", `${model} is rate limited upstream; try again shortly`);
        const ms = Math.min(left + Math.random() * 250, 1000, COOLDOWN_MAX_MS - waited); // a second at a time: re-read
        try { await sleep(ms, undefined, { signal }); } catch { throw fail(503, "unavailable", stopping.signal.aborted ? "the gateway is restarting; try again" : "the caller hung up"); }
        waited += ms;
      }
    } finally {
      live--;
      res.off("close", hangUp);
    }
  }

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

  /** Who the call is for: { runKey, agentId, runId, issueId, perpetual, rev, kind, component }. Throws 401 otherwise. */
  async function identify(cred: string, routeKind: string, ci = false): Promise<Caller> {
    if (!cred) throw fail(401, "unauthorized", "no credential: the API key must be this run's own credential");
    const runKey = sha256(cred) as RunKey;
    // The CI listener takes CI tokens only, and CI tokens work nowhere else: no other credential is even looked at there.
    if (ci !== cred.startsWith(CI_PREFIX)) throw fail(401, "unauthorized", ci ? "this address takes CI tokens only (POST /ci/token)" : "not a credential this gateway knows");
    if (ci) {
      ciOn();
      const t = q.ciToken.get(runKey) as CiTokenRow | undefined;
      if (!t || Date.parse(t.exp) <= now()) throw fail(401, "unauthorized", "this CI token is invalid or expired");
      return { runKey, agentId: null, runId: null, issueId: null, perpetual: false, rev: t.head ?? null, kind: CI_KIND, component: CI_KIND, ci: { repo: t.repo, subject: `${t.repo}#${t.pr}` } } as Caller;
    }
    const as = (row: RunIdentity | null | undefined, kind: string, component: string) => ({ runKey, agentId: row?.agent_id ?? null, runId: row?.run_id ?? null, issueId: row?.issue_id ?? null, perpetual: Boolean(row?.perpetual), rev: row?.rev ?? null, kind, component }) as Caller;
    if (same(cred, secret("gateway_source_key"))) return as(null, "source", SYSTEM.source);
    if (same(cred, secret("gateway_board_key"))) {
      // The board's side chat ("ask about this task"): no agent and no task run, so its "run" is the UTC day.
      return { ...as(null, "aside", "Board side chat"), runKey: `board-aside:${day(now())}` as RunKey } as Caller;
    }
    if (cred.startsWith("ahqj_")) {
      // A fast chat lane's turn token (slack-live-mcp) is signed with gateway_lane_secret: an agent's call only, so a holder of
      // the lane secret can never mint a system token.
      const lane = verifyToken(secret("gateway_lane_secret"), cred, now());
      if (lane?.k === "agent" && lane.a) {
        const row = (q.run.get(runKey) as RunRow | undefined) ?? settle(runKey, { agentId: lane.a, issueId: null });
        return as(row, routeKind, `Fast lane: ${String(lane.c ?? lane.a)}`.slice(0, 80));
      }
      const p = verifyToken(secret("gateway_job_secret"), cred, now());
      if (!p) throw fail(401, "unauthorized", "this run's model credential is invalid or expired");
      if (p.k === "job") {
        // A kernel job (boxes.ts): its run is the job, its agent's on its task (a chat or routine task by the day), while the job
        // lives.
        if (!jobLive(String(p.id))) throw fail(401, "unauthorized", "this job has ended");
        let row = q.run.get(runKey) as RunRow | undefined;
        if (!row) {
          const t = await taskOf(p.i);
          // A session's task lives for days (the job's frozen profile): its cap is per UTC day, as a chat task's.
          row = settle(runKey, { agentId: p.a, runId: String(p.id), issueId: t.issueId, perpetual: t.perpetual || jobProfile(String(p.id)) === "session" });
        }
        return as(row, routeKind, "agent");
      }
      if (p.k === "check") return { ...as(null, "check", "Check jobs"), check: { subject: String(p.c ?? "").slice(0, 80) } } as Caller;
      // An agent's model calls come only with a kernel job's token or a lane's: an agent-kind token under the job secret is no one's.
      if (!SYSTEM[p.k]) throw fail(401, "unauthorized", "this run's model credential is invalid or expired");
      const row = (q.run.get(runKey) as RunRow | undefined) ?? settle(runKey, { agentId: p.a, issueId: p.i });
      return as(row, p.k, String(p.c ?? SYSTEM[p.k]).slice(0, 80));
    }
    throw fail(401, "unauthorized", "not a credential this gateway knows");
  }

  const taskSubject = (who: { issueId: string | null; perpetual: boolean }, t: number) => (who.issueId ? (who.perpetual ? `${who.issueId}:${day(t)}` : who.issueId) : null);

  /** The limits in force for this call at `t`, each with what is spent on it (settled and in flight; `settled`: without calls
   *  in flight): the task's (an agent's call on a task), the install's day and month. */
  function limits(who: { agentId: string | null; issueId: string | null; perpetual: boolean }, t: number): (Limit & { settled: number })[] {
    const set = limitsSet(), d = day(t), m = month(t), task = who.agentId ? taskSubject(who, t) : null;
    const open = new Date(now() - TRUE_UP_MS).toISOString();
    // Totals and holds from one snapshot (reserve() reads inside its own transaction).
    return snapshot(() => [
      ...(set.task && task ? [{ scope: "task" as const, subject: task, cap: set.task, ...spend.task(task, open) }] : []),
      ...(set.day ? [{ scope: "day" as const, subject: d, cap: set.day, ...spend.days(d, d, open) }] : []),
      ...(set.month ? [{ scope: "month" as const, subject: m, cap: set.month, ...spend.days(`${m}-01`, `${m}-31`, open) }] : []),
    ]);
  }
  /** `f` on one read snapshot: inside the caller's transaction when there is one. */
  function snapshot<T>(f: () => T): T {
    if (db.isTransaction) return f();
    db.exec("BEGIN");
    try { return f(); } finally { db.exec("COMMIT"); }
  }

  /**
   * The prices a call is reserved at: its model's on OpenRouter's list, the dearest of any fallback `models`. A 403 for an id
   * OpenRouter doesn't list; a 503 (the caller retries) when no list could be read at all.
   */
  async function priceOf(body: Record<string, unknown>, path: string): Promise<Price> {
    const ids = [body.model, ...(Array.isArray(body.models) ? body.models : [])].map(String);
    const r = await (path === "embeddings" ? embeddingPrices : prices).lookup(ids);
    if ("unavailable" in r) throw fail(503, "prices_unavailable", "OpenRouter's models list couldn't be read to price this call; try again");
    if ("missing" in r) throw fail(403, "not_priced", `OpenRouter lists no model ${r.missing.join(", ").slice(0, 200)}`);
    const most = (k: keyof Price, pick = Math.max) => pick(...r.prices.map((p) => p[k]));
    return { in: most("in"), cached_in: most("cached_in"), out: most("out"), max_output: most("max_output", Math.min) };
  }

  /**
   * The room a call gets at `t`: refused (`over`) when a limit's settled spend has reached it; `busy` when only calls in flight
   * fill it (their holds settle at what was billed, usually less: the caller tries again, and nothing is recorded or told);
   * else the output tokens the tighter limit's room buys (at least MIN_OUTPUT, at most `want`) and the hold: the input
   * estimate plus that output at `perOut`, so the next call's room is what is left after it. `own`: this call's hold already
   * in the ledger, not counted against it; `extra`: spend not in the ledger yet, counted.
   */
  function room(who: Caller, t: number, inUsd: number, perOut: number, want: number, own = 0, extra = 0): { usd: number; maxOutput: number } | { over: Limit } | { busy: Limit } {
    const ls = limits(who, t).map((l) => ({ ...l, spent: l.spent - own + extra, settled: l.settled + extra }));
    const strip = ({ settled: _, ...l }: Limit & { settled: number }): Limit => l;
    const over = ls.find((l) => l.settled >= l.cap);
    if (over) return { over: strip(over) };
    const full = ls.find((l) => l.spent >= l.cap);
    if (full) return { busy: strip(full) };
    const tightest = ls.reduce<Limit | undefined>((a, b) => (!a || b.cap - b.spent < a.cap - a.spent ? b : a), undefined);
    const left = tightest ? tightest.cap - tightest.spent - inUsd : Infinity;
    const maxOutput = Math.min(want, perOut > 0 ? Math.max(MIN_OUTPUT, Math.floor(left / perOut)) : want);
    return { usd: inUsd + perOut * maxOutput, maxOutput };
  }

  /** One transaction, synchronous, so a call is always checked against every call settled or in flight before it: room(), and
   * when it goes ahead its `reserved` ledger row holding that hold. */
  function reserve(who: Caller, t: number, key: string, model: string, inUsd: number, perOut: number, want: number): ReturnType<typeof room> {
    return held(() => {
      const r = room(who, t, inUsd, perOut, want);
      if ("usd" in r) record(who, { key, model, costUsd: r.usd, status: "reserved", t, ms: null });
      return r;
    });
  }

  /**
   * A re-run of call `key` (reserved at `t`) after an attempt that cost `attempt`: in one transaction, room() again in the
   * call's own periods, its own hold set aside and the attempt counted; when it goes ahead the call's hold is replaced by the
   * re-run's and the attempt gets its own `reserved` row `attemptKey`.
   */
  function rehold(who: Caller, t: number, key: string, attemptKey: string, model: string, attempt: number, inUsd: number, perOut: number, want: number): ReturnType<typeof room> {
    return held(() => {
      const r = room(who, t, inUsd, perOut, want, (q.holdOf.get(key) as Sum | undefined)?.s ?? 0, attempt);
      if ("usd" in r) {
        q.rehold.run(r.usd, key);
        record(who, { key: attemptKey, model, costUsd: attempt, status: "reserved", t, ms: null });
      }
      return r;
    });
  }

  /** `f` in one immediate transaction, kept only when it grants a hold. */
  function held<T extends object>(f: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = f();
      db.exec("usd" in r ? "COMMIT" : "ROLLBACK");
      return r;
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
    // The repo's risk tier rules and class (its code review entry; none: the template's default rules) and the instance App's login.
    const entry = (c.tiers ?? {})[claims.repo.toLowerCase()] as { rules?: unknown; repo_class?: unknown } | undefined;
    send(res, 200, { token, expires_at: exp, review: c.review ?? null, tiers: { rules: entry?.rules ?? null, repo_class: entry?.repo_class, self: appLogin() } });
  }

  /**
   * Tells the owner once per limit, period and value (a restart included), or a task's delegator once per task and value; a
   * failed notice never fails the refusal.
   */
  async function tell(who: { agentId: string | null; issueId: string | null }, over: Limit) {
    const task = over.scope === "task";
    const to = task ? (tellDelegator && who.issueId ? (text: string) => tellDelegator(who.issueId!, text) : undefined) : notifyOwner;
    const key = [over.scope, task ? "task" : "install", over.subject, over.cap] as const;
    try {
      if (!to || !q.file.run(...key, new Date(now()).toISOString()).changes) return;
      if (task) await to(`Task spend cap reached: this task's calls have spent $${over.spent.toFixed(2)} of $${over.cap.toFixed(2)} (settings.task_usd), so its agent stops here. Split what is left into new tasks, or the owner can raise task_usd in Settings.`);
      else await to(`AidenHQ reached its ${over.scope === "day" ? "daily" : "monthly"} spend limit ($${over.spent.toFixed(2)} of $${over.cap.toFixed(2)}, settings.spend_${over.scope}_usd), so every model call is refused until the ${over.scope === "day" ? "next UTC day" : "next month (UTC)"}. Raise it in Settings to carry on now.`);
    } catch (e) {
      try { q.unfile.run(...key); } catch {} // the next refusal tells again
      log("spend limit notice failed", { err: String((e as Error).message).slice(0, 300) });
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
    let t0 = now();
    const cred = (!ci && (await asCaller?.(req))) || bearer(req);
    let who = await identify(cred, routeKind, ci);
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
    const price = await priceOf(body, path);
    const upKey = secret("openrouter_key");
    if (!upKey) throw fail(503, "no_upstream_key", "the gateway has no OpenRouter key");
    // Bounded output: the request's own limit, the model's ceiling, and what the tighter spend limit's room buys (reserve).
    const field = path === "responses" ? "max_output_tokens" : "max_tokens";
    const asked = [body[field], body.max_completion_tokens].filter((n): n is number => Number.isInteger(n) && (n as number) > 0);
    const id = `gw:${randomUUID()}`;
    // A model cooling down after a rate limit: waited out before the call holds anything; its periods are the time it goes.
    // A wait may outlive the credential (a job that ended meanwhile): it is checked again.
    if (await cooledDown(body.model, res)) { t0 = now(); who = await identify(cred, routeKind, ci); }
    const inUsd = (Math.ceil(Buffer.byteLength(raw) / 3) * price.in) / 1e6;
    const r = reserve(who, t0, id, body.model, inUsd, path === "embeddings" ? 0 : price.out / 1e6, Math.min(price.max_output, ...asked));
    if ("over" in r) {
      const over = r.over;
      void tell(who, over); // the 402 never waits on the notice
      // One ledger row per run, limit and period: a refused turn arrives several times (Codex retries a 402 five times).
      record(who, { key: `cap:${who.runKey}:${over.scope}:${over.subject}:${over.cap}`, model: body.model, status: "cap_reached", t: t0, ms: 0 });
      // No date or time in it: Paperclip reads one as a retry time (worded to match none of its retry/quota patterns).
      const what = over.scope === "task" ? "task spend cap reached: this task's" : `spend cap reached: the install's ${over.scope === "day" ? "daily" : "monthly"} limit,`;
      const next = over.scope === "task" ? "this task stops here; whoever asked for it has been told" : "the owner can raise it in Settings";
      throw fail(402, "cap_reached", `${what} $${over.spent.toFixed(2)} of $${over.cap.toFixed(2)} (settings.${over.scope === "task" ? "task" : `spend_${over.scope}`}_usd); ${next}`, { scope: over.scope, cap: over.cap, spent: over.spent });
    }
    // The room is held by calls in flight, not spent: a retryable 503 (their holds settle at what was billed).
    if ("busy" in r) throw fail(503, "spend_held", "the rest of the spend limit is held by calls in flight; try again shortly", { scope: r.busy.scope });
    let hold = r.usd;
    // An embedding has no output to bound: its whole price is its input.
    if (path !== "embeddings") {
      body[field] = r.maxOutput;
      if (body.max_completion_tokens !== undefined) body.max_completion_tokens = r.maxOutput;
    }
    body.provider = { ...(body.provider && typeof body.provider === "object" ? body.provider : {}), zdr: true };
    // Settled once, however the call ends: at what OpenRouter billed (usage.cost; tokens x list price if a usage block lacks it,
    // never 0); nothing when the upstream refused before any output or a stream failed in-band (`free`: OpenRouter bills
    // neither; the latter as `stream_error`, so it stays visible); else the reservation (a stream cut or ended without final
    // usage, a restart); an answer that began (2xx) without final usage is closed as `unsettled`, which trueUp settles at
    // what OpenRouter billed when it has a generation id. An error answer keeps its `upstream_<status>` (the board counts it
    // as an error) at the input estimate: an error answer carries no output.
    live++;
    const settle = (status: string, u?: Usage, free = false) => {
      live--;
      const billed = u ? (u.costUsd ?? (u.input * price.in + u.cached * price.cached_in + u.output * price.out) / 1e6) : free ? 0 : up && !up.ok ? inUsd : hold;
      const row = [new Date(now()).toISOString(), String(u?.model || body.model).slice(0, 120), u?.input ?? 0, u?.cached ?? 0, u?.output ?? 0, billed, now() - t0, !u && !free && up?.ok ? "unsettled" : status, gen || null, id];
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
        if (up?.status === 429 || (failed && RATE_LIMITED.test(failed.reason))) cool(body.model, up?.headers.get("retry-after") ?? null);
        const transient = err ? !["ECONNREFUSED", "ENOTFOUND"].includes(String(((err as Error).cause as { code?: string } | undefined)?.code)) : failed ? failed.transient && !rerun : RETRY_STATUS.has(up.status);
        if (!transient || n >= retryDelaysMs.length) { if (err) throw err; break; }
        if (failed) {
          // The re-run is cap-checked and sized like a new call, in the call's own periods, with the discarded attempt's cost
          // counted (refused: this attempt goes to the caller and settles on the call's own row). The discarded attempt keeps
          // its own row with the token counts it reported: free `stream_error` when it failed in-band; one that just ended
          // before any output may be billed, so it holds the input estimate as `unsettled`, trued up from its generation.
          const held = `gw:${randomUUID()}`;
          const billable = failed === NO_OUTPUT, spent = billable ? inUsd : 0;
          const again = rehold(who, t0, id, held, body.model, spent, inUsd, price.out / 1e6, Math.min(price.max_output, ...asked));
          if (!("usd" in again)) break;
          hold = again.usd;
          body[field] = again.maxOutput;
          if (body.max_completion_tokens !== undefined) body.max_completion_tokens = again.maxOutput;
          rerun = true;
          const tk = usageTap(true);
          tk.feed(peeked?.text ?? "");
          const ku = tk.done();
          const g = billable ? genOf(up, peeked?.text ?? "") : "";
          q.settle.run(held, new Date(now()).toISOString(), String(body.model).slice(0, 120), ku?.input ?? 0, ku?.cached ?? 0, ku?.output ?? 0, spent, now() - t0, billable ? "unsettled" : "stream_error", g || null, held);
        }
        const after = retryAfterMs(up?.headers.get("retry-after") ?? null, now());
        // Never sooner than the model's shared cooldown (this answer's own, or one a peer kernel extended).
        const cooled = String(body.model);
        const deadline = () => (q.cooldown.get(cooled) as { until: number } | undefined)?.until ?? 0;
        let until = deadline();
        const wait = Math.min(Math.max(Math.min(after ?? retryDelaysMs[n]! * (0.75 + Math.random() / 2), 20_000), until - now()), COOLDOWN_MAX_MS);
        log("upstream retry", { model: body.model, attempt: n + 1, ...(failed ? { stream_error: failed.reason } : { status: up?.status ?? String((err as Error).message).slice(0, 100) }), wait_ms: Math.round(wait) });
        await reader?.cancel().catch(() => {});
        await new Promise((r) => setTimeout(r, wait));
        // A deadline another call or kernel extended meanwhile is waited out too (by how far it moved, at most COOLDOWN_MAX_MS in all).
        for (let more = 0, next = deadline(); next > until && wait + more < COOLDOWN_MAX_MS; until = next, next = deadline()) {
          const ms = Math.min(next - until, COOLDOWN_MAX_MS - wait - more);
          more += ms;
          await new Promise((r) => setTimeout(r, ms));
        }
      }
    } catch (e) {
      // Refused before the request left (nothing reached OpenRouter): free. Any other failure may have been billed.
      settle("upstream_error", undefined, ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(String(((e as Error).cause as { code?: string } | undefined)?.code)));
      throw fail(502, "upstream_error", `OpenRouter unreachable (${(e as Error).message})`);
    }
    // The generation id is a cut-off call's handle (an Anthropic-format answer's own id is a `msg_` one: the header names it).
    // A stream's is written the moment it is seen, so a kernel that dies mid-stream leaves the true-up its handle; any other
    // answer's rides on the settle write.
    const sse = isSse(up);
    if ((gen = genOf(up, peeked?.text ?? "")) && sse) q.gen.run(gen, id);
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
    // Read to the end even if the caller hung up, so what OpenRouter billed still lands in the ledger. A stream that goes quiet
    // for streamIdleMs is cut: it is settled at its reservation (fail closed; trued up from OpenRouter's record when it has a
    // generation id) instead of held for minutes.
    let status = "upstream_aborted";
    try {
      res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k))));
      if (sse) poke();
      for await (const c of chunks()) {
        if (sse) poke();
        if (!res.destroyed) res.write(c);
        const s = text.decode(c, { stream: true });
        tap.feed(s);
        if (!gen && (gen = /"id"\s*:\s*"(gen-[\w-]{1,190})"/.exec(s)?.[1] ?? "") && sse) q.gen.run(gen, id);
      }
      status = up.ok ? "ok" : `upstream_${up.status}`;
    } finally {
      clearTimeout(idle);
      const u = tap.done();
      // A stream without final usage: free when it failed in-band (an error event), else at the reservation (its partial
      // usage, such as message_start's input alone, would under-bill it).
      const failed = sse ? tap.failure() : undefined;
      if (failed) log("upstream stream error", { model: body.model, gen, reason: failed.reason });
      if (failed && RATE_LIMITED.test(failed.reason)) cool(body.model, null);
      if (failed?.inBand && status === "ok") settle("stream_error", u && { ...u, costUsd: 0 }, true);
      else if (failed) settle(status);
      else settle(status, u, !up.ok && !sse && status !== "upstream_aborted"); // free: a definite error answer, no stream started
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
   * Prometheus text for the monitoring module (gateway.ts writes it as a node-exporter textfile; no route): today's spend by
   * agent and kind, the install's spend against its limits, refusals, CI review spend, calls in flight. Labels are agent keys,
   * never ids or secrets.
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
    // Summed by the labels shown (ids no grant names all read `unknown`): one sample per series.
    const by = (pick: (r: { billed: number; refused: number }) => number) => {
      const m = new Map<string, [Record<string, unknown>, number]>();
      for (const r of q.dayRows.all(today) as { agent: string; kind: string; billed: number; refused: number }[]) {
        if (!pick(r)) continue;
        const labels = { agent: keyOf(r.agent || null), kind: r.kind }, k = JSON.stringify(labels);
        m.set(k, [labels, (m.get(k)?.[1] ?? 0) + pick(r)]);
      }
      return [...m.values()];
    };
    metric("aidenhq_gateway_spend_usd_today", "Billed model spend since 00:00 UTC, by agent key and call kind.", by((r) => r.billed / 1e9));
    const install = limits({ agentId: null, issueId: null, perpetual: false }, now());
    metric("aidenhq_gateway_install_spend_usd", "The install's spend in the limit's period (UTC day or month), in flight included.", install.map((l) => [{ period: l.scope }, l.spent]));
    metric("aidenhq_gateway_install_limit_usd", "The install's spend limit for the period (settings.spend_day_usd, spend_month_usd).", install.map((l) => [{ period: l.scope }, l.cap]));
    metric("aidenhq_gateway_cap_refusals_today", "Runs refused over a spend limit or task cap since 00:00 UTC (one per run, limit and period).", by((r) => r.refused));
    metric("aidenhq_gateway_ci_spend_usd_today", "App CI code review spend since 00:00 UTC.", [[{}, (q.ciSpent.get(today) as Nano).n / 1e9]]);
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
      if (req.method === "GET" && path === "/api/v1/models") {
        // An engine reads each model's real window here (its config's context limit); any credential a model call takes may.
        await identify(bearer(req), "agent");
        const ids = (new URL(req.url ?? "", "http://gateway").searchParams.get("ids") ?? "").split(",").filter(Boolean);
        if (ids.length) await prices.lookup(ids);
        return send(res, 200, { object: "list", data: (await prices.catalog()).map((m) => ({ id: m.id, object: "model", context_length: m.context, max_completion_tokens: m.output })) });
      }
      const m = ROUTE.exec(path);
      if (req.method === "POST" && m) return await model(req, res, m[1] ?? "agent", m[2]!);
      if (req.method === "POST" && path === "/usage") {
        boardKeyed(req);
        const { since, after } = JSON.parse((await readBody(req)) || "{}") as { since?: unknown; after?: unknown };
        const rows = q.since.all(String(since ?? ""), String(after ?? "")) as (CallRow & { changed: string | null })[];
        // A full page names where the next one starts: after its last row's time and key.
        const last = rows.length === USAGE_PAGE ? rows.at(-1)! : undefined;
        const records = rows.map((r) => ({ key: r.key, at: r.at, agentId: r.agent_id, component: r.component, model: r.model, input: r.input, cached: r.cached, output: r.output, costUsd: r.cost_usd, runKey: r.run_key, runId: r.run_id, issueId: r.issue_id, rev: r.rev, kind: r.kind, ms: r.ms, status: r.status, ...(r.kind === CI_KIND ? { subject: r.task_subject } : {}) }));
        return send(res, 200, { records, ...(last ? { next: { since: last.changed ?? last.at, after: last.key } } : {}) });
      }
      if (req.method === "GET" && path === "/v1/spend/summary") {
        // The install's spend (settled and in flight) against its limits, and each agent's today (every granted agent, and any
        // other that spent today), most first.
        boardKeyed(req);
        const t = now(), today = day(t), r4 = (n: number) => Math.round(n * 1e4) / 1e4, set = limitsSet();
        const m = month(t);
        const { byAgent, daySpent, monthSpent } = snapshot(() => ({
          byAgent: new Map((q.agentsDay.all(today) as { agent: string; n: number }[]).map((r) => [r.agent, r.n / 1e9])),
          daySpent: spend.days(today, today, "").spent,
          monthSpent: spend.days(`${m}-01`, `${m}-31`, "").spent,
        }));
        const agents = [...new Set([...Object.keys(grants()), ...byAgent.keys()])].map((agent_id) => ({ agent_id, spent: r4(byAgent.get(agent_id) ?? 0) })).sort((a, b) => b.spent - a.spent);
        return send(res, 200, { day: today, month: m, install: { day: { spent: r4(daySpent), cap: set.day }, month: { spent: r4(monthSpent), cap: set.month } }, agents });
      }
      if (req.method === "GET" && path === "/v1/models/catalog") {
        boardKeyed(req);
        return send(res, 200, { models: await prices.catalog() });
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

  /**
   * The limits a new job of this agent on this task would start over (admission.ts): its task's cap, the install's day and
   * month. Each is told as a refused call's is (once), so a limit a last call crossed is never silent.
   */
  const exhausted = (agentId: string, task: string) => {
    // Admission doesn't know whether the task is a chat or routine one (its cap by the UTC day): both subjects are read. A
    // session agent's calls are only ever by the day (identify), so only that subject is.
    const t = now(), who = { agentId, issueId: task };
    const all = grants()[agentId]?.profile === "session" ? limits({ ...who, perpetual: true }, t) : [...limits({ ...who, perpetual: false }, t), ...limits({ ...who, perpetual: true }, t).filter((o) => o.scope === "task")];
    const over = all.filter((o) => o.spent >= o.cap);
    // Only a limit its settled spend reached is told (a limit held by calls in flight may settle below it); after the
    // caller's transaction (admission's) is over: the notice's row is a write on the same file.
    const spent = over.filter((o) => o.settled >= o.cap);
    if (spent.length) setImmediate(() => { for (const o of spent) void tell(who, o); });
    return over.map(({ settled: _, ...o }) => o);
  };
  /** A drain's first step (main.ts): the ledger's timers stop and cooldown waits end; → the true-up in flight, which close() must follow. */
  function stop(): Promise<void> {
    clearInterval(pruner);
    clearInterval(trueUps);
    prices.close();
    embeddingPrices.close();
    stopping.abort();
    return truing ?? Promise.resolve();
  }
  /** What a run key (a credential's sha256) has spent; spentBy: the same, by the credential. */
  const spentByKey = (runKey: string) => (q.spentRun.get(runKey) as Sum).s;
  const spentBy = (cred: string) => spentByKey(sha256(cred));
  /** A run key's tokens (settled calls' input, cached input and output). */
  const tokensByKey = (runKey: string) => ({ ...(q.tokensRun.get(runKey) as { input: number; cached: number; output: number }) });
  /** The limits a run key was refused at, as the scope each named (`day`, `month` or `task`): `[]` when it wasn't. The gateway
   *  refuses and records them, so this is the limit event itself, never a caller's account of it. A refusal is never forgotten
   *  for the key: a call settling after it means the limit was raised, not that the case the limit cut was judged. */
  const refusedByKey = (runKey: string) => [...new Set((q.refusedRun.all(runKey) as { key: string }[]).map((r) => r.key.split(":")[2] ?? ""))];
  return { handle, db, metricsText, exhausted, dayLimit: () => limitsSet().day, trueUp, spentBy, spentByKey, tokensByKey, refusedByKey, inflight: () => live, ciEnabled: () => Boolean(ciConf()), stop, close: () => { void stop(); db.close(); } };
}
