/**
 * Fleet Ops' detector (modules/fleet-ops): on a timer, checks the owner's alert thresholds in code and fires the Fleet Ops
 * routine's webhook only when something trips or recovers. Each incident fires once until it recovers, then once more with
 * a recovery note. Fleet Ops reads what is open and what recovered from fleet_status (`detector`). Off unless the module
 * is enabled (FLEET_OPS_INTERVAL_MINUTES) and setup has written the webhook's secret files.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Agent, Paperclip } from "./paperclip.js";
import type { Store } from "./store.js";
import { appsApi } from "./fleet.js";
import type { Grade, Grading } from "./grading.js";
import { parseRunLog } from "./runs.js";
import { alertIncidents } from "./monitoring.js";
import { TOO_LONG } from "./rollover.js";

const MIN = 60_000;
const STATE_KEY = "fleet_ops_detector";
const DOWN_MS = 15 * MIN; // an app incident open this long (the app-incident loop had its chance)
const STALE_MS = 60 * MIN; // a source with no good pass this long
/** Sources that pass on their own slower cadence: the security scanner runs daily. */
const STALE_FOR: Record<string, number> = { security: 26 * 60 * MIN };

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
const STUCK_DEFAULT_MS = 180 * MIN; // a run with no known timeout, running this long
const FAILS = 3; // an agent's last finished runs, all failed

/** `critical`: an outage or a critical alert, which wakes Fleet Ops at once; the rest wait for the next quiet-gap fire. */
export interface Incident { key: string; reason: string; critical?: boolean }
interface Open { reason: string; at: string; fired: boolean; told?: boolean; critical?: boolean }
interface State { open: Record<string, Open>; recovered: { key: string; reason: string; at: string; fired: boolean }[] }

/** What is open and what recovered lately (fleet_status shows it to Fleet Ops). */
export function detectorState(store: Pick<Store, "meta">): State {
  try {
    const s = JSON.parse(store.meta(STATE_KEY) ?? "{}");
    // Only what fleet_status documents: state written by an older detector (an ever-growing `failed` history) stays
    // out of the reply, which is otherwise cut before `open` and `recovered` reach Fleet Ops.
    return { open: s.open ?? {}, recovered: s.recovered ?? [] };
  } catch {
    return { open: {}, recovered: [] };
  }
}

/** A check group: its incidents, or undefined when it couldn't be checked (its open incidents stay open). */
type Check = () => Promise<Incident[] | undefined>;

/** The detector's last fire, and the gap before a fire with nothing critical in it (60 check runs a day, most one line, cost $3/day). */
export const QUIET_MS = 30 * MIN;

/**
 * One tick: run the checks, open what newly tripped, close what recovered, and fire once for whatever is new (incidents and
 * recovery notes together). Marked fired only when the webhook took it; otherwise the next tick tries again. Within `quietMs`
 * of the last fire only a new critical incident fires; the rest wait (still unfired) for a later tick.
 */
export async function tick(store: Pick<Store, "meta" | "setMeta">, checks: Record<string, Check>, fire: (body: unknown) => Promise<boolean>, now = new Date(), quietMs = 0): Promise<void> {
  const s = detectorState(store);
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
  // Every flag is Fleet Ops's. The owner hears only that Fleet Ops itself can't be reached: a flag its webhook hasn't taken
  // for a day (one fixed line, never a flag's own text), since that is the case where nobody else would act.
  const unheard = Object.values(s.open).filter((o) => !o.fired && !o.told && Date.parse(at) - Date.parse(o.at) > DAY_MS);
  if (unheard.length) {
    for (const o of unheard) o.told = true;
    queueOwnerLine(store, "🩺 **Fleet Ops is unreachable**: its health flags have not reached it for a day. Ask Aiden to check the Fleet Ops routine.");
  }
  const incidents = Object.entries(s.open).filter(([, o]) => !o.fired).map(([key, o]) => ({ key, reason: o.reason, since: o.at, ...(o.critical ? { critical: true } : {}) }));
  const recovered = s.recovered.filter((r) => !r.fired).map(({ key, reason, at }) => ({ key, reason, recovered_at: at }));
  const due = incidents.some((i) => i.critical) || !(Date.parse(at) - Date.parse(store.meta("fleet_ops_last_fire") ?? "") < quietMs);
  if ((incidents.length || recovered.length) && due && (await fire({ incidents, recovered }).catch(() => false))) {
    for (const i of incidents) s.open[i.key]!.fired = true;
    for (const r of s.recovered) r.fired = true;
    store.setMeta("fleet_ops_last_fire", at);
  }
  s.recovered = s.recovered.slice(-20);
  store.setMeta(STATE_KEY, JSON.stringify(s));
}

