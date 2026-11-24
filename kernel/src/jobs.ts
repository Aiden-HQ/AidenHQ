// Jobs (K7, spec §3.3.1, §5.11): an admitted job (admission.ts, POST /v1/jobs {wake}) runs its engine in the box the kernel got
// for it (boxes.ts, sandbox.ts buildJob: `docker exec` in the agent's computer), with the engine and authority frozen on its row.
// Each run is a detached process group
// under a small `sh` that records its exit status, writing straight to its log: nothing ties it to the kernel, so a kernel
// restart (KillMode=process) leaves it running and the next kernel adopts it from kernel.db (its pid and events offset). The
// watcher follows events.jsonl (untrusted: regular files only, no links, capped lines), the exit file, the deadline and a
// cancel. Judging a run's progress (no work for too long) is its dispatcher's: it stops the run (dispatch progress.ts).
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appendLine, lines, readFrom } from "../sdk/src/engine-io.ts";
import { inTx, iso, strictFact } from "./factlog.ts";
import { REFUSALS_DDL, busyError, refusalColumns, refusalOf, type Refusal } from "./refusals.ts";
import type { Facts } from "./facts.ts";
import { quietRun } from "./quiet.ts";
import { SESSION, buildJob, ensureStateDirs, observes, readEngines, type Box, type Engine, type SandboxConfig } from "./sandbox.ts";

/** What the control plane says about a task. */
export interface ControlPlane {
  task(id: string): Promise<{ id: string; identifier?: string; assigneeAgentId?: string | null; status?: string } | undefined>;
}
type Progress = { said?: string; saidAt?: string; plan?: unknown[]; steps?: unknown[] };
export interface JobView {
  id: string; module: string; agent: string; task: string; state: string; pid: number; log: string; dir: string; at: number;
  jobcaps: string[]; observing: boolean; live_input: boolean; exit: number | null; final: string; session: string | null;
  timedOut: boolean; cancelled: boolean; /** The account that stopped it (the board's Stop), when the owner did. */ stoppedBy: string | null; usage: { input: number; cached: number; output: number } | null;
  progress: Progress; version: number;
  /** When the run ended (ms), and whether its dispatcher acknowledged the end (outcome posted, whoever asked told). */
  ended: number | null; acked: boolean;
  /** Why the run's last write was refused at plan time, when nothing later went through, and its rule's stable code when it has one. */
  refused?: string;
  refusedCode?: string;
  /**
   * The kind the caller asked for, and the module whose kind it is. Both are the kernel's own, from its routing: the code is the
   * executor's, and the module alone is too broad (another of its kinds could return the same code), so a dispatcher binds a
   * terminal rule to all of them together.
   */
  refusedKind?: string;
  refusedSource?: string;
}

/** A job view's refusal fields: the words, and (when the plan gave one) its rule's code beside the kind asked for and its module. */
const refusedFields = (r: Refusal | undefined): Pick<JobView, "refused" | "refusedCode" | "refusedKind" | "refusedSource"> =>
  r ? { refused: r.why, ...(r.code ? { refusedCode: r.code } : {}), ...(r.kind ? { refusedKind: r.kind } : {}), ...(r.source ? { refusedSource: r.source } : {}) } : {};

export class JobError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "JobError"; this.status = status; this.code = code; }
}

// Nothing of the kernel's own environment reaches a box: the docker client gets BOX_ENV only.
const BOX_ENV = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"];
const ID = /^[\w.-]{1,100}$/;

// The run (its `docker exec` client) under a `sh` of builtins only that records its exit status and outlives a stop's SIGTERM
// to record it. Stopping the client stops nothing in the box: the dispatcher releases the box (the launcher destroys it).
const WRAP = 'trap : TERM INT HUP; "$@"; echo "$?" > "$0"';
const POLL_MS = 250;
// Setup's retry on a lock another opener holds, while it makes the same schema (below): about five seconds in all.
const SETUP_TRIES = 200;
const SETUP_RETRY_MS = 25;
/** A detached run's recorded exit status ("" while it runs, or when it died without its shell). */
export const exitStatus = (file: string) => { try { return readFileSync(file, "utf8").trim(); } catch { return ""; } };
/**
 * `argv` as a detached run that outlives the kernel (a restart's next kernel follows it again: jobs' adopt, a check's follow):
 * its own process group under WRAP, output appended to `logPath`, its exit status written to `${logPath}.exit`, and only
 * BOX_ENV of the kernel's environment. Its pid.
 */
