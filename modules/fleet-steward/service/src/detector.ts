// The Fleet Steward's detector, moved out of the board: on a timer it checks the owner's alert thresholds in code and files a
// task for the Steward only when something trips or recovers (kernel.tasks). Each incident is filed once until it recovers, then
// once more with a recovery note. The Steward reads what is open and what recovered with `fleet_detector`. Sources: the kernel's
// jobs (stuck, failing and silent runs), the control plane's tasks and agents, apps-mcp (apps.read) and Alertmanager's alerts.
import { createHash } from "node:crypto";
import { fence } from "./aidenhq-sdk/fence.ts";
import type { KernelClient } from "./aidenhq-sdk/kernel-client.ts";

const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
const DOWN_MS = 15 * MIN; // an app incident open this long (the app-incident loop had its chance)
const STALE_MS = 60 * MIN; // a source with no good pass this long
/** Sources that pass on their own slower cadence: the security scanner runs daily. */
const STALE_FOR: Record<string, number> = { security: 26 * 60 * MIN };
const age = (t: string | null | undefined, now: number) => (t ? now - Date.parse(t) : Infinity);
const mins = (ms: number) => `${Math.round(ms / MIN)} min`;

type SourceRow = { source: string; last_ok: string | null; failing: boolean };
/** The sources to raise: no good pass within their allowance, or failing with the last good pass over 15 minutes old. */
export function staleSources(rows: SourceRow[], t: number): { key: string; reason: string }[] {
  return rows
    .filter((x) => age(x.last_ok, t) > (STALE_FOR[x.source] ?? STALE_MS) || (x.failing && age(x.last_ok, t) > DOWN_MS))
    .map((x) => ({ key: x.source, reason: `source src_${x.source}: last good pass ${x.last_ok ? `${mins(age(x.last_ok, t))} ago` : "never"}${x.failing ? "; its latest pass failed" : ""}` }));
}
const PR_OPEN_MS = 60 * MIN; // a pull request of the agents org or the fleet's own open this long without merging (the warehouse lags GitHub by up to 15 minutes)

type PrRow = { repo: string; number: number; opened_at: string; draft: boolean; preview_url?: string };
/** The open agents-org and fleet-authored PRs nobody has merged within the allowance; merged or closed ones are no longer in the rows. A draft
 * cannot merge until someone marks it ready, so it is not overdue; only its age once ready counts. */
export function stalePrs(rows: PrRow[], t: number): { key: string; reason: string }[] {
  return rows
    .filter((x) => !x.draft && age(x.opened_at, t) > PR_OPEN_MS)
    // A running preview's link (apps-mcp: the PR's, or this server's change request's) rides on the row.
    .map((x) => ({ key: `${x.repo}#${x.number}`, reason: `${x.repo}#${x.number} open ${mins(age(x.opened_at, t))} without merging${x.preview_url && /^https?:\/\//.test(x.preview_url) ? ` (preview: ${x.preview_url})` : ""}` }));
}
// Never a sample: apps-mcp keeps app data behind app_status (per-caller read access); fleet_status shows what the detector holds.
type QualityRow = { name: string; state: "none" | "ok" | "unknown"; checks?: { name: string; ok: boolean; count: number | null }[] };
/**
 * Quality findings (apps' own /api/health checks, apps-mcp quality.ts): a failing check is `<app>:<check>` in the `quality`
 * group, never an app incident (bad data must not look like an outage or roll a deploy back). An app whose checks couldn't be
 * evaluated keeps its open findings open (`openKeys`: the detector's open keys): unknown is not recovered.
 */
/** An app-supplied name reduced to a short slug (a-z, 0-9, - and _). */
const slug = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "unnamed";

/** A routine's title for a line the owner reads: its own words, minus anything but letters, digits and light punctuation, at most 60. */
const plain = (v: unknown) => String(v ?? "").replace(/[^\w .:-]+/g, " ").trim().slice(0, 60);

export function qualityFindings(apps: QualityRow[], openKeys: string[]): Incident[] {
  const out: Incident[] = [];
  for (const a of apps) {
    if (a.state === "unknown") {
      for (const k of openKeys.filter((k) => k.startsWith(`quality:${a.name}:`))) out.push({ key: k.slice("quality:".length), reason: "" });
      continue;
    }
    for (const c of a.state === "ok" ? (a.checks ?? []).filter((c) => !c.ok) : []) {
      // The check's name comes from the app: only a short slug of it reaches Fleet Ops' task, never free text.
      const name = slug(c.name);
      const count = Number.isFinite(Number(c.count)) ? ` (${Number(c.count)})` : "";
      out.push({ key: `${a.name}:${name}`, reason: `app ${a.name}: quality check ${name} failing${c.count != null ? count : ""}; its owner reads the sample with app_status` });
    }
  }
  return out;
}
const SILENT_RUNS = 3; // finished jobs with no steps and no final words, in a day
const STUCK_DEFAULT_MS = 180 * MIN; // a run with no known timeout, running this long
const FAILS = 3; // an agent's last finished runs, all failed

const MISSED_GRACE_MS = 15 * MIN;
const HARD_FAIL = new Set(["failed", "timeout"]);

/** Active routines whose next fire (by Paperclip's cron) is overdue past the grace: the fire never happened. A coalesced or skipped fire still advances it. */
export function missedFires(routines: RoutineRow[], t: number): Incident[] {
  const out: Incident[] = [];
  for (const r of routines.filter((x) => x.status === "active")) {
    const late = (r.triggers ?? []).filter((x) => x.kind === "schedule" && x.enabled !== false && x.nextRunAt && age(x.nextRunAt, t) > MISSED_GRACE_MS);
    for (const x of late) out.push({ key: `${r.id}:${slug(x.label ?? "schedule")}`, reason: `routine ${plain(r.title)} (${slug(x.label ?? "schedule")}): fire due ${mins(age(x.nextRunAt, t))} ago, no run started` });
  }
  return out;
}

/** The routines (by id) whose newest FAILS finished jobs all hard-failed; `since[id]` is when the detector last paused it, so a resume counts only newer jobs. */
export function failingRoutines(jobs: JobRow[], since: Record<string, string> = {}): { routine: string; failures: number }[] {
  const by = new Map<string, JobRow[]>();
  for (const j of jobs) if (j.routine && j.ended_at && !["running", "admitted", "cancelled", "lost"].includes(j.state) && !(since[j.routine] && j.ended_at <= since[j.routine]!)) by.set(j.routine, [...(by.get(j.routine) ?? []), j]);
  const out: { routine: string; failures: number }[] = [];
  for (const [routine, list] of by) {
    const mine = list.sort((a, b) => b.ended_at!.localeCompare(a.ended_at!));
    let n = 0;
    while (n < mine.length && HARD_FAIL.has(mine[n]!.state)) n++;
    if (n >= FAILS) out.push({ routine, failures: n });
  }
  return out;
}

