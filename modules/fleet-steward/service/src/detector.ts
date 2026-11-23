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
/** Sources whose scope is one scanned target and whose error column carries that target's finding ("image not inventoried"), not a failed pass. */
const PER_TARGET_ERRORS = new Set(["security"]);
type FailingScope = { source: string; scope: string; error: string; since: string | null };
/**
 * Scopes still running whose every pass for a day has failed: a source with one working scope looks fine to staleSources
 * (its last good pass is fresh), so a scope failing alone, like one org's boards, would go unnoticed for good. The error is
 * the ingest's own text, which can quote GitHub or a site, so it reaches the Steward only fenced.
 */
export function failingScopes(rows: FailingScope[]): { key: string; reason: string }[] {
  return rows.filter((x) => !PER_TARGET_ERRORS.has(x.source)).map((x) => ({ key: `${x.source}:${x.scope}`, reason: `source src_${x.source}, scope ${x.scope}: every pass has failed since ${x.since ? `its last good pass at ${x.since}` : "it started"}; the latest error:\n${fence(x.error, "ingest.error")}` }));
}

type SpendTop = { day: string; name: string; cost_usd: number; calls: number };
type SpendRead = { usage?: { day: string; cost_usd: number; priced: number }[]; spend_components?: SpendTop[]; spend_subjects?: SpendTop[] };
const SPEND_FACTOR = 2; // today's billed spend over this many times the prior days' daily average
const SPEND_BASELINE_DAYS = 3; // priced days (of the prior 7) a baseline needs: a new install has none and stays silent
const SPEND_FLOOR_USD = 10; // below this a doubling is noise, not spend
/**
 * Billed spend today (UTC) above 2x the average of the prior 7 complete days that had priced spend, once at least 3 such
 * days exist. The incident names the day's costliest components and subjects; subjects can carry a caller's text (a check's
 * name), so they reach the Steward fenced.
 */
export function spendSpike(r: SpendRead, t: number): { key: string; reason: string }[] {
  const today = new Date(t).toISOString().slice(0, 10);
  const first = new Date(t - 7 * DAY_MS).toISOString().slice(0, 10);
  const byDay = new Map<string, number>();
  for (const u of r.usage ?? []) if (u.priced > 0) byDay.set(u.day, (byDay.get(u.day) ?? 0) + (u.cost_usd ?? 0));
  const prior = [...byDay].filter(([day, usd]) => day >= first && day < today && usd > 0).map(([, usd]) => usd);
  const spent = byDay.get(today) ?? 0;
  if (prior.length < SPEND_BASELINE_DAYS) return [];
  const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (spent < SPEND_FLOOR_USD || spent <= SPEND_FACTOR * avg) return [];
  const list = (rows: SpendTop[] | undefined) => (rows ?? []).filter((x) => x.day === today).map((x) => `${x.name} $${x.cost_usd.toFixed(2)} (${x.calls} calls)`).join("; ") || "none recorded";
  return [{ key: today, reason: `billed spend today is $${spent.toFixed(2)}, ${(spent / avg).toFixed(1)}x the $${avg.toFixed(2)} daily average of the prior ${prior.length} days.\nTop components: ${list(r.spend_components)}.\nTop subjects:\n${fence(list(r.spend_subjects), "spend.subjects")}` }];
}

/** A source scope whose last two completed passes each fetched fewer records than the source reported. */
type ShortScope = { source: string; scope: string; total: number; fetched: number };
export function shortScopes(rows: ShortScope[]): { key: string; reason: string }[] {
  return rows.map((x) => ({ key: `${x.source}:${x.scope}:incomplete`, reason: `source src_${x.source}, scope ${x.scope}: its last two completed passes fetched fewer records than the source reported (${x.fetched} of ${x.total} in the latest): records are being missed (paging, a filter or a cap in the writer)` }));
}

const PR_OPEN_MS = 60 * MIN; // a pull request the fleet published open this long without merging (the warehouse lags GitHub by up to 15 minutes)

type PrRow = { repo: string; number: number; opened_at: string; draft: boolean; ready_at?: string | null; preview_url?: string };
/** The open PRs the fleet published (the kernel's records of them, in any repo) nobody has merged within the allowance; merged or closed ones are no longer in the rows. A draft
 * cannot merge until someone marks it ready, so it is not overdue; the allowance runs from when it was marked ready (`ready_at`, where known), else from `opened_at`. */