const DAY_MS = 24 * 60 * MIN;
const SILENT_RUNS = 3; // silent runs in a day before the flag opens
const MISSED_GRACE_MS = 15 * MIN;
const HARD_FAIL = new Set(["failed", "timed_out"]);
const SOFT_CODES = new Set(["cap_reached", "issue_reassigned"]); // not the routine's fault

/** One-line owner messages waiting for the owner channel (it collects each once). */
export function queueOwnerLine(store: Pick<Store, "meta" | "setMeta">, line: string): void {
  const q: string[] = JSON.parse(store.meta("owner_health_lines") ?? "[]");
  store.setMeta("owner_health_lines", JSON.stringify([...q, line].slice(-20)));
}
export function takeOwnerLines(store: Pick<Store, "meta" | "setMeta">): string[] {
  const q: string[] = JSON.parse(store.meta("owner_health_lines") ?? "[]");
  if (q.length) store.setMeta("owner_health_lines", "[]");
  return q;
}

interface RoutineRow { id: string; title: string; status: string; triggers?: { kind?: string; enabled?: boolean; label?: string | null; nextRunAt?: string | null }[] }
/** Active routines whose next fire (by Paperclip's cron) is overdue past the grace: the fire never happened. A coalesced or skipped fire still advances it. */
export function missedFires(routines: RoutineRow[], t: number): Incident[] {
  const out: Incident[] = [];
  for (const r of routines.filter((x) => x.status === "active")) {
    const late = (r.triggers ?? []).filter((x) => x.kind === "schedule" && x.enabled !== false && x.nextRunAt && age(x.nextRunAt, t) > MISSED_GRACE_MS);
    for (const x of late) out.push({ key: `${r.id}:${x.label ?? "schedule"}`, reason: `routine ${r.title} (${x.label ?? "schedule"}): fire due ${mins(age(x.nextRunAt, t))} ago, no run started` });
  }
  return out;
}

interface RoutineRun { routineId: string; status: string; errorCode?: string | null; at: string }
/** Routines whose latest finished runs are all hard failures (FAILS in a row), counting only runs after `since[routineId]` (the owner's resume). */
export function failingRoutines(routines: RoutineRow[], runs: RoutineRun[], since: Record<string, string>): { routine: RoutineRow; failures: number }[] {
  const out: { routine: RoutineRow; failures: number }[] = [];
  for (const r of routines.filter((x) => x.status !== "archived")) {
    // While paused the failures stay on the books (the flag stays open); once resumed, only newer runs count.
    const from = r.status === "paused" ? undefined : since[r.id];
    const mine = runs.filter((x) => x.routineId === r.id && (!from || x.at > from) && !["running", "queued", "cancelled"].includes(x.status) && !SOFT_CODES.has(x.errorCode ?? "")).sort((a, b) => b.at.localeCompare(a.at));
    let n = 0;
    while (n < mine.length && HARD_FAIL.has(mine[n]!.status)) n++;
    if (n >= FAILS) out.push({ routine: r, failures: n });
  }
  return out;
}

const silentRuns = new Map<string, boolean>(); // run id → silent (a finished run's log never changes)

const age = (t: string | null | undefined, now: number) => (t ? now - Date.parse(t) : Infinity);
const mins = (ms: number) => `${Math.round(ms / MIN)} min`;

