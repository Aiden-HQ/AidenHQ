// The model gateway's logic (main.ts wires it to its listeners): who a call is for, the spend caps, the pass-through to
// OpenRouter with what it billed tapped from the answer, and the ledger (kernel.db's calls) the board pulls.
//
// Routes (OpenRouter-compatible; the caller's "API key" is its own per-run credential, never the OpenRouter key):
//   POST /api/v1/responses | /api/v1/chat/completions            kind agent (or the service kind its credential fixes)
//   POST /advisor/api/v1/... | /fanout/api/v1/...                kind advisor | fanout, counted against the caller's run
//   POST /api/v1/chat/completions  (Bearer gateway_board_key) kind aside: the board's side chat, capped per UTC day
//   POST /usage {since}           (Bearer gateway_board_key) the ledger since then → {records} (the board's Costs tab)
//   POST /internal/caps {scope, agentId, subject, cap}  (Bearer gateway_board_key) the owner raised a cap: the new cap
//   POST /c/<connection>/mcp      (Bearer: a job's own `ahqj_` token) the job's reads of a connection, its jobcaps only (../proxy.ts)
//   GET /health
// CI listener (gateway.ts, the CI runners' bridge address; only these routes, only `ahqci_` credentials, never on the others):
//   POST /ci/token                (Bearer: a GitHub Actions OIDC token, ci.ts) -> {token, expires_at}: an opaque CI token
//   POST /api/v1/chat/completions  kind ci-code-review: the allowed models only, CI's own caps, attributed to repo and PR
//   GET /health
// Credentials: a Paperclip run JWT (Codex in Paperclip, env_key PAPERCLIP_API_KEY; checked at Paperclip's /api/agents/me,
// its run id from the checked token, the task from that run); an agent computer's run token `ahqc_` (the launcher forwards
// its boxes' calls here with it; the launcher's /whoami names the agent, Paperclip run and task, asked every call so a run
// that ended stops at once); a runner token `ahqj_` (token.ts: an Engineer job, or the runner's reviewer/grader/intake), or a fast chat lane's turn token (same format, signed with gateway_lane_secret, agent kind only); the source writers' key (gateway_source_key); Paperclip's harness key
// (gateway_harness_key: the new-agent hello probe, whose env has no run JWT). The run key is the credential's sha256.
// Spend (spec §5.12): before forwarding, one transaction reserves (estimated input x in + max_output x out) x peak at the
// model's declared prices (config/gateway.json `models`; an unpriced model is refused) as a `reserved` ledger row, so every
// cap sum counts calls in flight; max_output is cut to what the tightest cap has left, and a call that can't buy MIN_OUTPUT
// tokens is refused. Settlement replaces the row's cost with max(reported, tokens x price); no usage (a stream cut, an
// upstream failure) leaves the reservation, and a restart settles every open one at it (fail closed).
// Caps: run / task / agent-day (grants caps, defaults 2/10/30 USD), always enforced; only the owner raises one (raise_cap). A
// task labelled `chat` or a routine's execution task is perpetual: its task cap counts the UTC day only. System kinds
// (reviewer, grader, source) are never capped. CI caps (config/gateway.json `ci`: per repo per UTC day, all CI per day) are
// never filed for raising.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { CI_KIND, CI_PREFIX, ciBodyProblem, githubKeys, verifyGithubOidc } from "./ci.ts";
import { verifyToken } from "./token.ts";

type Brand<T, B extends string> = T & { readonly __brand: B };
/** A run key: the sha256 of the caller's own credential (or the harness's day key). Run caps and the ledger key on it. */
export type RunKey = Brand<string, "RunKey">;
/**
 * Who a model call is for, settled by identify() from the credential alone (a checked token, Paperclip's /api/agents/me,
 * the launcher's /whoami, a stored CI token): only identify() makes one, and nothing in the request body ever feeds it.
 */