/** `critical`: an outage or a critical alert, which wakes Fleet Ops at once; the rest wait for the next quiet-gap fire. */
export interface Incident { key: string; reason: string; critical?: boolean }
interface Open { reason: string; at: string; fired: boolean; told?: boolean; critical?: boolean }
interface State { open: Record<string, Open>; recovered: { key: string; reason: string; at: string; fired: boolean }[] }


/** The detector's one stored value: what is open, what recovered, and when it last filed a task. */
export interface Kv { get(key: string): string | undefined; set(key: string, value: string): void }
const STATE_KEY = "detector";

/** What is open and what recovered lately (`fleet_detector` shows it to the Steward). */
export function detectorState(kv: Pick<Kv, "get">): State {
  try {
    const s = JSON.parse(kv.get(STATE_KEY) ?? "{}");
    return { open: s.open ?? {}, recovered: s.recovered ?? [] };
  } catch {
    return { open: {}, recovered: [] };
  }
}

/** The Steward's daily digest routine: while it is paused under quiet start, the Steward is off and the detector files nothing. */
const STEWARD_SWITCH = "Fleet Ops: daily digest";
/** Whether the detector may file for the Steward: always, unless quiet start is on and the owner has not turned the Steward's digest routine on. */
export async function stewardOn(kernel: KernelClient, quiet: string | undefined): Promise<boolean> {
  if (quiet !== "on") return true;
  const companies = (await kernel.read("/api/companies")) as Company[];
  const rows = (await Promise.all(companies.map(async (c) => (await kernel.read(`/api/companies/${c.id}/routines`)) as RoutineRow[]))).flat();
  return rows.some((r) => r.title === STEWARD_SWITCH && r.status === "active");
}

/** A check group: its incidents, or undefined when it couldn't be checked (its open incidents stay open). */
type Check = () => Promise<Incident[] | undefined>;

/** The last filing, and the gap before a filing with nothing critical in it (60 check runs a day, most one line). */
export const QUIET_MS = 30 * MIN;

/**
 * One tick: run the checks, open what newly tripped, close what recovered, and file once for whatever is new (incidents and
 * recovery notes together). Marked filed only when the kernel took it; otherwise the next tick tries again. Within `quietMs`
 * of the last filing only a new critical incident files; the rest wait (still unfiled) for a later tick.
 */
export async function tick(kv: Kv, checks: Record<string, Check>, file: (body: { incidents: { key: string }[]; recovered: { key: string }[] }) => Promise<boolean>, notify: (text: string) => Promise<void>, now = new Date(), quietMs = 0, stewardOn = true): Promise<void> {
  const s = detectorState(kv);
  const at = now.toISOString();
  for (const [group, check] of Object.entries(checks)) {
    const found = await check().catch(() => undefined);
    if (!found) continue;
    const tripped = new Map(found.map((i) => [`${group}:${i.key}`, i]));
    for (const [key, i] of tripped) if (!s.open[key]) s.open[key] = { reason: i.reason, at, fired: false, ...(i.critical ? { critical: true } : {}) };
    for (const [key, o] of Object.entries(s.open)) {
      if (!key.startsWith(`${group}:`) || tripped.has(key)) continue;
      delete s.open[key];
      // Never told anyone it was down: nothing to say about it coming back.
      if (o.fired) s.recovered.push({ key, reason: o.reason, at, fired: false });
    }
  }
  // The owner hears only that the Steward itself can't be reached: a flag no task has carried for a day (one fixed line, never
  // a flag's own text), since that is the case where nobody else would act.
  const unheard = !stewardOn ? [] : Object.values(s.open).filter((o) => !o.fired && !o.told && Date.parse(at) - Date.parse(o.at) > DAY_MS);
  if (unheard.length) {
    // Marked told only once the notice went out (a kernel blip is retried on the next tick).
    if (await notify("The Fleet Steward is unreachable: its health flags have not reached it for a day. Ask Aiden to check the fleet-steward module.").then(() => true, () => false)) for (const o of unheard) o.told = true;
  }
  const incidents = Object.entries(s.open).filter(([, o]) => !o.fired).map(([key, o]) => ({ key, ...(o.critical ? { critical: true } : {}) }));
  const recovered = s.recovered.filter((r) => !r.fired).map(({ key }) => ({ key }));
  const due = incidents.some((i) => i.critical) || !(Date.parse(at) - Date.parse(kv.get("last_filed") ?? "") < quietMs);
  if (stewardOn && (incidents.length || recovered.length) && due && (await file({ incidents, recovered }).catch(() => false))) {
    for (const i of incidents) s.open[i.key]!.fired = true;
    for (const r of s.recovered) r.fired = true;
    kv.set("last_filed", at);
  }
  // Only recoveries already filed are trimmed: an unfiled one is still owed to the Steward.
  s.recovered = [...s.recovered.filter((r) => r.fired).slice(-20), ...s.recovered.filter((r) => !r.fired)];
  kv.set(STATE_KEY, JSON.stringify(s));
}

interface Company { id: string }
interface AgentRow { id: string; name: string; status: string; adapterConfig?: { timeoutSec?: number } }
interface JobRow { id: string; agent: string; task?: string; routine?: string | null; state: string; started_at: string | null; ended_at: string | null; exit?: number | null; timed_out?: boolean; steps?: number; has_final?: boolean }
interface RoutineRow { id: string; title: string; status: string; triggers?: { kind?: string; enabled?: boolean; label?: string | null; nextRunAt?: string | null }[] }
interface IssueRow { id: string; identifier?: string; title?: string; status: string; createdAt?: string; parentId?: string | null; priority?: string; updatedAt: string; assigneeUserId?: string | null; assigneeAgentId?: string | null; originKind?: string | null; labels?: ({ name?: string } | null)[] }
interface CommentRow { authorType?: string; authorAgentId?: string | null; body?: string; createdAt: string; deletedAt?: string | null }
interface WorkRecord { task: string | null; identifier: string | null; state?: string; judged?: boolean; targets?: string[]; decided_at: string | null; created_at?: string }