/** The owner's alert list, as checks. */
export function checks(pc: Paperclip, store: Pick<Store, "meta" | "setMeta" | "refusalsSince">, grading: Pick<Grading, "stale">, now = () => Date.now(), warn?: (o: object, m: string) => void): Record<string, Check> {
  let appsOkAt = now(); // apps-mcp's last answer: a restart (an apply) is not an outage
  return {
    async run() {
      const t = now();
      const co = `/api/companies/${pc.companyId}`;
      const [agents, runs] = await Promise.all([pc.request<Agent[]>("GET", `${co}/agents`), pc.request<{ agentId: string; status: string; startedAt?: string | null; createdAt: string; error?: string | null; issueId?: string | null }[]>("GET", `${co}/heartbeat-runs?summary=true&limit=500`)]);
      const out: Incident[] = [];
      for (const a of agents.filter((x) => x.status !== "terminated")) {
        const mine = runs.filter((r) => r.agentId === a.id).sort((x, y) => (y.startedAt ?? y.createdAt).localeCompare(x.startedAt ?? x.createdAt));
        const timeout = Number(a.adapterConfig?.timeoutSec) * 1000;
        const limit = timeout > 0 ? 2 * timeout : STUCK_DEFAULT_MS;
        const stuck = mine.find((r) => r.status === "running" && age(r.startedAt ?? r.createdAt, t) > limit);
        if (stuck) out.push({ key: `${a.id}:stuck`, reason: `${a.name}: a run has been running ${mins(age(stuck.startedAt ?? stuck.createdAt, t))} (limit ${mins(limit)})` });
        const finished = mine.filter((r) => !["running", "queued", "cancelled"].includes(r.status)).slice(0, FAILS);
        if (finished.length === FAILS && finished.every((r) => r.status !== "succeeded")) {
          // Over the model's input limit: the task's history outgrew a fresh session. Rollover moves it (rollover.ts) unless
          // it is graded, an Engineer task, agent-made or waits on a card; say which task, so it isn't read as a flaky model.
          const long = TOO_LONG.test(finished[0]!.error ?? "") ? finished[0]!.issueId : undefined;
          const task = long ? (await pc.issueSummary(long).catch(() => undefined))?.identifier ?? long : undefined;
          out.push({ key: `${a.id}:failing`, reason: task ? `${a.name}: its last ${FAILS} runs failed: ${task} is too long for a fresh session (over the model's input limit). The board moves such a task to a successor within 10 minutes unless a run is on it, a card waits on it, it is graded, an Engineer task or not the owner's own (made by an agent or from a source): if it is still open, move its open sub-tasks to a new task and close it without an agent.` : `${a.name}: its last ${FAILS} runs failed (${finished.map((r) => r.status).join(", ")})` });
        }
      }
      return out;
    },
    async missed() {
      return missedFires(await pc.request<RoutineRow[]>("GET", `/api/companies/${pc.companyId}/routines`), now());
    },
    // 3 hard failures in a row: flag it and pause the routine until the owner resumes it.
    async routine() {
      const co = `/api/companies/${pc.companyId}`;
      const [routines, issues, runs] = await Promise.all([
        pc.request<RoutineRow[]>("GET", `${co}/routines`),
        pc.request<{ id: string; originId?: string | null }[]>("GET", `${co}/issues?originKind=routine_execution&limit=300`),
        pc.request<{ id: string; status: string; errorCode?: string | null; startedAt?: string | null; createdAt: string; contextSnapshot?: { issueId?: string } | null }[]>("GET", `${co}/heartbeat-runs?limit=300`),
      ]);
      const origin = new Map(issues.map((i) => [i.id, i.originId]));
      const t = now();
      // Spend-cap and upstream stops (the board ledger) are not the routine's fault; while one is happening fleet-wide, nothing is auto-paused.
      const refusals = store.refusalsSince(new Date(t - 7 * DAY_MS).toISOString());
      const refused = new Set(refusals.map((x) => x.runId));
      const fleetWide = refusals.some((x) => age(x.at, t) < 60 * MIN);
      // One outcome per routine issue: its latest run (a retry or wake is not another failure).
      const latest = new Map<string, (typeof runs)[number]>();
      for (const x of runs) {
        const issueId = x.contextSnapshot?.issueId;
        if (!issueId || !origin.get(issueId)) continue;
        const prev = latest.get(issueId);
        if (!prev || (x.startedAt ?? x.createdAt) > (prev.startedAt ?? prev.createdAt)) latest.set(issueId, x);
      }
      const rr = [...latest].map(([issueId, x]) => ({ routineId: origin.get(issueId)!, status: x.status, errorCode: refused.has(x.id) ? "cap_reached" : x.errorCode, at: x.startedAt ?? x.createdAt }));
      const since: Record<string, string> = JSON.parse(store.meta("routine_paused_at") ?? "{}");
      const failing = failingRoutines(routines, rr, since);
      for (const { routine, failures } of failing) {
        if (routine.status === "paused") {
          // Paused by the owner (or by hand): the resume must not re-pause on these old failures.
          if (!since[routine.id]) {
            since[routine.id] = new Date(t).toISOString();
            store.setMeta("routine_paused_at", JSON.stringify(since));
          }
          continue;
        }
        if (fleetWide) continue;
        await pc.request("PATCH", `/api/routines/${routine.id}`, { status: "paused" });
        since[routine.id] = new Date(t).toISOString();
        store.setMeta("routine_paused_at", JSON.stringify(since));
        queueOwnerLine(store, `⏸ **Routine paused**: ${routine.title} failed ${failures} runs in a row. Ask Aiden to resume it once it's fixed.`);
      }
      return failing.map(({ routine, failures }) => ({ key: routine.id, reason: `routine ${routine.title}: its last ${failures} runs failed${routine.status === "paused" ? " (paused until the owner resumes it)" : ""}` }));
    },
    // One heuristic: a Codex run that succeeded with no tool calls and no message, 3+ times in a day. Diagnostic only; nothing is paused.
    async silent() {
      const t = now();
      const codex = new Set((await pc.agents()).filter((a) => a.adapterType === "codex_local").map((a) => a.id));
      const runs = await pc.request<{ id: string; agentId: string; status: string; finishedAt?: string | null }[]>("GET", `/api/companies/${pc.companyId}/heartbeat-runs?limit=200`);
      let fetched = 0;
      const byAgent = new Map<string, number>();
      for (const r of runs.filter((x) => codex.has(x.agentId) && x.status === "succeeded" && x.finishedAt && age(x.finishedAt, t) < DAY_MS)) {
        let silent = silentRuns.get(r.id);
        if (silent === undefined) {
          if (fetched++ >= 15) continue; // the rest next tick
          silent = await pc.runLog(r.id, 300_000).then((l) => !l.truncated && parseRunLog(l.text).events.length === 0, () => false);
          if (silentRuns.size >= 500) silentRuns.delete(silentRuns.keys().next().value!);
          silentRuns.set(r.id, silent);
        }
        if (silent) byAgent.set(r.agentId, (byAgent.get(r.agentId) ?? 0) + 1);
      }
      return [...byAgent].filter(([, n]) => n >= SILENT_RUNS).map(([agentId, n]) => ({ key: agentId, reason: `agent ${agentId}: ${n} runs in 24h ended with no tool calls and no output` }));
    },
    // A graded task waiting on grading, or escalated, for over a day (the grading module settles closed tasks first and
    // answers the due and escalated rows). A row whose task has closed since is no waiting work: the module settles it on its
    // next tick, and until then a pass that recorded an escalation after the close must not read as a decision outstanding.
    // Module unreachable: no findings, not a page.
    async grade() {
      const t = now();
      const stale = (await grading.stale().catch((err) => (warn?.({ err: String(err) }, "fleet-ops: grading module unreachable; no grade findings"), [] as Grade[]))).filter((g) => age(g.updatedAt, t) > DAY_MS);
      const open: Grade[] = [];
      for (const g of stale) {
        // An unreadable task is left for the next tick, as the grading module's own sweep leaves it.
        const status = await pc.issue(g.issueId).then((i) => i.status, () => undefined);
        if (status && status !== "done" && status !== "cancelled") open.push(g);
      }
      return open.map((g) => ({ key: g.issueId, reason: `graded task ${g.issueId} ${g.state} for ${mins(age(g.updatedAt, t))}` }));
    },
    async app() {
      const t = now();
      // Unreachable: throws, so this group is "not checked" (its open incidents stay open); `service` reports the outage.
      const apps = await appsApi<{ name: string; incident?: { opened_at: string; kind: string; detail: string } }[]>("/internal/status");
      appsOkAt = t;
      return apps.filter((a) => a.incident && age(a.incident.opened_at, t) > DOWN_MS).map((a) => ({ key: a.name, critical: true, reason: `app ${a.name} unhealthy for ${mins(age(a.incident!.opened_at, t))} (${a.incident!.kind}); the app-incident loop hasn't fixed it` }));
    },
    // Apps' quality checks: findings for the app's owner (Fleet Ops routes them), separate from the `app` availability group.
    async quality() {
      const r = await appsApi<{ apps?: QualityRow[] }>("/internal/quality", undefined, { auth: true });
      if (!r.apps) return undefined;
      return qualityFindings(r.apps, Object.keys(detectorState(store).open));
    },
    async service() {
      const down = now() - appsOkAt;
      return down > DOWN_MS ? [{ key: "apps-mcp", critical: true, reason: `apps-mcp (the apps platform) not answering for ${mins(down)}` }] : [];
    },
    async source() {
      const t = now();
      const r = await appsApi<{ sources?: SourceRow[] }>("/internal/sources", undefined, { auth: true });
      if (!r.sources) return undefined; // the warehouse isn't set up
      // Which source and since when only: the agent reads the error itself with warehouse_query.
      return staleSources(r.sources, t);
    },
    // Monitoring alerts (Alertmanager's webhook, monitoring.ts): one incident per firing alert, recovered when it resolves.
    async alert() {
      return alertIncidents(store);
    },
    async pr() {
      const r = await appsApi<{ prs?: PrRow[] }>("/internal/open-prs", undefined, { auth: true });
      if (!r.prs) return undefined; // no warehouse or no agents org
      return stalePrs(r.prs, now());
    },
  };
}

