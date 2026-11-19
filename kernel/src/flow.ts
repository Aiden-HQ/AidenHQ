// Flow's views (docs/design/flow.md §5), derived from the fact log (facts.ts) on a read-only connection, so a definition can
// change without re-instrumenting:
//   task(id) / item(id)   the waterfall: every stage occurrence (start, end, actor), the facts, and every idle period with its reason
//   summary({since, to, by, scope})  per stage work and wait (p50/p75, wait by reason), DORA, churn and the fleet metrics
//   idleNow()             tasks idle now, oldest first
// A stage pairs a `to` fact with the latest open `from` fact of the same subject; a `to` that fails the stage's `where`
// leaves it open, and an occurrence still open at the end after such a `to` is dropped (the record went the other way).
// A task is idle while a task fact shows it open, no job of its own is queued (from its wake) or running, and no stage of it
// is open other than a wait the reasons below name (a stage starting at record.filed or work.waiting). The reason, in order: the
// latest unexpired `work.waiting`, an open record (owner, else reviewer), a blocker not done, an open child task, a future
// scheduled wake; then, for the gap still open now with no wake pending, `orphaned`; otherwise `unknown`, never a guess.
// A stage a module's fact opened counts as work for 24 hours at most; after that its task is idle as `stage_open:<name>`
// (a module that never closes its stage can't hold an item busy). Reads are bounded: a waterfall at 5,000 facts, a summary or
// idle read at 50,000 (`truncated` when cut); a summary is reused for 60 s.
// Reasons are evaluated at every fact inside a gap, so a gap splits where its cause changes. Durations are seconds, ratios 0..1.
import { DatabaseSync } from "node:sqlite";
import type { FactRow } from "./facts.ts";
import type { Stage } from "./flow-stages.ts";
import { link, type Change, type Text } from "../sdk/src/quality.ts";

export type Occurrence = { name: string; label: string; module: string; from: string; start: string; end: string | null; actor: string; task: string; subject: string; module_fact: boolean };
export type Idle = { task: string; start: string; end: string | null; reason: string; blocked_on?: string; holder: string };
export type Waterfall = { task: string; root: string; facts: FactRow[]; stages: Occurrence[]; idle: Idle[]; truncated: boolean };
export type By = "stage" | "agent" | "module" | "repo" | "model";
export const BY: By[] = ["stage", "agent", "module", "repo", "model"];

const DAY = 864e5;
const CLOSED = new Set(["done", "cancelled"]);
const ROWS = 50_000; // the most facts one summary or idle read loads
const TASK_ROWS = 5_000; // the most facts one waterfall loads
const STALE = DAY; // how long a stage a module opened counts as work
/** A module's fact: its version carries the module (POST /v1/facts, codehost localFacts). */
const moduleFact = (f: FactRow) => /^[a-z][a-z0-9-]*\//.test(f.version);
const ms = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();
const sec = (n: number) => Math.round(n / 1000);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const taskOf = (f: FactRow) => f.task ?? (f.subject.startsWith("task:") ? f.subject.slice(5) : null);
const byTime = (a: FactRow, b: FactRow) => a.at.localeCompare(b.at) || a.seq - b.seq;
/** Nearest-rank percentile of sorted numbers. */
const pct = (xs: number[], q: number) => xs[Math.max(0, Math.ceil(q * xs.length) - 1)]!;
const p50 = (xs: number[]) => (xs.length ? pct([...xs].sort((a, b) => a - b), 0.5) : null);
const ratio = (a: number, b: number) => (b ? a / b : null);

