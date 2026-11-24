// The wake inbox (one-way spec §4.2a): every reason to run an agent on a task is one durable row in kernel.db, written by
// one per-task scan. The reconcile poll scans every open task of the polled agents; a Paperclip event (the paperclip-events
// plugin, at most once and with duplicates) only scans its one task sooner. A dispatcher (role kernel.jobs) claims rows and
// turns them into jobs; admission binds `job` (unique, so a wake starts at most one job).
// Keys (never Paperclip's eventId): comment:<commentId>, issue:<issueId>:<updatedAt> (assigned or moved to todo),
// routine-run:<issueId> (a routine run's new task, cause routine:<key>: the routine's compiled key, so admission applies its own
// model; dispatch folds a run into an earlier open one of its routine, and cancels overtaken blocked ones), reopen:<issueId>:<statusVersion> (a comment reopened a finished task),
// wake_at:<module>.<id> (a module's scheduled wake, due at `until`), wait:<issueId>:<until> (an agent's own wait, idle.ts),
// idle:<issueId>:<since> (the idle sweep's nudge, idle.ts), unblocked:<issueId>:<closure> (a blocked task whose first-class
// blockers (blockedBy) are all done, cancelled or deleted: the poll moves it to todo with one tagged notice, then files
// this wake).
// Polled agents: those the modules that claim wakes dispatch (compile's `dispatches`); a module joins on its first claim.
// So nothing is polled until a dispatcher claims, and an agent's first scan only wakes for comments after its dispatcher
// joined or its own last word on the task, whichever is later.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Api } from "./channels.ts";
import { inTx, iso, strictFact } from "./factlog.ts";
import type { FactRow, Facts } from "./facts.ts";
import type { Outcomes } from "./outcomes.ts";
import { mentionedRepos } from "./boxes.ts";
import { agentPaused } from "../sdk/src/agent-paused.ts";
import { CONTINUITY_MS, decisionText, pickMember, weightsOf, type Candidate, type Weights } from "./team-routing.ts";

/** A comment the kernel posted for a job (outcomes.ts): it never wakes anyone. */
export const SELF_TAG = /<!-- aidenhq:job=/;
const OPEN = "todo,in_progress,in_review";
const LIVE = "('admitted','running')";
/** A claimed row with no job comes back to its claimer after this (a dispatcher crash, a busy admission). */
export const LEASE_MS = 60_000;

const DDL = `CREATE TABLE IF NOT EXISTS wakes (key TEXT PRIMARY KEY, task TEXT NOT NULL, agent TEXT NOT NULL, cause TEXT NOT NULL,
  at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, job TEXT UNIQUE, until INTEGER);
CREATE INDEX IF NOT EXISTS wakes_task ON wakes (task, state);
CREATE TABLE IF NOT EXISTS wake_tasks (task TEXT PRIMARY KEY, agent TEXT, status TEXT, comment TEXT);
CREATE TABLE IF NOT EXISTS wake_dispatchers (module TEXT PRIMARY KEY, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dispatch_since (agent TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS team_routes (task TEXT PRIMARY KEY, team TEXT NOT NULL, member TEXT, repos TEXT NOT NULL, at INTEGER NOT NULL,
  state TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, record TEXT NOT NULL DEFAULT '', snapshot TEXT);
CREATE TABLE IF NOT EXISTS chat_reopen (task TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_cursor (agent TEXT PRIMARY KEY, at INTEGER NOT NULL, after TEXT, until INTEGER);`;
/** What a decision was made from (team_routes.snapshot): the learning loop replays it with other weights or repos (routing-tune.ts). */
export type RouteSnapshot = { weights: Weights; candidates: Candidate[] };
/** A grants-table entry as the router reads it (compile's grantEntry): a team record lists its members; a member names its record. */
type TeamGrant = { key?: string; max_parallel?: number; team?: { name: string; members: string[]; weights?: Partial<Weights> }; member_of?: string; repos?: string[] };

/**
 * A wake notice: a labelled comment on the task, posted as the owner, which wakes its agent (asker.tell's open-parent path and
 * the team router's blocked path). A closed task hears nothing (a comment would reopen it).
 *
 * `id` is the producer's key for the notice: with one, the comment also carries `<!-- aidenhq-wake-id:<id> -->` and the task's
 * thread is read first, so a notice filed again (a retry after the send's answer was lost) posts nothing when its comment is
 * already there. The plain `WAKE_NOTICE` tag stays whole beside it, so every reader of a wake notice is unaffected. Without an
 * id it posts every time, as the kernel's own notices (escalate, outcomes) always have.
 */
export async function wakeNotice(owner: Api, task: string, text: string, id?: string): Promise<"posted" | "closed" | "missing" | "duplicate"> {
  const issue = await owner("GET", `/api/issues/${encodeURIComponent(task)}`);
  // Only a 404 says the task is gone. Anything else (a 5xx, a timeout) says nothing about it, and `missing` would be read as "no
  // task" by the producer, whose fallback is the owner: a transient read would alert the owner over a task that is still there.
  if (issue.status === 404) return "missing";
  if (issue.status !== 200) throw Object.assign(new Error(`the control plane answered ${issue.status} reading the task`), { status: 502 });
  const mark = id ? `<!-- aidenhq-wake-id:${id} -->` : "<!-- aidenhq-wake -->";
  if (id) {
    // Its own marker, read back from the task's thread: the control plane offers no comment idempotency key, so this is the only
    // way a second send of the same notice is known to be a second send. Read before the status is judged: a notice that already
    // landed is a duplicate even if its task has closed since, and a producer told "closed" would alert the owner for nothing.
    // A read that failed says nothing either way, so it is retried (502) rather than posting blind and waking the agent twice.
    const h = await owner("GET", `/api/issues/${encodeURIComponent(issue.json.id)}/comments`);
    if (h.status !== 200) throw Object.assign(new Error(`the control plane answered ${h.status} reading the task's thread`), { status: 502 });
    const seen = h.json as Comment[] | { comments?: Comment[] };
    const list = Array.isArray(seen) ? seen : seen?.comments ?? [];
    if (list.some((c) => !c.deletedAt && String(c.body ?? "").includes(mark))) return "duplicate";
  }
  if (["done", "cancelled"].includes(issue.json.status)) return "closed";
  const c = await owner("POST", `/api/issues/${encodeURIComponent(issue.json.id)}/comments`, { body: `[wake] ${text}\n\n<!-- aidenhq-wake -->${id ? `\n${mark}` : ""}` });
  if (c.status >= 300) throw Object.assign(new Error(`the control plane answered ${c.status}`), { status: 502 });
  return "posted";
}

