// The model gateway's logic (gateway.mjs wires it to its listeners): who a call is for, the spend caps, the pass-through
// to OpenRouter with what it billed tapped from the answer, and the ledger (SQLite) the board pulls.
//
// Routes (OpenRouter-compatible; the caller's "API key" is its own per-run credential, never the OpenRouter key):
//   POST /api/v1/responses | /api/v1/chat/completions            kind agent (or the service kind its credential fixes)
//   POST /advisor/api/v1/... | /fanout/api/v1/...                kind advisor | fanout, counted against the caller's run
//   POST /usage {since}           (Bearer gateway_board_key) the ledger since then → {records} (the board's Costs tab)
//   POST /internal/caps {scope, agentId, subject, cap}  (Bearer gateway_board_key) the owner raised a cap: the new cap
//   GET /health
// CI listener (gateway.mjs, the CI runners' bridge address; only these routes, only `ahqci_` credentials, never on the others):
//   POST /ci/token                (Bearer: a GitHub Actions OIDC token, ci.mjs) -> {token, expires_at}: an opaque CI token
//   POST /api/v1/chat/completions  kind ci-code-review: the allowed models only, CI's own caps, attributed to repo and PR
//   GET /health
// Credentials: a Paperclip run JWT (Codex in Paperclip, env_key PAPERCLIP_API_KEY; checked at Paperclip's /api/agents/me,
// its run id from the checked token, the task from that run); an agent computer's run token `ahqc_` (the launcher forwards
// its boxes' calls here with it; the launcher's /whoami names the agent, Paperclip run and task, asked every call so a run
// that ended stops at once); a runner token `ahqj_` (token.mjs: an Engineer job, or the runner's reviewer/grader/intake); the source writers' key (gateway_source_key); Paperclip's harness key
// (gateway_harness_key: the new-agent hello probe, whose env has no run JWT). The run key is the credential's sha256.
// Caps: run / task / agent-day (grants caps, defaults 2/10/30 USD), checked before each call as settled + in flight. A task
// labelled `chat` or a routine's execution task is perpetual: its task cap counts the UTC day only. System kinds
// (reviewer, grader, source) are never capped. config/gateway.json {"enforce_caps": false} turns refusals off (tracking stays).
// CI caps (config/gateway.json `ci`: per repo per UTC day, all CI per day) are always enforced and never filed for raising.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CI_KIND, CI_PREFIX, ciBodyProblem, githubKeys, verifyGithubOidc } from "./ci.mjs";
import { verifyToken } from "./token.mjs";

export const DEFAULT_CAPS = { run_usd: 2, task_usd: 10, day_usd: 30 };
const SYSTEM = { reviewer: "AI reviewer", grader: "Grader", source: "Source writers" };
const ROUTE = /^\/(?:(advisor|fanout)\/)?api\/v1\/(responses|chat\/completions)$/;
const MAX_BODY = 32 * 1024 * 1024;
const DAY_MS = 864e5;
// CI: a token lives 2 h (the job's timeout is 90 min); a repo gets at most 200 a day and 8 calls in flight; each call in flight
// holds at least $0.10 against the caps (a fresh token has no average), and a call OpenRouter didn't price is billed that.
const CI_TTL_MS = 2 * 3600_000;
const CI_TOKENS_PER_DAY = 200;
const CI_INFLIGHT = 8;
const CI_RESERVE_USD = 0.1;
const CI_MAX_BODY = 8 * 1024 * 1024;
// CI tokens a repo may be issued a minute. Only verified exchanges count (ci.mjs checks the claims, then GitHub's signature,
// about 20 microseconds), so a flood of forged or foreign tokens never uses up a real job's budget; one repo's flood of
// genuine ones only uses its own. Refusals on the CI listener are logged at most CI_REFUSALS_LOGGED a minute.
const CI_TOKENS_PER_MIN = 20;
const CI_REFUSALS_LOGGED = 20;

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const same = (a, b) => Boolean(a && b) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, type, message, extra = {}) => Object.assign(new Error(message), { status, type, extra });