const HOUR_MS = 60 * MIN;
// n = the kernel's MAX_REJECTS (tier.ts): the point where a branch is parked and the kernel wakes the task's delegator
// (escalate.ts); a park nothing moved for quietMs (no new request on the task) is the Steward's.
const REJECT_LOOP = { n: 5, windowMs: 7 * DAY_MS, quietMs: 6 * HOUR_MS };
/** A record someone said yes to (the kernel's record states past approval). */
const APPROVED = ["approved", "claimed", "done", "failed", "unknown"];
// A task waiting on a judgement (task_wait `for`, kernel idle.ts) longer than this: the owner's answer, or its delegator's.
const JUDGEMENT_WAIT_MS: Record<string, number> = { owner_wait: 24 * HOUR_MS, delegator_wait: 6 * HOUR_MS };
const REPEAT_FAILS = { n: 3, spanMs: 30 * MIN, freshMs: HOUR_MS }; // same category on one task within spanMs, the newest within freshMs
const MERGE_WAIT_MS = 6 * HOUR_MS; // a task waiting on a module (a module_wait: CI, a merge queue, a finish check's hold) this long
const IDLE_MS = 120 * MIN;
const IDLE_WAKE_CAP = 3; // the kernel's idle sweep stops waking a task's agent after this many a day (kernel/src/idle.ts IDLE_CAP) // an orphaned item (nothing running, filed or waiting on it) idle this long is stuck
const FLOW_RISE = 1.5; // a stage's p75 or wait share this much over last week's (observe mode)
const FLOW_MIN_N = 10;
const STALE_FOLLOWUP_MS = 3 * DAY_MS;
const SILENT_MS = 15 * MIN; // an owner message on a chat task with no reply
const SILENT_LOOKBACK_MS = 6 * HOUR_MS; // older than this, the owner has long since seen the silence

const UNSTARTED_MS = HOUR_MS; // a delegated task assigned to an agent, still todo with no job ever, this long after it was created
const PING_PONG = { n: 5, spanMs: 12 * HOUR_MS }; // runs of one task that alternate between two agents, all started within spanMs
const CARD_WAIT_MS = DAY_MS; // a Tier 2 card waiting on the owner this long gets the Steward's one reminder a day
const MAX_LOOKUPS = 20;
/** A row of the kernel's task state (GET /v1/tasks/state, kernel/src/task-state-read.ts). */
type StateRow = { task: string; identifier: string | null; since: string; reason: string; ref?: string; holder: string | null; attention: { who: string; why: string }[]; idle_wakes: number; wait_since?: string };
/** Idle with nothing recorded to wake it, a wake nothing took, or its history pruned: the state's unexplained idle. */
const UNEXPLAINED = ["orphaned", "unknown", "history_expired"];
type IdleItem = { task: string; identifier: string | null; reason: string; blocked_on?: string };

/** Tasks waiting on a module over MERGE_WAIT_MS (a PR's checks, eval or merge queue: the queue or a red base holds them), and tasks blocked on each other in a cycle (a blocked row's `ref` is `task:<blocker id>`). */
export function mergeDeadlocks(rows: StateRow[], t: number): { key: string; reason: string }[] {
  const ident = new Map(rows.map((r) => [r.task, r.identifier ?? r.task]));
  const items: IdleItem[] = rows.map((r) => ({ task: r.task, identifier: r.identifier, reason: r.reason, ...(r.reason === "blocked" && r.ref ? { blocked_on: ident.get(r.ref.slice(5)) ?? r.ref.slice(5) } : {}) }));
  const out: { key: string; reason: string }[] = [];
  for (const r of rows.filter((x) => x.reason === "module_wait" && age(x.since, t) > MERGE_WAIT_MS)) out.push({ key: r.task, reason: `task ${r.identifier ?? r.task} has waited ${mins(age(r.since, t))} on a module's step (${slug(r.ref ?? "")}: CI, its merge queue, or a finish check such as grading), so that step is holding it` });
  const by = new Map(items.filter((x) => x.identifier).map((x) => [x.identifier!, x]));
  const seen = new Set<string>();
  for (const i of items.filter((x) => x.reason === "blocked" && x.blocked_on)) {
    const ring = [i.identifier ?? i.task];
    for (let n = by.get(i.blocked_on!), k = 0; n && k < 10; n = n.blocked_on ? by.get(n.blocked_on) : undefined, k++) {
      if (n.identifier === ring[0]) {
        const key = [...ring].sort().join("+");
        if (!seen.has(key)) { seen.add(key); out.push({ key: slug(key), reason: `tasks ${ring.join(", ")} are blocked on each other in a cycle` }); }
        break;
      }
      if (n.reason !== "blocked" || ring.includes(n.identifier ?? n.task)) break;
      ring.push(n.identifier ?? n.task);
    }
  }
  return out;
}

/** Tasks whose last runs alternate between exactly two agents: PING_PONG.n runs, started within the span, at least n - 1 changes of agent. */
export function pingPong(jobs: JobRow[], t: number): { task: string; agents: string[]; n: number }[] {
  const by = new Map<string, JobRow[]>();
  for (const j of jobs) if (j.task && j.started_at && age(j.started_at, t) < PING_PONG.spanMs) by.set(j.task, [...(by.get(j.task) ?? []), j]);
  const out: { task: string; agents: string[]; n: number }[] = [];
  for (const [task, list] of by) {
    const runs = list.sort((a, b) => a.started_at!.localeCompare(b.started_at!));
    const agents = [...new Set(runs.map((j) => j.agent))];
    if (agents.length === 2 && runs.length >= PING_PONG.n && runs.every((j, i) => i === 0 || j.agent !== runs[i - 1]!.agent)) out.push({ task, agents, n: runs.length });
  }
  return out;
}

/** Open tasks of one agent and parent with the same title (case and punctuation aside): the same work filed twice. Each group once, by its identifiers. */
export function duplicateTasks(issues: IssueRow[]): { key: string; ids: string[] }[] {
  const by = new Map<string, IssueRow[]>();
  for (const i of issues.filter((x) => !exempt(x) && x.assigneeAgentId)) {
    const title = String(i.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (title.length >= 12) by.set(`${i.assigneeAgentId}\u0000${i.parentId ?? ""}\u0000${title}`, [...(by.get(`${i.assigneeAgentId}\u0000${i.parentId ?? ""}\u0000${title}`) ?? []), i]);
  }
  return [...by.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: createHash("sha256").update(k).digest("hex").slice(0, 8), ids: v.map((i) => i.identifier ?? i.id) }));
}

