// The wake inbox (one-way spec §4.2a): every reason to run an agent on a task is one durable row in kernel.db, written by
// one per-task scan. The reconcile poll scans every open task of the polled agents; a Paperclip event (the paperclip-events
// plugin, at most once and with duplicates) only scans its one task sooner. A dispatcher (role kernel.jobs) claims rows and
// turns them into jobs; admission binds `job` (unique, so a wake starts at most one job).
// Keys (never Paperclip's eventId): comment:<commentId>, issue:<issueId>:<updatedAt> (assigned or moved to todo),
// routine-run:<issueId> (a routine run's new task, cause routine:<key>: the routine's compiled key, so admission applies its own
// model; dispatch folds a run into an earlier open one of its routine, and cancels overtaken blocked ones), reopen:<issueId>:<statusVersion> (a comment reopened a finished task),
// wake_at:<module>.<id> (a module's scheduled wake, due at `until`), unblocked:<issueId>:<closure> (a blocked task whose first-class
// blockers (blockedBy) are all done or cancelled: the poll moves it to todo with one tagged notice, then files this wake).
// Polled agents: those the modules that claim wakes dispatch (compile's `dispatches`); a module joins on its first claim.
// So nothing is polled until a dispatcher claims, and an agent's first scan only wakes for comments after its dispatcher
// joined or its own last word on the task, whichever is later.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Api } from "./channels.ts";
import { factWriter, iso } from "./factlog.ts";
import type { Facts } from "./facts.ts";
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
  state TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, record TEXT NOT NULL DEFAULT '', snapshot TEXT);`;
/** What a decision was made from (team_routes.snapshot): the learning loop replays it with other weights or repos (routing-tune.ts). */
export type RouteSnapshot = { weights: Weights; overBudget: boolean; candidates: Candidate[] };
/** A grants-table entry as the router reads it (compile's grantEntry): a team record lists its members; a member names its record. */
type TeamGrant = { key?: string; max_parallel?: number; team?: { name: string; members: string[]; weights?: Partial<Weights> }; member_of?: string; repos?: string[] };

/**
 * A wake notice: a labelled comment on the task, posted as the owner, which wakes its agent (asker.tell's open-parent path and
 * the team router's blocked path). A closed task hears nothing (a comment would reopen it).
 */
export async function wakeNotice(owner: Api, task: string, text: string): Promise<"posted" | "closed" | "missing"> {
  const issue = await owner("GET", `/api/issues/${encodeURIComponent(task)}`);
  if (issue.status !== 200) return "missing";
  if (["done", "cancelled"].includes(issue.json.status)) return "closed";
  const c = await owner("POST", `/api/issues/${encodeURIComponent(issue.json.id)}/comments`, { body: `[wake] ${text}\n\n<!-- aidenhq-wake -->` });
  if (c.status >= 300) throw Object.assign(new Error(`the control plane answered ${c.status}`), { status: 502 });
  return "posted";
}

export interface Wake { key: string; task: string; agent: string; cause: string; at: number; state: string; claimed_by: string | null; job: string | null; until: number | null }
type Issue = { id: string; identifier?: string; title?: string; description?: string | null; parentId?: string | null; status?: string; assigneeAgentId?: string | null; updatedAt?: string; createdAt?: string; statusVersion?: number; blockedBy?: { id: string; identifier?: string | null; status: string }[]; originKind?: string | null; originId?: string | null; companyId?: string };
type Comment = { id: string; body?: string; authorAgentId?: string | null; authorUserId?: string | null; createdAt?: string; deletedAt?: string | null };
type Log = (msg: string, f?: Record<string, unknown>) => void;
const ms = (t?: string) => (t ? Date.parse(t) || 0 : 0);

export function createWakes({ db, owner, post, dispatches, routineKey = () => undefined, grants = () => ({}), knownRepo = () => false, teamDayUsedUp = () => false, tellBlocked = async () => {}, facts, log = () => {}, now = Date.now }: {
  /** Flow's fact log (facts.ts): task changes the scan sees, and each wake's opening, binding and dropping. */
  facts?: Facts;
  db: DatabaseSync;
  /** The control plane as the owner (only reads). */
  owner: Api;
  /** Writes as the task's agent (outcomes.ts): notes, and a routine run a dispatcher cancels. */
  post: Outcomes["post"];
  /** Whether a module dispatches an agent (jobs.ts dispatchesFrom), and the agents it dispatches (ids). */
  dispatches: { may: (module: string, agent: string) => boolean; agents: (module: string) => string[] };
  /** A Paperclip routine's compiled key (grants `routine_keys`, setup): none for a routine setup didn't make. */
  routineKey?: (routine: string) => string | undefined;
  /** The grants table's agents by id: teams and members (team routing). */
  grants?: () => Record<string, TeamGrant | undefined>;
  /** Whether a repo (owner/name, lower case) is one the instance's code hosts have: a task's text names only those for routing. */
  knownRepo?: (repo: string) => boolean;
  /** Whether the team of this member has used up its day cap (the gateway's own day scope, gateway/lib.ts dayHolder). */
  teamDayUsedUp?: (member: string, task: string) => boolean;
  /** A team task no member can take, blocked: whoever delegated it hears why (its open parent's wake notice, else the owner). */
  tellBlocked?: (task: Issue, text: string) => Promise<void>;
  log?: Log; now?: () => number;
}) {
  db.exec(DDL);
  if (!(db.prepare("PRAGMA table_info(team_routes)").all() as { name: string }[]).some((c) => c.name === "snapshot")) db.exec("ALTER TABLE team_routes ADD COLUMN snapshot TEXT");
  // What the scan last saw of a task (wake_tasks): `blocked` its blocker ids, and `polled` whether the wake logic has run on it
  // (a row made only to diff the task's facts, for a task nobody polls, is not a first sight's cursor).
  const have = new Set((db.prepare("PRAGMA table_info(wake_tasks)").all() as { name: string }[]).map((c) => c.name));
  if (!have.has("blocked")) db.exec("ALTER TABLE wake_tasks ADD COLUMN blocked TEXT");
  if (!have.has("polled")) db.exec("ALTER TABLE wake_tasks ADD COLUMN polled INTEGER NOT NULL DEFAULT 1");
  const q = (sql: string) => db.prepare(sql);
  const fact = factWriter(facts, log);
  const keyOf = (agent: string | null | undefined) => (agent ? grants()[agent]?.key ?? agent : null);
  const insert = (key: string, task: string, agent: string, cause: string, at: number, until: number | null = null, author = "unknown") => {
    const r = q("INSERT OR IGNORE INTO wakes (key, task, agent, cause, at, until) VALUES (?, ?, ?, ?, ?, ?)").run(key, task, agent, cause, at, until);
    if (r.changes) {
      log("wake", { key, task, cause });
      fact({ type: "wake.opened", subject: `wake:${key}`, version: "opened", at: iso(at), actor: author, task, data: { cause, author } });
    }
  };
  const dropped = (w: { key: string; task: string }, why: string) => fact({ type: "wake.dropped", subject: `wake:${w.key}`, version: "dropped", at: iso(now()), actor: "kernel", task: w.task, data: { why: why.slice(0, 200) } });
  const blockedKey = (i: Issue) => (i.blockedBy ? i.blockedBy.map((b) => b.id).sort().join(",") : null);

  /**
   * What changed on a task since the scan last saw it, as facts (spec: flow §1). Their versions come from Paperclip, so the event
   * path and the poll that see one change record it once. A task seen first is recorded as created, with the status and assignee
   * it has (from nothing). `actor`: who Paperclip says did it, else unknown.
   */
  function taskFacts(issue: Issue, prev: { agent: string | null; status: string | null; blocked: string | null } | undefined, source: "live" | "poll", actor: string) {
    const base = { subject: `task:${issue.id}`, task: issue.id, actor, source };
    const changed = ms(issue.updatedAt) || now();
    if (!prev) fact({ ...base, type: "task.created", version: "created", at: iso(ms(issue.createdAt) || changed), data: { parent: issue.parentId ?? null, origin: issue.originKind ?? null, source_marker: issue.originId ?? null } });
    const status = String(issue.status ?? "");
    if (status && (prev?.status ?? null) !== status) fact({ ...base, type: "task.status_changed", version: String(issue.statusVersion ?? issue.updatedAt ?? changed), at: iso(changed), data: { from: prev?.status ?? null, to: status } });
    const to = issue.assigneeAgentId ?? null;
    if ((prev?.agent ?? null) !== to) fact({ ...base, type: "task.assignee_changed", version: String(issue.updatedAt ?? changed), at: iso(changed), data: { from: keyOf(prev?.agent), to: keyOf(to) } });
    const blocked = blockedKey(issue);
    if (blocked !== null && blocked !== (prev?.blocked ?? "")) fact({ ...base, type: "task.blocked_changed", version: `${blocked}@${issue.updatedAt ?? changed}`, at: iso(changed), data: { blocked_by: blocked ? blocked.split(",") : [] } });
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
  const liveJob = (task: string) => q(`SELECT id, at FROM jobs WHERE task = ? AND state IN ${LIVE} ORDER BY at DESC LIMIT 1`).get(task) as { id: string; at: number } | undefined;
  const lastJob = (task: string) => q("SELECT id, at FROM jobs WHERE task = ? ORDER BY at DESC LIMIT 1").get(task) as { id: string; at: number } | undefined;

  /** One task's wakes: new comments past its cursor, and a move to todo (or a first sight of an unstarted todo task). */
  async function scan(issue: Issue, { reopened = false, source = "live", actor = "unknown" }: { reopened?: boolean; source?: "live" | "poll"; actor?: string } = {}) {
    const seen = q("SELECT agent, status, comment, blocked, polled FROM wake_tasks WHERE task = ?").get(issue.id) as { agent: string | null; status: string | null; comment: string | null; blocked: string | null; polled: number } | undefined;
    // The task's facts first: a task nobody polls (unassigned, or an agent no dispatcher claims) is recorded too.
    taskFacts(issue, seen, source, actor);
    const agent = issue.assigneeAgentId;
    const joined = agent ? polled().get(agent) : undefined;
    if (!agent || joined === undefined || grants()[agent]?.team) {
      q("INSERT INTO wake_tasks (task, agent, status, blocked, polled) VALUES (?, ?, ?, ?, 0) ON CONFLICT(task) DO UPDATE SET agent = excluded.agent, status = excluded.status, blocked = COALESCE(excluded.blocked, blocked)").run(issue.id, agent ?? null, String(issue.status ?? ""), blockedKey(issue));
      if (agent && joined !== undefined) return route(issue, agent);
      return;
    }
    if (grants()[agent]?.member_of) named(issue, agent);
    const prev = seen?.polled ? { agent: seen.agent, status: seen.status, comment: seen.comment } : undefined;
    const path = `/api/issues/${encodeURIComponent(issue.id)}/comments?${prev?.comment ? `order=asc&limit=500&after=${encodeURIComponent(prev.comment)}` : "order=desc&limit=500"}`;
    const r = await owner("GET", path);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`control plane GET comments → ${r.status}`);
    const all = (r.json as Comment[]).slice().sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    // First sight: only what came after the dispatcher joined or the agent's last word on the task.
    const boundary = prev ? 0 : Math.max(since(agent, joined), ...all.filter((c) => c.authorAgentId === agent || SELF_TAG.test(c.body ?? "")).map((c) => ms(c.createdAt)));
    for (const c of all) {
      if (c.deletedAt || ms(c.createdAt) <= boundary || c.authorAgentId === agent || SELF_TAG.test(c.body ?? "")) continue;
      insert(`comment:${c.id}`, issue.id, agent, "comment", ms(c.createdAt) || now(), null, c.authorAgentId ? `agent:${keyOf(c.authorAgentId)}` : c.authorUserId ? `account:${c.authorUserId}` : "unknown");
    }
    const status = String(issue.status ?? "");
    const moved = prev ? prev.status !== status || prev.agent !== agent : !lastJob(issue.id);
    if (status === "todo" && (reopened || moved) && !liveJob(issue.id)) {
      const at = ms(issue.updatedAt) || now();
      if (reopened) insert(`reopen:${issue.id}:${issue.statusVersion ?? issue.updatedAt}`, issue.id, agent, "reopen", at, null, actor);
      else if (!prev && issue.originKind === "routine_execution") {
        const key = routineKey(String(issue.originId ?? ""));
        insert(`routine-run:${issue.id}`, issue.id, agent, key ? `routine:${key}` : "routine", at, null, actor);
      }
      else insert(`issue:${issue.id}:${issue.updatedAt}`, issue.id, agent, prev?.agent === agent ? "status" : "assigned", at, null, actor);
    }
    const newest = prev?.comment && !all.length ? prev.comment : all.at(-1)?.id ?? null;
    q("INSERT INTO wake_tasks (task, agent, status, comment, blocked, polled) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(task) DO UPDATE SET agent = excluded.agent, status = excluded.status, comment = excluded.comment, blocked = COALESCE(excluded.blocked, blocked), polled = 1").run(issue.id, agent, status, newest, blockedKey(issue));
  }

  /**
   * A blocked task whose blockers (first-class, read from the single issue: a list row may leave them out) are all done or
   * cancelled leaves `blocked` for `todo` with one notice naming what closed (the PATCH carries it, tagged: it wakes nobody),
   * and its assignee is woken. Stateless: a task still blocked is simply retried next poll, and the wake key (the closure) files
   * once. Paperclip counts a cancelled blocker as unresolved for a status write, so those relations are cleared first; a 409 is
   * retried once with them all cleared.
   */
  async function unblock(issue: Issue, agent: string) {
    const r = await owner("GET", `/api/issues/${encodeURIComponent(issue.id)}`);
    if (r.status !== 200) throw new Error(`control plane GET issue → ${r.status}`);
    const task = r.json as Issue;
    const blockers = task.blockedBy ?? [];
    if (task.status !== "blocked" || !blockers.length || !blockers.every((b) => b.status === "done" || b.status === "cancelled")) return;
    const closure = blockers.map((b) => `${b.id}:${b.status}`).sort().join(",");
    const line = `${blockers.map((b) => b.identifier ?? b.id).join(", ")} closed (${blockers.map((b) => b.status).join(", ")}).`;
    const patch = (b: object) => owner("PATCH", `/api/issues/${encodeURIComponent(task.id)}`, b);
    const ok = (res: { status: number }) => { if (res.status >= 300) throw new Error(`control plane PATCH issue → ${res.status}`); return res; };
    const keep = blockers.filter((b) => b.status !== "cancelled").map((b) => b.id);
    if (keep.length !== blockers.length) ok(await patch({ blockedByIssueIds: keep }));
    const move = { status: "todo", comment: `Unblocked: ${line}\n\n<!-- aidenhq:job=kernel kind=unblocked -->` };
    let res = await patch(move);
    if (res.status === 409) { ok(await patch({ blockedByIssueIds: [] })); res = await patch(move); }
    ok(res);
    insert(`unblocked:${task.id}:${closure}`, task.id, agent, "unblocked", now(), null, "kernel");
  }

  // ---- Team routing (team-routing.ts picks; this gathers, records and places) ----
  // One decision row per task in team_routes: `placing` (picked, the reassignment not yet confirmed: a retry re-applies the
  // same pick, never re-scores), `placed`, `named` (assigned straight to a member: its delegator's structured choice), or
  // `blocked`. Selection is serialized in this process (`lock`), and a pending placement counts as its member's load.
  const OPEN_SET = new Set(OPEN.split(","));
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
  const route = (issue: Issue, team: string) => { const run = lock.then(() => place(issue, team)); lock = run.catch(() => {}); return run; };
  /** The members' snapshot (paused, open tasks, done tasks in the repo), awaited before the decision, which awaits nothing. */
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
      // Continuity: distinct tasks this member finished in one of the task's repos within the window (task status done).
      let done = 0;
      if (repos.length) for (const r of q("SELECT task, repos, done FROM team_routes WHERE member = ? AND at > ? AND task != ? AND state != 'blocked'").all(id, since, task) as { task: string; repos: string; done: number }[]) {
        if (!(JSON.parse(r.repos) as string[]).some((x) => repos.includes(x))) continue;
        if (!r.done) {
          const t = await owner("GET", `/api/issues/${encodeURIComponent(r.task)}`);
          if (t.status === 200 && t.json?.status === "done") q("UPDATE team_routes SET done = 1 WHERE task = ?").run(r.task);
          else continue;
        }
        done++;
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
    const tag = `\n\n<!-- aidenhq:job=kernel kind=routed -->`;
    if (!row) {
      const repos = repoText(issue);
      const snap = await snapshot(team, issue.id, repos);
      const weights = weightsOf(team.team);
      const over = snap.length > 0 && teamDayUsedUp(snap[0]!.id, issue.id);
      const revision = createHash("sha256").update(JSON.stringify([team.team, snap.map((m) => [m.key, m.g.repos ?? [], m.g.max_parallel ?? 1])])).digest("hex").slice(0, 12);
      db.exec("BEGIN IMMEDIATE");
      try {
        const candidates: Candidate[] = snap.map((m) => {
          const live = new Set((q(`SELECT task FROM jobs WHERE agent = ? AND state IN ${LIVE}`).all(m.id) as { task: string }[]).map((r) => r.task));
          const waiting = new Set([...m.open, ...(q("SELECT task FROM team_routes WHERE member = ? AND state = 'placing'").all(m.id) as { task: string }[]).map((r) => r.task)]);
          for (const t of live) waiting.delete(t);
          return { id: m.id, key: m.key, repos: m.g.repos ?? [], maxParallel: m.g.max_parallel ?? 1, paused: m.paused, running: live.size, queued: waiting.size, done: m.done };
        });
        const decision = pickMember({ repos, candidates, weights, overBudget: over });
        const record = decisionText({ team: team.team!.name, revision, repos, weights, decision });
        const snapshot: RouteSnapshot = { weights, overBudget: over, candidates };
        q("INSERT INTO team_routes (task, team, member, repos, at, state, record, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(issue.id, String(team.key), decision.pick?.id ?? null, JSON.stringify(repos), now(), decision.pick ? "placing" : "blocked", record, JSON.stringify(snapshot));
        db.exec("COMMIT");
        log("team routed", { task: issue.id, team: team.team!.name, pick: decision.pick?.key ?? null });
        if (!decision.pick) {
          const r = await owner("PATCH", `/api/issues/${encodeURIComponent(issue.id)}`, { status: "blocked", comment: record + tag });
          if (r.status >= 300) throw new Error(`control plane PATCH issue → ${r.status}`);
          await tellBlocked(issue, `**${issue.identifier ?? issue.id} is blocked:** no member of team ${team.team!.name} can take it.\n\n${record}\n\nUnpause a member, raise the team's day cap, or re-route it.`);
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
    if (now2.status === 200 && now2.json?.assigneeAgentId === row.member) await scan(now2.json as Issue);
  }

  const companies = new Map<string, string>();
  return {
    scan,
    /** The reconcile poll: every open task of every polled agent, and its blocked tasks whose blockers closed; and wakes whose jobs ended are done. */
    async poll() {
      q(`UPDATE wakes SET state = 'done' WHERE state = 'claimed' AND job IS NOT NULL AND job NOT IN (SELECT id FROM jobs WHERE state IN ${LIVE})`).run();
      for (const agent of polled().keys()) {
        try {
          if (!companies.has(agent)) {
            const a = await owner("GET", `/api/agents/${encodeURIComponent(agent)}`);
            if (a.status !== 200 || !a.json?.companyId) throw new Error(`control plane GET agent → ${a.status}`);
            companies.set(agent, String(a.json.companyId));
          }
          const l = await owner("GET", `/api/companies/${encodeURIComponent(companies.get(agent)!)}/issues?status=${OPEN}&limit=500&assigneeAgentId=${encodeURIComponent(agent)}`);
          if (l.status !== 200 || !Array.isArray(l.json)) throw new Error(`control plane GET issues → ${l.status}`);
          for (const issue of l.json as Issue[]) await scan(issue, { source: "poll" }).catch((e: Error) => log("wake scan failed", { task: issue.id, err: e.message }));
          const b = await owner("GET", `/api/companies/${encodeURIComponent(companies.get(agent)!)}/issues?status=blocked&limit=200&assigneeAgentId=${encodeURIComponent(agent)}`);
          if (b.status !== 200 || !Array.isArray(b.json)) throw new Error(`control plane GET blocked issues → ${b.status}`);
          for (const issue of b.json as Issue[]) await unblock(issue, agent).catch((e: Error) => log("wake unblock failed", { task: issue.id, err: e.message }));
        } catch (e) {
          log("wake poll failed", { agent, err: (e as Error).message });
        }
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
      await scan(r.json as Issue, { reopened: b.reopened === true, actor });
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
      if (r.status !== 200 || !issue.assigneeAgentId) return { error: `no assigned task ${task}` };
      if (b.agent !== undefined && b.agent !== issue.assigneeAgentId) return { error: "the agent isn't the task's assignee" };
      const key = `wake_at:${module}.${id}`;
      insert(key, issue.id, issue.assigneeAgentId, typeof b.cause === "string" ? `scheduled: ${b.cause.slice(0, 200)}` : "scheduled", at, at, `module:${module}`);
      return { key };
    },
    /**
     * Rows for the module to run, claimed at once (one transaction) and leased for LEASE_MS. Per task: with a live job, its
     * comments newer than the job (to deliver as input, `live_job`) and nothing else; without one, one row that starts the
     * next job. Rows a job already covered (older than its start) are dropped, or done for comments.
     */
    claim(module: string, limit = 20): (Wake & { live_job?: string })[] {
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        q("INSERT OR IGNORE INTO wake_dispatchers (module, since) VALUES (?, ?)").run(module, t);
        const rows = (q("SELECT * FROM wakes WHERE ((state = 'open' AND (until IS NULL OR until <= ?)) OR (state = 'claimed' AND job IS NULL AND claimed_by = ? AND until <= ?)) ORDER BY at, key").all(t, module, t) as unknown as Wake[]).filter((w) => dispatches.may(module, w.agent));
        const set = (w: Wake, state: string, why: string) => { q("UPDATE wakes SET state = ?, until = NULL WHERE key = ?").run(state, w.key); log(`wake ${state}`, { key: w.key, why }); if (state === "dropped") dropped(w, why); };
        const take = q("UPDATE wakes SET state = 'claimed', claimed_by = ?, until = ? WHERE key = ?");
        const out: (Wake & { live_job?: string })[] = [];
        const started = new Set<string>();
        for (const w of rows) {
          if (out.length >= limit) break;
          if (grants()[w.agent]?.team) { set(w, "dropped", "a team record never runs: its tasks go to a member"); continue; }
          const live = liveJob(w.task);
          const comment = w.cause === "comment";
          if (live) {
            if (!comment) set(w, "dropped", `task has the live job ${live.id}`);
            else if (w.at < live.at) set(w, "done", `before the live job ${live.id} started`);
            else { take.run(module, t + LEASE_MS, w.key); out.push({ ...w, state: "claimed", claimed_by: module, until: t + LEASE_MS, live_job: live.id }); }
            continue;
          }
          const last = lastJob(w.task);
          if (last && w.at < last.at) { set(w, comment ? "done" : "dropped", `before the job ${last.id} started`); continue; }
          // One starter per task: a pending one (claimed, no job yet, still leased) or the first here.
          const pending = q("SELECT key FROM wakes WHERE task = ? AND state = 'claimed' AND job IS NULL AND until > ? AND key != ?").get(w.task, t, w.key) as { key: string } | undefined;
          if (started.has(w.task) || pending) { if (!comment) set(w, "dropped", "coalesced into the task's next job"); continue; }
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
      const r = q("UPDATE wakes SET state = 'dropped', until = NULL WHERE key = ? AND state = 'claimed' AND claimed_by = ? AND job IS NULL").run(key, module);
      if (r.changes) {
        log("wake dropped", { key, module, why: why.slice(0, 200) });
        dropped({ key, task: (q("SELECT task FROM wakes WHERE key = ?").get(key) as { task: string }).task }, why);
      }
      return { dropped: r.changes > 0 };
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
    /** A claimed comment delivered into its live job (the input's ack). */
    delivered(module: string, key: string) {
      return q("UPDATE wakes SET state = 'delivered', until = NULL WHERE key = ? AND state = 'claimed' AND claimed_by = ?").run(key, module).changes > 0;
    },
    get: (key: string) => q("SELECT * FROM wakes WHERE key = ?").get(key) as unknown as Wake | undefined,
  };
}
export type Wakes = ReturnType<typeof createWakes>;
