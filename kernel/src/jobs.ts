// Jobs (K7, spec §3.3.1, §5.11): POST /v1/jobs starts an engine run in the agent's computer (sandbox.ts buildJob: `docker exec` in
// the box the computer launcher made for this task) for a dispatcher module (role kernel.jobs, checked by the backplane), only
// for an engine-run agent with a computer on a task the control plane assigns to it. Each run is a detached process group
// under a small `sh` that records its exit status, writing straight to its log: nothing ties it to the kernel, so a kernel
// restart (KillMode=process) leaves it running and the next kernel adopts it from kernel.db (its pid and events offset). The
// watcher follows events.jsonl (untrusted: regular files only, no links, capped lines), the exit file, the deadline, the
// progress stop (progress.ts) and the silence stop.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appendLine, lines, readFrom } from "../sdk/src/engine-io.ts";
import { progressTracker } from "./progress.ts";
import { SESSION, buildJob, observes, readEngines, type Box, type Engine, type SandboxConfig } from "./sandbox.ts";

/** What the control plane says: the agent (setup's metadata: its module, engine run, private reads, box) and the task. */
export interface ControlPlane {
  agent(id: string): Promise<{ id: string; metadata?: Record<string, unknown> } | undefined>;
  task(id: string): Promise<{ id: string; identifier?: string; assigneeAgentId?: string | null; status?: string } | undefined>;
}
// Every resource a job gets is derived from the verified (module, agent, task), never taken from the request: its workspace is
// work/tasks/<the task's identifier>, its box the one the launcher recorded for this task and agent. A request that names
// anything else is refused.
export interface JobRequest {
  agent: string; task: string; workspace?: { module: string; id: string }; prompt: string; session?: string;
  engine: { kind: string; model?: string; effort?: string };
  /** The job's own settings from its dispatcher, by name only from ENV_NAMES; only its gh read token reaches the box (its
   * helper and identity are in the launcher's env file). */
  env?: Record<string, string>;
  /** The job's box (the computer launcher made it for this task). */
  box: Box;
  /** A name for the log file (the task's identifier). */
  label?: string;
}
type Progress = { said?: string; saidAt?: string; plan?: unknown[]; steps?: unknown[] };
export interface JobView {
  id: string; module: string; agent: string; task: string; state: string; pid: number; log: string; dir: string; at: number;
  jobcaps: string[]; observing: boolean; live_input: boolean; exit: number | null; final: string; session: string | null;
  timedOut: boolean; stalled: boolean; stopped: string | null; cancelled: boolean; usage: { input: number; cached: number; output: number } | null;
  progress: Progress; version: number;
}

export class JobError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "JobError"; this.status = status; this.code = code; }
}

// The names a dispatcher may set in a job's env. Of them only the gh read token reaches the box; nothing of the kernel's own
// environment does (the docker client gets BOX_ENV).
const ENV_NAMES = new Set(["AIDENHQ_REPO_URL", "AIDENHQ_REPO_TOKEN", "GH_TOKEN", "AIDENHQ_GH_AUTH", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]);
const BOX_ENV = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"];
const ID = /^[\w.-]{1,100}$/;