export interface Wake { key: string; task: string; agent: string; cause: string; at: number; state: string; claimed_by: string | null; job: string | null; until: number | null }
type Issue = { id: string; identifier?: string; title?: string; description?: string | null; parentId?: string | null; status?: string; assigneeAgentId?: string | null; assigneeUserId?: string | null; labels?: { name?: string }[]; updatedAt?: string; createdAt?: string; statusVersion?: number; completedAt?: string | null; cancelledAt?: string | null; blockedBy?: { id: string; identifier?: string | null; status: string }[]; originKind?: string | null; originId?: string | null; companyId?: string; createdByAgentId?: string | null };
type Comment = { id: string; body?: string; authorAgentId?: string | null; authorUserId?: string | null; createdAt?: string; deletedAt?: string | null };
type Log = (msg: string, f?: Record<string, unknown>) => void;
const ms = (t?: string) => (t ? Date.parse(t) || 0 : 0);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function createWakes({ db, owner, post, dispatches, containers = () => new Set(), routineKey = () => undefined, grants = () => ({}), knownRepo = () => false, tellBlocked = async () => {}, facts, log = () => {}, now = Date.now }: {
  /** Flow's fact log (facts.ts): task changes the scan sees, and each wake's opening, binding and dropping. */
  facts?: Facts;
  db: DatabaseSync;
  /** The control plane as the owner (only reads). */
  owner: Api;
  /** Writes as the task's agent (outcomes.ts): notes, and a routine run a dispatcher cancels. */
  post: Outcomes["post"];
  /** Whether a module dispatches an agent (jobs.ts dispatchesFrom), and the agents it dispatches (ids). */
  dispatches: { may: (module: string, agent: string) => boolean; agents: (module: string) => string[] };
  /**
   * The log tasks setup makes and an agent holds (grants review_log, chat_task, fleet_issues), by id or
   * identifier: written to by many, they wake nobody (the chat lane answers a chat task's words itself).
   */
  containers?: () => Set<string>;
  /** A Paperclip routine's compiled key (grants `routine_keys`, setup): none for a routine setup didn't make. */
  routineKey?: (routine: string) => string | undefined;
  /** The grants table's agents by id: teams and members (team routing). */
  grants?: () => Record<string, TeamGrant | undefined>;
  /** Whether a repo (owner/name, lower case) is one the instance's code hosts have: a task's text names only those for routing. */
  knownRepo?: (repo: string) => boolean;
  /** A team task no member can take, blocked: whoever delegated it hears why (its open parent's wake notice, else the owner). */
  tellBlocked?: (task: Issue, text: string) => Promise<void>;
  log?: Log; now?: () => number;
}) {
  db.exec(DDL);
  // What the task facts last recorded of each task (task_facts_seen: its holder, status and blockers, and when): their own cursor,
  // apart from wake_tasks, so a change the kernel observes at once (observe) records its facts and never swallows the wake the scan
  // files from that same change. Born from wake_tasks when it first appears.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'task_facts_seen'").get()) {
    db.exec("CREATE TABLE task_facts_seen (task TEXT PRIMARY KEY, holder TEXT, status TEXT, blocked TEXT, at INTEGER NOT NULL DEFAULT 0)");
    db.exec("INSERT INTO task_facts_seen (task, holder, status, blocked) SELECT task, CASE WHEN agent IS NULL THEN NULL ELSE 'agent:' || agent END, status, NULL FROM wake_tasks");
  }
  if (!(db.prepare("PRAGMA table_info(team_routes)").all() as { name: string }[]).some((c) => c.name === "snapshot")) db.exec("ALTER TABLE team_routes ADD COLUMN snapshot TEXT");
  // What the scan last saw of a task (wake_tasks): `blocked` its blocker ids, and `polled` whether the wake logic has run on it
  // (a row made only to diff the task's facts, for a task nobody polls, is not a first sight's cursor).
  const have = new Set((db.prepare("PRAGMA table_info(wake_tasks)").all() as { name: string }[]).map((c) => c.name));
  if (!have.has("blocked")) db.exec("ALTER TABLE wake_tasks ADD COLUMN blocked TEXT");
  // The names its blockers had when last seen, and the verdict one issue read reached for each id, held for the live-list state
  // it was read in: `blocked_deleted` (a 404, id → `listed`/`absent`) and `blocked_exists` (a 200, the same shape). An id costs
  // one read per state change, so a blocker that sits unresolved costs one GET in total and the steady-state poll issues none.
  if (!have.has("blocked_names")) db.exec("ALTER TABLE wake_tasks ADD COLUMN blocked_names TEXT");
  if (!have.has("blocked_deleted")) db.exec("ALTER TABLE wake_tasks ADD COLUMN blocked_deleted TEXT");
  if (!have.has("blocked_exists")) db.exec("ALTER TABLE wake_tasks ADD COLUMN blocked_exists TEXT");
  if (!have.has("polled")) db.exec("ALTER TABLE wake_tasks ADD COLUMN polled INTEGER NOT NULL DEFAULT 1");
  // When a row was last claimed (`claimed_at`): the dispatcher reads the task's thread after it claims, so the job a wake starts
  // covers what happened before its claim, not before its spawn (a box start or a clone can take minutes).
  if (!(db.prepare("PRAGMA table_info(wakes)").all() as { name: string }[]).some((c) => c.name === "claimed_at")) db.exec("ALTER TABLE wakes ADD COLUMN claimed_at INTEGER");
  // An unblock half done (unblock): its blocker relations cleared, its move to todo not yet written.
  db.exec("CREATE TABLE IF NOT EXISTS unblocking (task TEXT PRIMARY KEY, closure TEXT NOT NULL, line TEXT NOT NULL)");
  const q = (sql: string) => db.prepare(sql);
  // Strict: every fact here is written in the move it describes, which fails with it.
  const fact = facts ? strictFact(facts) : () => {};
  const keyOf = (agent: string | null | undefined) => (agent ? grants()[agent]?.key ?? agent : null);
  const insert = (key: string, task: string, agent: string, cause: string, at: number, until: number | null = null, author = "unknown") => {
    const opened = inTx(db, "wake_open", () => {
      const r = q("INSERT OR IGNORE INTO wakes (key, task, agent, cause, at, until) VALUES (?, ?, ?, ?, ?, ?)").run(key, task, agent, cause, at, until);
      if (r.changes) fact({ type: "wake.opened", subject: `wake:${key}`, version: "opened", at: iso(at), actor: author, task, data: { cause, author } });
      return r.changes > 0;
    });
    if (opened) log("wake", { key, task, cause });
    return opened;
  };
  /**
   * A routine run's dropped wake comes back: dispatch drops a 4xx for good (the pre-#790 403 on the routine read), and without a
   * re-arm the run then sits in `todo` with no job until someone writes its status. Only a dropped row moves; open, claimed,
   * delivered and done rows stay as they are, so a run still gets exactly one job.
   */
  const rearmRoutine = (key: string, task: string, agent: string, cause: string, author: string) => {
    const t = now();
    const reopened = inTx(db, "wake_rearm", () => {
      const r = q("UPDATE wakes SET state = 'open', agent = ?, cause = ?, claimed_by = NULL, job = NULL, until = NULL, at = ? WHERE key = ? AND task = ? AND state = 'dropped'").run(agent, cause, t, key, task);
      if (r.changes) fact({ type: "wake.opened", subject: `wake:${key}`, version: `reopened@${t}`, at: iso(t), actor: author, task, data: { cause, author } });
      return r.changes > 0;
    });
    if (reopened) log("wake reopened", { key, task });
  };
  const dropped = (w: { key: string; task: string }, why: string) => fact({ type: "wake.dropped", subject: `wake:${w.key}`, version: "dropped", at: iso(now()), actor: "kernel", task: w.task, data: { why: why.slice(0, 200) } });
  /** A comment a job consumed (its prompt, or its live input, carried it): bound to that job, as admission binds a starter. */
  const covered = (w: { key: string; task: string }, job: string) => fact({ type: "wake.bound", subject: `wake:${w.key}`, version: `bound:${job}`, at: iso(now()), actor: "kernel", task: w.task, data: { job } });
  const blockedKey = (i: Issue) => (i.blockedBy ? i.blockedBy.map((b) => b.id).sort().join(",") : null);
  /** A read's verdict for a blocker id: `listed` or `absent`, the live list at the time it was read. */
  type Verdicts = Record<string, "listed" | "absent">;
  /** The verdicts one issue read reached, id → the list state it was read in. Tolerates the plain arrays older rows hold. */
  const verdicts = (v: string | null | undefined): Verdicts => {
    try {
      const raw: unknown = v ? JSON.parse(v) : null;
      if (Array.isArray(raw)) return Object.fromEntries(raw.filter((x): x is string => typeof x === "string").map((id) => [id, "absent" as const]));
      if (raw && typeof raw === "object") return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, "listed" | "absent"] => e[1] === "listed" || e[1] === "absent")) as Verdicts;
    } catch {}
    return {};
  };
  /** The ids whose verdict holds for this live list: each read is evidence only for the state it was read in. */
  const held = (v: Verdicts, live: Set<string>) => Object.keys(v).filter((id) => (v[id] === "listed") === live.has(id));
  /**
   * What a scan writes of a task's blockers, scoped to its current blocked period: the ids it had (`blocked`), their names,
   * and the verdicts one issue read reached (`blocked_deleted` on a 404, `blocked_exists` on a 200), kept until `unblock()`
   * releases the task. The live list is added, never replaces them, so an id that went is still known. A row that leaves
   * `blocked`, or enters it from outside, starts with this period's list only: a completed blocker on a todo task, or an
   * earlier period, is never mistaken for a deletion. A list row may leave `blockedBy` out: then it says nothing and the row
   * keeps exactly what it has, including nothing.
   */
  const memory = (seen: { status: string | null; blocked: string | null; blocked_names: string | null; blocked_deleted: string | null; blocked_exists: string | null } | undefined, status: string, issue: Issue) => {
    // A done or cancelled task is before `blocked`, whatever its row still says.
    const carried = status === "blocked" && seen?.status === "blocked";
    if (status !== "blocked") return { blocked: null, names: null, deleted: null, exists: null };
    if (!Array.isArray(issue.blockedBy)) return { blocked: carried ? seen!.blocked : null, names: carried ? seen!.blocked_names : null, deleted: carried ? seen!.blocked_deleted : null, exists: carried ? seen!.blocked_exists : null };
    const ids = new Set((carried ? (seen?.blocked ?? "").split(",") : []).filter(Boolean));
    for (const b of issue.blockedBy) ids.add(b.id);
    let names: Record<string, string> = {};
    if (carried && seen?.blocked_names) { try { names = JSON.parse(seen.blocked_names) as Record<string, string>; } catch { names = {}; } }
    for (const b of issue.blockedBy) names[b.id] = b.identifier ?? names[b.id] ?? b.id;
    // A verdict is evidence for the list state it was read in, and is carried only while the id stays in it (see `verdicts`).
    const live = new Set(issue.blockedBy.map((b) => b.id));
    const only = (v: string | null | undefined) => { const all = verdicts(v), kept = Object.fromEntries(held(all, live).map((id) => [id, all[id]])); return Object.keys(kept).length ? JSON.stringify(kept) : null; };
    return { blocked: [...ids].join(",") || null, names: Object.keys(names).length ? JSON.stringify(names) : null, deleted: carried ? only(seen?.blocked_deleted) : null, exists: carried ? only(seen?.blocked_exists) : null };
  };

  /**
   * What changed on a task since its facts last said, as facts (spec: flow §1). Their versions come from Paperclip, so the event
   * path and the poll that see one change record it once. A task with no task.created fact gets one (also one seen before the
   * log had it), with the status and assignee it has (from what its facts last said). `actor`: who Paperclip says did it, else
   * unknown. The holder is the agent, `"owner"` (a user assignee: every admin is the owner) or none. Status, holder and the chat
   * flag are read against the facts themselves, so a fact never written heals on the next look.
   * A chat flag the created fact lacks or that changed later is a `task.labeled` fact, dated at the created one (a flag, never
   * activity). The facts and that cursor move in one transaction.
   */
  const TASK_FACTS = ["task.created", "task.labeled", "task.status_changed", "task.assignee_changed", "task.blocked_changed"];