const readFile = (f: string | undefined) => {
  try {
    return f ? readFileSync(f, "utf8").trim() : "";
  } catch {
    return "";
  }
};

/** Fires the routine's webhook, signed like apps-mcp's incident webhook. False when it isn't wired yet or didn't take it. */
export async function fireWebhook(body: unknown, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const [url, secret] = [readFile(env.FLEET_OPS_WEBHOOK_URL_FILE), readFile(env.FLEET_OPS_WEBHOOK_SECRET_FILE)];
  if (!url || !secret) return false;
  const ts = String(Math.floor(Date.now() / 1000));
  const text = JSON.stringify(body);
  const sig = createHmac("sha256", secret).update(`${ts}.${text}`).digest("hex");
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-paperclip-timestamp": ts, "x-paperclip-signature": `sha256=${sig}` }, body: text, signal: AbortSignal.timeout(15_000) });
  // 409: a run is already going (coalesced): it reads the current state from fleet_status.
  return [200, 202, 409].includes(res.status);
}

let runNow: () => void = () => {};
/** Runs the detector now (a monitoring alert arrived) instead of at its next tick; nothing when it is off or already running. */
export const kickDetector = () => runNow();

/** Starts the detector when the module is on (main.ts). */
export function startDetector(pc: Paperclip, store: Store, grading: Grading, log: { info(o: object, m: string): void; warn(o: object, m: string): void }, env: NodeJS.ProcessEnv = process.env): void {
  const minutes = Number(env.FLEET_OPS_INTERVAL_MINUTES);
  if (!(minutes > 0)) return;
  const all = checks(pc, store, grading, undefined, (o, m) => log.warn(o, m));
  let busy = false;
  const run = async () => {
    if (busy || !readFile(env.FLEET_OPS_WEBHOOK_URL_FILE)) return; // not wired yet: setup writes the webhook after compose starts
    busy = true;
    try {
      await tick(store, all, async (body) => {
        const ok = await fireWebhook(body, env);
        const b = body as { incidents: { key: string }[]; recovered: { key: string }[] };
        log.info({ ok, incidents: b.incidents.map((i) => i.key), recovered: b.recovered.map((r) => r.key) }, "fleet-ops webhook");
        return ok;
      }, new Date(), QUIET_MS);
      store.events.emit("fleet"); // open boards refresh the fleet's health (events.ts)
    } catch (err) {
      log.warn({ err: String(err) }, "fleet-ops detector failed");
    } finally {
      busy = false;
    }
  };
  runNow = () => void run();
  setInterval(run, Math.max(1, minutes) * MIN).unref();
  setTimeout(run, MIN).unref();
  log.info({ minutes }, "fleet-ops detector on");
}