export type Caller = Brand<{
  runKey: RunKey; agentId: string | null; runId: string | null; issueId: string | null; perpetual: boolean; rev: string | null;
  kind: string; component: string; capped: boolean; ci?: { repo: string; subject: string };
}, "Caller">;
type GatewayError = Error & { status?: number; type?: string; extra?: Record<string, unknown> };
type Caps = { run_usd: number; task_usd: number; day_usd: number };
/** config/grants/grants.json `agents`, by Paperclip id (setup writes it). */
type Grants = Record<string, { rev?: string; key?: string; caps?: Partial<Caps> }>;
/** config/gateway.json `ci` (compile writes it from the ci module's settings). */
type CiConf = { enabled?: boolean; orgs?: unknown; models?: unknown; repo_day_usd?: unknown; day_usd?: unknown };
/** A run key's settled identity (the runs table), or the same fields resolved for one call. */
type RunRow = { run_key: string; agent_id: string | null; run_id: string | null; issue_id: string | null; rev: string | null; perpetual: number; at: string };
type RunIdentity = Pick<RunRow, "agent_id" | "run_id" | "issue_id" | "rev"> & { perpetual: number | boolean };
type CallRow = {
  key: string; at: string; day: string; run_key: string; run_id: string | null; agent_id: string | null; issue_id: string | null; task_subject: string | null;
  rev: string | null; kind: string; component: string; model: string; input: number; cached: number; output: number; cost_usd: number | null; ms: number | null; status: string;
};
type CiTokenRow = { hash: string; repo: string; pr: number; head: string | null; gh_run: string; attempt: string; exp: string; at: string };
type Sum = { s: number };
type Over = { scope: string; subject: string; cap: number; spent: number };
/** A model's declared prices (config/gateway.json `models`): USD per million tokens, the reservation's multiple, the output limit. */
type Price = { in: number; cached_in: number; out: number; peak: number; max_output: number };
/** What OpenRouter billed for one call. */
type Usage = { key: string; model: string; input: number; cached: number; output: number; costUsd: number | null };
type UsageBlock = {
  input_tokens?: number; prompt_tokens?: number; output_tokens?: number; completion_tokens?: number; cost?: unknown;
  input_tokens_details?: { cached_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number };
};
type Answer = { id?: unknown; model?: unknown; usage?: UsageBlock };
type Log = (msg: string, fields?: Record<string, unknown>) => void;

export const DEFAULT_CAPS: Caps = { run_usd: 2, task_usd: 10, day_usd: 30 };
const SYSTEM: { source: string } & Record<string, string> = { reviewer: "AI reviewer", grader: "Grader", source: "Source writers" };
const ROUTE = /^\/(?:(advisor|fanout)\/)?api\/v1\/(responses|chat\/completions)$/;
const MAX_BODY = 32 * 1024 * 1024;
const DAY_MS = 864e5;
// The fewest output tokens a call may be cut to; below that it is refused at the cap instead.
const MIN_OUTPUT = 1024;
// CI: a token lives 2 h (the job's timeout is 90 min); a repo gets at most 200 a day and 8 calls in flight.
const CI_TTL_MS = 2 * 3600_000;
const CI_TOKENS_PER_DAY = 200;
const CI_INFLIGHT = 8;
const CI_MAX_BODY = 8 * 1024 * 1024;
// CI tokens a repo may be issued a minute. Only verified exchanges count (ci.ts checks the claims, then GitHub's signature,
// about 20 microseconds), so a flood of forged or foreign tokens never uses up a real job's budget; one repo's flood of
// genuine ones only uses its own. Refusals on the CI listener are logged at most CI_REFUSALS_LOGGED a minute.
const CI_TOKENS_PER_MIN = 20;
const CI_REFUSALS_LOGGED = 20;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const same = (a: string, b: string) => Boolean(a && b) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
    const cols = (t: string) => (db.prepare(`PRAGMA main.table_info(${t})`).all() as { name: string }[]).map((c) => c.name).join(", ");
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

/**
 * What OpenRouter billed for one call, read as the answer passes: the last SSE `data:` line with a usage block (a chat
 * completion's final chunk, or `response.completed`), or the whole JSON body. done() → { key, model, input (uncached),
 * cached, output, costUsd } or undefined. The model is the one OpenRouter answered with.
 */
