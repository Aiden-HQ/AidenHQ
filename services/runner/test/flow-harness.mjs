// Shared by the flow-*.test.mjs files (one conversation each, so node runs them side by side): the real runner
// (src/main.mjs) as a child process, talking to a fake Paperclip, with fakes (test/fakes: codex and the agent behind it, gh)
// and local repositories for GitHub. Its jobs run in the kernel's job half (kernel/test/fixtures/jobs-host.mjs, the real
// kernel/src/jobs.ts in its own process), which the fake Paperclip's /v1/jobs routes lead to, each in a box from a fake
// launcher (jobLauncher) that the stand-in docker runs on the host, with the real engine (engine-codex, codex-openrouter).
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { State } from "../src/state.ts";
import { mintToken } from "../../../kernel/src/gateway/token.ts";
import { REQUEST_FIELDS } from "../../../kernel/sdk/src/reviewer.ts";
import { reviewWith } from "../../../modules/ai-reviewer/service/src/server.mjs";
import { readLog } from "./fakes/lib.mjs";
import { registry } from "./fakes/engines.mjs";
import { fakeJail } from "./fakes/jail.mjs";
import { openRecords } from "../../../kernel/src/records.ts";
import { createWrites } from "../../../kernel/src/writes.ts";
import { createBackplane } from "../../../kernel/src/backplane.ts";
import { KERNEL_KINDS } from "../../../kernel/src/kinds.ts";
import { asApproval } from "../src/cards.ts";

const RUNNER = join(import.meta.dirname, "../src/main.mjs");
const JOBS_HOST = join(import.meta.dirname, "../../../kernel/test/fixtures/jobs-host.mjs");
const DOCKER = join(import.meta.dirname, "../../../kernel/test/fixtures/docker.mjs");
const ROOT = join(import.meta.dirname, "../../..");

/**
 * The computer launcher's job routes (bearer computers_runner_key = "runner-key"), as the runner sees them, for every job's box:
 * each box is its env file and a record beside it under `jobsDir` (the stand-in docker, kernel/test/fixtures/docker.mjs, runs
 * the engine on the host from it), and the launcher's own record in jobs.json, which the kernel checks a job against. The env
 * file carries what the real one does (the run token, the helper as AIDENHQ_REPO_URL, the commit identity, the Codex home) and
 * `env` (the fakes' settings, a PATH with the fakes first). `opts`: `failJob` (a 500), `survive` (releases answering
 * "running"), `die` (the box is gone when the job runs).
 */
export function jobLauncher(jobsDir, env = {}) {
  const calls = [];
  const opts = { failJob: false, survive: 0, die: false };
  const goneAt = new Map();
  let n = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const send = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    if (req.headers.authorization !== "Bearer runner-key") return send(401, { error: "unauthorized" });
    calls.push({ route: req.url, body, at: Date.now() });
    const file = (c) => join(jobsDir, `${c}.box.json`);
    if (req.url === "/job") {
      if (opts.failJob) return send(500, { error: "docker run failed: no space left" });
      mkdirSync(jobsDir, { recursive: true });
      const container = `aidenhq-computer-t${++n}`;
      const outDir = join(jobsDir, container);
      mkdirSync(outDir, { recursive: true });
      const engineDir = JSON.parse(readFileSync(join(env.AIDENHQ_CONFIG_DIR, "engines.json"), "utf8"))[body.engine]?.dir ?? "";
      writeFileSync(file(container), JSON.stringify({ workspace: body.workspace, outDir, engineDir, die: opts.die }));
      const id = body.identity ?? {};
      const lines = { AIDENHQ_RUN_TOKEN: "ahqc_x", AIDENHQ_REPO_URL: `http://127.0.0.1:${body.helperPort}`, AIDENHQ_REPO_TOKEN: body.helperToken, AIDENHQ_TASK_WORKTREE: "/workspace", CODEX_HOME: body.state, GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "tag.gpgsign", GIT_CONFIG_VALUE_1: "false", ...Object.fromEntries(Object.entries(env).filter(([k]) => k === "PATH" || k === "HOME" || k.startsWith("FAKE_"))) };
      writeFileSync(join(jobsDir, `${container}.env`), Object.entries(lines).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
      const recs = existsSync(join(jobsDir, "../jobs.json")) ? JSON.parse(readFileSync(join(jobsDir, "../jobs.json"), "utf8")) : [];
      writeFileSync(join(jobsDir, "../jobs.json"), JSON.stringify([...recs, { container, agentId: body.agentId, issueId: body.issueId, workspace: body.workspace }]));
      return send(200, { container, envFile: join(jobsDir, `${container}.env`), outDir });
    }
    const box = existsSync(file(body.container)) ? JSON.parse(readFileSync(file(body.container), "utf8")) : { gone: true };
    if (req.url === "/job/renew") return box.gone ? send(404, { error: "box gone" }) : send(200, { container: body.container, issueId: body.issueId, workspace: box.workspace });
    if (req.url === "/job/release") {
      if (!box.gone && opts.survive > 0) return opts.survive--, send(200, { state: "running" });
      if (!box.gone) writeFileSync(file(body.container), JSON.stringify({ ...box, gone: true }));
      if (!goneAt.has(body.container)) goneAt.set(body.container, Date.now());
      return send(200, { state: "missing" });
    }
    send(404, { error: "no such route" });
  });
  return { server, calls, opts, goneAt };
}