export function stalePrs(rows: PrRow[], t: number): { key: string; reason: string }[] {
  return rows
    .filter((x) => !x.draft && age(x.ready_at ?? x.opened_at, t) > PR_OPEN_MS)
    // A running preview's link (apps-mcp: the PR's, or this server's change request's) rides on the row.
    .map((x) => ({ key: `${x.repo}#${x.number}`, reason: `${x.repo}#${x.number} open ${mins(age(x.opened_at, t))}${x.ready_at ? ` (ready ${mins(age(x.ready_at, t))} ago)` : ""} without merging${x.preview_url && /^https?:\/\//.test(x.preview_url) ? ` (preview: ${x.preview_url})` : ""}` }));
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

/** A routine's title for a line the chief of staff reads: its own words, minus anything but letters, digits and light punctuation, at most 60. */
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
/** Paperclip's agent lifecycle transitions: each normally ends within seconds (its stop proof). */
const TRANSITIONS = new Set(["preparing", "verifying", "pausing", "resuming", "terminating", "cleaning_up"]);
const STUCK_TRANSITION_MS = 15 * MIN;
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
export interface Incident { key: string; reason: string; critical?: boolean; /** The task the flag is about, when its key names a card rather than a task. */ task?: string }
/** `told`: the owner was told the Steward is unreachable (unfiled a day); `jammed`: the chief of staff was told the gate stayed jammed (open two hours). Each once, apart. */
interface Open { reason: string; at: string; fired: boolean; told?: boolean; jammed?: boolean; critical?: boolean; task?: string; /** When the gate's activity lookup first failed while the gate was past its two hours. */ lookup_failed_at?: string; /** The newest activity observed for this flag, kept so a later lookup that finds none, or fails, doesn't rewind the clock. */ last_activity?: string }
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
 * of the last filing only a new critical incident files; the rest wait (still unfiled) for a later tick. `jam`: a task for the
 * chief of staff naming the jammed gates' keys (the Steward didn't clear them), never the owner.
 */