export function spawnDetached(argv: string[], logPath: string): number {
  const env = Object.fromEntries(BOX_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]));
  const out = openSync(logPath, "a");
  const child = spawn("/bin/sh", ["-c", WRAP, `${logPath}.exit`, ...argv], { cwd: "/", env, detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  child.on("error", (e: NodeJS.ErrnoException) => { try { writeFileSync(`${logPath}.exit`, "1\n"); appendFileSync(logPath, `# couldn't start /bin/sh: ${e.code ?? e.message}\n`); } catch {} });
  child.unref();
  return child.pid ?? 0;
}
/**
 * A failed run's cause as its log tells it: the first line that is neither the kernel's header (`# ...`) nor the engine's JSON
 * output, i.e. what the engine wrote to stderr (e.g. Codex's "Error: thread/resume failed: ..."), its secret shapes blanked: it
 * reaches the ledger, the Steward and the task. Read from the log's head only.
 */
/** The run's last message beside its log. The logs folder can be gone (deleted by hand): it is made again, and a write that
 * still fails is logged, never thrown, so a job's end can't take the kernel down (generation 399). */
export function writeLastMessage(logPath: string, text: string, log: (msg: string, fields?: Record<string, unknown>) => void) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(`${logPath}.last.md`, text);
  } catch (e) {
    log("couldn't write the job's last message", { log: logPath, err: (e as Error).message });
  }
}
/**
 * Model-format sentinels a tokenizer or chat template can leak into a reply as literal text: DeepSeek's begin/end of sentence
 * (its word separator is U+2581, and a model may echo it with underscores instead), the `<|...|>` chat templates, Gemma's
 * `<start_of_turn>` and OpenAI's `<|endoftext|>`. A run whose whole answer was sentinels is left with no message at all, which
 * its dispatcher reads as one that ended without a reply.
 */
const SENTINELS = [
  "<\uff5cbegin\u2581of\u2581sentence\uff5c>", "<\uff5cend\u2581of\u2581sentence\uff5c>",
  "<\uff5cbegin_of_sentence\uff5c>", "<\uff5cend_of_sentence\uff5c>",
  "<begin\u2581of\u2581sentence>", "<end\u2581of\u2581sentence>", "<begin_of_sentence>", "<end_of_sentence>",
  "<|im_start|>", "<|im_end|>", "<\uff5cim_start\uff5c>", "<\uff5cim_end\uff5c>",
  "<|start_header_id|>", "<|end_header_id|>", "<|eot_id|>", "<|eom_id|>",
  "<start_of_turn>", "<|end_of_turn|>", "<end_of_turn>",
  "<|begin_of_text|>", "<|end_of_text|>", "<|endoftext|>",
  "<\uff5cend\u2581of\u2581text\uff5c>", "<|end\u2581of\u2581text|>",
  // DeepSeek's turn markers, which stand alone at an edge and name the role in the marker itself.
  "<\uff5cUser\uff5c>", "<\uff5cAssistant\uff5c>", "<\uff5cSystem\uff5c>",
];
/**
 * A chat template's message header and the roles its own template gives a turn: `model` is Gemma's role, not ChatML's, so a
 * reply that opens with `<|im_start|>model` is a heading, and its text stays.
 */
const HEADERS: { text: string; roles: string[] }[] = [
  { text: "<|im_start|>", roles: ["system", "user", "assistant", "tool", "ipython"] },
  { text: "<\uff5cim_start\uff5c>", roles: ["system", "user", "assistant", "tool", "ipython"] },
  { text: "<|start_header_id|>", roles: ["system", "user", "assistant", "ipython", "tool"] },
  { text: "<start_of_turn>", roles: ["user", "model", "system"] },
];
/** The padding beside a sentinel: whitespace and the invisible characters a tokenizer leaves around one. */
const PAD = /[\s\u200b\ufeff\u2060]/;
/** The first index at or after `from` that is not padding, and the last before `to` that is not. */
const skipStart = (text: string, from: number, to: number) => {
  let i = from;
  while (i < to && PAD.test(text[i]!)) i++;
  return i;
};
const skipEnd = (text: string, from: number, to: number) => {
  let i = to;
  while (i > from && PAD.test(text[i - 1]!)) i--;
  return i;
};
/** The same as `skipEnd` inside a line: spaces and invisible characters, never a newline. */
const skipSpace = (text: string, from: number, to: number) => {
  let i = to;
  while (i > from && /[ \t\u200b\ufeff\u2060]/.test(text[i - 1]!)) i--;
  return i;
};
/** How long a role at `at` is, when one of `roles` starts there and a template delimiter follows it, else 0. */
const roleAt = (text: string, at: number, to: number, roles: string[]) => {
  const role = roles.find((r) => text.startsWith(r, at));
  if (!role) return 0;
  let i = at + role.length;
  while (i < to && /[ \t\u200b\ufeff\u2060]/.test(text[i]!)) i++;
  if (i >= to || text[i] === "\n" || text[i] === "\r") return role.length;
  return HEADERS.some((h) => text.startsWith(h.text, i)) || SENTINELS.some((s) => text.startsWith(s, i)) ? role.length : 0;
};
/** How far a leading header and its role reach past `from`, or undefined when the text there opens with neither. */
const afterHeader = (text: string, from: number, to: number) => {
  const header = HEADERS.find((h) => text.startsWith(h.text, from) && text[from - 1] !== "\\");
  if (!header) return undefined;
  // Only padding, never a newline, may sit between a header and its role: a role on the next line is the reply's own word.
  let at = from + header.text.length;
  while (at < to && /[ \t\u200b\ufeff\u2060]/.test(text[at]!)) at++;
  return at - from + roleAt(text, at, to, header.roles);
};
/** Where the reply's own text ends before a trailing header and its role ("Done.<|im_end|><|im_start|>user"), or undefined. */
const beforeHeader = (text: string, from: number, to: number) => {
  const end = skipEnd(text, from, to);
  for (const header of HEADERS) {
    const role = header.roles.find((r) => end - r.length >= from && text.startsWith(r, end - r.length));
    if (!role) continue;
    // As at the opening edge, a role on the next line is the reply's own word, never a template's role line.
    const head = skipSpace(text, from, end - role.length);
    const at = head - header.text.length;
    if (at >= from && text.startsWith(header.text, at) && text[at - 1] !== "\\") return at;
  }
  return undefined;
};
/**
 * True when the sentinel from `from` to `to` is the whole of a Markdown blockquote line ("> <|im_end|>"): the reply shows the
 * marker on purpose, so it stays. A marker anywhere else is a leak, however it is indented.
 */