/** The statuses the pinned recovery sweep scans (idle.ts holds a settled wait out of all of them). */
const SCANNED = new Set(["todo", "in_progress", "in_review"]);
  const lastFacts = (task: string) => facts?.latest(`task:${task}`, TASK_FACTS) ?? new Map<string, FactRow>();
  /** A task's chat flag: its newest task.labeled, else its created fact's (undefined for a created fact older than the flag). */
  const chatOf = (last: Map<string, FactRow>) => { const c = last.get("task.labeled")?.data.chat ?? last.get("task.created")?.data.chat; return typeof c === "boolean" ? c : undefined; };
  /** A chat: the `chat` label when the read has labels, else the chat flag its facts recorded. */
  const isChat = (issue: Issue) => (Array.isArray(issue.labels) ? issue.labels.some((l) => l.name === "chat") : chatOf(lastFacts(issue.id)) === true);
  /**
   * The owner's own word on a task: a person's comment, never an agent's or any kernel-written tag (a kernel notice, a wake
   * notice, a bridge's relay: all posted under the owner's key but not said by them).
   */
  const ownerWord = (c: Comment) => !c.authorAgentId && Boolean(c.authorUserId) && !String(c.body ?? "").includes("<!-- aidenhq");
  /**
   * The issue as its facts need it: a list row may lack the description a first fact reads (a module's markers) or the labels a
   * chat flag reads, so a task with no created fact, or one whose chat flag nobody recorded, is read once whole.
   */
  const whole = async (issue: Issue): Promise<Issue> => {
    if (!facts) return issue;
    const last = lastFacts(issue.id);
    const need = last.has("task.created") ? chatOf(last) === undefined && !Array.isArray(issue.labels) : issue.description === undefined || !Array.isArray(issue.labels);
    if (!need) return issue;
    const r = await owner("GET", `/api/issues/${encodeURIComponent(issue.id)}`);
    return r.status === 200 ? (r.json as Issue) : issue;
  };
  const taskFacts = (issue: Issue, source: "live" | "poll", actor: string) => inTx(db, "task_facts", () => recordTaskFacts(issue, source, actor));
  function recordTaskFacts(issue: Issue, source: "live" | "poll", actor: string) {
    const last = lastFacts(issue.id);
    const base = { subject: `task:${issue.id}`, task: issue.id, actor, source };
    const changed = ms(issue.updatedAt) || now();
    // A task a module filed (modtasks.ts: its marker and source, no agent made it) has the module as origin and its source as marker.
    const module = issue.createdByAgentId ? undefined : /<!-- aidenhq-module:([\w-]+) -->/.exec(issue.description ?? "")?.[1];
    const marker = module ? /<!-- source:(\S{1,200}) -->/.exec(issue.description ?? "")?.[1] : undefined;
    const chat = Array.isArray(issue.labels) ? issue.labels.some((l) => l.name === "chat") : undefined;
    const created = last.get("task.created");
    if (!created) fact({ ...base, type: "task.created", version: "created", at: iso(ms(issue.createdAt) || changed), data: { parent: issue.parentId ?? null, identifier: issue.identifier ?? null, chat: Boolean(chat), origin: issue.originKind ?? (module ? `module:${module}` : null), source_marker: issue.originId ?? marker ?? null } });
    else if (chat !== undefined && chatOf(last) !== chat) fact({ ...base, type: "task.labeled", version: `chat:${chat}@${issue.updatedAt ?? changed}`, at: created.at, data: { chat } });
    const status = String(issue.status ?? "");
    const was = str(last.get("task.status_changed")?.data.to);
    // A close is dated by Paperclip's own close time, not the last edit: a task first seen long after it closed is no recent closure.
    const closedAt = ms((status === "done" ? issue.completedAt : status === "cancelled" ? issue.cancelledAt : null) ?? "");
    if (status && was !== status) fact({ ...base, type: "task.status_changed", version: String(issue.statusVersion ?? issue.updatedAt ?? changed), at: iso(closedAt || changed), data: { from: was, to: status } });
    const holder = issue.assigneeAgentId ? `agent:${issue.assigneeAgentId}` : issue.assigneeUserId ? "owner" : null;
    const to = holder ? (holder === "owner" ? holder : keyOf(holder.slice(6))) : null;
    const from = str(last.get("task.assignee_changed")?.data.to);
    if (from !== to) fact({ ...base, type: "task.assignee_changed", version: String(issue.updatedAt ?? changed), at: iso(changed), data: { from, to } });
    const blocked = blockedKey(issue);
    const lastBlocked = last.get("task.blocked_changed")?.data.blocked_by;
    const wasBlocked = Array.isArray(lastBlocked) ? lastBlocked.map(String).sort().join(",") : "";
    if (blocked !== null && blocked !== wasBlocked) fact({ ...base, type: "task.blocked_changed", version: `${blocked}@${issue.updatedAt ?? changed}`, at: iso(changed), data: { blocked_by: blocked ? blocked.split(",") : [] } });
    q("INSERT INTO task_facts_seen (task, holder, status, blocked, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task) DO UPDATE SET holder = excluded.holder, status = excluded.status, blocked = COALESCE(excluded.blocked, blocked), at = excluded.at").run(issue.id, holder, status, blocked, now());
  }
  /** The polled agents, each with when its dispatcher joined. */
  const polled = () => {
    const out = new Map<string, number>();
    for (const r of q("SELECT module, since FROM wake_dispatchers ORDER BY since").all() as { module: string; since: number }[]) for (const a of dispatches.agents(r.module)) if (!out.has(a)) out.set(a, r.since);
    return out;
  };
  /** When the inbox took an agent over (dispatch_since): kept from the first time it was polled. */
  const since = (agent: string, joined: number) => {
    q("INSERT OR IGNORE INTO dispatch_since (agent, at) VALUES (?, ?)").run(agent, joined);
    return (q("SELECT at FROM dispatch_since WHERE agent = ?").get(agent) as { at: number }).at;
  };
  // A job with `at`: what it covers, the claim of the wake that started it (its spawn time for a job no claimed wake started).
  const liveJob = (task: string) => q(`SELECT j.id, COALESCE(w.claimed_at, j.at) AS at FROM jobs j LEFT JOIN wakes w ON w.job = j.id WHERE j.task = ? AND j.state IN ${LIVE} ORDER BY j.at DESC LIMIT 1`).get(task) as { id: string; at: number } | undefined;
  const lastJob = (task: string) => q("SELECT j.id, COALESCE(w.claimed_at, j.at) AS at FROM jobs j LEFT JOIN wakes w ON w.job = j.id WHERE j.task = ? ORDER BY j.at DESC LIMIT 1").get(task) as { id: string; at: number } | undefined;

  /** One task's wakes: new comments past its cursor, and a move to todo (or a first sight of an unstarted todo task). */
  async function scan(issue: Issue, { reopened = false, source = "live", actor = "unknown", rehome = true }: { reopened?: boolean; source?: "live" | "poll"; actor?: string; rehome?: boolean } = {}) {
    const seen = q("SELECT agent, status, comment, blocked, blocked_names, blocked_deleted, blocked_exists, polled FROM wake_tasks WHERE task = ?").get(issue.id) as { agent: string | null; status: string | null; comment: string | null; blocked: string | null; blocked_names: string | null; blocked_deleted: string | null; blocked_exists: string | null; polled: number } | undefined;
    // The task's facts first: a task nobody polls (unassigned, or an agent no dispatcher claims) is recorded too.
    issue = await whole(issue);
    taskFacts(issue, source, actor);
    const box = containers();
    const agent = box.has(issue.id) || (issue.identifier && box.has(issue.identifier)) ? null : issue.assigneeAgentId;
    const joined = agent ? polled().get(agent) : undefined;
    if (!agent || joined === undefined || grants()[agent]?.team) {
      const st = String(issue.status ?? ""), mem = memory(seen, st, issue);
      q("INSERT INTO wake_tasks (task, agent, status, blocked, blocked_names, blocked_deleted, blocked_exists, polled) VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(task) DO UPDATE SET agent = excluded.agent, status = excluded.status, blocked = excluded.blocked, blocked_names = excluded.blocked_names, blocked_deleted = excluded.blocked_deleted, blocked_exists = excluded.blocked_exists, polled = 0").run(issue.id, agent ?? null, st, mem.blocked, mem.names, mem.deleted, mem.exists);
      if (agent && joined !== undefined) return serial(() => place(issue, agent));
      return;
    }
    if (grants()[agent]?.member_of) {
      // Re-placed (and scanned under its new member) when it never started on a busy member; the scan that follows a placement
      // runs inside the lock, so it never asks (`rehome`).
      if (rehome && mayMove(issue.id, agent) && await serial(() => move(issue, agent))) return;
      named(issue, agent);
    }
    const prev = seen?.polled ? { agent: seen.agent, status: seen.status, comment: seen.comment } : undefined;
    const path = `/api/issues/${encodeURIComponent(issue.id)}/comments?${prev?.comment ? `order=asc&limit=500&after=${encodeURIComponent(prev.comment)}` : "order=desc&limit=500"}`;
    const r = await owner("GET", path);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`control plane GET comments → ${r.status}`);
    const all = (r.json as Comment[]).slice().sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    // First sight: only what came after the dispatcher joined or the agent's last word on the task.
    const boundary = prev ? 0 : Math.max(since(agent, joined), ...all.filter((c) => c.authorAgentId === agent || SELF_TAG.test(c.body ?? "")).map((c) => ms(c.createdAt)));
    // Every untagged comment read is a fact (version = its id): the owner's say, an agent's. A comment the kernel wrote carries a
    // tag and is recorded by its writer (cp.ts, outcomes.ts, the owner paths), whose fact names the job: scan never races it. A
    // kernel notice (notices.ts) is posted with the owner's key but is never the owner's word, so it is no task.commented at all
    // (it would end an owner wait).
    for (const c of all) {
      if (c.deletedAt || /<!-- aidenhq(:(job|op)=|-kernel-notice:)/.test(c.body ?? "")) continue;
      fact({ type: "task.commented", subject: `task:${issue.id}`, version: String(c.id), at: iso(ms(c.createdAt) || now()), actor: c.authorAgentId ? `agent:${keyOf(c.authorAgentId)}` : c.authorUserId ? `account:${c.authorUserId}` : "unknown", task: issue.id, source, data: { kind: "comment" } });
    }
    // An owner's word on a finished chat reopens it before its wake is filed: admission refuses a wake on a done task, and a
    // comment through any route but the board's chat composer or a channel never reopened it. Only a word said after the close
    // counts (so an unrelated event on a long-done chat reopens nothing), and a cancelled chat stays closed.
    const chat = isChat(issue);
    const closed = (status: unknown) => status === "done" || status === "cancelled";
    /** An owner's own word said after `from` (ms): the only comment that can reopen a finished chat. */
    const ownerWordAfter = (from: number) => all.some((c) => !c.deletedAt && ownerWord(c) && ms(c.createdAt) > from);
    // A chat can close between the read this scan started from and the comment read: the poll listed it open, its job finished it,
    // then the owner replied. A comment at or after that snapshot's own `updatedAt` may not be reflected in its status, so the
    // task is read again before anything is filed from it: consuming the reply on the old open status would file a wake admission
    // then refuses for a done task. A re-read that fails proves nothing either way, so the reply is not consumed on the snapshot:
    // the task goes on the durable retry list and this scan files nothing, leaving the reply for the next read (a poll's window or
    // the retry row below) to judge against a status it actually saw. Filing it on the snapshot's open status is exactly the
    // wake admission then refuses `task-closed`.
    const snapshotAt = ms(issue.updatedAt);
    if (chat && !closed(issue.status) && all.some((c) => !c.deletedAt && ownerWord(c) && ms(c.createdAt) >= snapshotAt)) {
      const r2 = await owner("GET", `/api/issues/${encodeURIComponent(issue.id)}`);
      if (r2.status === 200 && r2.json && typeof r2.json === "object") issue = { ...issue, ...(r2.json as Issue) };
      else {
        q("INSERT INTO chat_reopen (task, at) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET at = excluded.at").run(issue.id, now());
        log("wake chat status re-read failed", { task: issue.id, status: r2.status });
        return;
      }
    }
    // A comment written after the task's last status change, as the facts saw it: a done status fact the fresh read still
    // reports was recorded when that close was seen, so a reply said after it is newer than the close, whatever clock wrote it.
    const lastStatus = lastFacts(issue.id).get("task.status_changed");
    const changedAt = ms(lastStatus?.at);
    const finishedAt = String(issue.status ?? "") === "done" ? Math.max(ms(issue.completedAt ?? undefined), lastStatus?.data.to === "done" ? changedAt : 0) : 0;
    let reopenedHere = false;
    // What a finished chat's pending reopen (chat_reopen) needs: a word still there to act on.
    const chatWord = String(issue.status ?? "") === "done" && chat && ownerWordAfter(finishedAt);
    // A finished chat with no owner word left to act on (the read found none, or the owner reopened or cancelled it himself) has
    // nothing to retry, so its row goes rather than being re-scanned every poll.
    if (!chatWord && q("SELECT 1 FROM chat_reopen WHERE task = ?").get(issue.id)) q("DELETE FROM chat_reopen WHERE task = ?").run(issue.id);
    if (chatWord) {
      // Said before the move: the comment read is a snapshot, and the owner may have cancelled the chat since. Only a task still
      // `done` is reopened (a cancelled chat stays closed), and a read that fails writes nothing.
      const fresh = await owner("GET", `/api/issues/${encodeURIComponent(issue.id)}`);
      if (fresh.status !== 200) {
        // A read that failed says nothing either way: keep the task on the retry list so a transient failure can't strand it.
        q("INSERT INTO chat_reopen (task, at) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET at = excluded.at").run(issue.id, now());
        log("wake chat reopen read failed", { task: issue.id, status: fresh.status });
        return;
      }
      if (String(fresh.json?.status) !== "done") { issue = { ...issue, ...(fresh.json as Issue) }; q("DELETE FROM chat_reopen WHERE task = ?").run(issue.id); }
      else if (!ownerWordAfter(Math.max(finishedAt, ms((fresh.json as Issue).completedAt ?? undefined), lastStatus?.data.to === "done" ? changedAt : 0))) {
        // The chat closed again after this word: the read is from before that, and the word it carries was already answered by
        // the newer turn. Reopening on it would put the chat in todo with nothing to run, so it stays closed.
        issue = { ...issue, ...(fresh.json as Issue) };
        q("DELETE FROM chat_reopen WHERE task = ?").run(issue.id);
        log("wake chat reopen skipped: a newer close than the reply", { task: issue.id });
      }
      else {
        const p = await owner("PATCH", `/api/issues/${encodeURIComponent(issue.id)}`, { status: "todo" });
        // A failed reopen leaves this scan's cursor where it was and the task on the poll's retry list, so the next scan reads
        // the same comment and tries the move again; filing its wake on the closed task would only be refused.
        if (p.status >= 300) {
          q("INSERT INTO chat_reopen (task, at) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET at = excluded.at").run(issue.id, now());
          log("wake chat reopen failed", { task: issue.id, status: p.status });
          return;
        }
        // The control plane's PATCH takes no expected status or version (no If-Match; `expectedStatusVersion` only promotes a
        // backlog task), so a close that landed between the read above and this write cannot be refused where it is applied.
        // What is checked is its outcome: a task that is closed again right after the write is not reopened, and nothing is
        // filed for it. A read that fails says nothing and the write's own answer stands.
        const after = await owner("GET", `/api/issues/${encodeURIComponent(issue.id)}`);
        if (after.status === 200 && closed(after.json?.status)) {
          issue = { ...issue, ...(after.json as Issue) };
          if (String(after.json?.status) === "done" && ownerWordAfter(finishedAt)) q("INSERT INTO chat_reopen (task, at) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET at = excluded.at").run(issue.id, now());
          else q("DELETE FROM chat_reopen WHERE task = ?").run(issue.id);
          log("wake chat reopen lost a race with a close", { task: issue.id, status: after.json?.status });
          return;
        }
        q("DELETE FROM chat_reopen WHERE task = ?").run(issue.id);
        // The issue is the reopened task from here on: its row below records `todo`, so the next scan files no status wake for the
        // move. Its facts are written before the wake it lets start, so task state reads the chat open when its run begins.
        issue = { ...issue, ...(p.json && typeof p.json === "object" ? p.json : {}), status: "todo", updatedAt: typeof p.json?.updatedAt === "string" ? p.json.updatedAt : iso(now()) };
        taskFacts(issue, source, actor);
        reopenedHere = true;
      }
    }
    // The fresh read or the reopen's answer may name another assignee than the one this scan is for (the owner moved the chat
    // while its reply was read, or reopened it under another agent). A wake filed for the old one is refused
    // `task-not-assigned`, and the comment cursor below would pass the reply for nobody: leave the row as it was, and the new
    // assignee's own event or the next poll scans it.
    if (chat && (issue.assigneeAgentId ?? null) !== agent) {
      log("wake scan deferred: the chat moved to another agent", { task: issue.id, from: agent, to: issue.assigneeAgentId ?? null });
      return;
    }
    // A chat reopened here also files the owner's word that reopened it, even when first sight put the comment cursor past
    // it: without that wake the chat would sit open with nothing to run it. A comment the cursor has not passed is filed as on
    // any task, whether or not it reopens the chat: on one that stays closed admission refuses the wake, and dispatch tells the
    // owner rather than passing the words silently. On a closed task only the owner's own word is filed: an agent's or a
    // module's comment there (a grader's verdict on the task it just closed) needs no run and must not reach the owner.
    const stillClosed = closed(issue.status);
    let commentFiled = false;
    for (const c of all) {
      if (c.deletedAt || c.authorAgentId === agent || SELF_TAG.test(c.body ?? "")) continue;
      if (stillClosed && !ownerWord(c)) continue;
      if (ms(c.createdAt) <= boundary && !(reopenedHere && ownerWord(c) && ms(c.createdAt) > finishedAt)) continue;
      commentFiled = insert(`comment:${c.id}`, issue.id, agent, "comment", ms(c.createdAt) || now(), null, c.authorAgentId ? `agent:${keyOf(c.authorAgentId)}` : c.authorUserId ? `account:${c.authorUserId}` : "unknown") || commentFiled;
    }
    const status = String(issue.status ?? "");
    // Handed to this agent since the scan last saw the task (from the owner, say, while nobody polled it): a wake, even if an
    // earlier job ran on it, and also on a task already in progress.
    const handed = seen !== undefined && (seen.agent ?? null) !== agent;
    const moved = prev ? prev.status !== status || prev.agent !== agent : handed || !lastJob(issue.id);
    // A task whose own wait is armed is the kernel's to settle (idle.ts): its park and restore move the status too, and a
    // status wake filed for one of those moves would start a second job beside the one the wait's wake starts. The wait's own
    // wake is the only thing that dispatches it.
    const armedWait = Boolean(q("SELECT 1 FROM wakes WHERE task = ? AND state = 'open' AND key LIKE 'wait:%'").get(issue.id));
    // The reopen above files the owner's comment's wake: no second status wake for the move itself. A chat whose comment wake
    // this scan filed is the same case seen from another scan (a concurrent one reopened it): the comment carries the run.
    // A reply already has a wake (another scan filed it while this one read an older cursor): its run is that comment's, not a
    // second status wake for the same move. A chat that went done -> todo is exactly the reopen that reply caused.
    const replyWake = chat && prev?.status === "done" && status === "todo" && Boolean(q("SELECT 1 FROM wakes WHERE task = ? AND key LIKE 'comment:%' AND state IN ('open', 'claimed')").get(issue.id));
    const fileable = !armedWait && !reopenedHere && !(chat && commentFiled) && !replyWake && (status === "todo" || (handed && status === "in_progress")) && (reopened || moved);
    // A move made while a job runs is filed once that job ends: until then the cursor keeps what it last saw (`deferred`).
    const deferred = fileable && Boolean(liveJob(issue.id));
    if (fileable && !deferred) {
      const at = ms(issue.updatedAt) || now();
      if (reopened) insert(`reopen:${issue.id}:${issue.statusVersion ?? issue.updatedAt}`, issue.id, agent, "reopen", at, null, actor);
      else if (!prev && issue.originKind === "routine_execution") {
        const key = routineKey(String(issue.originId ?? ""));
        insert(`routine-run:${issue.id}`, issue.id, agent, key ? `routine:${key}` : "routine", at, null, actor);
      }
      else insert(`issue:${issue.id}:${issue.updatedAt}`, issue.id, agent, prev?.agent === agent ? "status" : "assigned", at, null, actor);
    }
    // A routine run's first sight files its wake above; a wake a dispatcher then drops is re-armed here on the next scan, where
    // without this it waited for an external status write. Only a dropped row moves: open, claimed, delivered and done rows are
    // left alone, so one run still gets exactly one job.
    if (status === "todo" && !reopened && issue.originKind === "routine_execution" && !liveJob(issue.id) && !lastJob(issue.id)) {
      const key = routineKey(String(issue.originId ?? ""));
      rearmRoutine(`routine-run:${issue.id}`, issue.id, agent, key ? `routine:${key}` : "routine", actor);
    }
    const newest = prev?.comment && !all.length ? prev.comment : all.at(-1)?.id ?? null;
    const rowStatus = deferred ? String(prev?.status ?? seen?.status ?? "") : status, mem = memory(seen, rowStatus, issue);
    q("INSERT INTO wake_tasks (task, agent, status, comment, blocked, blocked_names, blocked_deleted, blocked_exists, polled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(task) DO UPDATE SET agent = excluded.agent, status = excluded.status, comment = excluded.comment, blocked = excluded.blocked, blocked_names = excluded.blocked_names, blocked_deleted = excluded.blocked_deleted, blocked_exists = excluded.blocked_exists, polled = 1")
      .run(issue.id, deferred ? (prev?.agent ?? seen?.agent ?? null) : agent, rowStatus, newest, mem.blocked, mem.names, mem.deleted, mem.exists);
  }

  /**
   * A blocked task whose blockers (first-class, read from the single issue: a list row may leave them out) are all done or
   * cancelled leaves `blocked` for `todo` with one notice naming what closed (the PATCH carries it, tagged: it wakes nobody),
   * and its assignee is woken. Stateless: a task still blocked is simply retried next poll, and the wake key (the closure) files
   * once. Paperclip counts a cancelled blocker as unresolved for a status write, so those relations are cleared first; a 409 is
   * retried once with them all cleared.
   * A blocker that was deleted is gone for good, and a task it held must not stay blocked on it. Paperclip reports that either
   * by dropping the relation or by keeping it with a stale status, and neither proves the blocker went: every id the task had
   * is read once in each list state and the verdict cached against that state. 404: deleted, and the notice names it. 200: the
   * issue exists, so a relation it is missing from was removed on purpose and the task stays blocked; an id that stays listed
   * at 200 is still a real blocker. A verdict is evidence only for the state it was read in, so an id that moves in or out of
   * the live list is judged afresh. The steady-state poll therefore issues no reads. The single-issue read is the authority:
   * if it omits `blockedBy`, nothing is concluded this poll. The ids it had are also the record that tells a task blocked from
   * outside from a task a team route parked with no blockers of its own: only the former is released when its list is empty.
   */
  async function unblock(issue: Issue, agent: string) {
    const r = await owner("GET", `/api/issues/${encodeURIComponent(issue.id)}`);
    if (r.status !== 200) throw new Error(`control plane GET issue → ${r.status}`);
    const task = r.json as Issue;
    // An unblock whose relations were cleared but whose move failed is finished from what it recorded, never stranded.
    const half = q("SELECT closure, line FROM unblocking WHERE task = ?").get(task.id) as { closure: string; line: string } | undefined;
    if (task.status !== "blocked") { if (half) q("DELETE FROM unblocking WHERE task = ?").run(task.id); return; }
    // An omitted relation is not "no blockers": the list row left it out and this read agrees, so nothing is known yet.
    if (!half && !Array.isArray(task.blockedBy)) return;
    const blockers = task.blockedBy ?? [];
    const resolved = (b: { status: string }) => b.status === "done" || b.status === "cancelled";
    const row = q("SELECT blocked, blocked_names, blocked_deleted, blocked_exists FROM wake_tasks WHERE task = ?").get(task.id) as { blocked: string | null; blocked_names: string | null; blocked_deleted: string | null; blocked_exists: string | null } | undefined;
    const parse = <T>(v: string | null | undefined, fallback: T): T => { try { return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } };
    const remembered = (row?.blocked ?? "").split(",").filter(Boolean);
    let names = parse<Record<string, string>>(row?.blocked_names, {});
    const live = new Set(blockers.map((b) => b.id));
    // A read's verdict is evidence only for the list state it was read in (see `verdicts`): a 404 held while the id stays
    // where it was read, a 200 likewise. A verdict for the other state is stale and its id is read afresh.
    const gone = verdicts(row?.blocked_deleted);
    const here = verdicts(row?.blocked_exists);
    const deleted = new Set(held(gone, live));
    const existing = new Set(held(here, live));
    const had = [...new Set([...live, ...remembered, ...Object.keys(gone), ...Object.keys(here)])];
    for (const b of blockers) names[b.id] = b.identifier ?? names[b.id] ?? b.id;
    let failed = false;
    for (const id of had) {
      const b = blockers.find((x) => x.id === id);
      if (b && resolved(b)) continue; // done or cancelled: closed, not deleted
      if (deleted.has(id) || existing.has(id)) continue; // this state's verdict is cached: no read
      const state = live.has(id) ? "listed" as const : "absent" as const;
      const g = await owner("GET", `/api/issues/${encodeURIComponent(id)}`);
      if (g.status === 404) { gone[id] = state; delete here[id]; deleted.add(id); existing.delete(id); }
      else if (g.status === 200) { here[id] = state; delete gone[id]; existing.add(id); deleted.delete(id); }
      else { failed = true; log("wake unblock blocker read failed", { task: task.id, blocker: id, status: g.status }); }
    }
    // A blocker known to exist whose relation went was removed on purpose: forget it, and leave the task blocked.
    const removed = new Set([...existing].filter((id) => !live.has(id)));
    // Kept for the next poll: the ids it had, their names, and each read's verdict. An id whose relation went while the
    // issue still exists is forgotten, verdict included: only a 404 releases a task.
    const settledIds = had.filter((id) => !removed.has(id));
    const settledNames = Object.fromEntries(Object.entries(names).filter(([id]) => settledIds.includes(id)));
    const keptVerdict = (v: Verdicts) => { const kept = Object.fromEntries(settledIds.filter((id) => v[id]).map((id) => [id, v[id]])); return Object.keys(kept).length ? JSON.stringify(kept) : null; };
    const save = () => q("UPDATE wake_tasks SET blocked = ?, blocked_names = ?, blocked_deleted = ?, blocked_exists = ? WHERE task = ?")
      .run(settledIds.join(",") || null, Object.keys(settledNames).length ? JSON.stringify(settledNames) : null, keptVerdict(gone), keptVerdict(here), task.id);
    // A read that failed leaves this poll's conclusion open: memory stays exactly as it was, the read is retried next poll, nothing is released.
    if (failed) return;
    const settled = blockers.every((b) => resolved(b) || deleted.has(b.id));
    if (!half && (!settled || (!blockers.length && !deleted.size))) { save(); return; }
    const nameOf = (id: string) => names[id] ?? id;
    const closed = blockers.filter((b) => resolved(b));
    const deletedIds = [...deleted].sort();
    const closure = half?.closure ?? [...closed.map((b) => `${b.id}:${b.status}`), ...deletedIds.map((id) => `${id}:deleted`)].sort().join(",");
    const line = half?.line ?? [...closed.map((b) => `${b.identifier ?? b.id} closed (${b.status})`), ...deletedIds.map((id) => `${nameOf(id)} (deleted)`)].join(", ") + ".";
    if (!half) q("INSERT OR REPLACE INTO unblocking (task, closure, line) VALUES (?, ?, ?)").run(task.id, closure, line);
    const patch = (b: object) => owner("PATCH", `/api/issues/${encodeURIComponent(task.id)}`, b);
    const ok = (res: { status: number }) => { if (res.status >= 300) throw new Error(`control plane PATCH issue → ${res.status}`); return res; };
    // A cancelled blocker still refuses a status write, and a deleted one no longer has a relation to keep.
    const keep = blockers.filter((b) => b.status !== "cancelled" && !deleted.has(b.id)).map((b) => b.id);
    if (keep.length !== blockers.length) ok(await patch({ blockedByIssueIds: keep }));
    const move = { status: "todo", comment: `Unblocked: ${line}\n\n<!-- aidenhq:job=kernel kind=unblocked -->` };
    let res = await patch(move);
    if (res.status === 409) { ok(await patch({ blockedByIssueIds: [] })); res = await patch(move); }
    ok(res);
    insert(`unblocked:${task.id}:${closure}`, task.id, agent, "unblocked", now(), null, "kernel");
    q("DELETE FROM unblocking WHERE task = ?").run(task.id);
    q("UPDATE wake_tasks SET blocked = NULL, blocked_names = NULL, blocked_deleted = NULL, blocked_exists = NULL WHERE task = ?").run(task.id);
  }

  // ---- Team routing (team-routing.ts picks; this gathers, records and places) ----
  // One decision row per task in team_routes: `placing` (picked, the reassignment not yet confirmed: a retry re-applies the
  // same pick, never re-scores), `placed`, `named` (assigned straight to a member: its delegator's structured choice), or
  // `blocked`. Selection is serialized in this process (`lock`), and a pending placement counts as its member's load.
  // A `placed` task that never had a job, whose member is busy (its max_parallel of live jobs, admission's own test) while
  // another member has a free slot, is scored again when its member's scan sees it (`move`): it goes to another member only if
  // that one scores strictly higher, the task itself counted against nobody. A task that ran a job keeps its member (its
  // session is there), and a `named` one is never moved.
  const OPEN_SET = new Set(OPEN.split(","));
  const tag = `\n\n<!-- aidenhq:job=kernel kind=routed -->`;
  // Only repos a code host has: a branch (fix/x), a path (modules/x) or a library (x/net) shaped like owner/name is no repo.
  const repoText = (i: Issue) => mentionedRepos(`${i.title ?? ""}\n${i.description ?? ""}`).map((r) => r.toLowerCase()).filter((r) => knownRepo(r));
  const keyId = (key: string) => Object.entries(grants()).find(([, g]) => g?.key === key)?.[0];
  /** A task given straight to a member: recorded, so its load and continuity count; a placement it confirms is placed. */
  function named(issue: Issue, member: string) {
    const team = grants()[member]!.member_of!;
    q("INSERT OR IGNORE INTO team_routes (task, team, member, repos, at, state) VALUES (?, ?, ?, ?, ?, 'named')").run(issue.id, team, member, JSON.stringify(repoText(issue)), now());
    q("UPDATE team_routes SET state = 'placed' WHERE task = ? AND member = ? AND state = 'placing'").run(issue.id, member);
  }
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => { const run = lock.then(fn); lock = run.catch(() => {}); return run; };
  const busy = (agent: string) => (q(`SELECT COUNT(*) AS n FROM jobs WHERE agent = ? AND state IN ${LIVE}`).get(agent) as { n: number }).n >= (grants()[agent]?.max_parallel ?? 1);
  /** The members' snapshot (paused, open tasks, whether each finished a task in the repo), read before the decision. */
  async function snapshot(team: TeamGrant, task: string, repos: string[]) {
    const out: { id: string; key: string; g: TeamGrant; paused: boolean; open: Set<string>; done: number }[] = [];
    const since = now() - CONTINUITY_MS;
    for (const key of team.team!.members) {
      const id = keyId(key);
      if (!id) continue;
      const a = await owner("GET", `/api/agents/${encodeURIComponent(id)}`);
      if (a.status !== 200) throw new Error(`control plane GET agent → ${a.status}`);
      const l = await owner("GET", `/api/companies/${encodeURIComponent(String(a.json.companyId))}/issues?status=${OPEN}&limit=500&assigneeAgentId=${encodeURIComponent(id)}`);
      if (l.status !== 200 || !Array.isArray(l.json)) throw new Error(`control plane GET issues → ${l.status}`);
      // Continuity: whether this member finished a task in one of the task's repos within the window (task status done).
      let done = 0;
      if (repos.length) for (const r of q("SELECT task, repos, done FROM team_routes WHERE member = ? AND at > ? AND task != ? AND state != 'blocked' ORDER BY done DESC").all(id, since, task) as { task: string; repos: string; done: number }[]) {
        if (!(JSON.parse(r.repos) as string[]).some((x) => repos.includes(x))) continue;
        if (!r.done) {
          const t = await owner("GET", `/api/issues/${encodeURIComponent(r.task)}`);
          if (t.status === 200 && t.json?.status === "done") q("UPDATE team_routes SET done = 1 WHERE task = ?").run(r.task);
          else continue;
        }
        done = 1;
        break;
      }
      out.push({ id, key, g: grants()[id] ?? {}, paused: agentPaused(a.json), open: new Set((l.json as Issue[]).map((i) => i.id)), done });
    }
    return out;
  }
  async function place(seen: Issue, teamId: string) {
    // Read again inside the lock: a duplicated event or the poll may have placed it already (and a list row may lack the description).
    const fresh = await owner("GET", `/api/issues/${encodeURIComponent(seen.id)}`);
    if (fresh.status !== 200) throw new Error(`control plane GET issue → ${fresh.status}`);
    const issue = fresh.json as Issue;
    if (issue.assigneeAgentId !== teamId || !OPEN_SET.has(String(issue.status)) || liveJob(issue.id)) return; // a job of the record from before the team finishes first
    const team = grants()[teamId]!;
    let row = q("SELECT member, state FROM team_routes WHERE task = ?").get(issue.id) as { member: string | null; state: string } | undefined;
    // Back on the team after a placement or a block (the delegator re-routed it): decided afresh.
    if (row && row.state !== "placing") { q("DELETE FROM team_routes WHERE task = ?").run(issue.id); row = undefined; }
    if (!row) {
      const repos = repoText(issue);
      const decide = await gather(team, issue.id, repos);
      db.exec("BEGIN IMMEDIATE");
      try {
        const { decision, record, snapshot } = decide();
        q("INSERT INTO team_routes (task, team, member, repos, at, state, record, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(issue.id, String(team.key), decision.pick?.id ?? null, JSON.stringify(repos), now(), decision.pick ? "placing" : "blocked", record, JSON.stringify(snapshot));
        db.exec("COMMIT");
        log("team routed", { task: issue.id, team: team.team!.name, pick: decision.pick?.key ?? null });
        if (!decision.pick) {
          const r = await owner("PATCH", `/api/issues/${encodeURIComponent(issue.id)}`, { status: "blocked", comment: record + tag });
          if (r.status >= 300) throw new Error(`control plane PATCH issue → ${r.status}`);
          await tellBlocked(issue, `**${issue.identifier ?? issue.id} is blocked:** no member of team ${team.team!.name} can take it.\n\n${record}\n\nUnpause a member, or re-route it.`);
          return;
        }
        row = { member: decision.pick.id, state: "placing" };
      } catch (e) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw e;
      }
    }
    const record = (q("SELECT record FROM team_routes WHERE task = ?").get(issue.id) as { record: string }).record;
    const r = await owner("PATCH", `/api/issues/${encodeURIComponent(issue.id)}`, { assigneeAgentId: row.member, comment: record + tag });
    if (r.status >= 300) throw new Error(`control plane PATCH issue → ${r.status}`);
    q("UPDATE team_routes SET state = 'placed' WHERE task = ? AND state = 'placing'").run(issue.id);
    const now2 = await owner("GET", `/api/issues/${encodeURIComponent(issue.id)}`);
    if (now2.status === 200 && now2.json?.assigneeAgentId === row.member) await scan(now2.json as Issue, { rehome: false });
  }
  /**
   * The members' snapshot for a decision on `task`, awaited; the decision itself (synchronous, so it can sit in a transaction)
   * is the returned function. The task counts as nobody's load: it is the one being placed.
   */
  async function gather(team: TeamGrant, task: string, repos: string[], from?: string) {
    const snap = await snapshot(team, task, repos);
    const weights = weightsOf(team.team);
    const revision = createHash("sha256").update(JSON.stringify([team.team, snap.map((m) => [m.key, m.g.repos ?? [], m.g.max_parallel ?? 1])])).digest("hex").slice(0, 12);
    return () => {
      const candidates: Candidate[] = snap.map((m) => {
        const live = new Set((q(`SELECT task FROM jobs WHERE agent = ? AND state IN ${LIVE}`).all(m.id) as { task: string }[]).map((r) => r.task));
        const waiting = new Set([...m.open, ...(q("SELECT task FROM team_routes WHERE member = ? AND state = 'placing'").all(m.id) as { task: string }[]).map((r) => r.task)]);
        for (const t of live) waiting.delete(t);
        waiting.delete(task);
        return { id: m.id, key: m.key, repos: m.g.repos ?? [], maxParallel: m.g.max_parallel ?? 1, paused: m.paused, running: live.size, queued: waiting.size, done: m.done };
      });
      const decision = pickMember({ repos, candidates, weights });
      const record = decisionText({ team: team.team!.name, revision, repos, weights, decision, from });
      const snapshot: RouteSnapshot = { weights, candidates };
      return { decision, record, snapshot };
    };
  }
  /** Whether a member's task is one `move` would score again: placed on it by the router, never run, its member busy, another member free. */
  function mayMove(task: string, member: string) {
    const row = q("SELECT member, state FROM team_routes WHERE task = ?").get(task) as { member: string | null; state: string } | undefined;
    if (row?.state !== "placed" || row.member !== member || lastJob(task) || !busy(member)) return false;
    const team = grants()[member]!.member_of!;
    return Object.entries(grants()).some(([id, g]) => id !== member && g?.member_of === team && !busy(id));
  }
  /** A never-started task on a busy member, scored again (see the state comment above): true when it moved. */
  async function move(seen: Issue, member: string) {
    const fresh = await owner("GET", `/api/issues/${encodeURIComponent(seen.id)}`);
    if (fresh.status !== 200) throw new Error(`control plane GET issue → ${fresh.status}`);
    const issue = fresh.json as Issue;
    if (issue.assigneeAgentId !== member || !OPEN_SET.has(String(issue.status)) || !mayMove(issue.id, member)) return false;
    const teamId = keyId(grants()[member]!.member_of!);
    const team = teamId ? grants()[teamId] : undefined;
    if (!team?.team) return false;
    const repos = repoText(issue);
    const decide = await gather(team, issue.id, repos, String(grants()[member]!.key ?? member));
    if (!mayMove(issue.id, member)) return false; // a job started, or a slot freed, while the snapshot was read
    const { decision, record, snapshot } = decide();
    const here = decision.scored.find((s) => s.id === member);
    if (!decision.pick || !here || decision.pick.id === member || decision.pick.score <= here.score) return false;
    const to = decision.pick.id;
    const r = await owner("PATCH", `/api/issues/${encodeURIComponent(issue.id)}`, { assigneeAgentId: to, comment: record + tag });
    if (r.status >= 300) throw new Error(`control plane PATCH issue → ${r.status}`);
    inTx(db, "team_move", () => {
      q("UPDATE team_routes SET member = ?, repos = ?, at = ?, record = ?, snapshot = ? WHERE task = ?").run(to, JSON.stringify(repos), now(), record, JSON.stringify(snapshot), issue.id);
      // The old member's wakes for it would only be refused at admission (not its task any more).
      for (const w of q("SELECT key, task FROM wakes WHERE task = ? AND agent = ? AND (state = 'open' OR (state = 'claimed' AND job IS NULL))").all(issue.id, member) as { key: string; task: string }[]) {
        q("UPDATE wakes SET state = 'dropped', until = NULL WHERE key = ?").run(w.key);
        dropped(w, "the task was re-routed to another member");
      }
    });
    log("team re-routed", { task: issue.id, team: team.team.name, from: member, to });
    const now2 = await owner("GET", `/api/issues/${encodeURIComponent(issue.id)}`);
    if (now2.status === 200 && now2.json?.assigneeAgentId === to) await scan(now2.json as Issue, { rehome: false });
    return true;
  }

  const companies = new Map<string, string>();
  /**
   * Since when an agent's finished chats are re-read (chat_cursor): a durable cursor per agent, so a comment missed while the
   * kernel is down is still found after it restarts, however long it was away. Per agent, not per company: one agent whose
   * turn failed (its company unknown, a list or a chat read broken) holds only its own window, never a colleague's.
   */
  const chatSince = (agent: string) => {
    const row = q("SELECT at, after, until FROM chat_cursor WHERE agent = ?").get(agent) as { at: number; after: string | null; until: number | null } | undefined;
    return row ?? { at: now() - 10 * 60_000, after: null, until: null };
  };
  /**
   * Where the agent's pass over its window stands: the window's start, the last id read when an earlier poll was cut short,
   * and the time the window ends (`until`, the first pass's start). A resumed pass that finishes moves the start to `until`,
   * so a long outage with more rows than one pass covers still catches up instead of restarting the same window forever.
   */
  const setChatSince = (agent: string, at: number, after: string | null, until: number | null) => q("INSERT INTO chat_cursor (agent, at, after, until) VALUES (?, ?, ?, ?) ON CONFLICT(agent) DO UPDATE SET at = excluded.at, after = excluded.after, until = excluded.until").run(agent, at, after, until);
  /** The wait-park reconcile, once idle.ts has it (it is made after this inbox): a task's own event re-parks a restored wait at
   *  once, so the recovery sweep's tick never gets to see a settled wait in a status it scans. */
  let settleOn: ((issue: Issue) => Promise<unknown>) | undefined;
  /** The reconcile's own pass (idle.ts settle), run after each poll: a wait that just ended is restored at this cadence. */
  let settleEach: (() => Promise<unknown>) | undefined;
  /** The most tasks a poll re-reads one by one (closures and hand-offs its lists can't show), and how long its reconcile may take. */
  const RECONCILE_MAX = 100;
  const RECONCILE_MS = 30_000;
  /** A task Paperclip says is gone is cancelled only once it is missing on two passes this far apart (first miss: in memory). */
  const MISSING_MS = 10 * 60_000;
  const missing = new Map<string, number>();
  return {
    scan,
    /** Hand the task reconcile to the inbox (idle.ts settleOne): called on a task's own event, before the next settle tick. */
    settleOn: (f: (issue: Issue) => Promise<unknown>) => { settleOn = f; },
    /** Hand the reconcile's whole pass to the inbox (idle.ts settle): run once per poll, after the lists are scanned. */
    settleEach: (f: () => Promise<unknown>) => { settleEach = f; },
    /**
     * A change the kernel just made through the control plane (cp.ts, the owner proxy): the task's facts at once, from the issue the
     * write returned. No wake: the event and the poll file those, from their own cursor.
     */
    async observe(issue: Issue, actor: string) { taskFacts(issue, "live", actor); },
    /**
     * The reconcile poll: every open or blocked task of every polled agent (a blocked one is released once its blockers closed); and wakes whose jobs
     * ended are done. Then every other open task of their companies (the owner's, unassigned ones, unpolled agents') has its facts
     * recorded, and the tasks the facts call open that no list returned are read one by one.
     */
    async poll() {
      try { q(`UPDATE wakes SET state = 'done' WHERE state = 'claimed' AND job IS NOT NULL AND job NOT IN (SELECT id FROM jobs WHERE state IN ${LIVE})`).run(); } catch (e) { log("wake poll failed", { step: "close ended wakes", err: (e as Error).message }); }
      const listed = new Set<string>();
      // A finished chat's comment can be missed with its event (a kernel restart, a lost delivery): every poll re-reads the chats
      // whose activity is newer than the company's durable cursor, so the scan can reopen and wake them.
      const polledAt = now();
      for (const agent of polled().keys()) {
        // The cursor is this agent's own, so a failure below holds only its window: every other agent still advances, and the
        // chats this one never listed stay inside its next `updatedSince`.
        let company = companies.get(agent);
        // The pass over the agent's window: where it started, whether it reached the end, and the last id it fully read. A pass
        // cut short keeps its start (nothing past it is skipped) and resumes past the ids it did read.
        const window = chatSince(agent);
        let complete = false, readTo: string | null = null;
        try {
          if (!company) {
            const a = await owner("GET", `/api/agents/${encodeURIComponent(agent)}`);
            if (a.status !== 200 || !a.json?.companyId) throw new Error(`control plane GET agent → ${a.status}`);
            company = String(a.json.companyId);
            companies.set(agent, company);
          }
          const l = await owner("GET", `/api/companies/${encodeURIComponent(company)}/issues?status=${OPEN}&limit=500&assigneeAgentId=${encodeURIComponent(agent)}`);
          if (l.status !== 200 || !Array.isArray(l.json)) throw new Error(`control plane GET issues → ${l.status}`);
          for (const issue of l.json as Issue[]) listed.add(issue.id);
          for (const issue of l.json as Issue[]) await scan(issue, { source: "poll" }).catch((e: Error) => log("wake scan failed", { task: issue.id, err: e.message }));
          const b = await owner("GET", `/api/companies/${encodeURIComponent(company)}/issues?status=blocked&limit=200&assigneeAgentId=${encodeURIComponent(agent)}`);
          if (b.status !== 200 || !Array.isArray(b.json)) throw new Error(`control plane GET blocked issues → ${b.status}`);
          for (const issue of b.json as Issue[]) listed.add(issue.id);
          // A blocked task hears its comments too (a sub-task's question to its delegator, which it is blocked on), then is released.
          for (const issue of b.json as Issue[]) {
            await scan(issue, { source: "poll" }).catch((e: Error) => log("wake scan failed", { task: issue.id, err: e.message }));
            await unblock(issue, agent).catch((e: Error) => log("wake unblock failed", { task: issue.id, err: e.message }));
          }
          // Paged by id, not offset: after an outage an agent can have more finished tasks than one page, and a concurrent
          // reopen shifting offset pages would skip the row that slid into the gap. The id cursor is stable under exactly that;
          // every page is collected before any scan, so this poll's own writes cannot move it either.
          const finished: Issue[] = [];
          let afterId: string | undefined = window.after ?? undefined, pageFailed = false;
          for (let page = 0; page < 25; page++) {
            const query = new URLSearchParams({ status: "done", limit: "200", assigneeAgentId: agent, updatedSince: iso(window.at), sortField: "id", sortDir: "asc", ...(afterId ? { afterId } : {}) });
            const d = await owner("GET", `/api/companies/${encodeURIComponent(company)}/issues?${query}`).catch((e: Error) => (log("wake poll failed", { agent, page, err: e.message }), undefined));
            if (!d || d.status !== 200 || !Array.isArray(d.json)) { pageFailed = true; break; }
            const rows = d.json as Issue[];
            finished.push(...rows);
            if (rows.length < 200) { complete = true; break; }
            afterId = rows.at(-1)?.id;
            if (!afterId) break;
          }
          // A page that failed ends the listing, but the pages before it are scanned: the work already read is not thrown away
          // (and their resume point is kept for the rest).
          if (pageFailed) log("wake chat window cut short", { agent, company });
          // A traversal cut short at its page budget, or a chat whose scan failed, is not the whole window. Its start stays, and
          // a resume point past the rows the pass actually processed lets the next poll go on from there: the page budget never
          // strands the chats beyond it. A page fetched but never scanned is not passed (`readTo` moves per processed row).
          let scanned = true;
          for (const issue of finished) {
            if (!listed.has(issue.id) && isChat(issue)) {
              listed.add(issue.id);
              await scan(issue, { source: "poll" }).catch((e: Error) => {
                scanned = false;
                readTo = null; // this chat's comment may be anywhere in the window: reread it whole
                q("INSERT INTO chat_reopen (task, at) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET at = excluded.at").run(issue.id, now());
                log("wake scan failed", { task: issue.id, err: e.message });
              });
            }
            // The resume point moves one processed row at a time: a row whose scan failed stops it here, so the next pass reads
            // that row's window again rather than starting past its comment.
            if (scanned) readTo = issue.id;
          }
          if (!complete) log("wake chat window truncated", { agent, company, reads_to: readTo });
          // A finished pass moves the start to its window's end (`until`): a resumed pass covers its ids to the end, and a reply
          // that landed while it ran is later than that end, so the next window has it. The one-second overlap keeps a change
          // that commits at the boundary inside the next window: Paperclip's `updatedSince` is strictly after.
          if (complete && scanned) setChatSince(agent, (window.until ?? polledAt) - 1000, null, null);
          else setChatSince(agent, window.at, readTo, window.until ?? polledAt);
        } catch (e) {
          // Whatever was processed before the failure is not skipped: the window keeps its start, and the resume point covers
          // only rows already scanned (a failed page adds none).
          setChatSince(agent, window.at, readTo, window.until ?? polledAt);
          log("wake poll failed", { agent, err: (e as Error).message });
        }
      }
      // A reopen the control plane refused, or a finished chat's comment read that failed, waits here until it succeeds, whatever
      // the rolling window above says: the scan reads its comment again and retries (no wake was filed for it).
      for (const { task } of q("SELECT task FROM chat_reopen ORDER BY at").all() as { task: string }[]) {
        try {
          const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}`);
          // Gone, or no longer a done chat (the owner cancelled or reopened it himself): there is nothing left to retry.
          if (r.status === 404 || (r.status === 200 && (String(r.json?.status) !== "done" || !isChat(r.json as Issue)))) q("DELETE FROM chat_reopen WHERE task = ?").run(task);
          else if (r.status === 200) await scan(r.json as Issue, { source: "poll" });
        } catch (e) { log("wake scan failed", { task, err: (e as Error).message }); }
      }
      if (settleEach) await settleEach().catch((e: Error) => log("task wait settle failed", { err: e.message }));
      // A parked task (backlog, its own wait armed) is outside OPEN, so the per-agent list above never scans it, and the
      // company query below only records its status facts: a lost `issue.comment.created` event would leave an owner's or
      // delegator's answer unread until the timed wake. These are scanned like an open task's, so the answer still wakes it.
      const parkedUntil = Date.now() + RECONCILE_MS;
      for (const { task } of q("SELECT DISTINCT task FROM wakes WHERE state = 'open' AND key LIKE 'wait:%'").all() as { task: string }[]) {
        if (Date.now() > parkedUntil) break;
        try {
          const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}`);
          if (r.status === 200) await scan(r.json as Issue, { source: "poll" });
        } catch (e) { log("wake scan failed", { task, err: (e as Error).message }); }
      }
      const until = Date.now() + RECONCILE_MS;
      for (const company of new Set(companies.values())) {
        try {
          const l = await owner("GET", `/api/companies/${encodeURIComponent(company)}/issues?status=${OPEN},blocked,backlog&limit=500`);
          if (l.status !== 200 || !Array.isArray(l.json)) throw new Error(`control plane GET issues → ${l.status}`);
          for (const row of l.json as Issue[]) {
            if (listed.has(row.id) || Date.now() > until) continue;
            listed.add(row.id);
            try { taskFacts(await whole(row), "poll", "unknown"); } catch (e) { log("wake reconcile failed", { task: row.id, err: (e as Error).message }); }
          }
        } catch (e) { log("wake reconcile failed", { company, err: (e as Error).message }); }
      }
      // A task the facts call open that no list returned may have closed or gone, its event lost: each is read once, least
      // recently seen first. Gone from Paperclip (404 on two passes ≥ 10 minutes apart) is cancelled, by the kernel.
      if (!facts) return;
      const seenAt = new Map((q("SELECT task, at FROM task_facts_seen").all() as { task: string; at: number }[]).map((r) => [r.task, r.at]));
      const gone = facts.openTasks().filter((t) => !listed.has(t)).sort((a, b) => (seenAt.get(a) ?? 0) - (seenAt.get(b) ?? 0) || a.localeCompare(b)).slice(0, RECONCILE_MAX);
      const seen = (task: string) => q("INSERT INTO task_facts_seen (task, at) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET at = excluded.at").run(task, now());
      for (const task of gone) {
        if (Date.now() > until) break;
        try {
          const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}`);
          if (r.status === 404) {
            const first = missing.get(task) ?? (missing.set(task, now()), now());
            if (now() - first < MISSING_MS) { seen(task); continue; }
            missing.delete(task);
            inTx(db, "task_gone", () => {
              fact({ type: "task.status_changed", subject: `task:${task}`, task, version: "missing", at: iso(now()), actor: "kernel", source: "poll", data: { from: str(lastFacts(task).get("task.status_changed")?.data.to), to: "cancelled" } });
              q("UPDATE task_facts_seen SET status = 'cancelled' WHERE task = ?").run(task);
              // A closed task is before `blocked`: its blocker history must not outlive the period it was recorded for.
              q("UPDATE wake_tasks SET status = 'cancelled', blocked = NULL, blocked_names = NULL, blocked_deleted = NULL, blocked_exists = NULL WHERE task = ?").run(task);
              seen(task);
            });
            continue;
          }
          missing.delete(task);
          if (r.status !== 200) { seen(task); log("wake reconcile failed", { task, err: `control plane GET issue → ${r.status}` }); continue; }
          const issue = r.json as Issue;
          taskFacts(issue, "poll", "unknown");
          if (issue.status === "done" || issue.status === "cancelled") q("UPDATE wake_tasks SET status = ?, blocked = NULL, blocked_names = NULL, blocked_deleted = NULL, blocked_exists = NULL WHERE task = ?").run(issue.status, task);
        } catch (e) { log("wake reconcile failed", { task, err: (e as Error).message }); }
      }
    },
    /** A Paperclip event (ids only, untrusted): scan the task it names, as the poll would. */
    async event(b: { issueId?: unknown; reopened?: unknown; actorType?: unknown; actorId?: unknown }) {
      if (typeof b.issueId !== "string" || !/^[\w-]{1,100}$/.test(b.issueId)) return { scanned: false };
      const r = await owner("GET", `/api/issues/${encodeURIComponent(b.issueId)}`);
      if (r.status !== 200) return { scanned: false };
      // Who Paperclip says did it (the event's actor), as a fact's actor.
      const id = typeof b.actorId === "string" && /^[\w-]{1,100}$/.test(b.actorId) ? b.actorId : "";
      const actor = id && b.actorType === "agent" ? `agent:${keyOf(id)}` : id && b.actorType === "user" ? `account:${id}` : "unknown";
      const issue = r.json as Issue;
      await scan(issue, { reopened: b.reopened === true, actor });
      // A task put back into a status the recovery sweep scans while its own wait is armed is parked again here rather than at
      // the next settle tick: the sweep's tick is 60–90 s and so is the poll, so the poll alone would leave a window in which
      // it can act first (idle.ts).
      if (settleOn && SCANNED.has(String(issue.status))) await settleOn(issue).catch((e: Error) => log("wait settle on event failed", { task: issue.id, err: e.message }));
      return { scanned: true };
    },
    /** A module's scheduled wake (role kernel.wake) for the task's assignee, due at `at`. */
    async schedule(module: string, b: { task?: unknown; agent?: unknown; at?: unknown; cause?: unknown; id?: unknown }) {
      const task = typeof b.task === "string" ? b.task.slice(0, 100) : "";
      const at = typeof b.at === "number" && Number.isFinite(b.at) ? b.at : now();
      const id = typeof b.id === "string" && /^[\w.-]{1,80}$/.test(b.id) ? b.id : randomBytes(8).toString("hex");
      if (!task) return { error: "send {task, agent?, at?, cause?, id?}" };
      const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}`);
      const issue = r.json as Issue;
      // A read that failed says nothing about the task: the module's retry (a 503) must not read as "no assigned task".
      if (r.status !== 200) return { error: `the control plane answered ${r.status} reading task ${task}`, upstream: true };
      if (!issue.assigneeAgentId) return { error: `no assigned task ${task}` };
      if (b.agent !== undefined && b.agent !== issue.assigneeAgentId) return { error: "the agent isn't the task's assignee" };
      const key = `wake_at:${module}.${id}`;
      insert(key, issue.id, issue.assigneeAgentId, typeof b.cause === "string" ? `scheduled: ${b.cause.slice(0, 1000)}` : "scheduled", at, at, `module:${module}`);
      return { key };
    },
    /**
     * A wake the kernel itself opens for a task's agent (idle.ts: an agent's own wait, an idle nudge), due at `at`; once per
     * key. Open rows of the task under `replaces` (a key prefix) are dropped first: a new wait replaces the earlier one.
     */
    open(b: { key: string; task: string; agent: string; cause: string; at?: number; replaces?: string; author?: string }) {
      const t = now(), at = b.at ?? t;
      inTx(db, "wake_replace", () => {
        if (b.replaces) for (const w of q("SELECT key, task FROM wakes WHERE task = ? AND state = 'open' AND key LIKE ? AND key != ?").all(b.task, `${b.replaces}%`, b.key) as { key: string; task: string }[]) {
          q("UPDATE wakes SET state = 'dropped', until = NULL WHERE key = ?").run(w.key);
          dropped(w, "replaced by a newer wait");
        }
        insert(b.key, b.task, b.agent, b.cause, at, at > t ? at : null, b.author ?? "kernel");
      });
    },
    /**
     * Rows for the module to run, claimed at once (one transaction) and leased for LEASE_MS. Per task: with a live job, its
     * comments newer than the job (to deliver as input, `live_job`), the rest waiting for the next job; without one, one row that
     * starts the next job, the others waiting for it. Rows a job already covered (older than the claim that started it) are
     * dropped, or done for comments: a wake is consumed only by a job whose prompt had its cause. Open rows come before
     * re-leased ones, so wakes that keep failing can never fill every slot and starve a new one.
     */
    claim(module: string, limit = 20): (Wake & { live_job?: string })[] {
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        q("INSERT OR IGNORE INTO wake_dispatchers (module, since) VALUES (?, ?)").run(module, t);
        const rows = (q("SELECT * FROM wakes WHERE ((state = 'open' AND (until IS NULL OR until <= ?)) OR (state = 'claimed' AND job IS NULL AND claimed_by = ? AND until <= ?)) ORDER BY state = 'claimed', at, key").all(t, module, t) as unknown as Wake[]).filter((w) => dispatches.may(module, w.agent));
        // Every end has its fact (else task state reads the wake as still pending or held): dropped, or done by the job that consumed it.
        const set = (w: Wake, end: { dropped: string } | { done: string; job: string }) => {
          const state = "job" in end ? "done" : "dropped";
          q("UPDATE wakes SET state = ?, until = NULL WHERE key = ?").run(state, w.key);
          log(`wake ${state}`, { key: w.key, why: "job" in end ? end.done : end.dropped });
          if ("job" in end) covered(w, end.job); else dropped(w, end.dropped);
        };
        const take = { run: (module: string, until: number, key: string) => q("UPDATE wakes SET state = 'claimed', claimed_by = ?, until = ?, claimed_at = ? WHERE key = ?").run(module, until, t, key) };
        const out: (Wake & { live_job?: string })[] = [];
        const started = new Set<string>();
        for (const w of rows) {
          if (out.length >= limit) break;
          if (grants()[w.agent]?.team) { set(w, { dropped: "a team record never runs: its tasks go to a member" }); continue; }
          const live = liveJob(w.task);
          const comment = w.cause === "comment";
          if (live) {
            // A wake is consumed only by a job whose prompt had its cause: any other waits for the next job (still open).
            if (!comment) continue;
            if (w.at < live.at) set(w, { done: `before the live job ${live.id} was claimed`, job: live.id });
            else { take.run(module, t + LEASE_MS, w.key); out.push({ ...w, state: "claimed", claimed_by: module, until: t + LEASE_MS, live_job: live.id }); }
            continue;
          }
          const last = lastJob(w.task);
          if (last && w.at < last.at) { const why = `before the job ${last.id} was claimed`; set(w, comment ? { done: why, job: last.id } : { dropped: why }); continue; }
          // One starter per task: a pending one (claimed, no job yet, still leased) or the first here.
          const pending = q("SELECT key FROM wakes WHERE task = ? AND state = 'claimed' AND job IS NULL AND until > ? AND key != ?").get(w.task, t, w.key) as { key: string } | undefined;
          // Others stay open: the job the starter brings consumes them (older than its claim); a starter dropped without a job doesn't.
          if (started.has(w.task) || pending) continue;
          started.add(w.task);
          take.run(module, t + LEASE_MS, w.key);
          out.push({ ...w, state: "claimed", claimed_by: module, until: t + LEASE_MS });
        }
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    /** The claimer gives a row up for good. */
    drop(module: string, key: string, why: string) {
      const n = inTx(db, "wake_drop", () => {
        const r = q("UPDATE wakes SET state = 'dropped', until = NULL WHERE key = ? AND state = 'claimed' AND claimed_by = ? AND job IS NULL").run(key, module);
        if (r.changes) dropped({ key, task: (q("SELECT task FROM wakes WHERE key = ?").get(key) as { task: string }).task }, why);
        return r.changes;
      });
      if (n) log("wake dropped", { key, module, why: why.slice(0, 200) });
      return { dropped: n > 0 };
    },
    /**
     * A note on a claimed wake's task that no job will answer (a redirect, a task with no request), posted as the task's agent
     * with the kernel's tag (SELF_TAG: it wakes nobody), once per wake. The task and agent are the wake's, never the caller's.
     */
    async note(module: string, key: string, body: unknown) {
      const w = q("SELECT task, agent FROM wakes WHERE key = ? AND state = 'claimed' AND claimed_by = ? AND job IS NULL").get(key, module) as { task: string; agent: string } | undefined;
      if (!w) return { status: 409, error: `wake ${key} isn't one this module claimed, or a job already answers it` };
      if (typeof body !== "string" || !body.trim()) return { status: 400, error: "send {body}" };
      const id = `w-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
      return post({ id, agent: w.agent, task: w.task }, { kind: "note", body: body.slice(0, 20_000) });
    },
    /**
     * Whether a task has a wake still waiting to start a job: an open row (not yet due, or due and unclaimed) or one a
     * dispatcher claimed with no job yet. A task with a live job is asked about its job instead (`GET /v1/jobs?task=`): the
     * two together are a task in flight. Dispatch reads this before folding a routine run into an earlier one (routines.ts):
     * a run whose job ended and left no wake is idle work, not something a new run belongs to. `retry`: only a wake that
     * restarts a run that stopped (dispatch's `retry.<job>`: only that run's own retry), which is what holds a parent's batch
     * summary; `except`: one key the caller is dropping itself, which no longer holds anything.
     */
    pending(module: string, task: string, o: { retry?: string; except?: string } = {}) {
      // Same rule as claim(): only rows for an agent this dispatcher runs count, each read on its own (a task's wakes can name
      // different agents across a reassignment). A pending row of another agent is never readable through this module.
      // A retry's key is exactly `wake_at:<module>.retry.<job>` (schedule's `wake_at:${module}.${id}` and dispatch's `retry.<job>`).
      const rows = q(`SELECT agent FROM wakes WHERE task = ? AND (state = 'open' OR (state = 'claimed' AND job IS NULL)) AND key != ?${o.retry ? " AND key = ?" : ""}`)
        .all(task, o.except ?? "", ...(o.retry ? [`wake_at:${module}.retry.${o.retry}`] : [])) as { agent: string }[];
      return rows.some((r) => dispatches.may(module, r.agent));
      // (`until` doesn't matter: a scheduled row is a wake still to come, and one whose lease ran out is claimable again.)
    },
    /**
     * A dispatcher's cancel of a routine run's task, posted as the task's agent (once per task and reason): folded into an
     * earlier run of its routine (`coalesced`), or overtaken by a later one that finished (`stale`). Dispatch judges which; the
     * kernel only lets it cancel an open or blocked routine run of an agent it dispatches, never any other task.
     */
    async cancelRoutineRun(module: string, b: { task?: unknown; why?: unknown; body?: unknown }) {
      if (typeof b.task !== "string" || (b.why !== "coalesced" && b.why !== "stale") || typeof b.body !== "string" || !b.body.trim()) return { status: 400, error: "send {task, why: coalesced|stale, body}" };
      const r = await owner("GET", `/api/issues/${encodeURIComponent(b.task)}`);
      const t = r.json as Issue;
      if (r.status !== 200 || t.originKind !== "routine_execution" || !t.assigneeAgentId || !`${OPEN},blocked`.split(",").includes(String(t.status)) || !dispatches.may(module, t.assigneeAgentId))
        return { status: 409, error: `${b.task} isn't an open routine run of an agent ${module} dispatches` };
      return post({ id: t.id, agent: t.assigneeAgentId, task: t.id }, { kind: b.why, status: "cancelled", body: b.body.slice(0, 2000) });
    },
    /** A claimed comment delivered into the live job that took it (the input's ack): bound to that job. */
    delivered(module: string, key: string, job: string) {
      return inTx(db, "wake_delivered", () => {
        const w = q("SELECT key, task FROM wakes WHERE key = ? AND state = 'claimed' AND claimed_by = ?").get(key, module) as { key: string; task: string } | undefined;
        if (!w) return false;
        q("UPDATE wakes SET state = 'delivered', until = NULL WHERE key = ?").run(key);
        covered(w, job);
        return true;
      });
    },
    get: (key: string) => q("SELECT * FROM wakes WHERE key = ?").get(key) as unknown as Wake | undefined,
    /** Whether a dispatcher that has joined runs this agent's wakes. */
    polls: (agent: string) => polled().has(agent),
  };
}
export type Wakes = ReturnType<typeof createWakes>;