// The run (its `docker exec` client) under a `sh` of builtins only that records its exit status and outlives a stop's SIGTERM
// to record it. Stopping the client stops nothing in the box: the dispatcher releases the box (the launcher destroys it).
const WRAP = 'trap : TERM INT HUP; "$@"; echo "$?" > "$0"';
const POLL_MS = 250;
const exitStatus = (file: string) => { try { return readFileSync(file, "utf8").trim(); } catch { return ""; } };
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
/** True while the run's shell is alive and is still that run (a reused pid isn't): for adopting it. */
export function runAlive(pid: number, logPath: string) {
  try {
    return alive(pid) && execFileSync("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }).includes(`${logPath}.exit`);
  } catch {
    return false;
  }
}

/** New engine events from `offset` in a job's events.jsonl: never through a link, a regular file only, each line capped. */
export function readEvents(jobDir: string, offset = 0) {
  const file = join(jobDir, "events.jsonl");
  const size = (() => { try { return lstatSync(file).size; } catch { return 0; } })();
  if (size < offset) offset = 0;
  const buf = readFrom(file, offset, 4 << 20);
  const { values, used } = lines(buf);
  // A line longer than one read is skipped whole, not waited on forever.
  const next = offset + (used || (buf.length === 4 << 20 ? buf.length : 0));
  const events = values.filter((e: any) => e && typeof e === "object" && ["progress", "usage", "session", "final"].includes(e.t)) as any[];
  return { events, offset: next, skipped: values.length - events.length };
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// Steps show command lines on the board: blank the usual secret shapes first, whatever the engine sent.
const redact = (t: string) =>
  t
    .replace(/(Bearer|Basic|token)\s+[^\s'"]+/gi, "$1 …")
    .replace(/:\/\/[^/\s@]+@/g, "://…@")
    .replace(/([?&](?:token|key|secret|password|sig|access_token)=)[^&\s'"]+/gi, "$1…")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS)[A-Z0-9_]*)=[^\s'"]+/g, "$1=…")
    .replace(/\b(sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-|AKIA)[A-Za-z0-9_-]+/g, "$1…");
const PLAN = (p: unknown) => (Array.isArray(p) ? p.slice(0, 20).map((i: any) => ({ text: clip(i?.step, 200), state: i?.done ? "done" : i?.doing ? "doing" : "todo" })).filter((i) => i.text) : undefined);
const STEPS = (s: unknown) => (Array.isArray(s) ? s.slice(-30).map((x: any) => ({ at: typeof x?.at === "string" ? x.at.slice(0, 40) : new Date().toISOString(), kind: "tool", text: clip(redact(String(x?.text ?? "")), 200) })) : undefined);

/** A folder inside `root` with no symlink on the way (a mount would bind its target), resolved. */
export function insideNoLinks(root: string, path: string, what: string): string {
  const base = realpathSync(root);
  let rel = relative(resolve(root), resolve(path));
  if (rel.startsWith("..") || isAbsolute(rel)) rel = relative(base, resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new JobError(400, "workspace-refused", `${what} refused: ${path} is not inside ${root}`);
  let at = base;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (!st) throw new JobError(400, "workspace-refused", `${what} refused: ${at} doesn't exist`);
    if (st.isSymbolicLink()) throw new JobError(400, "workspace-refused", `${what} refused: ${at} is a symlink`);
  }
  const real = realpathSync(join(base, rel));
  if (!real.startsWith(base + sep)) throw new JobError(400, "workspace-refused", `${what} refused: ${path} resolves outside ${root}`);
  return real;
}

/**
 * Whether a module dispatches an agent's jobs: compile lists them by agent key under the dispatcher's `dispatches`
 * (config/kernel/modules.json), and the grants table maps the agent's id to its key.
 */
export const dispatchesFrom = (modules: () => Record<string, { dispatches?: string[] } | undefined>, agents: () => Record<string, { key?: unknown } | undefined>) =>
  (module: string, agent: string) => { const key = agents()[agent]?.key; return typeof key === "string" && key !== "" && (modules()[module]?.dispatches ?? []).includes(key); };

const DDL = `CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, module TEXT NOT NULL, agent TEXT NOT NULL, task TEXT NOT NULL, engine TEXT NOT NULL, pid INTEGER NOT NULL,
  log TEXT NOT NULL, dir TEXT NOT NULL, at INTEGER NOT NULL, jobcaps TEXT NOT NULL, observing INTEGER NOT NULL, live_input INTEGER NOT NULL,
  box TEXT, session TEXT, offset INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, exit INTEGER, final TEXT NOT NULL DEFAULT '',
  why TEXT NOT NULL DEFAULT '{}', usage TEXT, progress TEXT NOT NULL DEFAULT '{}', ended INTEGER)`;

export function createJobs({ db, cfg, cp, mayDispatch, log, boxWrap, onEnd = () => {} }: {
  /** A job ended (or was found lost): the kernel releases the box it got for it (boxes.ts). */
  onEnd?: (id: string) => void;
  db: DatabaseSync; cfg: SandboxConfig; cp: ControlPlane;
  /** Whether this module dispatches this agent's jobs (compile: config/kernel/modules.json `dispatches`, by agent key). */
  mayDispatch: (module: string, agent: string) => boolean;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  /** The command a box job's engine runs under in its box (the computer launcher's scrub). */
  boxWrap: string;
}) {
  db.exec(DDL);
  // What admission records (wake, profile, the job that started it) and the routine cap it froze (provenance.ts reads it).
  const have = new Set((db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
  for (const c of ["wake", "profile", "parent_job", "routine", "routine_cap"]) if (!have.has(c)) db.exec(`ALTER TABLE jobs ADD COLUMN ${c} TEXT`);
  db.exec("CREATE INDEX IF NOT EXISTS jobs_task ON jobs (task, state)");
  // A kernel-admitted job's columns (admission.ts, boxes.ts), added where they are missing.
  const cols = new Set((db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
  for (const [c, t] of [["profile", "TEXT"], ["wake", "TEXT"], ["authority", "TEXT"], ["renewed", "INTEGER"], ["released", "INTEGER"]]) if (!cols.has(c!)) db.exec(`ALTER TABLE jobs ADD COLUMN ${c} ${t}`);
  const watchers = new Map<string, { stop: () => void; send?: (text: string, from: string) => boolean; cancel: () => void }>();
  const versions = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();
  const bump = (id: string) => {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    for (const w of waiters.get(id) ?? []) w();
    waiters.delete(id);
  };
  const row = (id: string) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, any> | undefined;
  const view = (r: Record<string, any>): JobView => {
    const why = JSON.parse(r.why || "{}");
    return {
      id: r.id, module: r.module, agent: r.agent, task: r.task, state: r.state, pid: r.pid, log: r.log, dir: r.dir, at: r.at,
      jobcaps: JSON.parse(r.jobcaps), observing: r.observing === 1, live_input: r.live_input === 1, exit: r.exit ?? null, final: r.final,
      session: r.session ?? null, timedOut: why.timedOut === true, stalled: why.stalled === true, stopped: why.stopped ?? null,
      cancelled: why.cancelled === true, usage: r.usage ? JSON.parse(r.usage) : null, progress: JSON.parse(r.progress || "{}"), version: versions.get(r.id) ?? 0,
    };
  };

  /** Follow a run to its end from its offset: events, exit file, deadline, progress and silence stops, and a cancel. */
  function watch(id: string, { adopted = false } = {}) {
    const r = row(id)!;
    const { pid, log: logPath, dir: jobDir } = r;
    const exitFile = `${logPath}.exit`;
    let offset: number = r.offset;
    let session: string | null = r.session ?? null;
    let final: string | undefined = r.final || undefined;
    const progress: Progress = JSON.parse(r.progress || "{}");
    const usage = { input: 0, cached: 0, output: 0, seen: false, ...(r.usage ? { ...JSON.parse(r.usage), seen: true } : {}) };
    const deadline = r.at + cfg.timeout_minutes * 60_000;
    const tracker = progressTracker({ start: r.at, ...(adopted ? { since: Date.now() } : {}), windowMs: cfg.progress_minutes * 60_000 });
    const stallMs = cfg.stall_minutes * 60_000;
    let grewAt = Date.now();
    let logSize = 0;
    let timedOut = false, stalled = false, cancelled = false, killed = false;
    let stopped: string | undefined;
    let over = false;
    const save = () => db.prepare("UPDATE jobs SET offset = ?, session = ?, final = ?, progress = ?, usage = ? WHERE id = ?").run(offset, session, final ?? "", JSON.stringify(progress), usage.seen ? JSON.stringify({ input: usage.input, cached: usage.cached, output: usage.output }) : null, id);
    const read = () => {
      try {
        const size = lstatSync(logPath).size;
        if (size > logSize) (logSize = size), (grewAt = Date.now());
      } catch {}
      let got;
      try {
        got = readEvents(jobDir, offset);
      } catch {
        return; // not a regular file: the job's own doing, nothing of it is read
      }
      if (got.offset === offset) return;
      grewAt = Date.now();
      offset = got.offset;
      for (const e of got.events) {
        if (e.t === "session" && typeof e.id === "string" && SESSION.test(e.id)) session = e.id;
        if (e.t === "final" && typeof e.text === "string") final = e.text;
        if (e.t === "usage") {
          for (const k of ["input", "cached", "output"] as const) usage[k] += Number.isFinite(e[k]) && e[k] > 0 ? e[k] : 0;
          usage.seen = true;
        }
        if (e.t === "progress") {
          const steps = STEPS(e.steps);
          tracker.add(steps);
          const text = clip(e.text, 600);
          if (text && text !== progress.said) (progress.said = text), (progress.saidAt = new Date().toISOString());
          const plan = PLAN(e.plan);
          if (plan?.length) progress.plan = plan;
          if (steps?.length) progress.steps = steps;
        }
      }
      save();
      bump(id);
    };
    const kill = () => {
      killed = true;
      try {
        process.kill(-pid, "SIGTERM");
        setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 10_000).unref();
      } catch {}
    };
    let timer: NodeJS.Timeout;
    const done = () => {
      clearInterval(timer);
      watchers.delete(id);
      read();
      over = true;
      const status = exitStatus(exitFile);
      const code = status === "" ? null : Number(status);
      let lastMessage = String(final ?? "").trim();
      const startError = code === 127 && `couldn't start ${r.engine}: ENOENT`;
      if (!lastMessage && startError) {
        appendFileSync(logPath, `# ${startError}\n`);
        lastMessage = `The job couldn't start: ${startError}.`;
      }
      if (lastMessage) writeFileSync(`${logPath}.last.md`, lastMessage);
      // No status: the run died without its shell, by its own stop or timeout (killed), else by hand (a failure).
      const exit = code === null && !killed ? 1 : code;
      const state = cancelled ? "cancelled" : stopped ? "stopped" : stalled ? "stalled" : timedOut ? "timeout" : exit ? "failed" : "done";
      db.prepare("UPDATE jobs SET state = ?, exit = ?, final = ?, why = ?, offset = ?, session = ?, ended = ? WHERE id = ?")
        .run(state, exit, lastMessage, JSON.stringify({ timedOut, stalled, stopped, cancelled }), offset, session, Date.now(), id);
      log("job finished", { job: id, task: r.task, state, exit });
      bump(id);
      onEnd(id);
    };
    const tick = () => {
      read();
      if (exitStatus(exitFile) || !alive(pid)) return done();
      if (!timedOut && Date.now() > tracker.deadline(deadline)) (timedOut = true), kill();
      if (!timedOut && (stopped = tracker.check())) (timedOut = true), kill();
      if (!timedOut && !tracker.waiting && Date.now() - grewAt > stallMs) (timedOut = stalled = true), kill();
    };
    // A box job's dir is the launcher's out folder, mounted in its box: the inbox reaches it the same way.
    const send = r.live_input === 1
      ? (text: string, from: string) => {
          read();
          if (over || final !== undefined || exitStatus(exitFile) || !alive(pid)) return false;
          try {
            appendLine(join(jobDir, "inbox.jsonl"), { t: "comment", from, text });
            return true;
          } catch {
            return false; // the inbox isn't a regular file (the job's doing): the comment waits for the next turn
          }
        }
      : undefined;
    watchers.set(id, { stop: () => (clearInterval(timer), save()), send, cancel: () => { cancelled = true; kill(); } });
    timer = setInterval(tick, POLL_MS);
    tick();
  }

  /** The kernel restarted: runs still going (or ended while no kernel followed them) are followed again; the rest are lost. */
  function adopt() {
    for (const r of db.prepare("SELECT * FROM jobs WHERE state = 'running'").all() as Record<string, any>[]) {
      const status = exitStatus(`${r.log}.exit`);
      // Killed by a signal (above 128) while no kernel followed it, e.g. a reboot: lost, like a run gone without a status.
      const ended = status !== "" && Number(status) >= 0 && Number(status) <= 128;
      if (ended || (status === "" && runAlive(r.pid, r.log))) {
        log("adopted a running job", { job: r.id, task: r.task, pid: r.pid });
        watch(r.id, { adopted: true });
        continue;
      }
      db.prepare("UPDATE jobs SET state = 'lost', exit = NULL, ended = ? WHERE id = ?").run(Date.now(), r.id);
      log("job lost while no kernel followed it", { job: r.id, task: r.task });
      onEnd(r.id);
    }
  }

  async function start(module: string, b: JobRequest): Promise<JobView> {
    if (!b || typeof b !== "object" || !ID.test(String(b.agent)) || !ID.test(String(b.task)) || typeof b.prompt !== "string" || !b.engine || typeof b.engine.kind !== "string") throw new JobError(400, "bad-request", "send {agent, task, workspace: {module, id}, prompt, engine: {kind, model?, effort?}}");
    // Identity binding (spec §5.11): an engine-run agent, on a task the control plane assigns to it now.
    if (!mayDispatch(module, b.agent)) throw new JobError(403, "not-your-agent", `module ${module} doesn't dispatch agent ${b.agent}'s jobs`);
    const agent = await cp.agent(b.agent);
    if (agent?.metadata?.runnerEngine !== true) throw new JobError(403, "not-an-engine-agent", `agent ${b.agent} isn't one that runs engine jobs`);
    const task = await cp.task(b.task);
    if (!task || task.assigneeAgentId !== b.agent) throw new JobError(403, "task-not-assigned", `task ${b.task} isn't assigned to agent ${b.agent}`);
    const ident = String(task.identifier ?? "");
    if (!ID.test(ident)) throw new JobError(400, "bad-task", `task ${b.task} has no identifier`);
    if (["done", "cancelled"].includes(String(task.status))) throw new JobError(409, "task-closed", `task ${b.task} is ${task.status}`);
    if (db.prepare("SELECT 1 FROM jobs WHERE task = ? AND state IN ('admitted', 'running')").get(b.task)) throw new JobError(409, "job-running", `task ${b.task} already has a job running`);
    const entry = readEngines(cfg)[b.engine.kind];
    if (!entry) throw new JobError(400, "unknown-engine", `no engine module provides "${b.engine.kind}"`);
    if (entry.box !== true) throw new JobError(400, "not-a-box-engine", `the ${b.engine.kind} engine doesn't run in an agent computer`);
    // Every job runs in its agent's computer: a box agent's, in the box the launcher made for this task. Private reads come
    // with the agent, never with the request.
    if (agent.metadata?.box !== true) throw new JobError(403, "not-a-box-agent", `agent ${b.agent} has no computer (image: in its definition) to run its jobs in`);
    if (!b.box) throw new JobError(400, "box-required", "a job runs in its agent's computer: name the launcher's box");
    const workPath = join(cfg.workDir, "tasks", ident);
    const box = checkBox(b.box, b.task, b.agent, workPath);
    const engine: Engine = { kind: b.engine.kind, model: String(b.engine.model ?? ""), effort: String(b.engine.effort ?? ""), ...(agent.metadata?.privateReads === true ? { reads: true } : {}) };
    if (b.workspace && (b.workspace.module !== module || b.workspace.id !== ident)) throw new JobError(403, "workspace-refused", `a job works in its own task's workspace (${module}, ${ident})`);
    const worktree = insideNoLinks(join(cfg.workDir, "tasks"), workPath, "workspace");
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.env ?? {})) {
      if (!ENV_NAMES.has(k) || typeof v !== "string" || v.length > 4096) throw new JobError(400, "env-refused", `a job's env may not set ${k}`);
      extra[k] = v;
    }
    const id = `j-${randomBytes(8).toString("hex")}`;
    const at = Date.now();
    mkdirSync(cfg.logsDir, { recursive: true });
    const logPath = join(cfg.logsDir, `${String(b.label ?? b.task).replace(/[^\w.-]/g, "_").slice(0, 60)}-${at}.log`);
    const jobDir = join(box.outDir, "job");
    mkdirSync(jobDir, { mode: 0o700 }); // new for every run: nothing of the job's is in it yet
    const built = buildJob({ cfg, engine, worktree, jobDir, sessionId: b.session, prompt: b.prompt, job: { agentId: b.agent, issueId: b.task, at }, box, gh: Boolean(extra.GH_TOKEN), boxWrap });
    const pick = (names: string[]) => Object.fromEntries(names.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]));
    const env: Record<string, string> = { ...pick(BOX_ENV), ...(extra.GH_TOKEN ? { GH_TOKEN: extra.GH_TOKEN, AIDENHQ_GH_AUTH: extra.GH_TOKEN } : {}) };
    appendFileSync(logPath, `# ${new Date(at).toISOString()} ${engine.kind}${engine.model ? ` (${engine.model})` : ""} in box ${box.container} (${worktree})\n`);
    const out = openSync(logPath, "a");
    const child = spawn("/bin/sh", ["-c", WRAP, `${logPath}.exit`, ...built.argv], { cwd: "/", env, detached: true, stdio: ["ignore", out, out] });
    closeSync(out);
    // Only /bin/sh itself failing to start lands here; a missing engine is the shell's exit 127.
    child.on("error", (e: NodeJS.ErrnoException) => { try { writeFileSync(`${logPath}.exit`, "1\n"); appendFileSync(logPath, `# couldn't start /bin/sh: ${e.code ?? e.message}\n`); } catch {} });
    child.unref();
    db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, box, session, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')")
      .run(id, module, b.agent, b.task, engine.kind, child.pid ?? 0, logPath, jobDir, at, "[]", observes(engine) ? 1 : 0, entry.live_input ? 1 : 0, JSON.stringify(box), b.session && SESSION.test(b.session) ? b.session : null);
    log("job started", { job: id, module, agent: b.agent, task: b.task, engine: engine.kind, pid: child.pid, box: box.container });
    watch(id);
    return view(row(id)!);
  }

  /**
   * An admitted job (admission.ts) starts in the box the kernel got it (boxes.ts): its engine and authority are the row's,
   * frozen at admission; the caller adds only the prompt and the session to resume.
   */
  function runAdmitted(id: string, { box, worktree, prompt, session, label }: { box: Box; worktree: string; prompt: string; session?: string; label: string }) {
    const r = row(id);
    if (!r || r.state !== "admitted" || !r.authority) throw new JobError(409, "not-admitted", `job ${id} isn't waiting to start`);
    const a = JSON.parse(r.authority) as { engine: string; model: string; effort: string; web: boolean };
    const entry = readEngines(cfg)[a.engine];
    if (entry?.box !== true) throw new JobError(400, "not-a-box-engine", `the ${a.engine} engine doesn't run in an agent computer`);
    // An engine that "reads" runs without web search (sandbox.ts observes).
    const engine: Engine = { kind: a.engine, model: a.model, effort: a.effort, ...(a.web === false ? { reads: true } : {}) };
    const at = Date.now();
    mkdirSync(cfg.logsDir, { recursive: true });
    const logPath = join(cfg.logsDir, `${String(label).replace(/[^\w.-]/g, "_").slice(0, 60)}-${at}.log`);
    const jobDir = join(box.outDir, "job");
    mkdirSync(jobDir, { mode: 0o700 });
    const built = buildJob({ cfg, engine, worktree, jobDir, sessionId: session, prompt, job: { agentId: r.agent, issueId: r.task, at }, box, boxWrap });
    const env = Object.fromEntries(BOX_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]));
    appendFileSync(logPath, `# ${new Date(at).toISOString()} ${engine.kind}${engine.model ? ` (${engine.model})` : ""} in box ${box.container} (${worktree})\n`);
    const out = openSync(logPath, "a");
    const child = spawn("/bin/sh", ["-c", WRAP, `${logPath}.exit`, ...built.argv], { cwd: "/", env, detached: true, stdio: ["ignore", out, out] });
    closeSync(out);
    child.on("error", (e: NodeJS.ErrnoException) => { try { writeFileSync(`${logPath}.exit`, "1\n"); appendFileSync(logPath, `# couldn't start /bin/sh: ${e.code ?? e.message}\n`); } catch {} });
    child.unref();
    db.prepare("UPDATE jobs SET pid = ?, log = ?, dir = ?, at = ?, box = ?, session = ?, observing = ?, live_input = ?, state = 'running' WHERE id = ?")
      .run(child.pid ?? 0, logPath, jobDir, at, JSON.stringify(box), session && SESSION.test(session) ? session : null, observes(engine) ? 1 : 0, entry.live_input ? 1 : 0, id);
    log("job started", { job: id, module: r.module, agent: r.agent, task: r.task, engine: engine.kind, pid: child.pid, box: box.container });
    watch(id);
    return view(row(id)!);
  }

  /** The box the computer launcher recorded (its jobs.json) for this task and agent, in this task's workspace; its paths are derived. */
  function checkBox(x: Box, task: string, agent: string, workspace: string): Box {
    const container = String(x?.container ?? "");
    if (!ID.test(container)) throw new JobError(400, "box-refused", "a box job names the launcher's box by its container");
    let recs: { container?: string; issueId?: string; agentId?: string; workspace?: string }[] = [];
    try { recs = JSON.parse(readFileSync(join(dirname(cfg.boxDir), "jobs.json"), "utf8")); } catch {}
    const rec = Array.isArray(recs) ? recs.find((r) => r?.container === container) : undefined;
    if (!rec || rec.issueId !== task || rec.agentId !== agent || resolve(String(rec.workspace)) !== resolve(workspace)) throw new JobError(403, "box-refused", `box ${container} isn't this task's and agent's (the launcher's record)`);
    const box = { container, envFile: join(cfg.boxDir, `${container}.env`), outDir: join(cfg.boxDir, container) };
    if ((x.envFile && x.envFile !== box.envFile) || (x.outDir && x.outDir !== box.outDir)) throw new JobError(400, "box-refused", "a box's files are the launcher's, under its jobs folder");
    if (!existsSync(box.outDir)) throw new JobError(400, "box-refused", `no box folder for ${container}`);
    return box;
  }

  const own = (module: string, id: string) => {
    const r = row(id);
    if (!r || r.module !== module) throw new JobError(404, "no-job", `no job ${id}`);
    return r;
  };

  return {
    start,
    runAdmitted,
    adopt,
    /** Status; with `after` (a version), waits up to `waitMs` for a change first. */
    async get(module: string, id: string, { after, waitMs = 0 }: { after?: number; waitMs?: number } = {}) {
      own(module, id);
      if (after !== undefined && waitMs > 0 && (versions.get(id) ?? 0) <= after && row(id)!.state === "running") {
        await new Promise<void>((res) => {
          const set = waiters.get(id) ?? new Set();
          const t = setTimeout(() => (set.delete(wake), res()), Math.min(waitMs, 30_000));
          const wake = () => (clearTimeout(t), res());
          set.add(wake);
          waiters.set(id, set);
        });
      }
      return view(row(id)!);
    },
    /** The module's own job admitted on a wake (none, or one: a wake starts at most one job), so a dispatcher that lost it finds it. */
    byWake: (module: string, wake: string) => (db.prepare("SELECT * FROM jobs WHERE module = ? AND wake = ?").all(module, wake) as Record<string, any>[]).map(view),
    stop(module: string, id: string) {
      const r = own(module, id);
      if (r.state === "running") watchers.get(id)?.cancel();
      return view(row(id)!);
    },
    /** A comment into a live run's inbox.jsonl: false once the run is over, or for an engine that takes none mid-run. */
    input(module: string, id: string, text: string, from = "owner") {
      own(module, id);
      return { sent: watchers.get(id)?.send?.(String(text).slice(0, 65_536), String(from).slice(0, 100)) ?? false };
    },
    /** A restart: every watcher stops and saves its offset; the runs go on for the next kernel. */
    detach() {
      for (const [, w] of watchers) w.stop();
      watchers.clear();
    },
    running: () => watchers.size,
  };
}
export type Jobs = ReturnType<typeof createJobs>;

/** A kernel-admitted job's row as the job token's holders read it (identity.ts, the gateway): undefined for any other job. */
export function admittedJob(db: DatabaseSync, id: string) {
  const r = db.prepare("SELECT agent, task, state, authority FROM jobs WHERE id = ? AND authority IS NOT NULL").get(id) as { agent: string; task: string; state: string; authority: string } | undefined;
  return r && { agent: r.agent, task: r.task, state: r.state, authority: JSON.parse(r.authority) };
}