/** Stage occurrences over facts (any order). */
export function pair(facts: FactRow[], stages: Stage[]): Occurrence[] {
  const sorted = [...facts].sort(byTime);
  const out: Occurrence[] = [];
  for (const s of stages) {
    const matches = (f: FactRow) => Object.entries(s.where ?? {}).every(([k, v]) => String(f.data[k]) === v);
    const occ = (from: FactRow, to?: FactRow): Occurrence => ({
      name: s.name, label: s.label, module: s.module, from: s.from, start: (s.start && str(from.data[s.start])) || from.at, end: to?.at ?? null,
      actor: to && to.actor !== "unknown" ? to.actor : from.actor, task: from.task ?? to?.task ?? "", subject: from.subject, module_fact: moduleFact(from),
    });
    const open = new Map<string, { f: FactRow; stale: boolean }[]>();
    for (const f of sorted) {
      if (s.from === s.to) { if (f.type === s.from && matches(f)) out.push(occ(f, f)); continue; }
      if (f.type === s.to) {
        const list = open.get(f.subject) ?? [];
        if (matches(f)) { const o = list.pop(); if (o) out.push(occ(o.f, f)); } else for (const o of list) o.stale = true;
      }
      if (f.type === s.from) open.set(f.subject, [...(open.get(f.subject) ?? []), { f, stale: false }]);
    }
    for (const list of open.values()) for (const o of list) if (!o.stale) out.push(occ(o.f));
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Facts indexed for the idle rule: by task (a `task:<id>` subject counts as its task), by subject, and children by parent. */
function index(rows: FactRow[]) {
  const byTask = new Map<string, FactRow[]>(), bySubject = new Map<string, FactRow[]>(), children = new Map<string, string[]>(), ident = new Map<string, string>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const f of [...rows].sort(byTime)) {
    const t = taskOf(f);
    if (t) push(byTask, t, f);
    push(bySubject, f.subject, f);
    if (f.type === "task.created" && f.subject.startsWith("task:")) {
      const id = f.subject.slice(5), parent = str(f.data.parent);
      if (parent && !children.get(parent)?.includes(id)) push(children, parent, id);
      if (str(f.data.identifier)) ident.set(id, f.data.identifier as string);
    }
  }
  return { byTask, bySubject, children, ident };
}
type Index = ReturnType<typeof index>;

/** A task's status at `t` from its status facts; open when none says otherwise. */
function closedAt(x: Index, task: string, t: number) {
  let closed = false;
  for (const f of x.bySubject.get(`task:${task}`) ?? []) if (f.type === "task.status_changed" && ms(f.at) <= t) closed = CLOSED.has(String(f.data.to ?? ""));
  return closed;
}

/** Why a task is idle at `t`; `now`: the gap is still open now, so `orphaned` may apply. `stale`: the task's open stages a module opened. */
function reasonAt(x: Index, task: string, t: number, now: boolean, stale: Occurrence[]): { reason: string; blocked_on?: string } {
  // 0. a stage a module opened over a day ago and still open
  const st = stale.find((o) => ms(o.start) + STALE <= t && (!o.end || ms(o.end) > t));
  if (st) return { reason: `stage_open:${st.name}` };
  // one pass over the task's facts up to t (they are in time order): the latest wait or resume per subject, records filed, the blocker list
  const lastWait = new Map<string, FactRow>(), filed = new Set<string>();
  let blocked: FactRow | undefined;
  const wakes: FactRow[] = [];
  for (const f of x.byTask.get(task) ?? []) {
    if (f.type === "wake.opened" && ms(f.seen_at) <= t) wakes.push(f);
    if (ms(f.at) > t) continue;
    if (f.type === "work.waiting" || f.type === "work.resumed") lastWait.set(f.subject, f);
    else if (f.type === "record.filed") filed.add(f.subject);
    else if (f.type === "task.blocked_changed" && f.subject === `task:${task}`) blocked = f;
  }
  // 1. the latest unexpired work.waiting, not resumed since
  let waiting: FactRow | undefined;
  for (const w of lastWait.values()) if (w.type === "work.waiting" && !(str(w.data.until) && ms(w.data.until as string) <= t) && (!waiting || byTime(w, waiting) > 0)) waiting = w;
  if (waiting) return { reason: String(waiting.data.reason ?? "unknown") };
  // 2. an open record: the owner's when filed for the owner first, held for them or escalated, else the reviewer's
  let record: string | undefined;
  for (const s of filed) {
    let done = false, owner = false;
    for (const f of x.bySubject.get(s) ?? []) {
      if (ms(f.at) > t) break;
      const escalated = f.type === "record.decided" && /^(escalate|owner)$/.test(String(f.data.decision));
      if ((f.type === "record.decided" && !escalated) || f.type === "record.landed" || f.type === "record.failed") done = true;
      if (f.type === "record.held" || escalated || (f.type === "record.filed" && f.data.state === "owner")) owner = true;
    }
    if (!done) record = owner ? "owner" : record ?? "reviewer";
  }
  if (record) return { reason: record };
  // 3. a blocker not done
  const blocker = (Array.isArray(blocked?.data.blocked_by) ? (blocked!.data.blocked_by as unknown[]) : []).map(String).find((b) => !closedAt(x, b, t));
  if (blocker) return { reason: "blocked", blocked_on: x.ident.get(blocker) ?? blocker };
  // 4. an open child task
  if ((x.children.get(task) ?? []).some((c) => (x.bySubject.get(`task:${c}`) ?? []).some((f) => f.type === "task.created" && ms(f.at) <= t) && !closedAt(x, c, t))) return { reason: "delegated" };
  // 5. a future scheduled wake (known by then, not yet bound or dropped)
  const pending = wakes.filter((f) => !(x.bySubject.get(f.subject) ?? []).some((g) => (g.type === "wake.bound" || g.type === "wake.dropped") && ms(g.at) <= t));
  if (pending.some((w) => ms(w.at) > t)) return { reason: "scheduled" };
  // 6. still idle now and nothing pending
  return { reason: now && !pending.length ? "orphaned" : "unknown" };
}

/** Stages whose open interval is a wait the idle reasons name, not work going on. */
const WAITS = new Set(["record.filed", "work.waiting"]);

/** A task's idle periods up to `now`; `occs`: the stage occurrences (any task's). None when no task fact says it was open. */
function idleOf(x: Index, task: string, now: number, occs: Occurrence[]): Idle[] {
  const fs = x.byTask.get(task) ?? [];
  const own = fs.filter((f) => f.subject === `task:${task}`);
  if (!own.some((f) => f.type === "task.created" || f.type === "task.status_changed")) return [];
  // open intervals, from creation (else its first fact) through status changes
  const open: [number, number][] = [];
  let from: number | null = ms((own.find((f) => f.type === "task.created") ?? fs[0]!).at);
  for (const f of own) if (f.type === "task.status_changed") {
    if (CLOSED.has(String(f.data.to ?? ""))) { if (from !== null) open.push([from, ms(f.at)]); from = null; } else if (from === null) from = ms(f.at);
  }
  if (from !== null) open.push([from, now]);
  // busy: each job from its wake (queued) to its end, or still running
  const jobs = new Map<string, [number, number]>();
  for (const f of fs) if (f.subject.startsWith("job:")) {
    const j = jobs.get(f.subject) ?? [Infinity, now];
    if (f.type === "job.queued") j[0] = Math.min(j[0], ms(str(f.data.wake_at) ?? f.at));
    if (f.type === "job.started") j[0] = Math.min(j[0], ms(f.at));
    if (f.type === "job.ended") j[1] = ms(f.at);
    jobs.set(f.subject, j);
  }
  const mine = occs.filter((o) => o.task === task && !WAITS.has(o.from));
  // a stage a module opened is work for a day at most
  const busy = [...[...jobs.values()].filter(([s]) => s < Infinity),
    ...mine.map((o): [number, number] => { const e = o.end ? ms(o.end) : now; return [ms(o.start), o.module_fact ? Math.min(e, ms(o.start) + STALE) : e]; })].sort((a, b) => a[0] - b[0]);
  const stale = mine.filter((o) => o.module_fact && (o.end ? ms(o.end) : now) > ms(o.start) + STALE);
  const gaps: [number, number][] = [];
  for (const [s, e] of open) {
    let cur = s;
    for (const [bs, be] of busy) { if (be <= cur || bs >= e) continue; if (bs > cur) gaps.push([cur, bs]); cur = Math.max(cur, be); }
    if (cur < e) gaps.push([cur, e]);
  }
  // split each gap where its cause may change: at every fact inside it
  const marks: number[] = stale.map((o) => ms(o.start) + STALE);
  for (const f of [...fs, ...(x.children.get(task) ?? []).flatMap((c) => x.bySubject.get(`task:${c}`) ?? [])]) {
    marks.push(ms(f.at), ms(f.seen_at));
    if (str(f.data.until)) marks.push(ms(f.data.until as string));
  }
  const assigns = own.filter((f) => f.type === "task.assignee_changed");
  const assignee = (t: number) => { let a = "unknown"; for (const f of assigns) { if (ms(f.at) > t) break; a = str(f.data.to) ?? "unknown"; } return a; };
  const out: Idle[] = [];
  for (const [s, e] of gaps) {
    const points = [s, ...new Set(marks.filter((m) => m > s && m < e))].sort((a, b) => a - b);
    points.forEach((p, i) => {
      const end = points[i + 1] ?? e, last = i === points.length - 1, openNow = last && e >= now;
      const r = reasonAt(x, task, openNow ? now : p, openNow, stale);
      const prev = out.at(-1);
      if (prev && prev.end === iso(p) && prev.reason === r.reason && prev.blocked_on === r.blocked_on) prev.end = openNow ? null : iso(end);
      else out.push({ task, start: iso(p), end: openNow ? null : iso(end), reason: r.reason, ...(r.blocked_on ? { blocked_on: r.blocked_on } : {}), holder: assignee(p) });
    });
  }
  return out;
}

/** Union of labelled segments clipped to [s, e], earlier-listed segments winning: seconds per label. */
function cover(segs: { s: number; e: number; reason: string }[], s: number, e: number): Record<string, number> {
  const cut = [...new Set([s, e, ...segs.flatMap((g) => [g.s, g.e]).filter((t) => t > s && t < e)])].sort((a, b) => a - b);
  const out: Record<string, number> = {};
  for (let i = 0; i + 1 < cut.length; i++) {
    const hit = segs.find((g) => g.s <= cut[i]! && g.e >= cut[i + 1]!);
    if (hit) out[hit.reason] = (out[hit.reason] ?? 0) + (cut[i + 1]! - cut[i]!);
  }
  return out;
}

/** Intervals a subject spends in `type` until the next fact of `type` or `ends` on it (or `until`, or `now`). */
function spans(fs: FactRow[], type: string, ends: string[], now: number) {
  const out: { s: number; e: number; reason: string }[] = [];
  fs.forEach((f, i) => {
    if (f.type !== type) return;
    let next: FactRow | undefined;
    for (let j = i + 1; j < fs.length && !next; j++) if (fs[j]!.type === type || ends.includes(fs[j]!.type)) next = fs[j];
    out.push({ s: ms(f.at), e: Math.min(next ? ms(next.at) : now, str(f.data.until) ? ms(f.data.until as string) : Infinity), reason: String(f.data.reason ?? "unknown") });
  });
  return out;
}

export function createFlow({ db, file, stages, now = () => new Date(), incident = () => false, cacheMs = 60_000 }: {
  /** The kernel's db (tests), or its file, opened here read-only (the kernel: reads never block the approval path). */
  db?: DatabaseSync; file?: string; stages: () => Stage[]; now?: () => Date;
  /** Whether a `task.created` fact files an incident (the incident module's marker), for DORA's failure and restore. */
  incident?: (f: FactRow) => boolean;
  /** How long a summary is reused for the same minute-rounded window, by and scope. */
  cacheMs?: number;
}) {
  const conn = db ?? new DatabaseSync(file!, { readOnly: true });
  if (!db) conn.exec("PRAGMA busy_timeout = 5000");
  const row = (r: any): FactRow => ({ ...r, data: JSON.parse(r.data) });
  const all = (sql: string, ...args: (string | number)[]) => (conn.prepare(sql).all(...args) as any[]).map(row);
  const chunked = (sql: (marks: string) => string, ids: string[], ...after: string[]) => {
    const out: FactRow[] = [];
    for (let i = 0; i < ids.length; i += 400) { const c = ids.slice(i, i + 400); out.push(...all(sql(c.map(() => "?").join(",")), ...c, ...after)); }
    return out;
  };
  const parentOf = (task: string) => str(all("SELECT * FROM facts WHERE type = 'task.created' AND subject = ? ORDER BY seq DESC LIMIT 1", `task:${task}`)[0]?.data.parent);
  const rootOf = (task: string) => { let t = task; const seen = new Set([t]); for (let p = parentOf(t); p && !seen.has(p); p = parentOf(p)) seen.add((t = p)); return t; };
  const childrenOf = (tasks: string[]) => chunked((m) => `SELECT * FROM facts WHERE type = 'task.created' AND json_extract(data, '$.parent') IN (${m})`, tasks).map((f) => f.subject.slice(5));

  /** The facts of these tasks, of every subject they touch, and of their children and blockers (for idle reasons). */
  function load(tasks: string[]) {
    const main = new Map<number, FactRow>(), add = (m: Map<number, FactRow>, rs: FactRow[]) => rs.forEach((r) => m.set(r.seq, r));
    const newest = ` ORDER BY seq DESC LIMIT ${TASK_ROWS + 1}`;
    add(main, chunked((m) => `SELECT * FROM facts WHERE task IN (${m})${newest}`, tasks));
    add(main, chunked((m) => `SELECT * FROM facts WHERE subject IN (${m})${newest}`, tasks.map((t) => `task:${t}`)));
    add(main, chunked((m) => `SELECT * FROM facts WHERE subject IN (${m})${newest}`, [...new Set([...main.values()].map((f) => f.subject).filter((s) => !s.startsWith("task:")))]));
    const truncated = main.size > TASK_ROWS;
    if (truncated) for (const seq of [...main.keys()].sort((a, b) => a - b).slice(0, main.size - TASK_ROWS)) main.delete(seq);
    const related = [...new Set([...childrenOf(tasks), ...[...main.values()].filter((f) => f.type === "task.blocked_changed").flatMap((f) => (Array.isArray(f.data.blocked_by) ? f.data.blocked_by.map(String) : []))])];
    const ctx = new Map(main);
    add(ctx, chunked((m) => `SELECT * FROM facts WHERE subject IN (${m})${newest}`, related.map((t) => `task:${t}`)));
    return { facts: [...main.values()].sort(byTime), ctx: index([...ctx.values()]), truncated };
  }

  function waterfall(task: string, tasks: string[]): Waterfall {
    const { facts, ctx, truncated } = load(tasks);
    const t = now().getTime();
    const occs = pair(facts, stages());
    return { task, root: rootOf(task), facts, stages: occs, idle: tasks.flatMap((id) => idleOf(ctx, id, t, occs)).sort((a, b) => a.start.localeCompare(b.start)), truncated };
  }

  /**
   * Facts from `from` to `to` (plus wakes known by then for later), the newest ROWS of them (`truncated` when more), and the
   * `task:` facts of every task they touch whatever their age (whether it is open).
   */
  const window = (from: number, to: number) => {
    const rows = all(`SELECT * FROM facts WHERE (at >= ? AND at < ?) OR (type = 'wake.opened' AND at >= ? AND seen_at < ?) ORDER BY at DESC, seq DESC LIMIT ${ROWS + 1}`, iso(from), iso(to), iso(to), iso(to));
    const truncated = rows.length > ROWS, kept = new Map(rows.slice(0, ROWS).map((r) => [r.seq, r]));
    const tasks = [...new Set([...kept.values()].map(taskOf).filter((t): t is string => Boolean(t)))];
    for (const r of chunked((m) => `SELECT * FROM facts WHERE subject IN (${m}) AND at < ?`, tasks.map((t) => `task:${t}`), iso(to))) kept.set(r.seq, r);
    return { rows: [...kept.values()].sort(byTime), truncated };
  };

  function summarize({ since, to, by = "stage", scope }: { since: string; to?: string; by?: By; scope?: string }) {
    const t0 = ms(since), t1 = to ? ms(to) : now().getTime(), days = Math.max((t1 - t0) / DAY, 1 / 24);
    // 90 days back, so a stage that began before `since` still pairs
    const { rows, truncated } = window(t0 - 90 * DAY, t1);
    const x = index(rows);
    const inWin = (f: { at: string } | FactRow) => ms(f.at) >= t0 && ms(f.at) < t1;
    const idle = new Map<string, Idle[]>();
    const occs = pair(rows, stages());
    const idleFor = (task: string) => idle.get(task) ?? (idle.set(task, idleOf(x, task, t1, occs)), idle.get(task)!);
    const jobEnd = new Map(rows.filter((f) => f.type === "job.ended").map((f) => [f.subject, f]));
    const keyOf = (o: Occurrence): string | undefined => {
      if (by === "stage") return undefined;
      if (by === "agent") return o.actor;
      if (by === "module") return o.module;
      if (by === "repo") return /^pr:([^#]+)#/.exec(o.subject)?.[1] ?? str(x.bySubject.get(o.subject)?.[0]?.data.repo) ?? "-";
      return str(jobEnd.get(o.subject)?.data.model) ?? "-";
    };

    // stages: work and wait per occurrence that ended in the window
    const groups = new Map<string, { o: Occurrence; key?: string; work: number[]; wait: number[]; total: { task: string; s: number }[]; waits: Record<string, number> }>();
    for (const o of occs) {
      if (!o.end || ms(o.end) < t0 || ms(o.end) >= t1 || (scope && scope !== "all" && o.module !== scope)) continue;
      const s = ms(o.start), e = ms(o.end), sub = x.bySubject.get(o.subject) ?? [];
      const segs = [...spans(sub, "work.waiting", ["work.resumed"], t1), ...spans(sub, "job.held", ["job.started"], t1),
        ...(o.task ? idleFor(o.task) : []).map((i) => ({ s: ms(i.start), e: i.end ? ms(i.end) : t1, reason: i.reason }))];
      const waits = cover(segs, s, e), wait = Object.values(waits).reduce((a, b) => a + b, 0);
      const key = keyOf(o), k = `${o.name}\0${key ?? ""}`;
      const g = groups.get(k) ?? { o, key, work: [], wait: [], total: [], waits: {} };
      g.work.push(sec(e - s - wait)); g.wait.push(sec(wait)); g.total.push({ task: o.task, s: sec(e - s) });
      for (const [r, v] of Object.entries(waits)) g.waits[r] = (g.waits[r] ?? 0) + sec(v);
      groups.set(k, g);
    }
    const order = stages().map((s) => s.name);
    const stageRows = [...groups.values()].sort((a, b) => order.indexOf(a.o.name) - order.indexOf(b.o.name) || (a.key ?? "").localeCompare(b.key ?? "")).map((g) => {
      const n = g.work.length, sw = [...g.work].sort((a, b) => a - b), sv = [...g.wait].sort((a, b) => a - b);
      const totals = [...g.total].sort((a, b) => b.s - a.s), cut = n >= 5 ? pct([...totals].map((t) => t.s).sort((a, b) => a - b), 0.75) : 0;
      return {
        name: g.o.name, label: g.o.label, ...(g.key !== undefined ? { key: g.key } : {}), n,
        ...(n >= 5 ? { work_p50: pct(sw, 0.5), work_p75: pct(sw, 0.75), wait_p50: pct(sv, 0.5), wait_p75: pct(sv, 0.75) } : { samples: g.total.map((t) => t.s) }),
        waits: g.waits,
        slow: totals.filter((t) => t.s >= cut).slice(0, 20).map((t) => ({ task: t.task, identifier: x.ident.get(t.task) ?? null, seconds: t.s })),
      };
    });

    // DORA
    const deploys = rows.filter((f) => f.type === "deploy.applied" && inWin(f));
    const failedHealth = (f: FactRow) => f.data.health === false || /fail|unhealthy|down/i.test(String(f.data.health ?? ""));
    const prKey = (subject: string) => subject.replace(/^pr:/, "").replace(/@.*$/, "").toLowerCase();
    const deployedPr = rows.filter((f) => f.type === "pr.deployed");
    const genOf = new Map(deployedPr.map((f) => [prKey(str(f.data.pr) ? `pr:${f.data.pr}` : f.subject), String(f.data.generation)]));
    const merged = new Map(rows.filter((f) => f.type === "pr.merged").map((f) => [prKey(f.subject), str(f.data.sha)]));
    const changes: Change[] = [...genOf.keys()].map((pr) => ({ id: pr, tier: "ran", at: "", keys: [pr, ...(merged.get(pr) ? [merged.get(pr)!.toLowerCase()] : [])], link: "", label: pr }));
    const failed = new Set(deploys.filter(failedHealth).map((d) => String(d.data.generation)));
    for (const d of rows) if (d.type === "deploy.applied" && d.data.revert_of != null) failed.add(String(d.data.revert_of));
    const linked = (t: Text) => { const l = link(t, changes); return l === "unknown" || l === "none" ? undefined : genOf.get(l.change.id); };
    for (const f of rows.filter((f) => f.type === "pr.reverted")) {
      const [repo, num] = prKey(f.subject).split("#");
      const g = linked({ id: f.id, title: "Revert", body: [f.data.of_pr, f.data.of_sha].filter((v) => typeof v === "string").join(" "), repo, number: Number(num) || undefined });
      if (g) failed.add(g);
    }
    const incidents = rows.filter((f) => f.type === "task.created" && incident(f));
    for (const f of incidents) { const g = linked({ id: f.id, title: String(f.data.title ?? ""), body: String(f.data.source_marker ?? "") }); if (g) failed.add(g); }
    const opened = new Map<string, number>();
    for (const f of rows) if (f.type === "pr.opened" && !opened.has(prKey(f.subject))) opened.set(prKey(f.subject), ms(f.at));
    const allDeploys = rows.filter((f) => f.type === "deploy.applied");
    const restores = [
      ...deploys.filter(failedHealth).map((d) => { const n = allDeploys.find((g) => ms(g.at) > ms(d.at) && !failedHealth(g)); return n ? sec(ms(n.at) - ms(d.at)) : undefined; }),
      ...incidents.filter(inWin).map((f) => { const ids = new Set([f.subject.slice(5), ...(x.children.get(f.subject.slice(5)) ?? [])]); const d = deployedPr.find((p) => p.task && ids.has(p.task) && ms(p.at) > ms(f.at)); return d ? sec(ms(d.at) - ms(f.at)) : undefined; }),
    ].filter((v): v is number => v !== undefined);
    const dora = deploys.length ? {
      deploys_per_day: deploys.filter((d) => !failedHealth(d)).length / days,
      lead_p50: p50(deployedPr.filter(inWin).map((p) => { const o = opened.get(prKey(p.subject)); return o === undefined ? undefined : sec(ms(p.at) - o); }).filter((v): v is number => v !== undefined)),
      failure_rate: deploys.filter((d) => failed.has(String(d.data.generation))).length / deploys.length,
      restore_p50: p50(restores),
    } : null;

    // churn: the mature cohort (PRs merged over 30 days before `to`)
    const added = rows.filter((f) => f.type === "code.added"), rewritten = rows.filter((f) => f.type === "code.rewritten");
    let churn = null;
    if (added.length || rewritten.length) {
      const cohort = new Map(added.filter((f) => ms(f.at) <= t1 - 30 * DAY).map((f) => [String(f.data.pr), Number(f.data.lines) || 0]));
      const lines = [...cohort.values()].reduce((a, b) => a + b, 0);
      const re = rewritten.filter((f) => cohort.has(String(f.data.pr)) && Number(f.data.days) <= 30).reduce((a, f) => a + (Number(f.data.lines) || 0), 0);
      const byPr = new Map<string, { by: Set<string>; lines: number }>();
      for (const f of rewritten) { const c = byPr.get(String(f.data.pr)) ?? { by: new Set(), lines: 0 }; c.by.add(String(f.data.by_pr)); c.lines += Number(f.data.lines) || 0; byPr.set(String(f.data.pr), c); }
      churn = { rewritten_30d: ratio(re, lines), hot_lines: [...byPr.values()].filter((c) => c.by.size >= 3).reduce((a, c) => a + c.lines, 0) };
    }

    // fleet
    const w = rows.filter(inWin);
    const done = new Set(w.filter((f) => f.type === "task.status_changed" && f.data.to === "done").map((f) => taskOf(f)!));
    const ended = w.filter((f) => f.type === "job.ended");
    const cost = (fs: FactRow[]) => fs.reduce((a, f) => a + (Number(f.data.cost_usd) || 0), 0);
    const noAction = w.filter((f) => f.type === "wake.bound").map((f) => jobEnd.get(`job:${f.data.job}`) ?? jobEnd.get(String(f.data.job))).filter((j): j is FactRow => j?.data.acted === false);
    const held: Record<string, number> = {};
    for (const [s, fs] of x.bySubject) if (s.startsWith("job:")) for (const h of spans(fs, "job.held", ["job.started"], t1)) {
      const v = Math.min(h.e, t1) - Math.max(h.s, t0); if (v > 0) held[h.reason] = (held[h.reason] ?? 0) + sec(v);
    }
    const firstBy = (type: string, ok: (f: FactRow) => boolean, keep: (f: FactRow) => boolean = () => true) => {
      const first = new Map<string, FactRow>();
      for (const f of w) if (f.type === type && keep(f) && f.task && !first.has(f.task)) first.set(f.task, f);
      return ratio([...first.values()].filter(ok).length, first.size);
    };
    const oldest: Record<string, { task: string; since: string }> = {};
    for (const o of occs) if (!o.end && (!oldest[o.name] || o.start < oldest[o.name]!.since)) oldest[o.name] = { task: o.task, since: o.start };
    const assigned = w.filter((f) => f.type === "task.assignee_changed");
    const owner = w.filter((f) => (f.type === "record.decided" && (f.data.decider === "owner" || f.actor.startsWith("account:"))) || (f.type === "wake.opened" && String(f.data.author ?? "").startsWith("account:"))).length;
    const lastStatus = (task: string) => (x.bySubject.get(`task:${task}`) ?? []).filter((f) => f.type === "task.status_changed").at(-1)?.data.to;
    const fleet = {
      oldest_by_stage: oldest,
      arrivals: w.filter((f) => f.type === "task.created").length,
      completions: done.size,
      retries_per_outcome: ratio(Math.max(0, ended.filter((f) => f.task && done.has(f.task)).length - done.size), done.size),
      no_action_wakes: noAction.length + w.filter((f) => f.type === "wake.dropped").length,
      no_action_cost: cost(noAction),
      held_seconds_by_reason: held,
      first_pass_grade: firstBy("grade.verdict", (f) => f.data.pass === true),
      first_pass_review: firstBy("record.decided", (f) => /^approve/.test(String(f.data.decision)), (f) => f.data.decider === "reviewer"),
      handoffs: assigned.filter((f) => str(f.data.from)).length,
      time_to_first_action_p50: p50(assigned.filter((f) => str(f.data.to)).map((a) => { const j = (x.byTask.get(taskOf(a)!) ?? []).find((f) => f.type === "job.started" && byTime(f, a) > 0); return j ? sec(ms(j.at) - ms(a.at)) : undefined; }).filter((v): v is number => v !== undefined)),
      owner_interventions_per_outcome: ratio(owner, done.size),
      cost_per_outcome: ratio(cost(ended), done.size),
      wasted_cost: cost(ended.filter((f) => f.data.acted === false || (f.task && lastStatus(f.task) === "cancelled"))),
    };
    return { since: iso(t0), to: iso(t1), by, scope: scope ?? "all", truncated, stages: stageRows, dora, churn, fleet };
  }
  const cache = new Map<string, { at: number; value: ReturnType<typeof summarize> }>();

  return {
    task: (id: string) => waterfall(id, [id]),
    /** The work item: the root of the task's tree and every descendant. */
    item(id: string): Waterfall {
      const root = rootOf(id), tasks = [root];
      for (let level = [root]; level.length && tasks.length < 500; ) { level = childrenOf(level).filter((c) => !tasks.includes(c)); tasks.push(...level); }
      return { ...waterfall(root, tasks.slice(0, 500)), task: id };
    },

    summary(q: { since: string; to?: string; by?: By; scope?: string }) {
      const minute = (t: number) => Math.floor(t / 60_000);
      const key = [minute(ms(q.since)), minute(q.to ? ms(q.to) : now().getTime()), q.by ?? "stage", q.scope ?? "all"].join("|");
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < cacheMs) return hit.value;
      const value = summarize(q);
      for (const [k, v] of cache) if (Date.now() - v.at >= cacheMs) cache.delete(k);
      if (cacheMs > 0) cache.set(key, { at: Date.now(), value });
      return value;
    },

    /** Tasks idle now (facts of the last 90 days), oldest first. */
    idleNow() {
      const t = now().getTime(), { rows, truncated } = window(t - 90 * DAY, t + 1), x = index(rows), occs = pair(rows, stages());
      const items: { task: string; identifier: string | null; since: string; reason: string; holder: string }[] = [];
      for (const task of x.byTask.keys()) {
        const gaps = idleOf(x, task, t, occs), last = gaps.at(-1);
        if (!last || last.end !== null) continue;
        let since = last.start;
        for (let i = gaps.length - 2; i >= 0 && gaps[i]!.end === since; i--) since = gaps[i]!.start;
        items.push({ task, identifier: x.ident.get(task) ?? null, since, reason: last.reason, holder: last.holder });
      }
      return { items: items.sort((a, b) => a.since.localeCompare(b.since)), truncated };
    },
  };
}
export type Flow = ReturnType<typeof createFlow>;