/** The stand-in `docker` in `bin`: the box records under `jobsDir` (a fast check's exec names only the container). */
export function fakeDocker(bin, jobsDir) {
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nFAKE_BOXES="${jobsDir}" exec "${process.execPath}" "${DOCKER}" "$@"\n`);
  chmodSync(join(bin, "docker"), 0o755);
}

/** The kernel's job half for a flow: its own process (a restart test kills and starts it again), over `db`. */
export function jobsHost(env, db) {
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", JOBS_HOST], { env: { ...env, JOBS_DB: db, JOBS_MODULE: "engineering" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stderr.on("data", (d) => (log += d));
  const exited = new Promise((r) => p.once("exit", r));
  const port = new Promise((res, rej) => { p.stdout.once("data", (d) => res(Number(String(d).trim()))); p.once("exit", (c) => rej(new Error(`the jobs host exited (${c}): ${log}`))); });
  // A host stopped before anything asked for its port (a flow that never starts a job) is no failure; a caller that awaits
  // the port still gets the error.
  port.catch(() => {});
  /** Kills it and resolves once it has exited. */
  const stop = (signal = "SIGKILL") => { if (p.exitCode === null && p.signalCode === null) p.kill(signal); return exited; };
  return { p, port, stop, log: () => log };
}

/**
 * A loopback port for a runner's helper (runner.yaml helper_port, which the kernel holds it to), claimed for this test process.
 * It is below every OS's ephemeral range (Linux 32768+, macOS 49152+), so no client socket takes it before the runner binds
 * it, and claimed with an exclusive mkdir, so flows running side by side never pick the same one.
 */
export async function freePort() {
  for (let port = 20000 + Math.floor(Math.random() * 12000); ; port = port + 1 < 32000 ? port + 1 : 20000) {
    const claim = join(tmpdir(), `aidenhq-helper-port-${port}`);
    try { mkdirSync(claim); } catch { continue; }
    process.once("exit", () => rmSync(claim, { recursive: true, force: true }));
    const free = await new Promise((r) => { const s = createServer().once("error", () => r(false)).listen(port, "127.0.0.1", () => s.close(() => r(true))); });
    if (free) return port;
  }
}

/** Forward a request to the job host at `port` (the runner's /v1/jobs calls, as the kernel's backplane takes them). */
export async function forwardJobs(port, req, body, res) {
  const r = await fetch(`http://127.0.0.1:${await port}${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, ...(body ? { body } : {}) }).catch((e) => ({ status: 502, text: async () => JSON.stringify({ error: { message: e.message } }) }));
  res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
}
const FAKES = join(import.meta.dirname, "fakes");
const COMPANY = "00000000-0000-4000-8000-000000000001";
const USER = "user-1";

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, stdio: "pipe" }).toString().trim();
// Not tied to any one flow's home: flows may run side by side, and this helper must outlive the flow that last set it up.
const gitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "init.defaultBranch",
  GIT_CONFIG_VALUE_0: "main",
  GIT_CONFIG_KEY_1: "protocol.file.allow",
  GIT_CONFIG_VALUE_1: "always",
};