/** Tasks outside monitoring, by what no agent can set: the bake-off project's identifier prefix and a routine's own run. A title or label is agent-set text and never exempts. */
export const exempt = (i: Pick<IssueRow, "identifier" | "originKind">): boolean => /^BAKA?-/i.test(i.identifier ?? "") || i.originKind === "routine_execution";

/** How a finished job ended, as a category: a timeout, or its state (failed, stalled, stopped) with a non-zero exit. */
const category = (j: JobRow) => (j.timed_out || j.state === "timeout" ? "timeout" : j.state === "failed" && j.exit ? `failed-exit-${j.exit}` : j.state);

/**
 * The newest run of three or more jobs of one task that ended the same way within 30 minutes of each other, the newest ended
 * within the last hour (a loop that is still going). Returns the task and category, once each.
 */
export function repeatedFailures(jobs: JobRow[], t: number): { task: string; category: string; n: number }[] {
  const by = new Map<string, number[]>();
  for (const j of jobs) {
    if (!j.task || ["running", "done", "cancelled"].includes(j.state) || !j.ended_at) continue;
    const k = `${j.task}\u0000${category(j)}`;
    by.set(k, [...(by.get(k) ?? []), Date.parse(j.ended_at)]);
  }
  const out: { task: string; category: string; n: number }[] = [];
  for (const [k, ends] of by) {
    const e = ends.sort((a, b) => b - a);
    if (t - e[0]! > REPEAT_FAILS.freshMs) continue;
    const n = e.filter((x) => e[0]! - x <= REPEAT_FAILS.spanMs).length;
    if (n >= REPEAT_FAILS.n) out.push({ task: k.split("\u0000")[0]!, category: k.split("\u0000")[1]!, n });
  }
  return out;
}

const SHARED_FAIL = { n: 3, windowMs: 30 * MIN, lookups: 30 }; // the same failure on n distinct tasks within windowMs is one component's outage

/** A failure's text as a signature: lowercase, ids and numbers stripped, an HTTP status (3 digits) kept. */
export const normalizeError = (e: string): string =>
  e.toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f-]{27}|\b[0-9a-f]{7,}\b|[a-z]{2,5}-\d+|\d+/g, (m) => (/^[1-5]\d\d$/.test(m) ? m : "#")).replace(/\s+/g, " ").trim().slice(0, 160);

/** Failures (one per task: its id and the name the owner reads) grouped by component and normalized error. */
export function groupFailures(hits: { component: string; error: string; id: string; name: string }[]) {
  const by = new Map<string, { component: string; error: string; tasks: Map<string, string> }>();
  for (const h of hits) {
    const error = normalizeError(h.error);
    const g = by.get(`${h.component}\u0000${error}`) ?? { component: h.component, error, tasks: new Map<string, string>() };
    g.tasks.set(h.id, h.name);
    by.set(`${h.component}\u0000${error}`, g);
  }
  return [...by.values()];
}

/** Records the AI reviewer judged and rejected, grouped by (task, branch or PR): the ones at the kernel's retry bound within the window. */
export function rejectLoops(records: WorkRecord[], t: number): { task: string; identifier: string | null; target: string; n: number; last: string }[] {
  const by = new Map<string, { task: string; identifier: string | null; target: string; n: number; last: string }>();
  for (const r of records) {
    if (!r.judged || !r.task || !r.decided_at || age(r.decided_at, t) > REJECT_LOOP.windowMs) continue;
    for (const target of r.targets?.length ? r.targets : [r.task]) {
      const k = `${r.task}\u0000${target}`;
      const was = by.get(k);
      by.set(k, { task: r.task, identifier: r.identifier, target, n: (was?.n ?? 0) + 1, last: was && was.last > r.decided_at ? was.last : r.decided_at });
    }
  }
  // Parked quietMs ago with no approved request on that target since. A request refused as parked, refused by code, still
  // in review or aimed elsewhere is no progress (the task's comments are read by the check: a re-brief, the owner's word).
  const approved = (x: { task: string; target: string; last: string }) => records.some((r) => r.task === x.task && (r.targets?.length ? r.targets : [r.task]).includes(x.target) && String(r.created_at ?? "") > x.last && APPROVED.includes(String(r.state)));
  return [...by.values()].filter((x) => x.n >= REJECT_LOOP.n && age(x.last, t) > REJECT_LOOP.quietMs && !approved(x));
}

/** The owner's own typed words on a chat task (not a relayed notice, the kernel's, or deleted). */
const ownerWords = (c: CommentRow) => c.authorType === "user" && !c.deletedAt && !/<!-- aidenhq-/.test(String(c.body));

/**
 * Owner-assigned todos nobody has touched in 3 days, ranked (priority, then age), for the morning brief. A task the owner
 * snoozed (the board parks it in Backlog, or the steward's own record from fleet_followup_snooze) is not listed until then.
 */