/** A JSON file re-read when it changes; `fallback` when it's missing or unreadable. */
function watched(file, pick, fallback) {
  let cache;
  return () => {
    let st;
    try { st = statSync(file); } catch { return fallback; }
    if (!cache || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
      let v = fallback;
      try { v = pick(JSON.parse(readFileSync(file, "utf8"))); } catch {}
      cache = { mtimeMs: st.mtimeMs, size: st.size, v };
    }
    return cache.v;
  };
}

export function openLedger(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS calls (key TEXT PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, run_key TEXT NOT NULL, run_id TEXT, agent_id TEXT,
      issue_id TEXT, task_subject TEXT, rev TEXT, kind TEXT NOT NULL, component TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cost_usd REAL, ms INTEGER, status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS calls_run ON calls (run_key);
    CREATE INDEX IF NOT EXISTS calls_task ON calls (agent_id, task_subject);
    CREATE INDEX IF NOT EXISTS calls_day ON calls (agent_id, day);
    CREATE INDEX IF NOT EXISTS calls_at ON calls (at);
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
  return db;
}

/**
 * What OpenRouter billed for one call, read as the answer passes: the last SSE `data:` line with a usage block (a chat
 * completion's final chunk, or `response.completed`), or the whole JSON body. done() → { key, model, input (uncached),
 * cached, output, costUsd } or undefined. The model is the one OpenRouter answered with.
 */
export function usageTap(sse) {
  let tail = "", body = "", found;
  const take = (text) => {
    if (!text.includes('"usage"')) return;
    try {
      const j = JSON.parse(text);
      const r = j?.type === "response.completed" ? j.response : j;
      if (r?.usage && typeof r.id === "string") found = r;
    } catch {}
  };
  return {
    feed(text) {
      if (!sse) { if (body.length < MAX_BODY) body += text; return; }
      const lines = (tail + text).split("\n");
      tail = lines.pop();
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
export function createGateway({ dbFile, grantsFile, settingsFile, secret, upstream = "https://openrouter.ai/api/v1", paperclipUrl, boardUrl, launcherUrl, githubJwksUrl, log = () => {}, now = Date.now }) {
  const db = openLedger(dbFile);
  const grants = watched(grantsFile, (j) => j.agents ?? {}, {});
  const enforcing = watched(settingsFile, (j) => j.enforce_caps !== false, true);
  // CI code review (compile writes it from the ci module's settings): { enabled, orgs, models, repo_day_usd, day_usd } or null.
  const ciConf = watched(settingsFile, (j) => (j.ci && typeof j.ci === "object" ? j.ci : null), null);
  const keyFor = githubKeys(githubJwksUrl, now);
  const inflight = new Map(); // id → { runKey, agentId, subject, day, est, ciRepo }
  const q = {
    run: db.prepare("SELECT * FROM runs WHERE run_key = ?"),
    addRun: db.prepare("INSERT OR IGNORE INTO runs (run_key, agent_id, run_id, issue_id, rev, perpetual, at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    add: db.prepare("INSERT OR IGNORE INTO calls (key, at, day, run_key, run_id, agent_id, issue_id, task_subject, rev, kind, component, model, input, cached, output, cost_usd, ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    spentRun: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s, COUNT(cost_usd) AS n FROM calls WHERE run_key = ?"),
    spentTask: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE agent_id = ? AND task_subject = ?"),
    spentDay: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE agent_id = ? AND day = ?"),
    cap: db.prepare("SELECT cap FROM caps WHERE scope = ? AND agent_id = ? AND subject = ?"),
    setCap: db.prepare("INSERT INTO caps (scope, agent_id, subject, cap, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (scope, agent_id, subject) DO UPDATE SET cap = excluded.cap, at = excluded.at"),
    file: db.prepare("INSERT OR IGNORE INTO filed (scope, agent_id, subject, cap, at) VALUES (?, ?, ?, ?, ?)"),
    unfile: db.prepare("DELETE FROM filed WHERE scope = ? AND agent_id = ? AND subject = ? AND cap = ?"),
    since: db.prepare("SELECT * FROM calls WHERE at >= ? ORDER BY at LIMIT 20000"),
    ciToken: db.prepare("SELECT * FROM ci_tokens WHERE hash = ?"),
    addCiToken: db.prepare("INSERT OR IGNORE INTO ci_tokens (hash, repo, pr, head, gh_run, attempt, exp, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    ciIssued: db.prepare("SELECT COUNT(*) AS n FROM ci_tokens WHERE repo = ? AND substr(at, 1, 10) = ?"),
    // A CI call's task_subject is `<owner>/<repo>#<pr>`.
    ciSpentRepo: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE kind = 'ci-code-review' AND day = ? AND substr(task_subject, 1, length(?)) = ?"),
    ciSpent: db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE kind = 'ci-code-review' AND day = ?"),
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

  async function paperclip(path, token) {
    const res = await fetch(new URL(path, paperclipUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw Object.assign(new Error(`Paperclip ${path.split("/")[2]} answered ${res.status}`), { status: res.status });
    return res.json();
  }

  /** A Paperclip run's task (Paperclip's record of the run, else `hint`) and whether that task is perpetual. */
  async function runTask(runId, hint = null) {
    const board = secret("paperclip_board_key");
    const run = runId ? await paperclip(`/api/heartbeat-runs/${encodeURIComponent(runId)}`, board).catch(() => undefined) : undefined;
    const issueId = run?.issueId ?? run?.contextSnapshot?.issueId ?? hint ?? null;
    const issue = issueId ? await paperclip(`/api/issues/${encodeURIComponent(issueId)}`, board).catch(() => undefined) : undefined;
    return { issueId, perpetual: Boolean(issue && ((issue.labels ?? []).some((l) => l?.name === "chat") || issue.originKind === "routine_execution")) };
  }

  /** A computer's run token as the launcher that issued it knows it now: { agentId, runId, issueId }. */
  async function computerRun(token) {
    if (!launcherUrl) throw fail(503, "unauthorized", "this gateway doesn't know where the computer launcher is");
    const res = await fetch(new URL("/whoami", launcherUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
      .catch((e) => { throw fail(503, "unauthorized", `the computer launcher is unreachable (${e.message})`); });
    if (res.status === 401) throw fail(401, "unauthorized", "this computer's run has ended");
    if (!res.ok) throw fail(503, "unauthorized", `the computer launcher answered ${res.status}`);
    const j = await res.json().catch(() => undefined);
    if (typeof j?.agentId !== "string" || !j.agentId) throw fail(401, "unauthorized", "the run token doesn't name its agent");
    return j;
  }

  /** A run key's identity, settled once: the agent, Paperclip's run id, its task and whether that task is perpetual, the rev. */
  function settle(runKey, { agentId = null, runId = null, issueId = null, perpetual = false }) {
    q.addRun.run(runKey, agentId, runId, issueId, (agentId && grants()[agentId]?.rev) || null, perpetual ? 1 : 0, new Date(now()).toISOString());
    return q.run.get(runKey);
  }

  /** Who the call is for: { runKey, agentId, runId, issueId, perpetual, rev, kind, component, capped }. Throws 401 otherwise. */
  async function identify(cred, routeKind, ci = false) {
    if (!cred) throw fail(401, "unauthorized", "no credential: the API key must be this run's own credential");
    const runKey = sha256(cred);
    // The CI listener takes CI tokens only, and CI tokens work nowhere else: no other credential is even looked at there.
    if (ci !== cred.startsWith(CI_PREFIX)) throw fail(401, "unauthorized", ci ? "this address takes CI tokens only (POST /ci/token)" : "not a credential this gateway knows");
    if (ci) {
      ciOn();
      const t = q.ciToken.get(runKey);
      if (!t || Date.parse(t.exp) <= now()) throw fail(401, "unauthorized", "this CI token is invalid or expired");
      return { runKey, agentId: null, runId: null, issueId: null, perpetual: false, rev: t.head ?? null, kind: CI_KIND, component: CI_KIND, capped: false, ci: { repo: t.repo, subject: `${t.repo}#${t.pr}` } };
    }
    const as = (row, kind, component, capped) => ({ runKey, agentId: row?.agent_id ?? null, runId: row?.run_id ?? null, issueId: row?.issue_id ?? null, perpetual: Boolean(row?.perpetual), rev: row?.rev ?? null, kind, component, capped });
    if (same(cred, secret("gateway_source_key"))) return as(null, "source", SYSTEM.source, false);
    if (same(cred, secret("gateway_harness_key"))) {
      // Paperclip's hello probe for a new agent: one shared key, so its "run" is the UTC day.
      return { ...as(null, routeKind, "agent", true), runKey: `harness:${day(now())}` };
    }
    if (cred.startsWith("ahqj_")) {
      const p = verifyToken(secret("gateway_job_secret"), cred, now());
      if (!p) throw fail(401, "unauthorized", "this run's model credential is invalid or expired");
      const row = q.run.get(runKey) ?? settle(runKey, { agentId: p.a, issueId: p.i });
      const system = p.k !== "agent";
      const component = String(p.c ?? (system ? SYSTEM[p.k] : "Engineer jobs")).slice(0, 80);
      return as(row, system ? p.k : routeKind, component, !system);
    }
    if (cred.startsWith("ahqc_")) {
      const box = await computerRun(cred);
      let row = q.run.get(runKey);
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
      let claims = {};
      try { claims = JSON.parse(Buffer.from(cred.split(".")[1], "base64url").toString("utf8")); } catch {}
      // A settled run key outlives Paperclip's check; the JWT's own expiry (Paperclip's TTL, 48h by default) still ends it.
      if (typeof claims.exp === "number" && claims.exp * 1000 <= now()) throw fail(401, "unauthorized", "this run's credential has expired");
      let row = q.run.get(runKey);
      if (!row) {
        // The JWT is genuine if Paperclip accepts it; only then is its payload (run id, agent) read.
        const me = await paperclip("/api/agents/me", cred).catch((e) => { throw fail(e.status === 401 || e.status === 403 ? 401 : 503, "unauthorized", e.message); });
        if (!me?.id || claims.sub !== me.id) throw fail(401, "unauthorized", "the run credential doesn't name its agent");
        row = settle(runKey, { agentId: me.id, runId: claims.run_id ?? null, ...(await runTask(claims.run_id)) });
      }
      return as(row, routeKind, "agent", true);
    }
    throw fail(401, "unauthorized", "not a credential this gateway knows");
  }

  const capOf = (who, scope, subject) => {
    const own = { ...DEFAULT_CAPS, ...((who.agentId && grants()[who.agentId]?.caps) || {}) }[`${scope}_usd`];
    return q.cap.get(scope, who.agentId ?? "", subject)?.cap ?? own;
  };
  const taskSubject = (who, t) => (who.issueId ? (who.perpetual ? `${who.issueId}:${day(t)}` : who.issueId) : null);

  /** The first cap this call would pass (settled + in flight), or undefined. */
  function overCap(who, t) {
    const pending = (pick) => [...inflight.values()].filter(pick).reduce((s, c) => s + c.est, 0);
    const today = day(t);
    const subject = taskSubject(who, t);
    const scopes = [
      ["run", who.runKey, () => q.spentRun.get(who.runKey).s + pending((c) => c.runKey === who.runKey)],
      ...(who.agentId && subject ? [["task", subject, () => q.spentTask.get(who.agentId, subject).s + pending((c) => c.agentId === who.agentId && c.subject === subject)]] : []),
      ...(who.agentId ? [["day", today, () => q.spentDay.get(who.agentId, today).s + pending((c) => c.agentId === who.agentId && c.day === today)]] : []),
    ];
    for (const [scope, subj, spentFn] of scopes) {
      const cap = capOf(who, scope, subj);
      const spent = spentFn();
      if (spent >= cap) return { scope, subject: subj, cap, spent };
    }
    return undefined;
  }

  /** The CI settings, when CI is on; else a 403 (settings.ci_review: off refuses every CI token at once). */
  function ciOn() {
    const c = ciConf();
    if (!c?.enabled) throw fail(403, "ci_off", "CI code review through the model gateway is off on this instance");
    return c;
  }

  /**
   * The first CI cap this call would pass: settled + in flight + this call's own reservation, the repo's day then all CI's
   * day; or undefined. A call may still cost more than its reservation, so a cap can be passed by at most what the calls in
   * flight (8 per repo) cost beyond theirs.
   */
  function ciOverCap(who, t, c, reserve) {
    const today = day(t);
    const pending = (pick) => [...inflight.values()].filter((x) => x.ciRepo && x.day === today && pick(x)).reduce((s, x) => s + x.est, 0);
    const prefix = `${who.ci.repo}#`;
    const scopes = [
      ["repo-day", Number(c.repo_day_usd), () => q.ciSpentRepo.get(today, prefix, prefix).s + pending((x) => x.ciRepo === who.ci.repo)],
      ["day", Number(c.day_usd), () => q.ciSpent.get(today).s + pending(() => true)],
    ];
    for (const [scope, cap, spentFn] of scopes) {
      const spent = spentFn();
      if (!(cap > 0) || spent + reserve > cap) return { scope, cap: cap > 0 ? cap : 0, spent };
    }
    return undefined;
  }

  /**
   * POST /ci/token: a GitHub Actions OIDC token in, an opaque CI token bound to the repo and PR it names out. Everything after
   * the body is read is synchronous, so two exchanges for one run attempt can't both pass: the row's UNIQUE (repo, run,
   * attempt) decides, and once written it stays, whatever happens to the answer (fail closed).
   */
  let issued = { minute: 0, byRepo: new Map() };
  async function ciToken(req, res) {
    const c = ciOn();
    const claims = await verifyGithubOidc(bearer(req), { orgs: Array.isArray(c.orgs) ? c.orgs : [], keyFor, now });
    let body = {};
    try { body = JSON.parse((await readBody(req, 4096)) || "{}") ?? {}; } catch (e) { if (e.status) throw e; }
    // No await from here on.
    const minute = Math.floor(now() / 60_000);
    if (issued.minute !== minute) issued = { minute, byRepo: new Map() };
    const n = (issued.byRepo.get(claims.repo) ?? 0) + 1;
    issued.byRepo.set(claims.repo, n);
    if (n > CI_TOKENS_PER_MIN) throw fail(429, "too_many_tokens", `${claims.repo} has had ${CI_TOKENS_PER_MIN} CI tokens this minute`);
    const t = now();
    if (q.ciIssued.get(claims.repo, day(t)).n >= CI_TOKENS_PER_DAY) throw fail(429, "too_many_tokens", `${claims.repo} has had ${CI_TOKENS_PER_DAY} CI tokens today`);
    const token = `${CI_PREFIX}${randomBytes(32).toString("base64url")}`;
    const head = /^[0-9a-f]{40}$/.test(String(body.head ?? "")) ? body.head : null; // advisory: the job says so
    const exp = new Date(t + CI_TTL_MS).toISOString();
    if (!q.addCiToken.run(sha256(token), claims.repo, claims.pr, head, claims.runId, claims.attempt, exp, new Date(t).toISOString()).changes) {
      throw fail(401, "unauthorized", "this run attempt has already traded its GitHub token");
    }
    log("ci token issued", { repo: claims.repo, pr: claims.pr, run: claims.runId });
    send(res, 200, { token, expires_at: exp });
  }

  /** One raise_cap per scope, subject and cap value, filed on the board with the gateway's key (needs the run's task). */
  async function fileRaise(who, over) {
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
      log("raise_cap filing failed", { err: String(e.message).slice(0, 300) });
      return false;
    }
  }

  // Stamped when the call ends (the board pulls by that time); counted on the UTC day it started.
  function record(who, r) {
    const t = r.t ?? now();
    q.add.run(r.key ?? `gw:${randomUUID()}`, new Date(now()).toISOString(), day(t), who.runKey, who.runId, who.agentId, who.issueId, who.ci ? who.ci.subject : taskSubject(who, t), who.rev, who.kind, who.component, String(r.model ?? "").slice(0, 120) || "unknown", r.input ?? 0, r.cached ?? 0, r.output ?? 0, r.costUsd ?? null, r.ms ?? null, r.status);
  }

  const send = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const bearer = (req) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  async function readBody(req, max = MAX_BODY) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > max) throw fail(413, "too_large", "request too large");
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function model(req, res, routeKind, path, ci = false) {
    const t0 = now();
    const who = await identify(bearer(req), routeKind, ci);
    let body;
    try { body = JSON.parse(await readBody(req, ci ? CI_MAX_BODY : MAX_BODY)); } catch (e) { throw e.status ? e : fail(400, "bad_request", "the body must be JSON"); }
    if (!body || typeof body !== "object" || typeof body.model !== "string") throw fail(400, "bad_request", "a model call needs a model");
    if (who.ci) {
      // CI's own gates, whatever the kill switch says: the models and fields it may use, calls in flight, its day caps. A
      // refusal is a 403 or 402 (codegenie and the workflow read those as permanent: no retry); too many in flight a 429.
      const c = ciOn();
      const problem = ciBodyProblem(body, Array.isArray(c.models) ? c.models : []);
      if (problem) throw fail(403, "not_allowed", problem);
      if ([...inflight.values()].filter((x) => x.ciRepo === who.ci.repo).length >= CI_INFLIGHT) throw fail(429, "too_many_calls", `at most ${CI_INFLIGHT} CI calls in flight per repo`);
      const avg = q.spentRun.get(who.runKey);
      const over = ciOverCap(who, t0, c, Math.max(CI_RESERVE_USD, avg.n ? avg.s / avg.n : 0));
      if (over) {
        record(who, { key: `cap:${who.ci.repo}:${over.scope}:${day(t0)}:${over.cap}`, model: body.model, status: "cap_reached", t: t0, ms: 0 });
        throw fail(402, "cap_reached", `spend cap reached: CI ${over.scope} $${over.spent.toFixed(2)} of $${over.cap.toFixed(2)}; the owner can raise it in settings`, { scope: over.scope, cap: over.cap, spent: over.spent });
      }
    }
    if (who.capped && enforcing()) {
      const over = overCap(who, t0);
      if (over) {
        const filed = await fileRaise(who, over);
        // One ledger row per run, scope and cap: a refused turn arrives several times (Codex retries a 402 five times).
        record(who, { key: `cap:${who.runKey}:${over.scope}:${over.cap}`, model: body.model, status: "cap_reached", t: t0, ms: 0 });
        const what = over.scope === "day" ? "agent-day" : over.scope; // no date or time: Paperclip reads one as a retry time
        // Worded to match none of Paperclip's retry/quota patterns (no automatic re-run).
        const next = over.scope === "run" ? "this run stops here; the next run starts with a fresh run cap" : filed ? "the owner has been asked to raise it" : "the owner must raise it";
        const message = `spend cap reached: ${what} $${over.spent.toFixed(2)} of $${over.cap.toFixed(2)}; ${next}`;
        throw fail(402, "cap_reached", message, { scope: over.scope, cap: over.cap, spent: over.spent });
      }
    }
    body.provider = { ...(body.provider && typeof body.provider === "object" ? body.provider : {}), zdr: true };
    const key = secret("openrouter_key");
    if (!key) throw fail(503, "no_upstream_key", "the gateway has no OpenRouter key");
    const id = randomUUID();
    const avg = q.spentRun.get(who.runKey);
    const est = Math.max(who.ci ? CI_RESERVE_USD : 0, avg.n ? avg.s / avg.n : 0);
    inflight.set(id, { runKey: who.runKey, agentId: who.agentId, subject: taskSubject(who, t0), day: day(t0), est, ciRepo: who.ci?.repo });
    try {
      let up;
      try {
        up = await fetch(`${upstream}/${path}`, { method: "POST", headers: { "content-type": "application/json", accept: req.headers.accept ?? "*/*", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
      } catch (e) {
        record(who, { model: body.model, status: "upstream_error", t: t0, ms: now() - t0 });
        throw fail(502, "upstream_error", `OpenRouter unreachable (${e.message})`);
      }
      res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k))));
      const tap = usageTap(String(up.headers.get("content-type") ?? "").includes("event-stream"));
      const text = new TextDecoder();
      // Read to the end even if the caller hung up, so what OpenRouter billed still lands in the ledger. If OpenRouter's
      // stream breaks, the row is still written (upstream_aborted): the billed usage if it arrived, else this run's average call.
      let status = "upstream_aborted";
      try {
        if (up.body) for await (const c of up.body) { if (!res.destroyed) res.write(c); tap.feed(text.decode(c, { stream: true })); }
        status = up.ok ? "ok" : `upstream_${up.status}`;
      } finally {
        const u = tap.done();
        // A CI call OpenRouter didn't price (ok or broken off) is billed its reservation, so it still counts against the caps.
        record(who, { ...u, costUsd: u?.costUsd ?? (status === "upstream_aborted" || (who.ci && status === "ok") ? est : null), model: u?.model || body.model, status, t: t0, ms: now() - t0 });
      }
      if (!res.destroyed) res.end();
    } finally {
      inflight.delete(id);
    }
  }

  function boardKeyed(req) {
    if (!same(bearer(req), secret("gateway_board_key"))) throw fail(401, "unauthorized", "unauthorized");
  }

  let refusals = { minute: 0, n: 0 };
  /** Whether a CI listener refusal may still be logged this minute (a flood of junk must not flood the journal). */
  function ciRefusalLogged() {
    const minute = Math.floor(now() / 60_000);
    if (refusals.minute !== minute) refusals = { minute, n: 0 };
    return ++refusals.n <= CI_REFUSALS_LOGGED;
  }

  /** `ci`: the request came in on the CI listener (gateway.mjs), which serves the CI routes only. */
  async function handle(req, res, { ci = false } = {}) {
    try {
      const path = String(req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/health") return send(res, 200, ci ? { ok: true } : { ok: true, enforcing: enforcing(), inflight: inflight.size });
      if (ci) {
        if (req.method === "POST" && path === "/ci/token") return await ciToken(req, res);
        if (req.method === "POST" && path === "/api/v1/chat/completions") return await model(req, res, "agent", "chat/completions", true);
        return send(res, 404, { error: { code: 404, type: "not_found", message: "no such route" } });
      }
      const m = ROUTE.exec(path);
      if (req.method === "POST" && m) return await model(req, res, m[1] ?? "agent", m[2]);
      if (req.method === "POST" && path === "/usage") {
        boardKeyed(req);
        const { since } = JSON.parse((await readBody(req)) || "{}");
        const records = q.since.all(String(since ?? "")).map((r) => ({ key: r.key, at: r.at, agentId: r.agent_id, component: r.component, model: r.model, input: r.input, cached: r.cached, output: r.output, costUsd: r.cost_usd, runKey: r.run_key, runId: r.run_id, issueId: r.issue_id, rev: r.rev, kind: r.kind, ms: r.ms, status: r.status, ...(r.kind === CI_KIND ? { subject: r.task_subject } : {}) }));
        return send(res, 200, { records });
      }
      if (req.method === "POST" && path === "/internal/caps") {
        boardKeyed(req);
        const b = JSON.parse((await readBody(req)) || "{}");
        if (!["run", "task", "day"].includes(b.scope) || typeof b.agentId !== "string" || !b.agentId || !/^[\w:.-]{1,128}$/.test(String(b.subject)) || !(b.cap > 0 && b.cap <= 1000)) throw fail(400, "bad_request", "send {scope: run|task|day, agentId, subject, cap (USD, 0-1000]}");
        q.setCap.run(b.scope, b.agentId, b.subject, b.cap, new Date(now()).toISOString());
        log("cap set", { scope: b.scope, agent: b.agentId, subject: b.subject, cap: b.cap });
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: { code: 404, type: "not_found", message: "no such route" } });
    } catch (e) {
      const status = e.status ?? 500;
      if ((status >= 500 || status === 401) && (!ci || ciRefusalLogged())) log("refused", { url: req.url, status, err: String(e.message).slice(0, 300) });
      if (!res.headersSent) send(res, status, { error: { code: status, type: e.type ?? "error", message: e.message, ...(e.extra ?? {}) } });
      else res.destroy();
    }
  }

  return { handle, db, ciEnabled: () => Boolean(ciConf()?.enabled), close: () => { clearInterval(pruner); db.close(); } };
}