/** A Paperclip with one parent task (the user's) and one part of it for Ada. */
export function fakePaperclip({ parent, part, engineers, parentComments = [], partComments = [], others = [], grades = new Map(), gateDelayMs = 0, onIssueCreated, ownerFallback = false, config, secrets, repos = {}, jobs, refuseStart = new Map() }) {
  const gradeLog = [];
  const graderCalls = [];
  const graderAnswers = [];
  const issues = new Map([parent, part, ...others.map((o) => o.issue)].map((i) => [i.id, i]));
  const comments = new Map([[parent.id, parentComments], [part.id, partComments], ...others.map((o) => [o.issue.id, o.comments])]);
  const patches = [];
  const activity = [];
  // Requests held open and never answered: a tick that never finishes (a stuck read), so only a pass before it can act.
  const hang = new Set();
  // How many of a task's next single reads fail (a 503): a board that can't say what a task's status is.
  const failRead = new Map();
  // The statuses a task's next comment posts refuse with, in order: a 503 blip, or a 422 the board would repeat.
  const failComment = new Map();
  // A post whose text matches refuses, `times` times ({ text, status, times }): one line the board won't take, others fine.
  const refuseComment = new Map();
  const held = [];
  const passed = [];
  const attached = [];
  const unknown = [];
  const ownerLines = []; // the owner's messages the runner queued at the kernel (POST /v1/notify)
  // The kernel's records for the runner's kinds: the real records, write lifecycle and backplane routes (kernel/src), with
  // the real reviewer module in the reviewer slot. `approvals` and `autos` are views of them as the board once kept them.
  const kdb = openRecords(join(mkdtempSync(join(tmpdir(), "flow-kernel-")), "kernel.db"));
  const key = (n) => { try { return readFileSync(join(secrets, n), "utf8").trim(); } catch { return ""; } };
  const autonomy = () => { try { return JSON.parse(readFileSync(join(config, "grants", "grants.json"), "utf8")).autonomy ?? "off"; } catch { return "off"; } };
  const reviewer = async (request) => {
    const gateway = /gateway:\n {2}url: (\S+)/.exec(readFileSync(join(config, "runner.yaml"), "utf8"))?.[1];
    if (!gateway) throw new Error("no gateway");
    const picked = Object.fromEntries(REQUEST_FIELDS.filter((k) => request[k] !== undefined).map((k) => [k, request[k]]));
    let marked = false;
    const modelToken = mintToken(key("gateway_job_secret"), { kind: "reviewer", component: request.component ?? "AI reviewer", ttlMs: 3600_000 });
    const v = await reviewWith(`${gateway}/api/v1/chat/completions`)(picked, { modelToken, onPanel: async () => void (marked = true) });
    return { ...v, ...(marked ? { panel_marked: true } : {}) };
  };
  const reviews = { request: reviewer };
  const kw = createWrites({ records: kdb, registry: () => KERNEL_KINDS, connections: () => ({}), secret: () => "", resolver: {}, reviews, autonomy, repos: () => ({ product: "acme/aidenhq", instance: "acme/aidenhq-instance", ...repos }),
    onTask: { open: async (t) => !["done", "cancelled"].includes(find(t)?.status), notify: async (t, text) => void notices.push({ task: find(t)?.identifier, text }), parent: async (t) => find(t)?.parentId ?? undefined }, replay: async () => ({ ok: false, text: "" }) });
  const backplane = createBackplane({ whoami: async () => { throw new Error("not here"); }, writes: kw, records: kdb, reviews, runnerKey: () => key("runner_writes_key"), reviewerKey: () => key("reviewer_key"), grantsFile: () => ({}) });
  /** A record as the board once showed it (cards.ts asApproval, the outcome whole, the reviewer's verdict as one entry). */
  const view = (r) => {
    const a = asApproval(r);
    const byReviewer = r.decided_by?.startsWith("reviewer:") || (r.state === "owner" && r.review);
    const verdicts = byReviewer ? [{ decision: r.state === "approved" || (["claimed", "done", "failed"].includes(r.state) && r.decided_by?.startsWith("reviewer:")) ? "approve" : ["rejected", "stale"].includes(r.state) ? "reject" : "escalate", code: r.review_code, reason: r.review, model: r.decided_by?.replace(/^reviewer:/, "").split("+")[0] }] : undefined;
    return { ...a, outcome: r.outcome, ...(verdicts ? { verdicts } : {}) };
  };
  const notices = []; // the kernel's notices on tasks (the owner's rejections, outcomes): kept apart from the thread
  const aliases = new Map(); // a test's own card id → the record it stands for
  const all = () => kdb.list(["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"], 1000).reverse();
  const approvals = {
    values: () => all().filter((r) => r.tier > 0).map(view)[Symbol.iterator](),
    get: (id) => { const r = kdb.get(aliases.get(id) ?? id); return r && view(r); },
    get size() { return all().filter((r) => r.tier > 0).length; },
    /** A card the owner already approved (`state: "approved"`), as a test plants one. */
    set: (id, c) => {
      const kind = c.action === "apply" ? "kernel.apply" : `runner.${c.action}`;
      const r = kdb.file({ kind, module: KERNEL_KINDS[kind].module, args: c.args, targets: {}, executor: { module: KERNEL_KINDS[kind].module }, policy: "test", tier: 2, panel: false, card: { sentence: c.sentence ?? "", changes: "", reads: "", cost: "", details: c.details ?? "" }, requester: { agent: "", key: "", name: "the runner", roles: [], kind: "runner" }, task: c.issueId, identifier: c.identifier, state: "owner" });
      kdb.decide(r.id, r.digest, c.state === "rejected" ? "reject" : "approve", c.decidedBy ?? "account:owner", "web");
      aliases.set(id, r.id);
    },
  };
  const autoRows = () => all().filter((r) => r.tier === 0).map((r) => ({ ...view(r), rule: r.rule, ok: r.outcome?.ok }));
  const autos = { some: (fn) => autoRows().some(fn), at: (i) => autoRows().at(i) };
  // primer.publish (POST /v1/writes with a job token), with the bearer each request came with.
  const records = new Map();
  const created = []; // tasks the runner filed (POST …/issues), as the board key
  const filings = []; // every POST …/issues, created or answered from an idempotency key
  const runs = []; // the runs Paperclip started, one per task it could dispatch
  const wakes = []; // the runs a comment on a task started: Paperclip's task-scoped wake
  let n = 0;
  // Like Paperclip, a comment bumps its task's updatedAt (the runner skips a task it already handled at the same one).
  const addComment = (issueId, body) => {
    const createdAt = new Date(Date.now() + ++n).toISOString();
    comments.get(issueId).push({ id: `comment-${n}`, authorType: "user", authorUserId: USER, body, createdAt });
    const i = issues.get(issueId);
    if (i) i.updatedAt = createdAt;
    // A comment on a task wakes its agent: that is Paperclip's task-scoped wake, and the one an assignment ends in.
    if (i && ["todo", "in_progress", "blocked"].includes(i.status)) dispatch(i, { body });
  };
  const find = (ref) => issues.get(ref) ?? [...issues.values()].find((i) => i.identifier === ref);
  // Paperclip serves a task's blockers resolved, so a blocker whose status changes reads as resolved everywhere.
  const served = (i) => (i.blockedBy ? { ...i, blockedBy: i.blockedBy.map((b) => find(b.id) ?? b) } : i);
  /**
   * Paperclip's wake of an agent on a task it holds (a real Paperclip here, as CLAUDE.md's "Paperclip quirks" describes it).
   * A task filed already assigned starts nothing: it waits in `todo` until a comment on it (or its heartbeat) wakes the agent,
   * which is how the board's wake-ups and a delegation end. The agent holds one folder for a whole run, so a task that doesn't
   * ask for a folder of its own has nothing to run in: it is left in progress with no run, and the terminal recovery blocks it
   * three seconds later. Every delegation carries `agent_default` for exactly this; a task filed without it never runs.
   */
  const dispatch = (i, wake) => {
    const agent = engineers.find((a) => a.id === i.assigneeAgentId);
    if (!agent?.defaultEnvironmentId) return; // a host agent: Paperclip's folder rules don't apply
    // Every wake asked of it, whether or not a live run takes it (`wakes` is what the runner asked for).
    if (wake) wakes.push({ issueId: i.id, agentId: agent.id, body: wake.body });
    if (runs.some((r) => r.issueId === i.id)) return; // a live run takes the comment: no second one
    const mode = i.executionWorkspaceSettings?.mode ?? i.executionWorkspacePreference;
    i.status = "in_progress";
    if (mode === "agent_default" || mode === "isolated_workspace") return void runs.push({ issueId: i.id, agentId: agent.id });
    i.status = "blocked";
    // Paperclip's own notice, not the owner's words.
    comments.get(i.id).push({ id: `system-${++n}`, authorType: "system", authorAgentId: null, authorUserId: null, body: "Paperclip automatically retried continuation for this assigned `in_progress` issue during terminal run recovery, but it still has no live execution path. Moving it to `blocked` so it is visible for intervention.", createdAt: new Date(Date.now() + n).toISOString() });
  };
  // The board's args schema is strict: a merge card's PR entries take these fields only, and any other is a 400 naming it.
  const strictArgs = (args) => (args?.prs ?? []).flatMap((p, i) => Object.keys(p ?? {}).filter((k) => !["repo", "number", "url", "head", "noReview"].includes(k)).map((k) => `prs.${i}: Unrecognized key: "${k}"`));
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://x");
    const send = (json, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const path = url.pathname;
    if (path.startsWith("/v1/jobs")) return forwardJobs(jobs(), req, body, res);
    const agentRead = req.method === "GET" && /^\/api\/agents\/([^/]+)$/.exec(path)?.[1];
    if (agentRead) { const a = engineers.find((x) => x.id === decodeURIComponent(agentRead)); return a ? send(a) : send({ error: "not found" }, 404); }
    // The runner's own kinds, claims, outcomes and reviews: the kernel's real routes (its keys only).
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (/^\/v1\/(writes|reviews)/.test(path) && bearer && [key("runner_writes_key"), key("reviewer_key")].includes(bearer)) {
      return backplane(Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method: req.method, url: req.url, headers: req.headers }), res);
    }
    if (path === "/v1/writes" && req.method === "POST") {
      const id = `k-${String(records.size + 1).padStart(16, "0")}`;
      records.set(id, { id, ...JSON.parse(body), bearer: String(req.headers.authorization ?? "").replace(/^Bearer /, ""), tier: 1, state: "review", outcome: null });
      return send({ id, tier: 1, state: "review" });
    }
    const record = req.method === "GET" && /^\/v1\/writes\/(k-[0-9a-f]{16})$/.exec(path)?.[1];
    if (record) return records.has(record) ? send(records.get(record)) : send({ error: { message: "no record" } }, 404);
    if (hang.has("issues") && req.method === "GET" && path === `/api/companies/${COMPANY}/issues`) {
      held.push(res);
      return;
    }
    const issue = /^\/api\/issues\/([^/]+)/.exec(path)?.[1];
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/labels`) return send([{ id: "label-engineer", name: "engineer" }]);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/agents`) return send(engineers);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/routines`) return send([]);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/issues`) {
      const q = url.searchParams;
      let list = [...issues.values()];
      if (q.get("labelId")) list = list.filter((i) => (i.labels ?? []).some((l) => l.id === q.get("labelId")));
      if (q.get("assigneeAgentId")) list = list.filter((i) => i.assigneeAgentId === q.get("assigneeAgentId"));
      if (q.get("assigneeUserId")) list = list.filter((i) => i.assigneeUserId === (q.get("assigneeUserId") === "me" ? USER : q.get("assigneeUserId")));
      if (q.get("parentId")) list = list.filter((i) => i.parentId === q.get("parentId"));
      if (q.get("q")) list = list.filter((i) => `${i.title}\n${i.description}`.toLowerCase().includes(q.get("q").toLowerCase()));
      return send(list.map(served));
    }
    if (req.method === "GET" && path === "/api/cli-auth/me") return send({ userId: USER });
    if (req.method === "POST" && path === `/api/companies/${COMPANY}/issues`) {
      const b = JSON.parse(body);
      filings.push(b);
      // The same idempotency key returns the task it made, marked as such (the board's deduplicated response): an earlier
      // filing's task, whose run may have ended.
      const seen = b.idempotencyKey && [...issues.values()].find((x) => x.idempotencyKey === b.idempotencyKey);
      if (seen) return send({ ...seen, deduplicated: true });
      // An assignee the company doesn't have (a removed or replaced agent) files to whoever asked, the owner: the row is
      // found assigned to the owner and no run ever picks it up (opt-in: the fixtures keep ids outside the agent list).
      const known = !ownerFallback || !b.assigneeAgentId || engineers.some((a) => a.id === b.assigneeAgentId);
      const i = { id: `made-${created.length + 1}`, identifier: `PEN-${100 + created.length}`, status: b.status, title: b.title, description: b.description, assigneeAgentId: known ? b.assigneeAgentId : null, assigneeUserId: known ? null : USER, idempotencyKey: b.idempotencyKey ?? null, parentId: null, createdByUserId: USER, createdByAgentId: null, labels: [], executionWorkspacePreference: b.executionWorkspacePreference ?? null, executionWorkspaceSettings: b.executionWorkspaceSettings ?? null };
      created.push({ ...b, id: i.id });
      issues.set(i.id, i);
      comments.set(i.id, []);
      // A test's own race, before the runner wakes the new task (a PR merging as its review task is filed).
      await onIssueCreated?.({ issue: i, body: b });
      // Filed already assigned: Paperclip starts no run. Only a wake of its agent (a comment, or its heartbeat) does.
      return send(i, 201);
    }
    const upload = new RegExp(`^/api/companies/${COMPANY}/issues/([^/]+)/attachments$`).exec(path);
    if (req.method === "POST" && upload) {
      const name = /filename="([^"]+)"/.exec(body)?.[1];
      attached.push({ issue: upload[1], name });
      return send({ id: `file-${attached.length}`, originalFilename: name }, 201);
    }
    if (issue && find(decodeURIComponent(issue))) {
      const i = find(decodeURIComponent(issue));
      if (req.method === "GET" && !path.endsWith("/comments") && (failRead.get(i.id) ?? 0) > 0) {
        failRead.set(i.id, failRead.get(i.id) - 1);
        return send({ error: "temporarily unavailable" }, 503);
      }
      if (req.method === "GET" && path.endsWith("/comments")) return send(comments.get(i.id));
      if (req.method === "GET" && path.endsWith("/attachments")) return send([]);
      if (req.method === "POST" && path.endsWith("/comments")) {
        const only = refuseComment.get(i.id);
        if (only?.times && JSON.parse(body).body.includes(only.text)) {
          only.times -= 1;
          return send({ error: `refused ${only.status}` }, only.status);
        }
        const refuse = failComment.get(i.id)?.shift();
        if (refuse) return send({ error: `refused ${refuse}` }, refuse);
        addComment(i.id, JSON.parse(body).body);
        return send({ ok: true }, 201);
      }
      if (req.method === "PATCH") {
        const fields = JSON.parse(body);
        patches.push({ issue: i.identifier, ...fields });
        // Paperclip refuses "in progress" on a task with an unresolved blocker; `refuseStart` plays the same race once
        // without the blocker being visible on reads.
        const left = refuseStart.get(i.id) ?? 0;
        if (fields.status === "in_progress" && (left > 0 || (i.blockedBy ?? []).some((b) => !["done", "cancelled"].includes(find(b.id)?.status ?? b.status)))) {
          if (left > 0) refuseStart.set(i.id, left - 1);
          return send({ error: "Issue is blocked by unresolved blockers" }, 422);
        }
        const { comment, ...rest } = fields;
        Object.assign(i, rest, { updatedAt: new Date().toISOString() });
        if (comment) addComment(i.id, comment);
        return send(i);
      }
      if (req.method === "GET") return send(served(i));
    }
    // Graded done: the grading module's contract (modules/grading/service/src/grades.ts), simplified, and a scripted grader
    // model; the runner's own closes ask the kernel's finish gate (/v1/finish), which the grading check answers.
    if (path === "/v1/notify" && req.method === "POST") {
      ownerLines.push(JSON.parse(body).text);
      return send({ queued: true });
    }
    if (path === "/v1/finish" && req.method === "POST") {
      const { task } = JSON.parse(body);
      const g = grades.get(find(task)?.id);
      if (gateDelayMs) await new Promise((r) => setTimeout(r, gateDelayMs));
      if (!g || g.state === "satisfied") return send({ pass: true });
      if (!["pending", "awaiting_evidence", "grading_failed", "escalated"].includes(g.state)) Object.assign(g, { state: "pending", updatedAt: new Date().toISOString() });
      return send({ pass: false, state: g.state });
    }
    const gradeOne = /^\/internal\/grades\/([^/]+)$/.exec(path);
    if (gradeOne && req.method === "GET") return send({ state: grades.get(find(decodeURIComponent(gradeOne[1]))?.id)?.state || null });
    const gradeRoute = /^\/internal\/grades\/([^/]+)\/(verdict)$/.exec(path);
    if (gradeRoute) {
      const id = find(decodeURIComponent(gradeRoute[1]))?.id;
      const g = grades.get(id);
      const stamp = (state) => Object.assign(g, { state, updatedAt: new Date().toISOString() });
      const v = JSON.parse(body);
      gradeLog.push(v);
      if (v.outcome === "awaiting_evidence") stamp("awaiting_evidence");
      else if (v.outcome === "satisfied") stamp("satisfied");
      // Unverified only (nothing unmet): the delegator's at once, no attempt counted (grades.ts unverifiedOnly).
      else if (v.outcome === "needs_revision") stamp(v.criteria.some((c) => c.met === "unknown") && !v.criteria.some((c) => c.met === "no") ? "escalated" : ++g.attempts >= 3 ? "escalated" : "needs_revision");
      else if (v.outcome === "grading_failed") stamp("grading_failed");
      else stamp("escalated");
      return send(g);
    }
    // The board's retry window for a failed grading pass is a minute; the fake shortens it so a flow can see the retry.
    const retryDue = (g) => (g.state === "grading_failed" ? Date.now() - Date.parse(g.updatedAt) >= 2000 : false);
    if (path === "/internal/grades" && req.method === "GET") return send({ grades: [...grades.values()].filter((g) => ["pending", "awaiting_evidence"].includes(g.state) || retryDue(g)), resubmitted: [] });
    if (path === "/grader" && req.method === "POST") {
      graderCalls.push(JSON.parse(body));
      const next = graderAnswers.shift();
      if (next?.abort) {
        res.writeHead(500, { "content-type": "text/plain" });
        return res.end("The operation was aborted due to timeout");
      }
      return send({ choices: [{ message: { content: JSON.stringify(next ?? { verdict: "cannot_judge", criteria: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    // The board's internal API: the runner's activity for the Crew view, and messages passed on.
    if (path.startsWith("/internal/")) {
      if (path.endsWith("/runner/activity")) activity.push(JSON.parse(body));
      if (path.endsWith("/pass")) {
        passed.push({ path, ...JSON.parse(body) });
        return send({ passed: true, to: "Alfred", part: "PEN-3" });
      }
      return send({});
    }
    unknown.push(`${req.method} ${path}`);
    send({ error: "not found" }, 404);
  });
  /** The owner's decision on the newest pending card for an action (one with the reviewer is escalated to them first). */
  const decide = (action, state) => {
    const r = all().filter((x) => asApproval(x).action === action && ["review", "owner"].includes(x.state)).at(-1);
    assert.ok(r, `a pending ${action} card`);
    if (r.state === "review") kdb.review(r.id, r.digest, { decision: "escalate", by: "reviewer:~acme/test", note: "(test) to the owner" });
    const out = kw.decide(r.id, { digest: r.digest, decision: state === "approved" ? "approve" : "reject", by: "account:owner", via: "web" });
    assert.equal(typeof out, "object", String(out));
    return view(kdb.get(r.id));
  };
  return { server, comments, patches, activity, held, passed, attached, unknown, ownerLines, addComment, approvals, records, autos, decide, kdb, kw, notices, issues, grades, gradeLog, graderCalls, graderAnswers, created, filings, runs, wakes, hang, failRead, failComment, refuseComment, refuseStart };
}

/**
 * Call inside a describe: starts a fake Paperclip and the real runner for it, stops both after. `env`: more runner
 * environment; `runnerYaml`: more lines for config/runner.yaml.
 */
export function flow({ parent: parentOver, part: partOver, alfredPart: alfredOver, siblings = [], grants, grades, partComments: partCommentsOver = [], env = {}, runnerYaml = "", replies = false, step: initialStep, computers = [], moreEngineers = [], onIssueCreated, ownerFallback = false, setup, refuseStart, kernelRepos = {} } = {}) {
  let dir, runner, runnerEnv, paperclip, jobs, launcher, output = "";
  /** The kernel's job half (a test may stop it and start it again: a kernel restart). */
  const startJobs = () => (jobs = jobsHost(runnerEnv, join(dir, "kernel.db")));
  const startRunner = () => {
    runner = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", RUNNER], { env: runnerEnv, stdio: ["ignore", "pipe", "pipe"] });
    runner.stdout.on("data", (d) => (output += d));
    runner.stderr.on("data", (d) => (output += d));
  };
  const fakeLog = () => readLog(join(dir, "fake.log"));
  const partComments = () => paperclip.comments.get("part").map((c) => c.body);
  const agentRuns = () => fakeLog().filter((e) => e.kind === "agent").map((e) => e.data);
  const toolRuns = () => fakeLog().filter((e) => e.kind === "tool").map((e) => e.data);
  const step = (text) => writeFileSync(join(dir, "claude-step"), text);
  const say = (text) => paperclip.addComment("part", text);
  const context = () => `\nrunner output:\n${output.slice(-3000)}\ncomments on the part:\n${partComments().join("\n---\n")}\nunknown requests: ${paperclip.unknown.join(", ")}`;
  const waitFor = async (what, ok, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && runner.exitCode === null) {
      if (ok()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`timed out waiting for ${what}${context()}`);
  };
  const reviews = () => paperclip.patches.filter((p) => p.issue === "PEN-2" && p.status === "in_review");
  const starts = () => paperclip.patches.filter((p) => p.issue === "PEN-2" && p.status === "in_progress");
  /** One turn: the user's comment, then the agent's reply (the part back in review). `ms`: a turn doing more than usual. */
  const turn = async (comment, ms) => {
    const n = reviews().length;
    say(comment);
    await waitFor(`the reply to "${comment}"`, () => reviews().length > n, ms);
    return reviews().at(-1);
  };
  const githubTip = (branch = "fix/remove-legacy") => git(dir, "--git-dir", join(dir, "github/acme/app.git"), "rev-parse", branch);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "aidenhq-flow-"));
    const home = join(dir, "home");
    const config = join(dir, "config");
    const secrets = join(dir, "secrets");
    const bin = join(dir, "bin");
    for (const d of [home, config, secrets, bin]) mkdirSync(d, { recursive: true });

    // GitHub: bare repositories that git@github.com:<org>/<name>.git resolves to. No auto-maintenance: a real box's git dies
    // with the box, but here the agent runs on the host and its detached gc would outlive the turn.
    writeFileSync(join(home, ".gitconfig"), `[user]\n\tname = Test\n\temail = test@example.com\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n[url "${join(dir, "github")}/"]\n\tinsteadOf = git@github.com:\n`);
    for (const slug of ["acme/app", "acme/infra"]) {
      const src = join(dir, "src", slug);
      mkdirSync(src, { recursive: true });
      git(src, "init", "-q");
      writeFileSync(join(src, "README.md"), `# ${slug}\n`);
      git(src, "add", "README.md");
      git(src, "commit", "-qm", "chore: initial commit");
      mkdirSync(dirname(join(dir, "github", slug)), { recursive: true });
      git(dir, "clone", "-q", "--bare", src, join(dir, "github", `${slug}.git`));
    }
    // The fakes log and take their steps through FAKE_* settings, baked in here: a job's env is the kernel's allowlist, so
    // nothing of the runner's environment reaches the engine or the bwrap it runs under.
    const fakeEnv = { FAKE_LOG: join(dir, "fake.log"), FAKE_STEP: join(dir, "claude-step"), ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("FAKE_"))) };
    const exports = Object.entries(fakeEnv).map(([k, v]) => `export ${k}='${v}'\n`).join("");
    for (const name of ["codex", "gh"]) {
      writeFileSync(join(bin, name), name === "codex" ? `#!/bin/sh\n${exports}exec "${join(FAKES, `${name}.sh`)}" "$@"\n` : `#!/bin/sh\n${exports}exec "${process.execPath}" "${join(FAKES, `${name}.mjs`)}" "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    // The host sandbox (the reviewer eval's, a fast check outside a job) and every job's box.
    fakeJail(bin, join(dir, "fake.log"));
    const jobsDir = join(home, ".local/state/aidenhq-computers/jobs");
    fakeDocker(bin, jobsDir);

    writeFileSync(join(config, "system.yaml"), `paperclip:\n  company_id: "${COMPANY}"\nuser:\n  names: ["Dana"]\n`);
    writeFileSync(join(config, "engines.json"), JSON.stringify(registry()));
    writeFileSync(
      join(config, "runner.yaml"),
      `label: engineer
poll_seconds: 0.2
helper_port: ${await freePort()}
allowed_orgs: [acme]
work_dir: ${join(dir, "work")}
state_dir: ${join(dir, "state")}
max_concurrent: 1
timeout_minutes: 2
engines:
  openrouter:
    model: acme/model-1
intake:
  codex_args: []
  timeout_seconds: 30
replies:
  enabled: ${replies ? "true" : "false"}
  debounce_seconds: 0
reviews:
  enabled: false
recurring:
  enabled: false
${runnerYaml}`,
    );
    if (grants) {
      mkdirSync(join(config, "grants"), { recursive: true });
      writeFileSync(join(config, "grants", "grants.json"), JSON.stringify(grants));
    }
    writeFileSync(join(secrets, "paperclip_board_key"), "board-key\n", { mode: 0o600 });
    writeFileSync(join(secrets, "computers_runner_key"), "runner-key\n", { mode: 0o600 });
    writeFileSync(join(secrets, "board_internal_token"), "board-token\n", { mode: 0o600 });
    writeFileSync(join(secrets, "gateway_job_secret"), "job-secret\n", { mode: 0o600 });
    // The runner's own board key: the board returns a card's args only to it, as in production.
    writeFileSync(join(secrets, "reviewer_key"), `${"k".repeat(64)}\n`, { mode: 0o600 });
    // The runner's key to the kernel for its own kinds (runner_writes_key).
    writeFileSync(join(secrets, "runner_writes_key"), `${"w".repeat(64)}\n`, { mode: 0o600 });
    writeFileSync(join(secrets, "engineering_token"), "engineering-token\n", { mode: 0o600 });

    // PEN-2713/PEN-2714: the repositories are on the user's task; Ada's part only says go.
    const engineers = [
      // Every Engineer runs its jobs in a computer (metadata.box), on Codex through OpenRouter.
      { id: "engineer-claude", name: "Software Engineer", status: "idle", adapterType: "opencode_local", adapterConfig: { model: "openrouter/acme/model-1" }, metadata: { setupKey: "aidenhq:engineer-openrouter", runnerEngine: true, engine: "codex-openrouter", box: true, persona: { name: "Ada" }, privateReads: true, models: ["openrouter/acme/model-1", "openrouter/acme/model-2"] } },
      { id: "engineer-codex", name: "Engineer · Grace", status: "idle", adapterType: "opencode_local", adapterConfig: { model: "openrouter/acme/model-2" }, metadata: { setupKey: "aidenhq:engineer-grace", runnerEngine: true, engine: "codex-openrouter", box: true, persona: { name: "Grace" }, privateReads: true } },
      // Setup marks every engine-run agent (dispatch: runner) runnerEngine, and one with a computer box: the kernel starts jobs only for those.
      ...moreEngineers.map((a) => ({ ...a, metadata: { runnerEngine: true, box: true, ...a.metadata } })),
    ];
    const parent = { id: "parent", identifier: "PEN-1", title: "Drop Legacy support", status: "todo", assigneeUserId: USER, createdByUserId: USER, createdByAgentId: null, labels: [], description: "Remove Legacy from these repos:\n\n- acme/app\n- acme/infra\n" };
    const part = { id: "part", identifier: "PEN-2", title: "Drop Legacy support", status: "todo", parentId: "parent", assigneeAgentId: "engineer-claude", assigneeUserId: null, createdByUserId: USER, createdByAgentId: null, labels: [], description: "Ada, go ahead and start this on dev please" };
    // PEN-3155: Alfred's report is a comment on the user's task, and the user asks Ada to take it over.
    const alfred = { id: "assistant", name: "Researcher", status: "idle", adapterType: "codex_local", adapterConfig: {}, metadata: { setupKey: "aidenhq:assistant", persona: { name: "Alfred" } } };
    const parentComments = [{ id: "alfred-report", authorType: "agent", authorAgentId: "assistant", body: "## Legacy usage — preliminary\n\nLegacy is still read by the infra alerts.", createdAt: new Date(Date.now() - 60_000).toISOString() }];
    // Alfred's part of the same task: his chat, where the user may write to Ada from.
    const alfredPart = { id: "alfred-part", identifier: "PEN-3", title: "Drop Legacy support", status: "todo", parentId: "parent", assigneeAgentId: "assistant", assigneeUserId: null, labels: [], description: "Draft the changelog entry", ...alfredOver };
    const alfredChat = [
      { id: "alfred-1", authorType: "user", authorUserId: USER, body: "Draft the changelog entry", createdAt: new Date(Date.now() - 50_000).toISOString() },
      { id: "alfred-2", authorType: "agent", authorAgentId: "assistant", body: "Draft: Legacy support is removed from the app and the alerts.", createdAt: new Date(Date.now() - 40_000).toISOString() },
    ];
    Object.assign(parent, parentOver);
    Object.assign(part, partOver);
    // Agents in a computer (`image:` in the module): Paperclip runs them, and a task they get must have a folder of its own.
    const inComputers = computers.map((id) => ({ id, name: id, status: "idle", adapterType: "codex_local", adapterConfig: {}, defaultEnvironmentId: "env-computer", metadata: { setupKey: `aidenhq:${id}` } }));
    paperclip = fakePaperclip({ parent, part, engineers: [...engineers, alfred, ...inComputers], parentComments, partComments: partCommentsOver, others: [{ issue: alfredPart, comments: alfredChat }, ...siblings], grades: new Map(Object.entries(grades ?? {}).map(([id, g]) => [id, { issueId: id, attempts: 0, state: "open", verdicts: [], updatedAt: new Date(0).toISOString(), ...g }])), onIssueCreated, ownerFallback, config, secrets, jobs: () => jobs.port, refuseStart, repos: { agentsOrg: env.AIDENHQ_GITHUB_AGENTS_ORG ?? "acme", ...kernelRepos, ...(env.AIDENHQ_PRODUCT_REPO ? { product: env.AIDENHQ_PRODUCT_REPO } : {}), ...(/apply:\n {2}repo: (\S+)/.exec(runnerYaml)?.[1] ? { instance: /apply:\n {2}repo: (\S+)/.exec(runnerYaml)[1] } : {}) } });
    await new Promise((r) => paperclip.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${paperclip.server.address().port}`;

    step(initialStep ?? "commit");
    // The boxes' env: the fakes first, then the agents' own commands (/opt/aidenhq/bin in a real box).
    launcher = jobLauncher(jobsDir, { AIDENHQ_CONFIG_DIR: config, PATH: `${bin}:${join(ROOT, "services/runner/bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, ...fakeEnv });
    await new Promise((r) => launcher.server.listen(0, "127.0.0.1", r));
    runnerEnv = {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH}`,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        AIDENHQ_CONFIG_DIR: config,
        AIDENHQ_SECRETS_DIR: secrets,
        AIDENHQ_ENV_FILE: join(dir, "none.env"),
        PAPERCLIP_URL: url,
        BOARD_INTERNAL_URL: url,
        AIDENHQ_KERNEL_URL: url,
        AIDENHQ_GRADING_URL: url,
        FAKE_LOG: join(dir, "fake.log"),
        FAKE_STEP: join(dir, "claude-step"),
        AIDENHQ_GRADER_URL: `${url}/grader`,
        AIDENHQ_LAUNCHER_URL: `http://127.0.0.1:${launcher.server.address().port}`,
        AIDENHQ_BOX_RELEASE_RETRY_MS: "50",
        ...env,
    };
    // Fixtures a scenario needs before the first poll: GitHub's PRs (github-prs.json) or the runner's own state rows.
    setup?.({ dir });
    startJobs();
    startRunner();
  });
  after(async () => {
    // Both are gone before the hook ends, so neither's exit lands after the test as async activity.
    const runnerGone = runner && runner.exitCode === null && runner.signalCode === null ? new Promise((r) => runner.once("exit", r)) : undefined;
    runner?.kill("SIGKILL");
    await Promise.all([runnerGone, jobs?.stop()]);
    paperclip?.server.close();
    launcher?.server.close();
    // A job the runner left going (jobs are detached) may still be writing here: retried, so a failed flow ends instead of
    // throwing here and skipping the file's later after hooks (a server left listening keeps the process alive).
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });
  // An agent turn or publishing in progress (the merge queue runs on in the background: GitHub fails here).
  const running = () => (paperclip.activity.at(-1)?.running ?? []).some((r) => r.identifier === "PEN-2" && r.mode !== "merging PRs");
  /** The first run (the assignment's) has replied and nothing is running. */
  const settled = async () => {
    await waitFor("the first reply", () => reviews().length > 0);
    await waitFor("quiet", () => !running());
  };
  /** The exact word pr: the branch is on GitHub afterwards. */
  const publish = async () => {
    const n = partComments().length;
    say("pr");
    await waitFor("the results", () => partComments().slice(n).some((c) => c.includes("| Branch | Result |")));
  };
  /** Lets a "slow" fake turn finish (it holds until this file exists). */
  const release = () => writeFileSync(join(dir, "release"), "");
  /** Time enough for the runner (polling every 50ms) to have acted on something, for "nothing happened" checks. */
  const idle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
  /** The runner logged no error and never asked for a repository. */
  const noErrors = () => {
    assert.ok(!/"msg":"error"/.test(output), `the runner logged an error${context()}`);
    assert.ok(!partComments().some((c) => /Which repository|Runner error/.test(c)));
  };
  return {
    get dir() {
      return dir;
    },
    get runner() {
      return runner;
    },
    get runnerEnv() {
      return runnerEnv;
    },
    get paperclip() {
      return paperclip;
    },
    get jobs() {
      return jobs;
    },
    get output() {
      return output;
    },
    get launcher() {
      return launcher;
    },
    startRunner, startJobs, fakeLog, partComments, agentRuns, toolRuns, step, say, context, waitFor, reviews, starts, turn, githubTip, running, settled, publish, release, idle, noErrors,
  };
}