export function rankFollowups(issues: IssueRow[], t: number, top = 10, snoozed: Record<string, string> = {}) {
  const weight: Record<string, number> = { critical: 4, urgent: 4, high: 3, medium: 2, low: 1 };
  return issues
    .filter((i) => i.status === "todo" && i.assigneeUserId && !i.assigneeAgentId && !exempt(i) && age(i.updatedAt, t) >= STALE_FOLLOWUP_MS && !(Date.parse(snoozed[i.identifier ?? i.id] ?? "") > t))
    .sort((a, b) => (weight[b.priority ?? ""] ?? 0) - (weight[a.priority ?? ""] ?? 0) || Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    .slice(0, top)
    .map((i) => ({ task: i.identifier ?? i.id, title: String(i.title ?? "").slice(0, 120), priority: i.priority ?? "medium", idle_days: Math.floor(age(i.updatedAt, t) / DAY_MS), options: ["snooze 7d", "close", "delegate"] }));
}


type FlowStage = { name: string; n: number; work_p75?: number; wait_p75?: number; work_p50?: number; wait_p50?: number; waits?: Record<string, number> };
const p75 = (s: FlowStage) => (s.work_p75 ?? 0) + (s.wait_p75 ?? 0);
const waitShare = (s: FlowStage) => { const w = Object.values(s.waits ?? {}).reduce((a, b) => a + b, 0); const work = (s.work_p50 ?? 0) * s.n; return w + work > 0 ? w / (w + work) : 0; };
/** Stages whose p75 or wait share rose more than 50% over the week before, with n >= 10 in both weeks: what the `flow` group would file (observe mode: logged, never filed). */
export function slowerStages(now: FlowStage[], before: FlowStage[]): string[] {
  const prev = new Map(before.map((s) => [s.name, s]));
  return now.filter((s) => {
    const b = prev.get(s.name);
    return b && s.n >= FLOW_MIN_N && b.n >= FLOW_MIN_N && ((p75(b) > 0 && p75(s) > FLOW_RISE * p75(b)) || (waitShare(b) > 0 && waitShare(s) > FLOW_RISE * waitShare(b)));
  }).map((s) => s.name);
}

/** The owner's alert list, as checks. `pause` pauses a routine (kernel role kernel.routines). `apps` reads apps-mcp (a module holding apps.read); `alerts` is Alertmanager's list. */
export function checks(d: { kernel: KernelClient; kv: Kv; pause: (routine: string) => Promise<void>; apps: <T>(path: string) => Promise<T>; alerts: () => Promise<Incident[]>; openKeys: () => string[]; notify?: (text: string, key: string) => Promise<void>; gradeFailures: () => Promise<{ task: string; at: string; reason: string }[]>; now?: () => number; log?: (msg: string, f?: Record<string, unknown>) => void }): Record<string, Check> {
  const now = d.now ?? (() => Date.now());
  let appsOkAt = now(); // apps-mcp's last answer: a restart (an apply) is not an outage
  const companies = async () => (await d.kernel.read("/api/companies")) as Company[];
  /** Every open task's state, as the kernel computes it (one snapshot). */
  const openStates = async () => ((await d.kernel.call("GET", "/v1/tasks/state?open=1")).tasks ?? []) as StateRow[];
  const agents = async () => (await Promise.all((await companies()).map(async (c) => (await d.kernel.read(`/api/companies/${c.id}/agents`)) as AgentRow[]))).flat().filter((a) => a.status !== "terminated");
  /** One check run's task reads, cached: a task's row, or undefined when it can't be read (a failed lookup never hides an incident). A failure is not kept. */
  const taskReads = () => {
    const seen = new Map<string, IssueRow>();
    return async (id: string) => {
      let i = seen.get(id);
      if (!i) { i = (await (d.kernel.read(`/api/issues/${encodeURIComponent(id)}`) as Promise<IssueRow>).catch(() => undefined)) ?? undefined; if (i) seen.set(id, i); }
      return i;
    };
  };
  /** A task's id as the owner reads it (the raw id when it can't be read), or undefined when it is exempt. Lookups last one check run. */
  const lookup = () => {
    const read = taskReads();
    return async (id: string) => {
      const i = await read(id);
      return i && exempt(i) ? undefined : i?.identifier ?? id;
    };
  };
  const routines = async () => (await Promise.all((await companies()).map(async (c) => (await d.kernel.read(`/api/companies/${c.id}/routines`)) as RoutineRow[]))).flat();
  let jobCache = new Map<string, JobRow[]>(); // one check run's job reads, shared by `component` and `run`
  const jobsOf = async (agent: string) => {
    let jobs = jobCache.get(agent);
    if (!jobs) jobCache.set(agent, (jobs = ((await d.kernel.call("GET", `/v1/work?agent=${encodeURIComponent(agent)}`)).jobs ?? []) as JobRow[]));
    return jobs;
  };
  /** Tasks a component incident explains this run: their own incidents are not raised anew (one already open stays until it recovers). */
  let explained = new Set<string>();
  // An owner notice per incident, recorded as told only once it went out: a failed send is tried again on the next check, and
  // forgotten when the incident is gone, so its next occurrence is told again.
  const told = (): string[] => JSON.parse(d.kv.get("owner_told") ?? "[]");
  const announce = async (key: string, text: string) => {
    if (told().includes(key)) return;
    try {
      await d.notify?.(text, key);
    } catch {
      return;
    }
    d.kv.set("owner_told", JSON.stringify([...told(), key]));
  };
  const forgetTold = (prefix: string, keep: string[]) => {
    const now = told(), left = now.filter((k) => !k.startsWith(prefix) || keep.includes(k));
    if (left.length !== now.length) d.kv.set("owner_told", JSON.stringify(left));
  };
  const suppressed = (task: string, key: string) => explained.has(task) && !d.openKeys().includes(key);
  return {
    // The same failure on several tasks is one component down (the grader, the job runner), whatever the per-task checks below see.
    // Runs first: it fills `explained` for them. The grader's cause is read from the grading service's record, a job's from its ledger line (both written by code, never by an agent).
    async component() {
      const t = now();
      jobCache = new Map();
      explained = new Set();
      const hits: { component: string; error: string; id: string; name: string }[] = [];
      // The grader's failed passes, from the grading service's own record (never a task comment, which anyone can write).
      const graderRead = await d.gradeFailures().catch(() => undefined);
      for (const f of (graderRead ?? []).filter((f) => age(f.at, t) < SHARED_FAIL.windowMs)) {
        const name = await lookup()(f.task);
        if (name) hits.push({ component: "grader", error: f.reason, id: f.task, name });
      }
      let looked = 0;
      for (const a of await agents()) {
        for (const j of await jobsOf(a.id)) {
          if (!j.task || j.state !== "failed" || age(j.ended_at, t) > SHARED_FAIL.windowMs || looked++ >= SHARED_FAIL.lookups) continue;
          const final = ((await d.kernel.call("GET", `/v1/work?job=${encodeURIComponent(j.id)}`).catch(() => undefined)) as { final?: string | null } | undefined)?.final ?? "";
          const error = /^The job failed: (.+)/s.exec(final)?.[1];
          const name = error ? await lookup()(j.task) : undefined;
          if (error && name) hits.push({ component: "job runner", error, id: j.task, name });
        }
      }
      const open = d.openKeys();
      // The grading service couldn't be asked: its open incidents stay open.
      const out: Incident[] = graderRead ? [] : open.filter((k) => k.startsWith("component:grader:")).map((k) => ({ key: k.slice("component:".length), reason: "" }));
      for (const g of groupFailures(hits)) {
        const key = `${g.component.replace(/\W+/g, "-")}:${createHash("sha256").update(g.error).digest("hex").slice(0, 8)}`;
        const isOpen = open.includes(`component:${key}`);
        if (g.tasks.size < (isOpen ? 1 : SHARED_FAIL.n)) continue; // once open, one fresh failure keeps it open
        for (const id of g.tasks.keys()) explained.add(id);
        const names = [...g.tasks.values()].slice(0, 10).map(slug).join(", ");
        out.push({ key, critical: true, reason: `${g.component} is failing the same way on ${g.tasks.size} tasks within 30 minutes (${names}); the error as the component reported it:\n${fence(g.error, "component.error")}` });
        await announce(`component:${key}`, `A component is down: the ${g.component} has failed the same way on ${SHARED_FAIL.n} or more tasks. The Fleet Steward is on it.`);
      }
      forgetTold("component:", out.map((i) => `component:${i.key}`));
      return out;
    },
    // Stuck, failing and silent runs, from the kernel's job ledger.
    async run() {
      const t = now();
      const out: Incident[] = [];
      const live = lookup();
      for (const a of await agents()) {
        const mine = await jobsOf(a.id);
        const timeout = Number(a.adapterConfig?.timeoutSec) * 1000;
        const limit = timeout > 0 ? 2 * timeout : STUCK_DEFAULT_MS;
        const stuck = mine.find((j) => j.state === "running" && age(j.started_at, t) > limit);
        if (stuck) out.push({ key: `${a.id}:stuck`, reason: `${a.name}: a run has been running ${mins(age(stuck.started_at, t))} (limit ${mins(limit)})` });
        const finished = mine.filter((j) => !["running", "cancelled"].includes(j.state)).slice(0, FAILS);
        if (finished.length === FAILS && finished.every((j) => j.state !== "done")) out.push({ key: `${a.id}:failing`, reason: `${a.name}: its last ${FAILS} runs failed (${finished.map((j) => j.state).join(", ")})` });
        // The same ending three times on one task inside half an hour is a loop (what the last-three check can't tell from three tasks).
        for (const r of repeatedFailures(mine, t)) {
          const task = suppressed(r.task, `run:${a.id}:repeat:${slug(await live(r.task))}`) ? undefined : await live(r.task);
          if (task) out.push({ key: `${a.id}:repeat:${slug(task)}`, reason: `${a.name}: ${r.n} runs of task ${task} ended "${r.category}" within 30 minutes` });
        }
        // One heuristic: a job that finished with no steps and no final words, 3+ times in a day. Diagnostic only.
        const silent = mine.filter((j) => j.state === "done" && !j.steps && !j.has_final && age(j.ended_at, t) < DAY_MS).length;
        if (silent >= SILENT_RUNS) out.push({ key: `${a.id}:silent`, reason: `agent ${a.name}: ${silent} runs in 24h ended with no steps and no output` });
      }
      return out;
    },
    // A routine whose last 3 jobs all hard-failed is paused (the owner is told; Aiden resumes it once it's fixed). Not while the
    // failures are fleet-wide: a credits (402) or key (401) refusal, or no agent finishing a job at all, is not the routine's fault.
    async routine() {
      const t = now();
      const rows = await routines();
      const jobs = (await Promise.all((await agents()).map((a) => jobsOf(a.id)))).flat();
      const recent = jobs.filter((j) => !["running", "admitted", "cancelled"].includes(j.state) && age(j.ended_at, t) < 60 * MIN);
      const failed = recent.filter((j) => HARD_FAIL.has(j.state));
      let fleetWide = failed.length > 0 && !recent.some((j) => j.state === "done") && new Set(failed.map((j) => j.agent)).size >= 2;
      for (const j of failed.sort((a, b) => b.ended_at!.localeCompare(a.ended_at!)).slice(0, 5)) {
        if (fleetWide) break;
        const final = ((await d.kernel.call("GET", `/v1/work?job=${encodeURIComponent(j.id)}`).catch(() => undefined)) as { final?: string | null } | undefined)?.final ?? "";
        fleetWide = /\b(401|402)\b|insufficient credits|invalid api key/i.test(final);
      }
      const since: Record<string, string> = JSON.parse(d.kv.get("routine_paused_at") ?? "{}");
      const out: Incident[] = [];
      for (const { routine, failures } of failingRoutines(jobs, since)) {
        const row = rows.find((r) => r.id === routine);
        if (!row || row.status === "archived") continue;
        // Paused by hand: its old failures must not re-pause it on resume.
        if (row.status === "paused" && !since[routine]) { since[routine] = new Date(t).toISOString(); d.kv.set("routine_paused_at", JSON.stringify(since)); continue; }
        if (row.status === "active" && !fleetWide) {
          await d.pause(routine);
          since[routine] = new Date(t).toISOString();
          d.kv.set("routine_paused_at", JSON.stringify(since));
          await d.notify?.(`Routine paused: ${plain(row.title)} failed ${failures} runs in a row. Ask Aiden to resume it once it's fixed.`, `routine-paused:${routine}`).catch(() => {});
        }
        out.push({ key: routine, reason: `routine ${plain(row.title)}: its last ${failures} runs failed${row.status === "paused" ? " (paused until the owner resumes it)" : ""}` });
      }
      // Paused by this detector and still paused: the flag stays open until the owner resumes it (a resume clears it).
      for (const id of Object.keys(since)) {
        const row = rows.find((r) => r.id === id);
        if (row?.status === "paused" && !out.some((i) => i.key === id)) out.push({ key: id, reason: `routine ${plain(row.title)}: paused after repeated failures, until the owner resumes it` });
      }
      return out;
    },
    // An active routine whose next cron fire is overdue by 15 minutes and no run started: Paperclip's scheduler has stopped.
    async missed() {
      return missedFires(await routines(), now());
    },
    // Queued wakes while no job starts: the owner hears at once, with no agent job needed to file or read anything.
    async dispatch() {
      const t = now();
      const w = (await d.kernel.call("GET", "/v1/work")) as { waiting?: { count: number; oldest_at: string | null; oldest_cause: string | null }; last_started_at?: string | null };
      if (!w.waiting?.count || age(w.waiting.oldest_at, t) <= DOWN_MS || age(w.last_started_at, t) <= DOWN_MS) return (forgetTold("dispatch-stalled", []), []);
      const text = `No agent work has started for ${mins(Math.min(age(w.last_started_at, t), age(w.waiting.oldest_at, t)))} while ${w.waiting.count} wake${w.waiting.count === 1 ? "" : "s"} wait (oldest: ${slug(w.waiting.oldest_cause)}).`;
      await announce("dispatch-stalled", text);
      return [{ key: "stalled", critical: true, reason: text }];
    },
    // A task held for grading (label grading, in review) for over a day: the grader's verdict is overdue.
    async grade() {
      const t = now();
      const out: Incident[] = [];
      for (const c of await companies()) {
        const label = ((await d.kernel.read(`/api/companies/${c.id}/labels`)) as { id: string; name: string }[]).find((l) => l.name === "grading");
        if (!label) continue;
        const held = (await d.kernel.read(`/api/companies/${c.id}/issues?labelId=${label.id}&status=in_review&limit=100&excludeRoutineExecutions=true`)) as IssueRow[];
        for (const i of held.filter((x) => age(x.updatedAt, t) > DAY_MS && !suppressed(x.id, `grade:${x.id}`))) out.push({ key: i.id, reason: `task ${i.identifier ?? i.id} held for grading for ${mins(age(i.updatedAt, t))}` });
      }
      return out;
    },
    // Orphaned work: the kernel's task state (nothing running, filed or waiting on the task: orphaned, unknown or history
    // expired), over 2 hours. The one stuck-work rule.
    // A task whose holder the kernel's idle sweep already woke 3 times in a day (kernel idle.ts) is critical at once: waking
    // it again won't move it, so Fleet Ops looks at it.
    async stuck() {
      const t = now();
      const out: Incident[] = [];
      const items = await openStates();
      const capped = (x: { idle_wakes?: number }) => (x.idle_wakes ?? 0) >= IDLE_WAKE_CAP;
      for (const i of items.filter((x) => UNEXPLAINED.includes(x.reason) && (capped(x) || age(x.since, t) > IDLE_MS) && !exempt({ identifier: x.identifier, originKind: null }) && !suppressed(x.task, `stuck:${x.task}`))) {
        // Owned by nobody, or by the owner (a person, not an agent's work): not someone's stuck work (the inbox, review-log and
        // issues tasks are idle by design; owner-assigned todos are the stale follow-up check's). A backlog task is `backlog`, never idle.
        if (!i.holder || i.holder === "owner") continue;
        if (capped(i)) out.push({ key: `${i.task}:idle-capped`, critical: true, reason: `task ${i.identifier ?? i.task} is still idle after ${i.idle_wakes} idle wakes of its agent today (nothing running, filed or waiting on it, ${mins(age(i.since, t))}): waking it again won't move it` });
        else out.push({ key: i.task, reason: `task ${i.identifier ?? i.task} idle for ${mins(age(i.since, t))} with nothing running, filed or waiting on it (${slug(i.reason)})` });
      }
      return out;
    },
    // Observe mode (docs/design/flow.md): a stage that got slower week over week is logged as what it would file; nothing is filed until promoted.
    async flow() {
      const t = now();
      const q = (a: number, b: number) => `/v1/flow?since=${encodeURIComponent(new Date(t - a * DAY_MS).toISOString())}&to=${encodeURIComponent(new Date(t - b * DAY_MS).toISOString())}`;
      const [cur, prev] = (await Promise.all([d.kernel.call("GET", q(7, 0)), d.kernel.call("GET", q(14, 7))])).map((r) => (r.stages ?? []) as FlowStage[]);
      for (const name of slowerStages(cur!, prev!)) d.log?.("flow.would_file", { stage: name });
      return [];
    },
    // A parked branch (the kernel parks it at MAX_REJECTS, 5 rejections, and wakes the delegator) that nothing moved for 6 hours.
    async loop() {
      const t = now();
      const r = (await d.kernel.call("GET", `/v1/work?since=${encodeURIComponent(new Date(t - REJECT_LOOP.windowMs).toISOString())}`)) as { records?: WorkRecord[] };
      const out: Incident[] = [];
      const read = taskReads();
      for (const l of rejectLoops(r.records ?? [], t)) {
        const task = await read(l.task);
        if (task && (exempt(task) || ["done", "cancelled"].includes(task.status))) continue;
        // Moved on by a person or its delegator: a comment after the park from the owner (their own words) or another agent
        // (a re-brief ends with one). The task's own agent and the kernel's notices don't count. Unreadable: still raised.
        const comments = ((await d.kernel.read(`/api/issues/${encodeURIComponent(l.task)}/comments?order=desc&limit=50`).catch(() => [])) as CommentRow[]) ?? [];
        if (comments.some((c) => !c.deletedAt && c.createdAt > l.last && (ownerWords(c) || (c.authorType === "agent" && c.authorAgentId !== task?.assigneeAgentId)))) continue;
        out.push({ key: `${l.task}:${slug(l.target)}`, reason: `task ${task?.identifier ?? l.task}: the AI reviewer rejected ${slug(l.target)} ${l.n} times (parked at ${REJECT_LOOP.n}) and nothing has moved for ${mins(age(l.last, t))}` });
      }
      return out;
    },
    // A task waiting on a judgement past its limit (a day on the owner, 6 hours on its delegator): the ask went unanswered.
    async judgement() {
      const t = now();
      // By attention, not the representative reason: a task also running, queued or on a card still waits on the answer.
      const out: Incident[] = [];
      for (const i of await openStates()) {
        const why = i.attention.map((a) => a.why).find((w) => JUDGEMENT_WAIT_MS[w] !== undefined);
        const since = i.wait_since ?? i.since;
        if (why && age(since, t) > JUDGEMENT_WAIT_MS[why]! && !exempt({ identifier: i.identifier, originKind: null })) out.push({ key: i.task, reason: `task ${i.identifier ?? i.task} has waited ${mins(age(since, t))} on its ${why === "owner_wait" ? "owner's" : "delegator's"} answer` });
      }
      return out;
    },
    // A delegated task (a sub-task assigned to an agent) still todo an hour after it was made, with no job ever on it: the delegation never started.
    async unstarted() {
      const t = now();
      const out: Incident[] = [];
      let looked = 0;
      for (const c of await companies()) {
        const todo = (await d.kernel.read(`/api/companies/${c.id}/issues?status=todo&limit=200&excludeRoutineExecutions=true`)) as IssueRow[];
        for (const i of todo.filter((x) => x.parentId && x.assigneeAgentId && !exempt(x) && age(x.createdAt, t) > UNSTARTED_MS && looked < MAX_LOOKUPS)) {
          looked++;
          const w = (await d.kernel.call("GET", `/v1/work?task=${encodeURIComponent(i.id)}`).catch(() => undefined)) as { busy?: boolean; jobs?: unknown[] } | undefined;
          if (w && !w.busy && !w.jobs?.length) out.push({ key: i.id, reason: `delegated task ${i.identifier ?? i.id} has had no run ${mins(age(i.createdAt, t))} after it was assigned` });
        }
      }
      return out;
    },
    // Merge waits over 6 hours, and tasks blocked on each other: the queue or a red base holds them.
    async deadlock() {
      return mergeDeadlocks((await openStates()).filter((i) => !exempt({ identifier: i.identifier, originKind: null })), now());
    },
    // One task whose runs alternate between two agents five times in 12 hours.
    async pingpong() {
      const t = now();
      const out: Incident[] = [];
      const live = lookup();
      for (const a of await agents()) {
        for (const p of pingPong(await jobsOf(a.id), t)) {
          const task = await live(p.task);
          if (task && !out.some((o) => o.key === slug(task))) out.push({ key: slug(task), reason: `task ${task}: ${p.n} runs in 12 hours alternated between two agents (${p.agents.map(slug).join(", ")})` });
        }
      }
      return out;
    },
    // The same work filed twice: open tasks of one agent and parent with one title.
    async duplicate() {
      const open = (await Promise.all((await companies()).map(async (c) => (await d.kernel.read(`/api/companies/${c.id}/issues?status=todo,in_progress,in_review,blocked&limit=200&excludeRoutineExecutions=true`)) as IssueRow[]))).flat();
      return duplicateTasks(open).map((g) => ({ key: g.key, reason: `tasks ${g.ids.map(slug).join(", ")} are open for the same agent with the same title` }));
    },
    // A Tier 2 card on the owner for over 24 hours: the Steward sends the owner one reminder per card per 24 hours (fleet-check).
    async card() {
      const t = now();
      const r = (await d.kernel.call("GET", `/v1/work?since=${encodeURIComponent(new Date(t - 7 * DAY_MS).toISOString())}`)) as { records?: (WorkRecord & { id?: string; kind?: string; tier?: number })[] };
      return (r.records ?? []).filter((x) => x.state === "owner" && x.tier === 2 && x.id && age(x.created_at, t) > CARD_WAIT_MS).map((x) => ({ key: slug(x.id), reason: `Tier 2 card ${slug(x.kind)} on task ${slug(x.identifier ?? x.task)} has waited ${mins(age(x.created_at, t))} on the owner` }));
    },
    // An owner message on a chat task with no reply: the front door is silent.
    async front() {
      const t = now();
      const out: Incident[] = [];
      for (const c of await companies()) {
        const label = ((await d.kernel.read(`/api/companies/${c.id}/labels`)) as { id: string; name: string }[]).find((l) => l.name === "chat");
        if (!label) continue;
        const chats = ((await d.kernel.read(`/api/companies/${c.id}/issues?labelId=${label.id}&limit=100`)) as IssueRow[]).filter((i) => age(i.updatedAt, t) < SILENT_LOOKBACK_MS).slice(0, 20);
        for (const i of chats) {
          const comments = (((await d.kernel.read(`/api/issues/${i.id}/comments?order=desc&limit=20`).catch(() => [])) as CommentRow[]) ?? []).filter((x) => !x.deletedAt);
          const last = comments.find(ownerWords); // newest first
          // Any later comment, an agent's or a relayed notice, is an answer (a deferral note counts).
          if (last && age(last.createdAt, t) > SILENT_MS && age(last.createdAt, t) < SILENT_LOOKBACK_MS && !comments.some((x) => x.createdAt > last.createdAt && !ownerWords(x))) out.push({ key: i.id, critical: true, reason: `an owner message on chat ${i.identifier ?? i.id} has had no reply for ${mins(age(last.createdAt, t))}` });
        }
      }
      return out;
    },
    async app() {
      const t = now();
      // Unreachable: throws, so this group is "not checked" (its open incidents stay open); `service` reports the outage.
      const apps = await d.apps<{ name: string; incident?: { opened_at: string; kind: string; detail: string } }[]>("/internal/status");
      appsOkAt = t;
      return apps.filter((a) => a.incident && age(a.incident.opened_at, t) > DOWN_MS).map((a) => ({ key: a.name, critical: true, reason: `app ${a.name} unhealthy for ${mins(age(a.incident!.opened_at, t))} (${a.incident!.kind}); the app-incident loop hasn't fixed it` }));
    },
    // Apps' quality checks: findings for the app's owner, separate from the `app` availability group.
    async quality() {
      const r = await d.apps<{ apps?: QualityRow[] }>("/internal/quality");
      if (!r.apps) return undefined;
      return qualityFindings(r.apps, d.openKeys());
    },
    async service() {
      const down = now() - appsOkAt;
      return down > DOWN_MS ? [{ key: "apps-mcp", critical: true, reason: `apps-mcp (the apps platform) not answering for ${mins(down)}` }] : [];
    },
    async source() {
      const r = await d.apps<{ sources?: SourceRow[] }>("/internal/sources");
      if (!r.sources) return undefined; // the warehouse isn't set up
      // Which source and since when only: the agent reads the error itself with warehouse_query.
      return staleSources(r.sources, now());
    },
    // Monitoring alerts (alerts.ts): one incident per firing alert, recovered when it resolves.
    alert: d.alerts,
    async pr() {
      const r = await d.apps<{ prs?: PrRow[] }>("/internal/open-prs");
      if (!r.prs) return undefined; // no warehouse or no agents org
      return stalePrs(r.prs, now());
    },
  };
}

const SNOOZES = "followup_snoozes";
const MAX_SNOOZE_DAYS = 30;
/** The owner's snoozes (task identifier -> ISO date) in the steward's own record. */
const snoozesOf = (kv: Pick<Kv, "get">): Record<string, string> => { try { return JSON.parse(kv.get(SNOOZES) ?? "{}"); } catch { return {}; } };
/** Snooze a follow-up (the chief of staff's tool, on the owner's reply): at most 30 days. */
export function snoozeFollowup(kv: Kv, task: string, days: number, now = Date.now()) {
  const id = String(task).trim().slice(0, 40);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("task must be a task identifier");
  const until = new Date(now + Math.min(MAX_SNOOZE_DAYS, Math.max(1, Math.floor(Number(days) || 7))) * DAY_MS).toISOString();
  const s = Object.fromEntries(Object.entries(snoozesOf(kv)).filter(([, v]) => Date.parse(v) > now));
  kv.set(SNOOZES, JSON.stringify({ ...s, [id]: until }));
  return { task: id, snoozed_until: until };
}

/** The owner's stale follow-ups, ranked, for the morning brief (`fleet_stale_followups`); a snoozed one waits out its date. */
export async function staleFollowups(d: { kernel: KernelClient; kv: Pick<Kv, "get">; now?: () => number }) {
  const t = (d.now ?? (() => Date.now()))();
  const companies = (await d.kernel.read("/api/companies")) as Company[];
  const todo = (await Promise.all(companies.map(async (c) => (await d.kernel.read(`/api/companies/${c.id}/issues?status=todo&limit=200&excludeRoutineExecutions=true`)) as IssueRow[]))).flat();
  return { followups: rankFollowups(todo, t, 10, snoozesOf(d.kv)) };
}