const QUOTE_PREFIX = 64;
const quoted = (text: string, from: number, to: number, lineStart: number, limit: number) => {
  // A blockquote's own marks are a handful of characters: a longer prefix is reply text, and is not walked at all.
  if (from - lineStart > QUOTE_PREFIX) return false;
  const prefix = text.slice(lineStart, from);
  if (!/^[ \t]*>[ \t>]*$/.test(prefix)) return false;
  let i = to;
  while (i < limit && PAD.test(text[i]!)) i++;
  return i === limit;
};
/** The index at which each line starts, so a line start costs a lookup rather than a scan. */
const lineStarts = (text: string) => {
  const starts = [0];
  for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", nl + 1)) starts.push(nl + 1);
  return starts;
};
/**
 * A final message without the model-format sentinels a tokenizer or chat template leaks as literal text. They leak at the edges
 * of a completion, so a sentinel at either end is removed, with the padding beside it and the role line its header carries: a
 * reply that was only sentinels is left empty, so its dispatcher reads it as one that ended without a reply, while a reply that
 * shows a marker in a blockquote keeps it. Every step reads only the characters it needs, so a long reply or a run of
 * sentinels costs its own length rather than its square.
 */
export function stripSentinels(text: string): string {
  let from = 0, to = text.length;
  const starts = lineStarts(text);
  let line = 0;
  const leadLine = (at: number) => { while (line + 1 < starts.length && starts[line + 1]! <= at) line++; return starts[line]!; };
  let back = starts.length - 1;
  const tailLine = (at: number) => { while (back > 0 && starts[back]! > at) back--; return starts[back]!; };
  // Each edge is settled once: a removal there shortens the text and never touches the other edge, so neither end is rescanned.
  for (;;) {
    const at = skipStart(text, from, to);
    const after = afterHeader(text, at, to);
    const hit = after !== undefined ? undefined : SENTINELS.find((s) => text.startsWith(s, at) && text[at - 1] !== "\\");
    const reach = after ?? hit?.length;
    if (reach === undefined || quoted(text, at, at + reach, leadLine(at), to)) break;
    from = at + reach;
  }
  // The trailing scan stays inside what the leading one left: a reply that is the word `model` after a header is its own text.
  for (;;) {
    const end = skipEnd(text, from, to);
    const head = beforeHeader(text, from, end);
    if (head !== undefined) {
      if (quoted(text, head, end, tailLine(head), to)) break;
      to = head;
      continue;
    }
    const hit = SENTINELS.find((s) => end - s.length >= from && text.startsWith(s, end - s.length) && text[end - s.length - 1] !== "\\");
    if (!hit || quoted(text, end - hit.length, end, tailLine(end - hit.length), to)) break;
    to = end - hit.length;
  }
  return text.slice(skipStart(text, from, to), skipEnd(text, from, to));
}
export function firstError(logPath: string): string {
  let head = "";
  try { head = readFrom(logPath, 0, 256 * 1024).toString("utf8"); } catch { return ""; }
  const line = head.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("{"));
  return line ? clip(redact(line), 300) : "";
}
/** Codex's refusal to resume a session its home has no record of (one made before the box, or by a home since rebuilt). */
const STALE_SESSION = /no rollout found for thread id/;
/** The last `bytes` of a job's log (its end carries the engine's own error), or "" when it can't be read. */
export function logTail(logPath: string, bytes = 64 * 1024): string {
  try {
    const size = statSync(logPath).size;
    return readFrom(logPath, Math.max(0, size - bytes), bytes).toString("utf8");
  } catch {
    return "";
  }
}
export const alive = (pid: number) => {
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

const pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// Steps show command lines on the board: blank the usual secret shapes first, whatever the engine sent.
export const redact = (t: string) =>
  t
    .replace(/(Bearer|Basic|token)\s+[^\s'"]+/gi, "$1 …")
    .replace(/:\/\/[^/\s@]+@/g, "://…@")
    .replace(/([?&](?:token|key|secret|password|sig|access_token)=)[^&\s'"]+/gi, "$1…")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS)[A-Z0-9_]*)=[^\s'"]+/g, "$1=…")
    .replace(/\b(sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-|AKIA|ahqj_)[A-Za-z0-9_.-]+/g, "$1…");
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
  why TEXT NOT NULL DEFAULT '{}', usage TEXT, progress TEXT NOT NULL DEFAULT '{}', ended INTEGER, full_prompt TEXT, resumed INTEGER)`;

export function createJobs({ db, cfg, cp, mayDispatch, log, boxWrap, onEnd = () => {}, facts, agentKey = (id) => id, stateNeed }: {
  /** Flow's fact log (facts.ts): job.started and job.ended. */
  facts?: Facts;
  /** An agent's key (grants), for the facts' actor. */
  agentKey?: (agent: string) => string;
  /** A job ended (or was found lost): the kernel releases the box it got for it (boxes.ts). */
  onEnd?: (id: string) => void;
  db: DatabaseSync; cfg: SandboxConfig; cp: ControlPlane;
  /** The state root can't be made: the owner hears it once per episode (main.ts), not once per job. */
  stateNeed?: (e: Error, episode: string) => void;
  /** Whether this module dispatches this agent's jobs (compile: config/kernel/modules.json `dispatches`, by agent key). */
  mayDispatch: (module: string, agent: string) => boolean;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  /** The command a box job's engine runs under in its box (the computer launcher's scrub). */
  boxWrap: string;
}) {
  /**
   * The schema, as one step two openers can't both run: one BEGIN IMMEDIATE, every column read inside it, so the second opener
   * sees the first's ALTERs and skips them. An opener that finds the database busy (another is setting it up right now) tries
   * again just after it rather than failing, a bounded number of times so a lock that never frees is still an error.
   */
  const setup = () => {
    for (let attempt = 1; ; attempt++) {
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec(DDL);
        db.exec(REFUSALS_DDL);
        refusalColumns(db);
        // A kernel-admitted job's columns, added where they are missing: what admission records (the wake, the profile, the
        // job that started it, its frozen authority and routine), and boxes.ts's lease and release.
        const cols = new Set((db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
        for (const [c, t] of [["wake", "TEXT"], ["profile", "TEXT"], ["parent_job", "TEXT"], ["routine", "TEXT"], ["authority", "TEXT"], ["renewed", "INTEGER"], ["released", "INTEGER"], ["identifier", "TEXT"], ["full_prompt", "TEXT"], ["resumed", "INTEGER"]] as const) if (!cols.has(c)) db.exec(`ALTER TABLE jobs ADD COLUMN ${c} ${t}`);
        db.exec("CREATE INDEX IF NOT EXISTS jobs_task ON jobs (task, state)");
        db.exec("CREATE INDEX IF NOT EXISTS jobs_identifier ON jobs (identifier, state)"); // workspaces.ts: a folder's liveness
        db.exec("CREATE INDEX IF NOT EXISTS jobs_agent_at ON jobs (agent, at DESC)"); // work.ts: an agent's newest jobs first
        // `acked`: the dispatcher's completion acknowledgement. Runs that ended before the column existed were dealt with by the old ledger.
        if (!cols.has("acked")) db.exec("ALTER TABLE jobs ADD COLUMN acked INTEGER; UPDATE jobs SET acked = COALESCE(ended, at) WHERE state NOT IN ('admitted', 'running')");
        db.exec("COMMIT");
        return;
      } catch (e) {
        // The other opener holds the lock (here or at any step inside it): wait for it and try again, bounded.
        try { db.exec("ROLLBACK"); } catch {}
        if (busyError(e) && attempt < SETUP_TRIES) { pause(SETUP_RETRY_MS); continue; }
        throw e;
      }
    }
  };
  setup();
  const refusal = (id: string) => refusalOf(db, id);
  const watchers = new Map<string, { stop: () => void; send?: (text: string, from: string) => boolean; cancel: (by?: string) => void }>();
  const versions = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();
  const bump = (id: string) => {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    for (const w of waiters.get(id) ?? []) w();
    waiters.delete(id);
  };
  /** The job's queue and its wake's binding, as of its admission (its row's own time and wake): with its first start (queueFacts). */
  const queued = (r: Record<string, any>) => facts && queueFacts(db, strictFact(facts), r.id, agentKey(r.agent));
  /**
   * job.started / job.ended. An ended job carries what the gateway billed for it (its calls' run id is the job id: gateway/lib.ts
   * identify) and whether it acted: it filed a record, commented (outcomes.ts, cp.ts record who) or changed its task's status.
   * Strict: called inside the move it describes, which fails with it.
   */
  const jobFact = (r: Record<string, any>, type: "job.started" | "job.ended", data: Record<string, unknown> = {}) => {
    if (!facts) return;
    const at = Date.now();
    let extra: Record<string, unknown> = {};
    if (type === "job.ended") {
      const live = "status NOT IN ('cap_reached', 'reserved')";
      const sum = (() => { try { return db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached, COALESCE(SUM(output), 0) AS output FROM calls WHERE run_id = ? AND ${live}`).get(r.id) as Record<string, number>; } catch { return { cost_usd: 0, input: 0, cached: 0, output: 0 }; } })();
      const model = (() => { try { return (db.prepare(`SELECT model FROM calls WHERE run_id = ? AND ${live} GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1`).get(r.id) as { model: string } | undefined)?.model ?? ""; } catch { return ""; } })();
      const since = iso(r.at);
      const acted = (() => {
        try {
          return Boolean(db.prepare("SELECT 1 FROM facts WHERE task = ? AND at >= ? AND ((type = 'task.commented' AND json_extract(data, '$.job') = ?) OR (type = 'task.status_changed' AND actor = ?)) LIMIT 1").get(r.task, since, r.id, `agent:${agentKey(r.agent)}`)
            || db.prepare("SELECT 1 FROM records WHERE task = ? AND created_at >= ? LIMIT 1").get(r.task, since));
        } catch { return false; }
      })();
      // quiet: a routine run that only closed or parked its task (quiet.ts); written here and nowhere else.
      // no_reply: the run's answer was exactly NO_REPLY, a deliberate silence (a notice, a "thanks"); task state reads it as an answered turn.
      const noReply = String((row(r.id)?.final as string | undefined) ?? "").trim() === "NO_REPLY";
      extra = { ...sum, model, acted, ...(noReply ? { no_reply: true } : {}), quiet: (() => { try { return quietRun(db, { id: r.id, task: r.task, at: r.at, routine: r.routine, state: String(data.state), requester: r.agent }); } catch { return false; } })() };
    }
    strictFact(facts)({ type, subject: `job:${r.id}`, version: type === "job.started" ? "started" : "ended", at: iso(at), actor: `agent:${agentKey(r.agent)}`, task: r.task, data: { ...data, ...extra } });
  };
  const row = (id: string) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, any> | undefined;
  const view = (r: Record<string, any>): JobView => {
    const why = JSON.parse(r.why || "{}");
    const refused = refusal(r.id);
    return {
      id: r.id, module: r.module, agent: r.agent, task: r.task, state: r.state, pid: r.pid, log: r.log, dir: r.dir, at: r.at,
      jobcaps: JSON.parse(r.jobcaps), observing: r.observing === 1, live_input: r.live_input === 1, exit: r.exit ?? null, final: r.final,
      session: r.session ?? null, timedOut: why.timedOut === true,
      cancelled: why.cancelled === true, stoppedBy: why.by ?? null, usage: r.usage ? JSON.parse(r.usage) : null, progress: JSON.parse(r.progress || "{}"), version: versions.get(r.id) ?? 0, ended: r.ended ?? null, acked: r.acked != null, ...refusedFields(refused),
    };
  };

  /**
   * Follow a run to its end from its offset: events, exit file, deadline, and a cancel. `resumed`: this run started by resuming
   * a stored session, so a "no rollout found" failure falls back to one fresh turn (below); `restart` starts that turn.
   */
  function watch(id: string, opts: { resumed: boolean; restart: () => void }) {
    const r = row(id)!;
    const { pid, log: logPath, dir: jobDir } = r;
    const exitFile = `${logPath}.exit`;
    let offset: number = r.offset;
    let session: string | null = r.session ?? null;
    let final: string | undefined = r.final || undefined;
    const progress: Progress = JSON.parse(r.progress || "{}");
    const usage = { input: 0, cached: 0, output: 0, seen: false, ...(r.usage ? { ...JSON.parse(r.usage), seen: true } : {}) };
    const deadline = r.at + cfg.timeout_minutes * 60_000;
    let timedOut = false, cancelled = false, killed = false, stoppedBy: string | undefined;
    let over = false;
    let retried = false;
    const save = () => db.prepare("UPDATE jobs SET offset = ?, session = ?, final = ?, progress = ?, usage = ? WHERE id = ?").run(offset, session, final ?? "", JSON.stringify(progress), usage.seen ? JSON.stringify({ input: usage.input, cached: usage.cached, output: usage.output }) : null, id);
    const read = () => {
      let got;
      try {
        got = readEvents(jobDir, offset);
      } catch {
        return; // not a regular file: the job's own doing, nothing of it is read
      }
      if (got.offset === offset) return;
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
    let ending: { state: string; exit: number | null; lastMessage: string } | undefined;
    const done = () => {
      read();
      over = true;
      // A resumed session the engine can't find (one made before its own home, or by a home since rebuilt): the task's session
      // is cleared and the turn runs again at once on a fresh one, with the full first-turn prompt. Not a failure, and nothing
      // is reported. One shot per run: a run that started fresh never takes this path, so it can't loop.
      if (!ending && !retried && opts.resumed) {
        const status = exitStatus(exitFile);
        const code = status === "" ? null : Number(status);
        if (code !== null && code !== 0 && !timedOut && !cancelled && STALE_SESSION.test(logTail(logPath))) {
          retried = true;
          clearInterval(timer);
          watchers.delete(id);
          db.prepare("UPDATE jobs SET session = NULL WHERE agent = ? AND task = ? AND engine = ? AND authority IS NOT NULL").run(r.agent, r.task, r.engine);
          log("session not found: the turn runs again on a fresh session", { job: id, task: r.task, session: r.session });
          try {
            opts.restart();
            bump(id);
            return;
          } catch (e) {
            log("couldn't run the turn again on a fresh session", { job: id, task: r.task, err: (e as Error).message.slice(0, 300) });
            ending = end();
          }
        }
      }
      ending ??= end();
      const { state, exit, lastMessage } = ending;
      // The end and its fact in one transaction: if the fact can't be written the run stays running and the next tick tries again.
      try {
        inTx(db, "job_end", () => {
          db.prepare("UPDATE jobs SET state = ?, exit = ?, final = ?, why = ?, offset = ?, session = ?, ended = ? WHERE id = ?")
            .run(state, exit, lastMessage, JSON.stringify({ timedOut, cancelled, ...(stoppedBy ? { by: stoppedBy } : {}) }), offset, session, Date.now(), id);
          jobFact(r, "job.ended", { state, exit, why: state === "done" ? "" : state === "cancelled" ? `stopped${stoppedBy ? ` by ${stoppedBy}` : ""}` : state === "timeout" ? `ran past ${cfg.timeout_minutes} minutes` : clip(lastMessage, 200) });
        });
      } catch (e) {
        log("job end not recorded; tried again next tick", { job: id, task: r.task, state, err: (e as Error).message });
        return;
      }
      clearInterval(timer);
      watchers.delete(id);
      log("job finished", { job: id, task: r.task, state, exit });
      bump(id);
      onEnd(id);
    };
    /** How the run ended, worked out once (its log notes are written once). */
    const end = () => {
      const status = exitStatus(exitFile);
      const code = status === "" ? null : Number(status);
      let lastMessage = stripSentinels(String(final ?? ""));
      const startError = code === 127 && `couldn't start ${r.engine}: ENOENT`;
      if (!lastMessage && startError) {
        appendFileSync(logPath, `# ${startError}\n`);
        lastMessage = `The job couldn't start: ${startError}.`;
      }
      // A failed run that said nothing: its first error line is its last message, so the ledger, the Steward and the task's
      // failure notice carry the cause.
      const error = !lastMessage && code !== 0 && !timedOut && !cancelled ? firstError(logPath) : "";
      if (error) lastMessage = `The job failed: ${error}`;
      if (lastMessage) writeLastMessage(logPath, lastMessage, log);
      // No status: the run died without its shell, by its own stop or timeout (killed), else by hand (a failure).
      const exit = code === null && !killed ? 1 : code;
      const state = cancelled ? "cancelled" : timedOut ? "timeout" : exit ? "failed" : "done";
      return { state, exit, lastMessage };
    };
    const tick = () => {
      read();
      if (exitStatus(exitFile) || !alive(pid)) return done();
      if (!timedOut && Date.now() > deadline) (timedOut = true), kill();
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
    watchers.set(id, { stop: () => (clearInterval(timer), save()), send, cancel: (by) => { cancelled = true; stoppedBy = by; kill(); } });
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
        watch(r.id, adoptRestart(r));
        continue;
      }
      try {
        inTx(db, "job_lost", () => {
          db.prepare("UPDATE jobs SET state = 'lost', exit = NULL, ended = ? WHERE id = ?").run(Date.now(), r.id);
          jobFact(r, "job.ended", { state: "lost", exit: null, why: "no kernel followed it" });
        });
      } catch (e) {
        log("lost job not recorded; the next kernel tries again", { job: r.id, task: r.task, err: (e as Error).message });
        continue;
      }
      log("job lost while no kernel followed it", { job: r.id, task: r.task });
      onEnd(r.id);
    }
  }

  /** A fresh folder in the box's out folder for this run: a retry gets its own, so job.json is never written twice over. */
  const newJobDir = (outDir: string) => {
    for (let n = 1; n <= 50; n++) {
      const dir = join(outDir, n === 1 ? "job" : `job-${n}`);
      try {
        mkdirSync(dir, { mode: 0o700 });
        return dir;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    throw new Error(`no free job folder in ${outDir}`);
  };

  type Run = { box: Box; worktree: string; prompt: string; session?: string; fullPrompt?: string; label: string };

  /**
   * An admitted job (admission.ts) starts in the box the kernel got it (boxes.ts): its engine and authority are the row's,
   * frozen at admission; the caller adds only the prompt and the session to resume (`fullPrompt`: the full first-turn prompt,
   * used when no session resumes and when a stored one turns out stale).
   */
  function runAdmitted(id: string, run: Run) {
    const r = row(id);
    if (!r || r.state !== "admitted" || !r.authority) throw new JobError(409, "not-admitted", `job ${id} isn't waiting to start`);
    // The full first-turn prompt is kept on the row: a stale session's retry, and a retry after a kernel restart, both need it.
    db.prepare("UPDATE jobs SET full_prompt = ? WHERE id = ?").run(run.fullPrompt ?? run.prompt, id);
    start(id, run);
    return view(row(id)!);
  }

  /** Where a run adopted after a kernel restart starts again when its session turns out stale: its box, its workspace, its full prompt. */
  function adoptRestart(r: Record<string, any>): { resumed: boolean; restart: () => void } {
    const box = r.box ? (JSON.parse(r.box) as Box & { workspace?: string }) : undefined;
    return {
      // What the run itself started with, never a session its own events later reported.
      resumed: r.resumed === 1,
      restart: () => {
        if (!box?.workspace) throw new JobError(409, "no-box", `job ${r.id} has no box to run again in`);
        // A row from before the full prompt was kept has nothing to run the turn again with: it ends as it would have.
        if (!r.full_prompt) throw new JobError(409, "no-full-prompt", `job ${r.id} kept no full prompt`);
        start(r.id, { box, worktree: box.workspace, prompt: r.full_prompt, label: r.identifier ?? r.id });
      },
    };
  }

  /** Start (or restart, after a stale session) one run of an admitted job in its box, and follow it. */
  function start(id: string, { box, worktree, prompt, session, fullPrompt, label }: Run) {
    const r = row(id)!;
    const a = JSON.parse(r.authority) as { engine: string; model: string; effort: string; web: boolean };
    const entry = readEngines(cfg)[a.engine];
    if (entry?.box !== true) throw new JobError(400, "not-a-box-engine", `the ${a.engine} engine doesn't run in an agent computer`);
    // An engine that "reads" runs without web search (sandbox.ts observes).
    const engine: Engine = { kind: a.engine, model: a.model, effort: a.effort, ...(a.web === false ? { reads: true } : {}) };
    const resumed = Boolean(session && SESSION.test(session));
    // The prompt a turn runs with when nothing resumes: the caller's full form, else what the row kept at admission, else its own.
    const firstTurn = fullPrompt ?? r.full_prompt ?? prompt;
    const at = Date.now();
    const { logs } = ensureStateDirs(cfg.stateDir, stateNeed);
    // A retry is another run of the same job in the same box: its log (and its .exit beside it) must not be the last run's.
    const stem = join(logs, `${String(label).replace(/[^\w.-]/g, "_").slice(0, 60)}-${at}`);
    let logPath = `${stem}.log`;
    for (let n = 2; existsSync(`${logPath}.exit`) || existsSync(logPath); n++) logPath = `${stem}-${n}.log`;
    const jobDir = newJobDir(box.outDir);
    const built = buildJob({ cfg, engine, worktree, jobDir, sessionId: session, prompt, job: { agentId: r.agent, issueId: r.task, at }, box, boxWrap });
    appendFileSync(logPath, `# ${new Date(at).toISOString()} ${engine.kind}${engine.model ? ` (${engine.model})` : ""} in box ${box.container} (${worktree})\n`);
    const pid = spawnDetached(built.argv, logPath);
    // Running and its fact in one transaction; if they can't be written the run is stopped and the start fails (admission's
    // couldn't-start path ends the job).
    try {
      inTx(db, "job_start", () => {
        if (r.state === "admitted") queued(r);
        // `resumed`: this run started by resuming a stored session (a run restarted after a kernel reboot needs to know).
        db.prepare("UPDATE jobs SET pid = ?, log = ?, dir = ?, at = ?, box = ?, session = ?, resumed = ?, offset = 0, final = '', progress = '{}', usage = NULL, observing = ?, live_input = ?, state = 'running' WHERE id = ?")
          .run(pid, logPath, jobDir, at, JSON.stringify(box), resumed ? session! : null, resumed ? 1 : 0, observes(engine) ? 1 : 0, entry.live_input ? 1 : 0, id);
        jobFact(r, "job.started");
      });
    } catch (e) {
      try { if (pid) process.kill(-pid, "SIGKILL"); } catch {}
      throw e;
    }
    log("job started", { job: id, module: r.module, agent: r.agent, task: r.task, engine: engine.kind, pid, box: box.container });
    watch(id, {
      resumed,
      restart: () => start(id, { box, worktree, prompt: firstTurn, label }),
    });
    return view(row(id)!);
  }

  const own = (module: string, id: string) => {
    const r = row(id);
    if (!r || r.module !== module) throw new JobError(404, "no-job", `no job ${id}`);
    return r;
  };

  return {
    runAdmitted,
    adopt,
    /**
     * The workspace a dispatcher may have written into before a job starts (the code host's clone asks, with the caller's own
     * token): an open task assigned now to an agent this module dispatches. Its folder's name.
     */
    async workspace(module: string, taskId: unknown): Promise<{ task: string; workspace: string }> {
      if (!ID.test(String(taskId))) throw new JobError(400, "bad-request", "send {task}");
      const task = await cp.task(String(taskId));
      if (!task?.assigneeAgentId || !mayDispatch(module, String(task.assigneeAgentId))) throw new JobError(403, "not-your-task", `module ${module} doesn't dispatch task ${taskId}'s agent`);
      if (["done", "cancelled"].includes(String(task.status))) throw new JobError(409, "task-closed", `task ${taskId} is ${task.status}`);
      const ident = String(task.identifier ?? "");
      if (!ID.test(ident)) throw new JobError(400, "bad-task", `task ${taskId} has no identifier`);
      return { task: String(taskId), workspace: ident };
    },
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
    /** The module's jobs the kernel keeps for it: a task's (newest first), or every one not yet acknowledged (live, or ended and unacknowledged). */
    list: (module: string, f: { task: string } | { open: true }) => (("task" in f
      ? db.prepare("SELECT * FROM jobs WHERE module = ? AND task = ? ORDER BY at DESC").all(module, f.task)
      : db.prepare("SELECT * FROM jobs WHERE module = ? AND acked IS NULL ORDER BY at").all(module)) as Record<string, any>[]).map(view),
    /** The dispatcher is done with an ended job (its outcome posted, whoever asked told): it leaves the open list. */
    ack(module: string, id: string) {
      const r = own(module, id);
      if (r.state === "admitted" || r.state === "running") throw new JobError(409, "job-live", `job ${id} is still ${r.state}`);
      db.prepare("UPDATE jobs SET acked = ? WHERE id = ? AND acked IS NULL").run(Date.now(), id);
      return view(row(id)!);
    },
    stop(module: string, id: string) {
      const r = own(module, id);
      if (r.state === "running") watchers.get(id)?.cancel();
      return view(row(id)!);
    },
    /** The owner's Stop (the board, as `by`, an account id): every running job of a task, or of an agent, whatever module runs it; or one job (the Steward's reviewed stop). */
    stopRunning(f: { task: string } | { agent: string } | { job: string }, by: string) {
      const [col, v] = "task" in f ? ["task", f.task] : "agent" in f ? ["agent", f.agent] : ["id", f.job];
      return (db.prepare(`SELECT * FROM jobs WHERE state IN ('admitted', 'running') AND ${col} = ?`).all(v) as Record<string, any>[]).flatMap((r) => {
        if (r.state === "admitted") {
          // Still launching (its computer or clones): ended now, so runAdmitted refuses to start it ("isn't waiting to start").
          inTx(db, "job_stopped_early", () => {
            if (!db.prepare("UPDATE jobs SET state = 'cancelled', final = 'Stopped before it started.', why = ?, ended = ? WHERE id = ? AND state = 'admitted'").run(JSON.stringify({ cancelled: true, by }), Date.now(), r.id).changes) return;
            queued(r);
            jobFact(r, "job.ended", { state: "cancelled", exit: null, why: `stopped by ${by}` });
          });
          return [view(row(r.id)!)];
        }
        const w = watchers.get(r.id);
        if (!w) return [];
        w.cancel(by);
        return [view(r)];
      });
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
  const r = db.prepare("SELECT agent, task, state, authority, identifier FROM jobs WHERE id = ? AND authority IS NOT NULL").get(id) as { agent: string; task: string; state: string; authority: string; identifier: string | null } | undefined;
  return r && { agent: r.agent, task: r.task, state: r.state, authority: JSON.parse(r.authority), identifier: r.identifier ?? "" };
}

/**
 * A job's queue (from its wake's time) and its wake's binding, as of its admission: written with the job's first start, or with its
 * end when it couldn't start, inside that move. A job deferred for want of a computer (its row deleted, its wake given back)
 * never had either, so nothing reads it as queued. Call it before the start rewrites the row's `at`.
 */
export function queueFacts(db: DatabaseSync, fact: (f: { type: string; subject: string; version: string; at: string; actor: string; task: string; data: Record<string, unknown> }) => void, id: string, key: string) {
  const r = db.prepare("SELECT task, wake, at FROM jobs WHERE id = ?").get(id) as { task: string; wake: string | null; at: number } | undefined;
  if (!r?.wake) return;
  const w = db.prepare("SELECT at FROM wakes WHERE key = ?").get(r.wake) as { at: number } | undefined;
  fact({ type: "job.queued", subject: `job:${id}`, version: "queued", at: iso(r.at), actor: `agent:${key}`, task: r.task, data: { wake: r.wake, wake_at: iso(w?.at ?? r.at), agent: key } });
  fact({ type: "wake.bound", subject: `wake:${r.wake}`, version: `bound:${id}`, at: iso(r.at), actor: "kernel", task: r.task, data: { job: id } });
}
