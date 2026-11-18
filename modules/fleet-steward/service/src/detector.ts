// The Fleet Steward's detector, moved out of the board: on a timer it checks the owner's alert thresholds in code and files a
// task for the Steward only when something trips or recovers (kernel.tasks). Each incident is filed once until it recovers, then
// once more with a recovery note. The Steward reads what is open and what recovered with `fleet_detector`. Sources: the kernel's
// jobs (stuck, failing and silent runs), the control plane's tasks and agents, apps-mcp (apps.read) and Alertmanager's alerts.
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
const PR_OPEN_MS = 60 * MIN; // an agents-org pull request open this long without merging (the warehouse lags GitHub by up to 15 minutes)

type PrRow = { repo: string; number: number; opened_at: string; draft: boolean; preview_url?: string };
/** The open agents-org PRs nobody has merged within the allowance; merged or closed ones are no longer in the rows. A draft
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

/** A check group: its incidents, or undefined when it couldn't be checked (its open incidents stay open). */
type Check = () => Promise<Incident[] | undefined>;

/** The last filing, and the gap before a filing with nothing critical in it (60 check runs a day, most one line). */
export const QUIET_MS = 30 * MIN;

/**
 * One tick: run the checks, open what newly tripped, close what recovered, and file once for whatever is new (incidents and
 * recovery notes together). Marked filed only when the kernel took it; otherwise the next tick tries again. Within `quietMs`
 * of the last filing only a new critical incident files; the rest wait (still unfiled) for a later tick.
 */
export async function tick(kv: Kv, checks: Record<string, Check>, file: (body: { incidents: { key: string }[]; recovered: { key: string }[] }) => Promise<boolean>, notify: (text: string) => Promise<void>, now = new Date(), quietMs = 0): Promise<void> {
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
  const unheard = Object.values(s.open).filter((o) => !o.fired && !o.told && Date.parse(at) - Date.parse(o.at) > DAY_MS);
  if (unheard.length) {
    for (const o of unheard) o.told = true;
    await notify("The Fleet Steward is unreachable: its health flags have not reached it for a day. Ask Aiden to check the fleet-steward module.").catch(() => {});
  }
  const incidents = Object.entries(s.open).filter(([, o]) => !o.fired).map(([key, o]) => ({ key, ...(o.critical ? { critical: true } : {}) }));
  const recovered = s.recovered.filter((r) => !r.fired).map(({ key }) => ({ key }));
  const due = incidents.some((i) => i.critical) || !(Date.parse(at) - Date.parse(kv.get("last_filed") ?? "") < quietMs);
  if ((incidents.length || recovered.length) && due && (await file({ incidents, recovered }).catch(() => false))) {
    for (const i of incidents) s.open[i.key]!.fired = true;
    for (const r of s.recovered) r.fired = true;
    kv.set("last_filed", at);
  }
  s.recovered = s.recovered.slice(-20);
  kv.set(STATE_KEY, JSON.stringify(s));
}

interface Company { id: string }
interface AgentRow { id: string; name: string; status: string; adapterConfig?: { timeoutSec?: number } }
interface JobRow { id: string; agent: string; state: string; started_at: string | null; ended_at: string | null; exit?: number | null; timed_out?: boolean; steps?: number; has_final?: boolean }
interface IssueRow { id: string; identifier?: string; status: string; updatedAt: string }

/** The owner's alert list, as checks. `apps` reads apps-mcp (a module holding apps.read); `alerts` is Alertmanager's list. */
export function checks(d: { kernel: KernelClient; apps: <T>(path: string) => Promise<T>; alerts: () => Promise<Incident[]>; openKeys: () => string[]; now?: () => number }): Record<string, Check> {
  const now = d.now ?? (() => Date.now());
  let appsOkAt = now(); // apps-mcp's last answer: a restart (an apply) is not an outage
  const companies = async () => (await d.kernel.read("/api/companies")) as Company[];
  const agents = async () => (await Promise.all((await companies()).map(async (c) => (await d.kernel.read(`/api/companies/${c.id}/agents`)) as AgentRow[]))).flat().filter((a) => a.status !== "terminated");
  const jobsOf = async (agent: string) => ((await d.kernel.call("GET", `/v1/work?agent=${encodeURIComponent(agent)}`)).jobs ?? []) as JobRow[];
  return {
    // Stuck, failing and silent runs, from the kernel's job ledger.
    async run() {
      const t = now();
      const out: Incident[] = [];
      for (const a of await agents()) {
        const mine = await jobsOf(a.id);
        const timeout = Number(a.adapterConfig?.timeoutSec) * 1000;
        const limit = timeout > 0 ? 2 * timeout : STUCK_DEFAULT_MS;
        const stuck = mine.find((j) => j.state === "running" && age(j.started_at, t) > limit);
        if (stuck) out.push({ key: `${a.id}:stuck`, reason: `${a.name}: a run has been running ${mins(age(stuck.started_at, t))} (limit ${mins(limit)})` });
        const finished = mine.filter((j) => !["running", "cancelled"].includes(j.state)).slice(0, FAILS);
        if (finished.length === FAILS && finished.every((j) => j.state !== "done")) out.push({ key: `${a.id}:failing`, reason: `${a.name}: its last ${FAILS} runs failed (${finished.map((j) => j.state).join(", ")})` });
        // One heuristic: a job that finished with no steps and no final words, 3+ times in a day. Diagnostic only.
        const silent = mine.filter((j) => j.state === "done" && !j.steps && !j.has_final && age(j.ended_at, t) < DAY_MS).length;
        if (silent >= SILENT_RUNS) out.push({ key: `${a.id}:silent`, reason: `agent ${a.name}: ${silent} runs in 24h ended with no steps and no output` });
      }
      return out;
    },
    // A task held for grading (label grading, in review) for over a day: the grader's verdict is overdue.
    async grade() {
      const t = now();
      const out: Incident[] = [];
      for (const c of await companies()) {
        const label = ((await d.kernel.read(`/api/companies/${c.id}/labels`)) as { id: string; name: string }[]).find((l) => l.name === "grading");
        if (!label) continue;
        const held = (await d.kernel.read(`/api/companies/${c.id}/issues?labelId=${label.id}&status=in_review&limit=100&excludeRoutineExecutions=true`)) as IssueRow[];
        for (const i of held.filter((x) => age(x.updatedAt, t) > DAY_MS)) out.push({ key: i.id, reason: `task ${i.identifier ?? i.id} held for grading for ${mins(age(i.updatedAt, t))}` });
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