export async function tick(kv: Kv, checks: Record<string, Check>, file: (body: { incidents: { key: string }[]; recovered: { key: string }[] }) => Promise<boolean>, notify: (text: string) => Promise<void>, now = new Date(), quietMs = 0, stewardOn = true, acting?: (task: string) => Promise<string | undefined>, jam?: (keys: string[]) => Promise<void>): Promise<void> {
  const s = detectorState(kv);
  const at = now.toISOString();
  // A retired check group (one this detector no longer runs, e.g. the old Tier 2 `card` reminders) leaves nothing open behind it.
  const groups = Object.keys(checks);
  for (const key of Object.keys(s.open)) if (!groups.some((g) => key.startsWith(`${g}:`))) delete s.open[key];
  for (const [group, check] of Object.entries(checks)) {
    const found = await check().catch(() => undefined);
    if (!found) continue;
    const tripped = new Map(found.map((i) => [`${group}:${i.key}`, i]));
    for (const [key, i] of tripped) {
      const open = s.open[key];
      if (!open) s.open[key] = { reason: i.reason, at, fired: false, ...(i.critical ? { critical: true } : {}), ...(i.task ? { task: i.task } : {}) };
      else if (i.task) open.task = i.task;
    }
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
  // A jammed gate (a PR on code review, an approval card with the AI reviewer, an answered wait that never resumed) stays closed for
  // everyone while it is open, so two hours after it was raised the chief of staff gets a task naming it (the Steward didn't clear
  // it), whether or not a check task carried it. The owner is not told: an agent settles it.
  // A gate someone is acting on is not jammed: its two hours restart from the last job or agent comment (`acting`).
  const jammed: [string, Open][] = [];
  if (stewardOn) for (const [key, o] of Object.entries(s.open)) {
    if (!JAMMED.test(key) || o.jammed || Date.parse(at) - Date.parse(o.at) <= GATE_ESCALATE_MS) continue;
    // A review-stall's key is a card id; its task came with the flag. The other keys name their task.
    const task = o.task ?? /^(?:gate|unresumed):(.+)$/.exec(key)?.[1];
    // The newest activity seen so far for this flag, kept across ticks: a job that ran and ended between ticks, or a lookup that
    // finds nothing now, must not rewind the clock to the flag's own age.
    let last = o.last_activity;
    if (task && acting) {
      try {
        const found = await acting(task);
        o.lookup_failed_at = undefined;
        // Only ever forward: a lookup that comes back with an older comment (or an ended job's start after a newer one's end) must
        // not move the clock backwards past activity already seen.
        if (found && (!last || Date.parse(found) > Date.parse(last))) o.last_activity = last = found;
      } catch {
        // An unreadable task is not inactivity: one transient failure must not file a false jam line, so the flag waits one more
        // window before the clock alone decides. A lookup that keeps failing past that window still escalates, so a persistent
        // failure can't suppress it either.
        o.lookup_failed_at ??= at;
        if (Date.parse(at) - Date.parse(o.lookup_failed_at) < GATE_LOOKUP_MS) continue;
      }
    } else o.lookup_failed_at = undefined;
    if (Date.parse(at) - Math.max(Date.parse(o.at), Date.parse(last ?? "") || 0) > GATE_ESCALATE_MS) jammed.push([key, o]);
  }
  if (jammed.length && jam && (await jam(jammed.map(([k]) => k)).then(() => true, () => false))) for (const [, o] of jammed) o.jammed = true;
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
interface AgentRow { id: string; name: string; status: string; lifecycleState?: string; adapterConfig?: { timeoutSec?: number } }
interface JobRow { id: string; agent: string; task?: string; routine?: string | null; state: string; started_at: string | null; ended_at: string | null; exit?: number | null; timed_out?: boolean; steps?: number; has_final?: boolean }
interface RoutineRow { id: string; title: string; status: string; triggers?: { kind?: string; enabled?: boolean; label?: string | null; nextRunAt?: string | null }[] }
interface IssueRow { id: string; identifier?: string; title?: string; status: string; createdAt?: string; parentId?: string | null; priority?: string; updatedAt: string; assigneeUserId?: string | null; assigneeAgentId?: string | null; createdByAgentId?: string | null; createdByUserId?: string | null; originKind?: string | null; labels?: ({ name?: string } | null)[] }
interface CommentRow { authorType?: string; authorAgentId?: string | null; body?: string; createdAt: string; deletedAt?: string | null }
interface WorkRecord { task: string | null; identifier: string | null; state?: string; judged?: boolean; targets?: string[]; decided_at: string | null; created_at?: string }

const HOUR_MS = 60 * MIN;
// n malice rejections (the reviewer rejects only malice, tier.ts MALICE) on one task with nothing approved since, quiet for
// quietMs (no new request on the task): the Steward's to look at, a possibly compromised agent. An hour is the
// judgement rule's window too: a delegator that re-briefs does so within its own woken run, so an hour of quiet means nobody will.
const REJECT_LOOP = { n: 5, windowMs: 7 * DAY_MS, quietMs: HOUR_MS };
/** A record someone said yes to (the kernel's record states past approval). */
const APPROVED = ["approved", "claimed", "done", "failed", "unknown"];
// A task waiting on someone else's call longer than this is the Steward's to settle: an agent's question to its delegator or the
// chief of staff (task_wait `for`, kernel idle.ts), or a task an agent made that was handed to the owner. An owner wait is the owner's own conversation (or a part's handoff on their task), never stuck.
const JUDGEMENT_WAIT_MS = HOUR_MS;
const JUDGEMENTS: Record<string, string> = { delegator_wait: "waited on its delegator's call", handback: "sat handed back to the owner" };
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
const QUEUE_MS = HOUR_MS; // an agent's tasks held on capacity this long (the oldest hold), while computers sit idle
const REVIEW_STALL_MS = 15 * MIN; // a card with the AI reviewer, undecided this long (a review normally takes seconds to a few minutes)
const REVIEW_GATE_MS = 90 * MIN; // a PR the merge queue holds for code review's verdict with no job on the task, twice a review run's 45-minute limit
const UNRESUMED_MS = HOUR_MS; // a task still waiting on an answer that arrived this long ago
const GATE_ESCALATE_MS = 2 * HOUR_MS; // a jammed gate's flag still open this long after it was raised goes to the chief of staff (tick's `jam`)
const GATE_LOOKUP_MS = HOUR_MS; // a failed activity lookup defers that flag this long; still failing past it, the clock decides
const JAMMED = /^(gate|unresumed|review-stall):/;
const MAX_LOOKUPS = 20;
/**
 * When a gate's task was last acted on, for tick's two-hour escalation: now while a job runs or is queued on it (the kernel's
 * `job_running`, `job_queued`; a `job_held` capacity hold is QUEUE_MS's, not work), else the newest comment by its holder or by a
 * fleet-audit agent (the Steward; another agent's comment is not the work moving). The kernel's own markers don't count.
 * Undefined when neither. Throws when the task can't be read: a failed lookup is unknown activity, never inactivity.
 */
export function gateActivity(d: { kernel: KernelClient; now?: () => number }): (task: string) => Promise<string | undefined> {
  // The agent directory, read at most once every five minutes: the holder key (the kernel's `assignee_changed.to`) and the agents
  // that act on a gate for the fleet (role fleet-audit). Paperclip names a comment's author by agent ID, so the holder key is
  // resolved to its ID before the two are compared.
  let directory: { at: number; holders: Map<string, string>; auditors: Set<string> } | undefined;
  const dir = async () => {
    const t = (d.now ?? Date.now)();
    if (directory && t - directory.at < 5 * MIN) return directory;
    const r = (await d.kernel.call("GET", "/v1/agents")) as { agents?: Record<string, { key?: string; roles?: string[] }> };
    const agents = r.agents ?? {};
    const holders = new Map(Object.entries(agents).filter(([id, g]) => g?.key).map(([id, g]) => [g.key!, id]));
    const auditors = new Set(Object.entries(agents).filter(([, g]) => (g?.roles ?? []).includes("fleet-audit")).map(([id]) => id));
    return (directory = { at: t, holders, auditors });
  };
  return async (task) => {
    const row = ((await d.kernel.call("GET", `/v1/tasks/state?ids=${encodeURIComponent(task)}`)).tasks ?? [])[0] as StateRow | undefined;
    if (row && ["job_running", "job_queued"].includes(row.reason)) return new Date((d.now ?? Date.now)()).toISOString();
    // The two activity sources are independent: one failing must not discard what the other saw, or a persistent failure of
    // one would let a gate with recent activity on the other look idle. Only when neither can be read is the task unknown.
    const [people, comments, work] = await Promise.allSettled([
      dir(),
      d.kernel.read(`/api/issues/${encodeURIComponent(task)}/comments?order=desc&limit=20`) as Promise<CommentRow[]>,
      d.kernel.call("GET", `/v1/work?task=${encodeURIComponent(task)}`) as Promise<{ jobs?: JobRow[] }>,
    ]);
    // A comment is only readable as activity with the directory that says whose it is: without it, the comments are unknown.
    const known = people.status === "fulfilled" && comments.status === "fulfilled";
    const comment = known
      ? comments.value.find((c) => !c.deletedAt && c.authorType === "agent" && !/<!-- aidenhq-/.test(String(c.body)) && (c.authorAgentId != null && (c.authorAgentId === (row?.holder ? people.value.holders.get(row.holder) ?? row.holder : undefined) || people.value.auditors.has(c.authorAgentId))))?.createdAt
      : undefined;
    // A run that started and ended between two ticks left no comment and no current state: its own start and end are the activity.
    let job: string | undefined;
    if (work.status === "fulfilled") for (const j of work.value.jobs ?? []) for (const t of [j.started_at, j.ended_at]) if (t && (!job || Date.parse(t) > Date.parse(job))) job = t;
    if (!known && work.status === "rejected") throw work.reason;
    return [comment, job].filter((t): t is string => Boolean(t)).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  };
}

/** A row of the kernel's task state (GET /v1/tasks/state, kernel/src/task-state-read.ts). */
type StateRow = { task: string; identifier: string | null; since: string; reason: string; ref?: string; holder: string | null; attention: { who: string; why: string; ref?: string }[]; idle_wakes: number; wait_since?: string; stage?: string };
/** Idle with nothing recorded to wake it, a wake nothing took, or its history pruned: the state's unexplained idle. */
const UNEXPLAINED = ["unpolled", "orphaned", "unknown", "history_expired"];
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

/**
 * Tasks the merge queue holds for code review's verdict (a `module_wait` whose reason is `code_review`, the kernel's row: no job
 * running, queued or held on the task) over REVIEW_GATE_MS. A review run is bounded at 45 minutes and the wait ends when a job
 * starts, so a wait this long is not a run in progress: the verdict will not change by itself (a post parked, a run never queued).
 */
export function reviewGateStalls(rows: StateRow[], t: number): { key: string; reason: string; since: string }[] {
  return rows
    .filter((r) => r.reason === "module_wait" && r.ref === "code_review" && age(r.since, t) > REVIEW_GATE_MS)
    .map((r) => ({ key: r.task, since: r.since, reason: `task ${r.identifier ?? r.task}: its PR has waited ${mins(age(r.since, t))} on code review's verdict with no job on the task` }));
}

/**
 * Tasks whose open owner or delegator wait (the task_wait fact: ref `wait:<task>`, and the wait is the task's representative
 * reason, so nothing runs, is queued or is on a card) has a comment that ends it by the kernel's own rule (task-state.ts: the
 * owner's typed words, or anyone but the holder and the kernel) newer than the wait and over UNRESUMED_MS old: the answer came and
 * nothing resumed the task. `comments` reads a task's comments, newest first, `holder` the task's assignee agent id as the
 * comments name it; an unreadable one counts as not answered. At most MAX_LOOKUPS tasks are read, from `start` around the list; `unscanned` names the rest.
 */
export async function unresumedWaits(rows: StateRow[], t: number, comments: (task: string) => Promise<CommentRow[]>, holder: (task: string) => Promise<string | undefined>, start = 0): Promise<{ found: { key: string; reason: string }[]; unscanned: string[] }> {
  const found: { key: string; reason: string }[] = [];
  const due = rows.filter((r) => (r.reason === "owner_wait" || r.reason === "delegator_wait") && r.attention.some((a) => a.why === r.reason && a.ref?.startsWith("wait:")) && !exempt({ identifier: r.identifier, originKind: null }));
  const scan = Math.min(due.length, MAX_LOOKUPS);
  for (let n = 0; n < scan; n++) {
    const r = due[(start + n) % due.length]!;
    const since = r.wait_since ?? r.since;
    const mine = r.reason === "delegator_wait" ? await holder(r.task).catch(() => undefined) : undefined;
    const answer = (await comments(r.task).catch(() => [])).find((c) => !c.deletedAt && Date.parse(c.createdAt) > Date.parse(since) && age(c.createdAt, t) > UNRESUMED_MS && !/<!-- aidenhq-/.test(String(c.body)) && (r.reason === "owner_wait" ? ownerWords(c) : c.authorAgentId !== (mine ?? r.holder)));
    if (answer) found.push({ key: r.task, reason: `task ${r.identifier ?? r.task} has not resumed ${mins(age(answer.createdAt, t))} after its ${r.reason === "owner_wait" ? "owner's" : "delegator's"} answer arrived (the wait began ${mins(age(since, t))} ago)` });
  }
  return { found, unscanned: Array.from({ length: due.length - scan }, (_, n) => due[(start + scan + n) % due.length]!.task) };
}

/**
 * Agents with tasks held on capacity (`job_held`, ref `capacity`: the agent's max_parallel, or every computer taken) whose oldest hold is
 * over QUEUE_MS, while computers sit idle (fewer running jobs than the kernel's `capacity`). A fleet at capacity raises nothing.
 */
export function capacityQueues(rows: StateRow[], running: number, capacity: number, t: number): { key: string; reason: string }[] {
  const idle = capacity - running;
  if (idle <= 0) return [];
  const by = new Map<string, StateRow[]>();
  for (const r of rows.filter((x) => x.reason === "job_held" && x.ref === "capacity" && x.holder)) by.set(r.holder!, [...(by.get(r.holder!) ?? []), r]);
  const out: { key: string; reason: string }[] = [];
  for (const [agent, held] of by) {
    const oldest = Math.max(...held.map((r) => age(r.since, t)));
    if (oldest > QUEUE_MS) out.push({ key: slug(agent), reason: `agent ${slug(agent)} has ${held.length} task${held.length === 1 ? "" : "s"} held on capacity, the oldest ${mins(oldest)}, while ${idle} of ${capacity} computers are idle (${running} jobs running)` });
  }
  return out;
}

/** Write records still with the AI reviewer (state `review`) past REVIEW_STALL_MS: a review that was lost or never ran. */
export function reviewStalls(records: (WorkRecord & { id?: string; kind?: string })[], t: number): { key: string; reason: string; task?: string }[] {
  return records
    .filter((x) => x.state === "review" && x.id && age(x.created_at, t) > REVIEW_STALL_MS)
    .map((x) => ({ key: slug(x.id), reason: `card ${slug(x.id)} (${slug(x.kind)}) on task ${slug(x.identifier ?? x.task)} has been with the AI reviewer for ${mins(age(x.created_at, t))} with no decision`, ...(x.task ? { task: x.task } : {}) }));
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
export function checks(d: { kernel: KernelClient; kv: Kv; pause: (routine: string) => Promise<void>; apps: <T>(path: string) => Promise<T>; alerts: () => Promise<Incident[]>; openKeys: () => string[]; notify?: (text: string, key: string) => Promise<void>; owner?: (text: string) => Promise<void>; gradeFailures: () => Promise<{ task: string; at: string; reason: string }[]>; now?: () => number; log?: (msg: string, f?: Record<string, unknown>) => void }): Record<string, Check> {
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
  // Whether a task an agent made (its creator never changes): kept across passes, so each pass reads at most MAX_LOOKUPS new
  // handbacks and every one is reached in turn. A failed read is not kept.
  const agentMade = new Map<string, boolean>();
  /** Handbacks whose task couldn't be read, until when they are raised unread (a failed read backs off, so later ones get read). */
  const unreadUntil = new Map<string, number>();
  let unresumedAt = 0; // where the next `unresumed` pass starts in its list, so a bounded pass reaches every eligible wait
  let jobCache = new Map<string, JobRow[]>(); // one check run's job reads, shared by `component` and `run`
  const jobsOf = async (agent: string) => {
    let jobs = jobCache.get(agent);
    if (!jobs) jobCache.set(agent, (jobs = ((await d.kernel.call("GET", `/v1/work?agent=${encodeURIComponent(agent)}`)).jobs ?? []) as JobRow[]));
    return jobs;
  };
  /** Tasks a component incident explains this run: their own incidents are not raised anew (one already open stays until it recovers). */
  let explained = new Set<string>();
  // A notice per incident (a task for the chief of staff, main.ts toChief), recorded as told only once it went out: a failed send is tried again on the next check, and
  // forgotten when the incident is gone, so its next occurrence is told again.
  const told = (): string[] => JSON.parse(d.kv.get("owner_told") ?? "[]");
  const announce = async (key: string, text: string, send = (x: string) => d.notify?.(x, key)) => {
    if (told().includes(key)) return;
    try {
      await send(text);
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
      const owed = (): Record<string, number> => JSON.parse(d.kv.get("routine_notice_owed") ?? "{}");
      // The routines this detector paused itself (`since` is only the failure cutoff, set for a hand-paused one too).
      const mine = new Set<string>(JSON.parse(d.kv.get("routine_paused_by_detector") ?? "[]"));
      const justPaused = new Set<string>(); // paused by this check: the rows were read before it
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
          mine.add(routine);
          justPaused.add(routine);
          // Kept at once, beside the cutoff: a later failure in this check must not lose whose pause it is.
          d.kv.set("routine_paused_by_detector", JSON.stringify([...mine]));
          // Its id only: a routine's title is an agent's words, and this text is the chief of staff's instruction. Owed until told: a
          // failed filing (quiet start, the kernel down) is tried again below on each check while it stays paused.
          d.kv.set("routine_notice_owed", JSON.stringify({ ...owed(), [routine]: failures }));
        }
        out.push({ key: routine, reason: `routine ${plain(row.title)}: its last ${failures} runs failed${row.status === "paused" ? " (paused until the owner resumes it)" : ""}` });
      }
      // Paused by this detector and still paused: the flag stays open until the owner resumes it (a resume clears it). A routine
      // paused by hand is the owner's choice: no flag.
      for (const id of [...mine]) {
        const row = rows.find((r) => r.id === id);
        const pausedNow = row?.status === "paused" || justPaused.has(id);
        if (!pausedNow) { mine.delete(id); continue; }
        if (row && !out.some((i) => i.key === id)) out.push({ key: id, reason: `routine ${plain(row.title)}: paused after repeated failures, until the owner resumes it` });
      }
      d.kv.set("routine_paused_by_detector", JSON.stringify([...mine]));
      // The notices this detector owes (routines it paused), each told once; one no longer paused is owed nothing.
      for (const [id, n] of Object.entries(owed())) {
        const left = { ...owed() };
        // Paused now: read so, or paused by this very check (the rows were read before it).
        if (rows.find((r) => r.id === id)?.status === "paused" || justPaused.has(id)) {
          const ok = await d.notify?.(`Routine paused: routine ${id} failed ${n} runs in a row (fleet_status names it). Resume it once its cause is fixed.`, `routine-paused:${id}`).then(() => true, () => false);
          if (!ok) continue;
        }
        delete left[id];
        d.kv.set("routine_notice_owed", JSON.stringify(left));
      }
      return out;
    },
    // An active routine whose next cron fire is overdue by 15 minutes and no run started: Paperclip's scheduler has stopped.
    async missed() {
      return missedFires(await routines(), now());
    },
    // An agent Paperclip holds in a lifecycle transition (pausing, resuming, ...) past 15 minutes: it refuses the agent's wakes,
    // so its routine runs fail and tasks assigned to it are blocked, while its status may read idle.
    async lifecycle() {
      const t = now();
      const seen: Record<string, { state: string; at: string }> = JSON.parse(d.kv.get("lifecycle_since") ?? "{}");
      const next: typeof seen = {};
      const out: Incident[] = [];
      for (const a of await agents()) {
        if (!a.lifecycleState || !TRANSITIONS.has(a.lifecycleState)) continue;
        const at = seen[a.id]?.state === a.lifecycleState ? seen[a.id]!.at : new Date(t).toISOString();
        next[a.id] = { state: a.lifecycleState, at };
        if (age(at, t) > STUCK_TRANSITION_MS) out.push({ key: `${a.id}:${a.lifecycleState}`, reason: `${a.name}: Paperclip has held it in lifecycle state "${a.lifecycleState}" for ${mins(age(at, t))}, so it refuses the agent's wakes (routine runs fail, tasks assigned to it are blocked). Its stop proof isn't passing: a product bug (Paperclip wiring) for the Maintainer` });
      }
      d.kv.set("lifecycle_since", JSON.stringify(next));
      return out;
    },
    // Queued wakes while no job starts: the owner hears at once (`owner`), with no agent job needed to file or read anything. A task
    // for the chief of staff would wait on the very dispatch that stalled, so this is the owner's second line beside a lost Steward.
    async dispatch() {
      const t = now();
      const w = (await d.kernel.call("GET", "/v1/work")) as { waiting?: { count: number; oldest_at: string | null; oldest_cause: string | null }; last_started_at?: string | null };
      if (!w.waiting?.count || age(w.waiting.oldest_at, t) <= DOWN_MS || age(w.last_started_at, t) <= DOWN_MS) return (forgetTold("dispatch-stalled", []), []);
      const text = `No agent work has started for ${mins(Math.min(age(w.last_started_at, t), age(w.waiting.oldest_at, t)))} while ${w.waiting.count} wake${w.waiting.count === 1 ? "" : "s"} wait (oldest: ${slug(w.waiting.oldest_cause)}).`;
      await announce("dispatch-stalled", text, (x) => d.owner?.(x));
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
    // Orphaned work: the kernel's task state (nothing running, filed or waiting on the task: unpolled, orphaned, unknown or
    // history expired), over 2 hours. The one stuck-work rule.
    // A task whose holder the kernel's idle sweep already woke 3 times in a day (kernel idle.ts) is critical at once: waking
    // it again won't move it, so Fleet Ops looks at it.
    async stuck() {
      const t = now();
      const out: Incident[] = [];
      const items = await openStates();
      const capped = (x: { idle_wakes?: number }) => (x.idle_wakes ?? 0) >= IDLE_WAKE_CAP;
      // `unpolled`: no dispatcher runs the holder, so no wake is ever taken, and it is raised at once: not critical, since a
      // dispatcher outage makes every idle task unpolled at once and one fix covers them all.
      const stuck = (x: { reason: string; idle_wakes?: number; since: string }) => capped(x) || x.reason === "unpolled" || age(x.since, t) > IDLE_MS;
      for (const i of items.filter((x) => UNEXPLAINED.includes(x.reason) && stuck(x) && !exempt({ identifier: x.identifier, originKind: null }) && !suppressed(x.task, `stuck:${x.task}`))) {
        // Owned by nobody, or by the owner (a person, not an agent's work): not someone's stuck work (the inbox, review-log and
        // issues tasks are idle by design; owner-assigned todos are the stale follow-up check's). A backlog task is `backlog`, never idle.
        if (!i.holder || i.holder === "owner") continue;
        if (i.reason === "unpolled") out.push({ key: `${i.task}:unpolled`, reason: `task ${i.identifier ?? i.task} is idle for ${mins(age(i.since, t))} and no enabled dispatcher runs its agent ${i.holder}: no wake will ever start it, so its agent's assignment has to be fixed or the task re-routed` });
        else if (capped(i)) out.push({ key: `${i.task}:idle-capped`, critical: true, reason: `task ${i.identifier ?? i.task} is still idle after ${i.idle_wakes} idle wakes of its agent today (nothing running, filed or waiting on it, ${mins(age(i.since, t))}): waking it again won't move it` });
        else out.push({ key: i.task, reason: `task ${i.identifier ?? i.task} idle for ${mins(age(i.since, t))} with nothing running, filed or waiting on it (${slug(i.reason)})` });
      }
      return out;
    },
    // A PR held for code review's verdict with no job on its task: the merge gate's own jam (a post parked, a run never queued).
    async gate() {
      return reviewGateStalls((await openStates()).filter((i) => !exempt({ identifier: i.identifier, originKind: null })), now());
    },
    // An owner or delegator wait the kernel still holds open although a comment answers it (its own rule disagreed, as in #1194): the
    // answer is on the task, the work is not moving. A wait the kernel did close that nothing resumed is `stuck`'s (idle, orphaned). A pass
    // reads at most MAX_LOOKUPS tasks; incidents already open for the ones it did not reach stay open.
    async unresumed() {
      const read = taskReads();
      const { found, unscanned } = await unresumedWaits(await openStates(), now(), (task) => d.kernel.read(`/api/issues/${encodeURIComponent(task)}/comments?order=desc&limit=20`) as Promise<CommentRow[]>, async (task) => (await read(task))?.assigneeAgentId ?? undefined, unresumedAt);
      unresumedAt += MAX_LOOKUPS;
      const kept = d.openKeys().filter((k) => k.startsWith("unresumed:") && unscanned.includes(k.slice("unresumed:".length)) && !found.some((f) => `unresumed:${f.key}` === k));
      return [...found, ...kept.map((k) => ({ key: k.slice("unresumed:".length), reason: "" }))];
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
    // A task waiting on someone else's call over an hour (a delegator wait, or an agent's task handed to the
    // owner): the Steward settles it. A handback is raised only on a task an agent made (each task read once, kept across passes,
    // at most MAX_LOOKUPS new reads a pass): a task the owner made and got back is their own result to read.
    async judgement() {
      const t = now();
      let looked = 0;
      // By attention, not the representative reason: a task also running, queued or on a card still waits on the answer.
      const out: Incident[] = [];
      const states = await openStates();
      // Kept only for tasks still open: a closed task's entries go.
      const live = new Set(states.map((i) => i.task));
      for (const m of [agentMade, unreadUntil]) for (const k of m.keys()) if (!live.has(k)) m.delete(k);
      for (const i of states) {
        const why = i.attention.map((a) => a.why).find((w) => JUDGEMENTS[w] !== undefined);
        // A handback's own age is the state's `since` only while the handback is what the task waits on (a pending card or an
        // older wait shows instead, and the handback waits its turn); a delegator wait's is `wait_since`.
        if (why === "handback" && i.reason !== "handback") continue;
        const since = why === "handback" ? i.since : i.wait_since ?? i.since;
        if (!why || age(since, t) <= JUDGEMENT_WAIT_MS || exempt({ identifier: i.identifier, originKind: null })) continue;
        if (why === "handback" && !agentMade.has(i.task) && !((unreadUntil.get(i.task) ?? 0) > t)) {
          // Past this pass's reads, a handback already open stays open (a later pass reads it); a failed read is unknown, so it is
          // raised, and not read again for an hour.
          if (looked++ >= MAX_LOOKUPS) { if (d.openKeys().includes(`judgement:${i.task}`)) out.push({ key: i.task, reason: "" }); continue; }
          const task = (await (d.kernel.read(`/api/issues/${encodeURIComponent(i.task)}`) as Promise<IssueRow>).catch(() => undefined)) ?? undefined;
          if (task) agentMade.set(i.task, Boolean(task.createdByAgentId && !task.createdByUserId));
          else unreadUntil.set(i.task, t + HOUR_MS);
        }
        if (why === "handback" && agentMade.get(i.task) === false) continue;
        out.push({ key: i.task, reason: `task ${i.identifier ?? i.task} has ${JUDGEMENTS[why]} for ${mins(age(since, t))} (${why})` });
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
    // An agent whose tasks sit held on capacity over an hour while computers idle: the router or admission is misplacing work.
    async queue() {
      const w = (await d.kernel.call("GET", "/v1/work")) as { running?: unknown[]; capacity?: number };
      if (!Array.isArray(w.running) || !(Number(w.capacity) > 0)) return undefined; // not readable: its open incidents stay open
      return capacityQueues((await openStates()).filter((i) => !exempt({ identifier: i.identifier, originKind: null })), w.running.length, Number(w.capacity), now());
    },
    // A card with the AI reviewer over 15 minutes (Tier 1; a Tier 2 card on the owner is theirs, on their card).
    async "review-stall"() {
      const t = now();
      const r = (await d.kernel.call("GET", `/v1/work?since=${encodeURIComponent(new Date(t - 7 * DAY_MS).toISOString())}`)) as { records?: Parameters<typeof reviewStalls>[0] };
      return reviewStalls(r.records ?? [], t);
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
      const r = await d.apps<{ sources?: SourceRow[]; failing_scopes?: FailingScope[]; short_scopes?: ShortScope[] }>("/internal/sources");
      if (!r.sources) return undefined; // the warehouse isn't set up
      return [...staleSources(r.sources, now()), ...failingScopes(r.failing_scopes ?? []), ...shortScopes(r.short_scopes ?? [])];
    },
    // Billed spend today far above the recent days' (the kernel's one work read, which carries the day's top components and subjects).
    async spend() {
      const t = now();
      const from = new Date(Date.parse(new Date(t).toISOString().slice(0, 10)) - 7 * DAY_MS).toISOString();
      return spendSpike((await d.kernel.call("GET", `/v1/work?since=${encodeURIComponent(from)}`)) as SpendRead, t);
    },
    // Monitoring alerts (alerts.ts): one incident per firing alert, recovered when it resolves.
    alert: d.alerts,
    async pr() {
      const r = await d.apps<{ prs?: PrRow[]; github_error?: boolean }>("/internal/open-prs");
      if (!r.prs) return undefined;
      // A key is matched to an open incident ignoring case (a repo's spelling differs by source and by release), keeping the open one's spelling.
      const open = new Map(d.openKeys().filter((k) => k.startsWith("pr:")).map((k) => [k.slice(3).toLowerCase(), k.slice(3)]));
      const found = stalePrs(r.prs, now()).map((x) => ({ ...x, key: open.get(x.key.toLowerCase()) ?? x.key }));
      // GitHub couldn't be read: its open incidents stay open (not recovered), while this server's own change requests (`local/…`) were read.
      if (r.github_error) for (const k of d.openKeys()) if (k.startsWith("pr:") && !k.startsWith("pr:local/")) found.push({ key: k.slice(3), reason: "" });
      return found;
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