export function usageTap(sse: boolean): { feed(text: string): void; done(): Usage | undefined } {
  let tail = "", body = "", found: (Answer & { id: string; usage: UsageBlock }) | undefined;
  const take = (text: string) => {
    if (!text.includes('"usage"')) return;
    try {
      const j = JSON.parse(text) as (Answer & { type?: unknown; response?: Answer }) | null;
      const r = j?.type === "response.completed" ? j.response : j;
      if (r?.usage && typeof r.id === "string") found = r as Answer & { id: string; usage: UsageBlock };
    } catch {}
  };
  return {
    feed(text) {
      if (!sse) { if (body.length < MAX_BODY) body += text; return; }
      const lines = (tail + text).split("\n");
      tail = lines.pop()!;
      for (const l of lines) if (l.startsWith("data: ")) take(l.slice(6));
    },
    done() {
      if (sse) { if (tail.startsWith("data: ")) take(tail.slice(6)); } else take(body);
      if (!found) return undefined;
      const u = found.usage;
      const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      const input = u.input_tokens ?? u.prompt_tokens ?? 0;
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

/**
 * The gateway: handle(req, res). `secret(name)` reads a secret file (fresh each time, so a rotation needs no restart);
 * `upstream` is OpenRouter's API base; Paperclip and the board's internal API as URLs.
 */
export function createGateway({ dbFile, legacyDbFile, grantsFile, settingsFile, tools, asCaller, secret, upstream = "https://openrouter.ai/api/v1", paperclipUrl, boardUrl, launcherUrl, githubJwksUrl, log = () => {}, now = Date.now }: {
  dbFile: string; legacyDbFile?: string; grantsFile: string; settingsFile: string; tools?: (req: IncomingMessage, res: ServerResponse, connection: string, o: { jobs: boolean }) => Promise<void>;
  /** A module's model call for the agent whose tool call it serves (module token + caller assertion): that caller's own credential. */
  asCaller?: (req: IncomingMessage) => Promise<string | undefined>; secret: (name: string) => string; upstream?: string; paperclipUrl?: string;
  boardUrl?: string; launcherUrl?: string; githubJwksUrl?: string; log?: Log; now?: () => number;
}) {
  const { db, moved } = openLedger(dbFile, legacyDbFile);
  if (moved) log("ledger rows moved into kernel.db", { rows: moved });
  // A reservation a restart left open is settled at its reserved amount (fail closed).
  db.prepare("UPDATE calls SET status = 'unsettled', at = ? WHERE status = 'reserved'").run(new Date(now()).toISOString());
  const grants = watched(grantsFile, (j) => (j.agents ?? {}) as Grants, {});
  const prices = watched(settingsFile, (j) => (j.models && typeof j.models === "object" ? (j.models as Record<string, Price>) : {}), {});
  // CI code review (compile writes it from the ci module's settings): { enabled, orgs, models, repo_day_usd, day_usd } or null.
  const ciConf = watched<CiConf | null>(settingsFile, (j) => (j.ci && typeof j.ci === "object" ? (j.ci as CiConf) : null), null);
  const keyFor = githubKeys(githubJwksUrl, now);
  const q = {
    run: db.prepare("SELECT * FROM runs WHERE run_key = ?"),
    addRun: db.prepare("INSERT OR IGNORE INTO runs (run_key, agent_id, run_id, issue_id, rev, perpetual, at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    add: db.prepare("INSERT OR IGNORE INTO calls (key, at, day, run_key, run_id, agent_id, issue_id, task_subject, rev, kind, component, model, input, cached, output, cost_usd, ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    spentRun: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE run_key = ?"),
    spentTask: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE agent_id = ? AND task_subject = ?"),
    spentDay: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE agent_id = ? AND day = ?"),
    cap: db.prepare("SELECT cap FROM caps WHERE scope = ? AND agent_id = ? AND subject = ?"),
    setCap: db.prepare("INSERT INTO caps (scope, agent_id, subject, cap, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (scope, agent_id, subject) DO UPDATE SET cap = excluded.cap, at = excluded.at"),
    file: db.prepare("INSERT OR IGNORE INTO filed (scope, agent_id, subject, cap, at) VALUES (?, ?, ?, ?, ?)"),
    unfile: db.prepare("DELETE FROM filed WHERE scope = ? AND agent_id = ? AND subject = ? AND cap = ?"),
    since: db.prepare("SELECT * FROM calls WHERE at >= ? AND status != 'reserved' ORDER BY at LIMIT 20000"),
    settle: db.prepare("UPDATE calls SET key = ?, at = ?, model = ?, input = ?, cached = ?, output = ?, cost_usd = ?, ms = ?, status = ? WHERE key = ? AND status = 'reserved'"),
    inflight: db.prepare("SELECT COUNT(*) AS n FROM calls WHERE status = 'reserved'"),
    ciToken: db.prepare("SELECT * FROM ci_tokens WHERE hash = ?"),
    addCiToken: db.prepare("INSERT OR IGNORE INTO ci_tokens (hash, repo, pr, head, gh_run, attempt, exp, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    ciIssued: db.prepare("SELECT COUNT(*) AS n FROM ci_tokens WHERE repo = ? AND substr(at, 1, 10) = ?"),
    // A CI call's task_subject is `<owner>/<repo>#<pr>`.
    ciSpentRepo: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE kind = 'ci-code-review' AND day = ? AND substr(task_subject, 1, length(?)) = ?"),
    ciSpent: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE kind = 'ci-code-review' AND day = ?"),
    ciInflight: db.prepare("SELECT COUNT(*) AS n FROM calls WHERE status = 'reserved' AND kind = 'ci-code-review' AND substr(task_subject, 1, length(?)) = ?"),
  };
  const prune = () => {
    const cut = new Date(now() - 40 * DAY_MS).toISOString();
    db.prepare("DELETE FROM calls WHERE at < ?").run(cut);
    db.prepare("DELETE FROM filed WHERE at < ?").run(cut);
    db.prepare("DELETE FROM runs WHERE at < ?").run(new Date(now() - 7 * DAY_MS).toISOString());
    db.prepare("DELETE FROM ci_tokens WHERE exp < ?").run(new Date(now() - 2 * DAY_MS).toISOString());
  };
  prune();
  const pruner = setInterval(prune, 3600_000);
  pruner.unref();

  async function paperclip(path: string, token: string): Promise<unknown> {
    const res = await fetch(new URL(path, paperclipUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw Object.assign(new Error(`Paperclip ${path.split("/")[2]} answered ${res.status}`), { status: res.status });
    return res.json();
  }

  /** A Paperclip run's task (Paperclip's record of the run, else `hint`) and whether that task is perpetual. */
  async function runTask(runId: string | null | undefined, hint: string | null = null) {
    const board = secret("paperclip_board_key");
    const run = (runId ? await paperclip(`/api/heartbeat-runs/${encodeURIComponent(runId)}`, board).catch(() => undefined) : undefined) as { issueId?: string; contextSnapshot?: { issueId?: string } } | undefined;
    const issueId = run?.issueId ?? run?.contextSnapshot?.issueId ?? hint ?? null;
    const issue = (issueId ? await paperclip(`/api/issues/${encodeURIComponent(issueId)}`, board).catch(() => undefined) : undefined) as { labels?: ({ name?: string } | null)[]; originKind?: string } | undefined;
    return { issueId, perpetual: Boolean(issue && ((issue.labels ?? []).some((l) => l?.name === "chat") || issue.originKind === "routine_execution")) };
  }

  /** A computer's run token as the launcher that issued it knows it now: { agentId, runId, issueId }. */
  async function computerRun(token: string): Promise<{ agentId: string; runId?: string | null; issueId?: string | null }> {
    if (!launcherUrl) throw fail(503, "unauthorized", "this gateway doesn't know where the computer launcher is");
    const res = await fetch(new URL("/whoami", launcherUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
      .catch((e: Error) => { throw fail(503, "unauthorized", `the computer launcher is unreachable (${e.message})`); });
    if (res.status === 401) throw fail(401, "unauthorized", "this computer's run has ended");
    if (!res.ok) throw fail(503, "unauthorized", `the computer launcher answered ${res.status}`);
    const j = (await res.json().catch(() => undefined)) as { agentId?: unknown; runId?: string | null; issueId?: string | null } | undefined;
    if (typeof j?.agentId !== "string" || !j.agentId) throw fail(401, "unauthorized", "the run token doesn't name its agent");
    return j as { agentId: string; runId?: string | null; issueId?: string | null };
  }

  /** A run key's identity, settled once: the agent, Paperclip's run id, its task and whether that task is perpetual, the rev. */
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
    if (same(cred, secret("gateway_harness_key"))) {
      // Paperclip's hello probe for a new agent: one shared key, so its "run" is the UTC day.
      return { ...as(null, routeKind, "agent", true), runKey: `harness:${day(now())}` as RunKey } as Caller;
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
      const row = (q.run.get(runKey) as RunRow | undefined) ?? settle(runKey, { agentId: p.a, issueId: p.i });
      const system = p.k !== "agent";
      const component = String(p.c ?? (system ? SYSTEM[p.k] : "Engineer jobs")).slice(0, 80);
      return as(row, system ? p.k : routeKind, component, !system);
    }
    if (cred.startsWith("ahqc_")) {
      const box = await computerRun(cred);
      let row: RunIdentity | undefined = q.run.get(runKey) as RunRow | undefined;
      if (!row) {
        const task = await runTask(box.runId, box.issueId);
        // Settled only once the launcher knows the Paperclip run (its first exec binds it): until then the identity is
        // resolved again on every call, so a run is never pinned without its task (run and agent-day caps still apply).
        row = box.runId ? settle(runKey, { agentId: box.agentId, runId: box.runId, ...task })
          : { agent_id: box.agentId, run_id: null, issue_id: task.issueId, perpetual: task.perpetual, rev: grants()[box.agentId]?.rev ?? null };
      }
      return as(row, routeKind, "agent", true);
    }
    if (cred.startsWith("eyJ")) {
      // The claims are read from the credential itself: its hash is the run key, so they are the bytes Paperclip accepted.
      let claims: { exp?: unknown; sub?: unknown; run_id?: string } = {};
      try { claims = JSON.parse(Buffer.from(cred.split(".")[1]!, "base64url").toString("utf8")); } catch {}
      // A settled run key outlives Paperclip's check; the JWT's own expiry (Paperclip's TTL, 48h by default) still ends it.
      if (typeof claims.exp === "number" && claims.exp * 1000 <= now()) throw fail(401, "unauthorized", "this run's credential has expired");
      let row = q.run.get(runKey) as RunRow | undefined;
      if (!row) {
        // The JWT is genuine if Paperclip accepts it; only then is its payload (run id, agent) read.
        const me = (await paperclip("/api/agents/me", cred).catch((e: GatewayError) => { throw fail(e.status === 401 || e.status === 403 ? 401 : 503, "unauthorized", e.message); })) as { id?: string } | undefined;
        if (!me?.id || claims.sub !== me.id) throw fail(401, "unauthorized", "the run credential doesn't name its agent");
        row = settle(runKey, { agentId: me.id, runId: claims.run_id ?? null, ...(await runTask(claims.run_id)) });
      }
      return as(row, routeKind, "agent", true);
    }
    throw fail(401, "unauthorized", "not a credential this gateway knows");
  }

  const capOf = (who: { agentId: string | null }, scope: string, subject: string): number => {
    const own = ({ ...DEFAULT_CAPS, ...((who.agentId && grants()[who.agentId]?.caps) || {}) } as Record<string, number>)[`${scope}_usd`]!; // scope: run, task or day
    return (q.cap.get(scope, who.agentId ?? "", subject) as { cap: number } | undefined)?.cap ?? own;
  };
  const taskSubject = (who: { issueId: string | null; perpetual: boolean }, t: number) => (who.issueId ? (who.perpetual ? `${who.issueId}:${day(t)}` : who.issueId) : null);

  /** The caps this call counts against, each with what is spent on it (settled + reserved): none for an uncapped kind. */
  function capScopes(who: Caller, t: number): Over[] {
    const today = day(t);
    if (who.ci) {
      const c = ciOn(), prefix = `${who.ci.repo}#`;
      return [
        { scope: "repo-day", subject: who.ci.repo, cap: Number(c.repo_day_usd) > 0 ? Number(c.repo_day_usd) : 0, spent: (q.ciSpentRepo.get(today, prefix, prefix) as Sum).s },
        { scope: "day", subject: today, cap: Number(c.day_usd) > 0 ? Number(c.day_usd) : 0, spent: (q.ciSpent.get(today) as Sum).s },
      ];
    }
    if (!who.capped) return [];
    const subject = taskSubject(who, t);
    const scopes: [string, string, number][] = [["run", who.runKey, (q.spentRun.get(who.runKey) as Sum).s]];
    if (who.agentId && subject) scopes.push(["task", subject, (q.spentTask.get(who.agentId, subject) as Sum).s]);
    if (who.agentId) scopes.push(["day", today, (q.spentDay.get(who.agentId, today) as Sum).s]);
    return scopes.map(([scope, subj, spent]) => ({ scope, subject: subj, cap: capOf(who, scope, subj), spent }));
  }

  /** The prices a call is reserved and settled at: its model's, the dearest of any fallback `models`; a 403 when one has none. */
  function priceOf(body: Record<string, unknown>): Price {
    const ids = [body.model, ...(Array.isArray(body.models) ? body.models : [])].map(String);
    const table = prices();
    const missing = ids.filter((id) => !Object.hasOwn(table, id));
    if (missing.length) throw fail(403, "not_priced", `no declared price for model ${missing.join(", ").slice(0, 200)}; the owner can add one (a module's models:)`);
    const most = (k: keyof Price, pick = Math.max) => pick(...ids.map((id) => Number(table[id]![k]) || 0));
    return { in: most("in"), cached_in: most("cached_in"), out: most("out"), peak: Math.max(1, most("peak")), max_output: most("max_output", Math.min) };
  }

  /**
   * One transaction: the room the tightest cap leaves, the output tokens that buys (at most `want`), and a `reserved` ledger
   * row holding the call's whole worst case. Synchronous, so calls in flight can never reserve past a cap together.
   */
  function reserve(who: Caller, t: number, key: string, model: string, inUsd: number, perOut: number, want: number): { usd: number; maxOutput: number } | { over: Over } {
    db.exec("BEGIN IMMEDIATE");
    try {
      const scopes = capScopes(who, t);
      const room = Math.min(Infinity, ...scopes.map((s) => s.cap - s.spent));
      const fits = room < inUsd ? -1 : perOut > 0 ? Math.floor((room - inUsd) / perOut) : Infinity;
      const maxOutput = Math.min(want, fits);
      if (maxOutput < Math.min(want, MIN_OUTPUT)) {
        db.exec("ROLLBACK");
        return { over: scopes.reduce((a, b) => (b.cap - b.spent < a.cap - a.spent ? b : a)) };
      }
      const usd = inUsd + maxOutput * perOut;
      record(who, { key, model, costUsd: usd, status: "reserved", t, ms: null });
      db.exec("COMMIT");
      return { usd, maxOutput };
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The CI settings, when CI is on; else a 403 (settings.ci_review: off refuses every CI token at once). */
  function ciOn(): CiConf {
    const c = ciConf();
    if (!c?.enabled) throw fail(403, "ci_off", "CI code review through the model gateway is off on this instance");
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
    send(res, 200, { token, expires_at: exp });
  }

  /** One raise_cap per scope, subject and cap value, filed on the board with the gateway's key (needs the run's task). */
  async function fileRaise(who: Caller, over: Over): Promise<boolean> {
    // A run cap is on the credential's hash: the next run has a new one, so a raised run cap would never be used.
    if (over.scope === "run" || !who.agentId || !who.issueId || !boardUrl) return false;
    const args = [over.scope, who.agentId, over.subject, over.cap];
    if (!q.file.run(...args, new Date(now()).toISOString()).changes) return true;
    try {
      const res = await fetch(new URL("/internal/approvals/raise-cap", boardUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${secret("board_internal_token")}`, "x-gateway-key": secret("gateway_board_key"), "content-type": "application/json" },
        body: JSON.stringify({ issue: who.issueId, scope: over.scope, agentId: who.agentId, subject: over.subject, cap: over.cap, spent: Math.round(over.spent * 1e4) / 1e4 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`the board answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      log("raise_cap filed", { scope: over.scope, agent: who.agentId, subject: over.subject, cap: over.cap });
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
    q.add.run(r.key ?? `gw:${randomUUID()}`, new Date(now()).toISOString(), day(t), who.runKey, who.runId, who.agentId, who.issueId, who.ci ? who.ci.subject : taskSubject(who, t), who.rev, who.kind, who.component, String(r.model ?? "").slice(0, 120) || "unknown", r.input ?? 0, r.cached ?? 0, r.output ?? 0, r.costUsd ?? null, r.ms ?? null, r.status);
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
      // CI's own gates: the models and fields it may use and calls in flight. A refusal is a 403 or 402 (codegenie and the
      // workflow read those as permanent: no retry); too many in flight a 429.
      const c = ciOn();
      const problem = ciBodyProblem(body, Array.isArray(c.models) ? c.models : []);
      if (problem) throw fail(403, "not_allowed", problem);
      if ((q.ciInflight.get(`${who.ci.repo}#`, `${who.ci.repo}#`) as { n: number }).n >= CI_INFLIGHT) throw fail(429, "too_many_calls", `at most ${CI_INFLIGHT} CI calls in flight per repo`);
    }
    const price = priceOf(body);
    const upKey = secret("openrouter_key");
    if (!upKey) throw fail(503, "no_upstream_key", "the gateway has no OpenRouter key");
    // Bounded output: the request's own limit, the model's, and what the tightest cap has left (reserve).
    const field = path === "responses" ? "max_output_tokens" : "max_tokens";
    const asked = [body[field], body.max_completion_tokens].filter((n): n is number => Number.isInteger(n) && (n as number) > 0);
    const per = price.peak / 1e6;
    const id = `gw:${randomUUID()}`;
    const r = reserve(who, t0, id, body.model, Math.ceil(Buffer.byteLength(raw) / 3) * price.in * per, price.out * per, Math.min(price.max_output, ...asked));
    if ("over" in r) {
      const over = r.over;
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
    // Settled once, however the call ends: the billed usage at max(reported, tokens x price), else the reservation.
    const settle = (status: string, u?: Usage) => {
      const floor = u ? (u.input * price.in + u.cached * price.cached_in + u.output * price.out) / 1e6 : 0;
      const row = [new Date(now()).toISOString(), String(u?.model || body.model).slice(0, 120), u?.input ?? 0, u?.cached ?? 0, u?.output ?? 0, u ? Math.max(u.costUsd ?? 0, floor) : r.usd, now() - t0, status, id];
      try { q.settle.run(u?.key ?? id, ...row); } catch { q.settle.run(id, ...row); } // a generation id already used keeps the reservation's key
    };
    let up: Response;
    try {
      up = await fetch(`${upstream}/${path}`, { method: "POST", headers: { "content-type": "application/json", accept: req.headers.accept ?? "*/*", authorization: `Bearer ${upKey}` }, body: JSON.stringify(body) });
    } catch (e) {
      settle("upstream_error");
      throw fail(502, "upstream_error", `OpenRouter unreachable (${(e as Error).message})`);
    }
    const tap = usageTap(String(up.headers.get("content-type") ?? "").includes("event-stream"));
    const text = new TextDecoder();
    // Read to the end even if the caller hung up, so what OpenRouter billed still lands in the ledger.
    let status = "upstream_aborted";
    try {
      res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k))));
      if (up.body) for await (const c of up.body) { if (!res.destroyed) res.write(c); tap.feed(text.decode(c, { stream: true })); }
      status = up.ok ? "ok" : `upstream_${up.status}`;
    } finally {
      settle(status, tap.done());
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
    metric("aidenhq_gateway_ci_day_cap_usd", "App CI code review's all-repos day cap (0: CI review off).", [[{}, ci?.enabled ? Number(ci.day_usd) || 0 : 0]]);
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
        if (req.method === "POST" && path === "/api/v1/chat/completions") return await model(req, res, "agent", "chat/completions", true);
        return send(res, 404, { error: { code: 404, type: "not_found", message: "no such route" } });
      }
      const c = /^\/c\/([a-z0-9_]+)\/mcp$/.exec(path);
      if (c) { if (!tools) throw fail(404, "not_found", "no such route"); return await tools(req, res, c[1]!, { jobs: true }); }
      const m = ROUTE.exec(path);
      if (req.method === "POST" && m) return await model(req, res, m[1] ?? "agent", m[2]!);
      if (req.method === "POST" && path === "/usage") {
        boardKeyed(req);
        const { since } = JSON.parse((await readBody(req)) || "{}") as { since?: unknown };
        const records = (q.since.all(String(since ?? "")) as CallRow[]).map((r) => ({ key: r.key, at: r.at, agentId: r.agent_id, component: r.component, model: r.model, input: r.input, cached: r.cached, output: r.output, costUsd: r.cost_usd, runKey: r.run_key, runId: r.run_id, issueId: r.issue_id, rev: r.rev, kind: r.kind, ms: r.ms, status: r.status, ...(r.kind === CI_KIND ? { subject: r.task_subject } : {}) }));
        return send(res, 200, { records });
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

  return { handle, db, metricsText, ciEnabled: () => Boolean(ciConf()?.enabled), close: () => { clearInterval(pruner); db.close(); } };
}
