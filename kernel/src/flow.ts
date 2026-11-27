// Flow's views (docs/design/flow.md §5), derived from the fact log (facts.ts) on a read-only connection, so a definition can
// change without re-instrumenting:
//   task(id) / item(id)   the waterfall: every stage occurrence (start, end, actor), the facts, and every idle period with its reason
//   summary({since, to, by, scope})  per stage work and wait (p50/p75, wait by reason), DORA, churn and the fleet metrics
//   journey({name, ...})  a declared journey's items (journeys.ts), each a bar of phase blocks; the summary adds its insights
// A stage pairs a `to` fact with the latest open `from` fact of the same subject; a `to` that fails the stage's `where`
// leaves it open, and an occurrence still open at the end after such a `to` is dropped (the record went the other way).
// A task is idle while a task fact shows it open, no job of its own is queued (from its wake) or running, and no stage of it
// is open other than a wait the reasons below name (a stage starting at record.filed or work.waiting). The reason, in order: the
// latest unexpired `work.waiting` (an agent's own wait, task_wait's `wait:<task>` subject, also ends when the task's next job
// starts), an open record (owner, else reviewer), a blocker not done, an open child task, a future
// scheduled wake; then, for the gap still open now with no wake pending, `orphaned`; otherwise `unknown`, never a guess.
// A stage a module's fact opened counts as work for 24 hours at most; after that its task is idle as `stage_open:<name>`
// (a module that never closes its stage can't hold an item busy). Reads are bounded: a waterfall at 5,000 facts, a summary or
// idle read at 50,000 (`truncated` when cut); a summary is reused for 60 s.
// Reasons are evaluated at every fact inside a gap, so a gap splits where its cause changes. Durations are seconds, ratios 0..1.
import { DatabaseSync } from "node:sqlite";
import type { FactRow } from "./facts.ts";
import type { Stage } from "./flow-stages.ts";
import { link, type Change, type Text } from "../sdk/src/quality.ts";
import { buildItems, insights, listItems, type AuthorKind, type Built, type Dora, type Journey, type Sort } from "./journeys.ts";

export type Occurrence = { name: string; label: string; module: string; from: string; start: string; end: string | null; actor: string; task: string; subject: string; module_fact: boolean };
export type Idle = { task: string; start: string; end: string | null; reason: string; blocked_on?: string; note?: string; holder: string };
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

/**
 * A wake not bound this long past its due time, and never held by admission (`job.held`: queued behind the agent's
 * max_parallel, the computers, a spend limit), no longer counts as pending: nothing is taking it to a job.
 */
const PENDING_MAX = 2.5 * 3600_000;
/** When a wake stops counting as pending by age (PENDING_MAX), or never when it closed or admission holds it. */
const agesOut = (x: Index, fs: FactRow[], f: FactRow) =>
  (x.bySubject.get(f.subject) ?? []).some((g) => g.type === "wake.bound" || g.type === "wake.dropped" || g.type === "job.held") || fs.some((g) => g.type === "job.queued" && ms(g.at) >= ms(f.at))
    ? Infinity
    : Math.max(ms(f.at), ms(f.seen_at)) + PENDING_MAX;

/**
 * Why a task is idle, asked at times that never go back (`at(t, now)`; `now`: the gap is still open now, so `orphaned` may
 * apply): one sweep over the task's facts in time order carries the waits, records, blocker and wakes forward, so a gap split
 * at every fact costs one pass, not one per point. `stale`: the task's open stages a module opened.
 */
function reasoner(x: Index, task: string, stale: Occurrence[]) {
  const fs = x.byTask.get(task) ?? [];
  const at = fs.map((f) => ms(f.at));
  let i = 0;
  const lastWait = new Map<string, FactRow>(), records = new Map<string, { done: boolean; owner: boolean }>();
  let blocked: FactRow | undefined;
  // wakes: pending from when the kernel knew of it (seen_at) until bound or dropped, or until a job on the task is queued after it
  // (the kernel settles a comment that arrived before a job started as done, with no fact: that job reads it), or until it ages
  // out (agesOut: one nothing takes to a job makes the task orphaned, so the idle sweep and the steward see it); scheduled while
  // its time is still ahead
  const edges: [number, number, number][] = []; // [time, pending delta, future delta]
  const queued = fs.filter((g) => g.type === "job.queued").map((g) => ms(g.at));
  for (const f of fs) if (f.type === "wake.opened") {
    const due = ms(f.at);
    const s = ms(f.seen_at);
    const close = Math.min(agesOut(x, fs, f), ...(x.bySubject.get(f.subject) ?? []).filter((g) => g.type === "wake.bound" || g.type === "wake.dropped").map((g) => ms(g.at)), ...queued.filter((q) => q >= due));
    if (s < close) { edges.push([s, 1, 0], [close, -1, 0]); if (s < Math.min(due, close)) edges.push([s, 0, 1], [Math.min(due, close), 0, -1]); }
  }
  edges.sort((a, b) => a[0] - b[0]);
  let e = 0, pending = 0, future = 0;
  return (t: number, now: boolean): { reason: string; blocked_on?: string; note?: string } => {
    for (; i < fs.length && at[i]! <= t; i++) {
      const f = fs[i]!;
      if (f.type === "work.waiting" || f.type === "work.resumed") lastWait.set(f.subject, f);
      else if (f.type === "job.started") lastWait.delete(`wait:${task}`);
      else if (f.type === "task.blocked_changed" && f.subject === `task:${task}`) blocked = f;
      else if (f.type.startsWith("record.")) {
        const r = records.get(f.subject) ?? { done: false, owner: false };
        const escalated = f.type === "record.decided" && /^(escalate|owner)$/.test(String(f.data.decision));
        if ((f.type === "record.decided" && !escalated) || f.type === "record.landed" || f.type === "record.failed") r.done = true;
        if (f.type === "record.held" || escalated || (f.type === "record.filed" && f.data.state === "owner")) r.owner = true;
        if (f.type === "record.filed" || records.has(f.subject)) records.set(f.subject, r);
      }
    }
    for (; e < edges.length && edges[e]![0] <= t; e++) { pending += edges[e]![1]; future += edges[e]![2]; }
    // 0. a stage a module opened over a day ago and still open
    const st = stale.find((o) => ms(o.start) + STALE <= t && (!o.end || ms(o.end) > t));
    if (st) return { reason: `stage_open:${st.name}` };
    // 1. the latest unexpired work.waiting, not resumed since
    let waiting: FactRow | undefined;
    for (const w of lastWait.values()) if (w.type === "work.waiting" && !(str(w.data.until) && ms(w.data.until as string) <= t) && (!waiting || byTime(w, waiting) > 0)) waiting = w;
    if (waiting) return { reason: String(waiting.data.reason ?? "unknown"), ...(str(waiting.data.note) ? { note: waiting.data.note as string } : {}) };
    // 2. an open record: the owner's when filed for the owner first, held for them or escalated, else the reviewer's
    let record: string | undefined;
    for (const r of records.values()) if (!r.done) record = r.owner ? "owner" : record ?? "reviewer";
    if (record) return { reason: record };
    // 3. a blocker not done
    const blocker = (Array.isArray(blocked?.data.blocked_by) ? (blocked!.data.blocked_by as unknown[]) : []).map(String).find((b) => !closedAt(x, b, t));
    if (blocker) return { reason: "blocked", blocked_on: x.ident.get(blocker) ?? blocker };
    // 4. an open child task
    if ((x.children.get(task) ?? []).some((c) => (x.bySubject.get(`task:${c}`) ?? []).some((f) => f.type === "task.created" && ms(f.at) <= t) && !closedAt(x, c, t))) return { reason: "delegated" };
    // 5. a future scheduled wake (known by then, not yet bound or dropped)
    if (future > 0) return { reason: "scheduled" };
    // 6. still idle now and nothing pending
    return { reason: now && !pending ? "orphaned" : "unknown" };
  };
}

/** Stages whose open interval is a wait the idle reasons name, not work going on. */
const WAITS = new Set(["record.filed", "work.waiting"]);

/** When a task was open, from its creation (else its first fact) through its status changes, up to `now`; none when no task fact says. */
function openOf(x: Index, task: string, now: number): [number, number][] {
  const fs = x.byTask.get(task) ?? [];
  const own = fs.filter((f) => f.subject === `task:${task}`);
  if (!own.some((f) => f.type === "task.created" || f.type === "task.status_changed")) return [];
  const open: [number, number][] = [];
  let from: number | null = ms((own.find((f) => f.type === "task.created") ?? fs[0]!).at);
  for (const f of own) if (f.type === "task.status_changed") {
    if (CLOSED.has(String(f.data.to ?? ""))) { if (from !== null) open.push([from, ms(f.at)]); from = null; } else if (from === null) from = ms(f.at);
  }
  if (from !== null) open.push([from, now]);
  return open;
}

/** A task's idle periods up to `now`; `occs`: the stage occurrences (any task's). None when no task fact says it was open. */
function idleOf(x: Index, task: string, now: number, occs: Occurrence[]): Idle[] {
  const fs = x.byTask.get(task) ?? [];
  const own = fs.filter((f) => f.subject === `task:${task}`);
  const open = openOf(x, task, now);
  if (!open.length) return [];
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
  // split each gap where its cause may change: at every fact inside it (gaps and marks both ascending: one pointer)
  const marks: number[] = stale.map((o) => ms(o.start) + STALE);
  for (const f of [...fs, ...(x.children.get(task) ?? []).flatMap((c) => x.bySubject.get(`task:${c}`) ?? [])]) {
    marks.push(ms(f.at), ms(f.seen_at));
    if (str(f.data.until)) marks.push(ms(f.data.until as string));
    if (f.type === "wake.opened" && agesOut(x, fs, f) < Infinity) marks.push(agesOut(x, fs, f));
  }
  marks.sort((a, b) => a - b);
  const assigns = own.filter((f) => f.type === "task.assignee_changed");
  let ai = 0, holder = "unknown";
  const assignee = (t: number) => { for (; ai < assigns.length && ms(assigns[ai]!.at) <= t; ai++) holder = str(assigns[ai]!.data.to) ?? "unknown"; return holder; };
  const why = reasoner(x, task, stale);
  const out: Idle[] = [];
  let m = 0;
  for (const [s, e] of gaps) {
    for (; m < marks.length && marks[m]! <= s; m++);
    const points = [s];
    for (; m < marks.length && marks[m]! < e; m++) if (marks[m] !== points.at(-1)) points.push(marks[m]!);
    points.forEach((p, i) => {
      const end = points[i + 1] ?? e, last = i === points.length - 1, openNow = last && e >= now;
      const r = why(openNow ? now : p, openNow);
      const prev = out.at(-1);
      if (prev && prev.end === iso(p) && prev.reason === r.reason && prev.blocked_on === r.blocked_on && prev.note === r.note) prev.end = openNow ? null : iso(end);
      else out.push({ task, start: iso(p), end: openNow ? null : iso(end), reason: r.reason, ...(r.blocked_on ? { blocked_on: r.blocked_on } : {}), ...(r.note ? { note: r.note } : {}), holder: assignee(p) });
    });
  }
  return out;
}

type Seg = { s: number; e: number; reason: string };
/** Union of labelled segments clipped to [s, e], earlier-listed segments winning: seconds per label. */
function cover(segs: Seg[], s: number, e: number): Record<string, number> {
  const cut = [...new Set([s, e, ...segs.flatMap((g) => [g.s, g.e]).filter((t) => t > s && t < e)])].sort((a, b) => a - b);
  const out: Record<string, number> = {};
  for (let i = 0; i + 1 < cut.length; i++) {
    const hit = segs.find((g) => g.s <= cut[i]! && g.e >= cut[i + 1]!);
    if (hit) out[hit.reason] = (out[hit.reason] ?? 0) + (cut[i + 1]! - cut[i]!);
  }
  return out;
}
/**
 * An item's idle seconds per reason in [s, e]: where its subject waits (its own `work.waiting`), else where every one of its tasks
 * open then is idle (a piece of work is busy while any task of its tree works). The slice's reason is the wait's, else the first
 * task's that isn't `delegated` or `blocked` (a parent waiting on its own subtask says less than the subtask), else that one.
 */
function idleIn(waits: Seg[], tasks: { open: [number, number][]; idle: Seg[] }[], s: number, e: number): Record<string, number> {
  const edges = [...waits.flatMap((g) => [g.s, g.e]), ...tasks.flatMap((t) => [...t.open.flat(), ...t.idle.flatMap((g) => [g.s, g.e])])];
  const cut = [...new Set([s, e, ...edges.filter((t) => t > s && t < e)])].sort((a, b) => a - b);
  const out: Record<string, number> = {};
  for (let i = 0; i + 1 < cut.length; i++) {
    const a = cut[i]!, b = cut[i + 1]!, hit = (g: Seg) => g.s <= a && g.e >= b;
    let reason = waits.find(hit)?.reason;
    if (!reason) {
      const rs = tasks.filter((t) => t.open.some(([os, oe]) => os <= a && oe >= b)).map((t) => t.idle.find(hit)?.reason);
      if (!rs.length || rs.includes(undefined)) continue;
      reason = rs.find((r) => r !== "delegated" && r !== "blocked") ?? rs[0]!;
    }
    out[reason] = (out[reason] ?? 0) + (b - a);
  }
  return out;
}

/** Intervals a subject spends in `type` until the next fact of `type` or `ends` on it (or `until`, or `now`). */
function spans(fs: FactRow[], type: string, ends: string[], now: number) {
  const out: Seg[] = [];
  fs.forEach((f, i) => {
    if (f.type !== type) return;
    let next: FactRow | undefined;
    for (let j = i + 1; j < fs.length && !next; j++) if (fs[j]!.type === type || ends.includes(fs[j]!.type)) next = fs[j];
    out.push({ s: ms(f.at), e: Math.min(next ? ms(next.at) : now, str(f.data.until) ? ms(f.data.until as string) : Infinity), reason: String(f.data.reason ?? "unknown") });
  });
  return out;
}

export function createFlow({ db, file, stages, journeys = () => [], now = () => new Date(), incident = () => false, cacheMs = 60_000 }: {
  /** The kernel's db (tests), or its file, opened here read-only (the kernel: reads never block the approval path). */
  db?: DatabaseSync; file?: string; stages: () => Stage[]; journeys?: () => Journey[]; now?: () => Date;
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
    // and their ancestors' (a piece of work is its root's: journeys.ts), however long ago they were last touched
    for (let depth = 0; depth < 10; depth++) {
      const have = new Set([...kept.values()].filter((r) => r.type === "task.created").map((r) => r.subject.slice(5)));
      const up = [...new Set([...kept.values()].filter((r) => r.type === "task.created").map((r) => str(r.data.parent)).filter((p): p is string => Boolean(p) && !have.has(p!)))];
      if (!up.length) break;
      for (const r of chunked((m) => `SELECT * FROM facts WHERE subject IN (${m}) AND at < ?`, up.map((t) => `task:${t}`), iso(to))) kept.set(r.seq, r);
      if (!up.some((p) => [...kept.values()].some((r) => r.subject === `task:${p}` && r.type === "task.created"))) break;
    }
    return { rows: [...kept.values()].sort(byTime), truncated };
  };

  /**
   * One window's read, shared by the summary and the journey lists (reused for `cacheMs` per minute-rounded window): its facts
   * from 90 days before `t0` (so a stage or journey that began earlier still pairs), the stage occurrences, idle periods, and
   * every journey's items.
   */
  const contexts = new Map<string, { at: number; value: ReturnType<typeof read> }>();
  function context(t0: number, t1: number) {
    const k = `${Math.floor(t0 / 60_000)}|${Math.floor(t1 / 60_000)}`, hit = contexts.get(k);
    if (hit && Date.now() - hit.at < cacheMs) return hit.value;
    const value = read(t0, t1);
    for (const [c, v] of contexts) if (Date.now() - v.at >= cacheMs) contexts.delete(c);
    if (cacheMs > 0) contexts.set(k, { at: Date.now(), value });
    return value;
  }
  function read(t0: number, t1: number) {
    const { rows, truncated } = window(t0 - 90 * DAY, t1);
    const x = index(rows), occs = pair(rows, stages()), idle = new Map<string, Idle[]>();
    const idleFor = (task: string) => idle.get(task) ?? (idle.set(task, idleOf(x, task, t1, occs)), idle.get(task)!);
    const lower = new Map<string, FactRow[]>();
    for (const [sub, fs] of x.bySubject) { const l = sub.toLowerCase(); lower.set(l, [...(lower.get(l) ?? []), ...fs]); }
    // a journey block's idle: the subject's own waits, then its tasks' idle periods
    const tasksOf = new Map<string, { open: [number, number][]; idle: Seg[] }>();
    const taskIdle = (t: string) => tasksOf.get(t) ?? (tasksOf.set(t, { open: openOf(x, t, t1), idle: idleFor(t).map((i) => ({ s: ms(i.start), e: i.end ? ms(i.end) : t1, reason: i.reason })) }), tasksOf.get(t)!);
    const itemIdle = (tasks: string[], subject: string, s: number, e: number) => idleIn(spans(lower.get(subject) ?? [], "work.waiting", ["work.resumed"], t1), tasks.map(taskIdle), s, e);
    const links = recordLinks(t0 - 90 * DAY);
    const built = new Map(journeys().map((j) => [j.name, buildItems(j, { rows, bySubject: x.bySubject, byTask: x.byTask, ident: x.ident, now: t1, links, idle: itemIdle })]));
    return { rows, truncated, x, occs, idleFor, built, dora: doraOf(rows, x, [...built.values()].flat()) };
  }

  /**
   * The PRs each task's done code-host writes name, from the records table (the one link for a PR's review rounds before it
   * existed: a pr or push write is filed before the PR has a number, so only a merge's record.filed fact names it): `args.prs`
   * and the PR URL in the outcome. Keyed `pr:<owner>/<repo>#<n>`, lowercase. None when the table isn't there (tests).
   */
  function recordLinks(since: number) {
    const out = new Map<string, string[]>();
    let rs: { task: string; args: string; outcome: string | null }[];
    try { rs = conn.prepare("SELECT task, args, outcome FROM records WHERE state = 'done' AND created_at >= ? AND (kind LIKE '%.pr' OR kind LIKE '%.push' OR kind LIKE '%.merge')").all(iso(since)) as typeof rs; } catch { return out; }
    for (const r of rs) {
      const args = (() => { try { return JSON.parse(r.args) ?? {}; } catch { return {}; } })(), text = String((() => { try { return JSON.parse(r.outcome ?? "null")?.text ?? ""; } catch { return ""; } })());
      const prs = [...(Array.isArray(args.prs) ? args.prs : []).filter((p: any) => p?.repo && p?.number).map((p: any) => `${p.repo}#${p.number}`),
        ...[...text.matchAll(/(?:github\.com\/([\w.-]+\/[\w.-]+)\/pull|codehost:([\w.-]+\/[\w.-]+)\/change)\/(\d+)/gi)].map((m) => `${m[1] ?? m[2]}#${m[3]}`)];
      for (const pr of new Set(prs.map((p) => `pr:${p.toLowerCase()}`))) out.set(pr, [...new Set([...(out.get(pr) ?? []), r.task])]);
    }
    return out;
  }

  /**
   * DORA's five over any period, from the window's facts. Deploy frequency: healthy deploys a day. Lead time: a PR's opening to
   * its deploy (p50). Change failure: deploys with failed health, rolled back, or shipping a PR a revert or an incident names
   * (quality.ts's linker). Recovery: a failed deploy to the next healthy one, an incident to the deploy of its fix (p50). Rework:
   * deploys that ship a revert or a fix (a PR titled as a fix that names a deployed PR, or one done for an incident).
   */
  function doraOf(rows: FactRow[], x: Index, built: Built[]) {
    const all = rows.filter((f) => f.type === "deploy.applied");
    const failedHealth = (f: FactRow) => f.data.health === false || /fail|unhealthy|down/i.test(String(f.data.health ?? ""));
    const prKey = (subject: string) => subject.replace(/^pr:/, "").replace(/@.*$/, "").toLowerCase();
    const deployedPr = rows.filter((f) => f.type === "pr.deployed");
    const genOf = new Map(deployedPr.map((f) => [prKey(str(f.data.pr) ? `pr:${f.data.pr}` : f.subject), String(f.data.generation)]));
    const merged = new Map(rows.filter((f) => f.type === "pr.merged").map((f) => [prKey(f.subject), str(f.data.sha)]));
    const changes: Change[] = [...genOf.keys()].map((pr) => ({ id: pr, tier: "ran", at: "", keys: [pr, ...(merged.get(pr) ? [merged.get(pr)!.toLowerCase()] : [])], link: "", label: pr }));
    const failed = new Set(all.filter(failedHealth).map((d) => String(d.data.generation)));
    for (const d of all) if (d.data.revert_of != null) failed.add(String(d.data.revert_of));
    const linked = (t: Text) => { const l = link(t, changes); return l === "unknown" || l === "none" ? undefined : l.change.id; };
    const rework = new Set<string>();
    for (const f of rows.filter((f) => f.type === "pr.reverted")) {
      const [repo, num] = prKey(f.subject).split("#");
      const g = genOf.get(linked({ id: f.id, title: "Revert", body: [f.data.of_pr, f.data.of_sha].filter((v) => typeof v === "string").join(" "), repo, number: Number(num) || undefined }) ?? "");
      if (g) failed.add(g);
      if (genOf.has(prKey(f.subject))) rework.add(genOf.get(prKey(f.subject))!);
    }
    const incidents = rows.filter((f) => f.type === "task.created" && incident(f));
    for (const f of incidents) { const g = genOf.get(linked({ id: f.id, title: String(f.data.title ?? ""), body: String(f.data.source_marker ?? "") }) ?? ""); if (g) failed.add(g); }
    for (const f of rows) if (f.type === "pr.opened" && /\b(hot)?fix/i.test(String(f.data.title ?? "")) && genOf.has(prKey(f.subject))) {
      const [repo, num] = prKey(f.subject).split("#");
      if (linked({ id: f.id, title: String(f.data.title), repo, number: Number(num) || undefined })) rework.add(genOf.get(prKey(f.subject))!);
    }
    const incidentTasks = new Set(incidents.flatMap((f) => [f.subject.slice(5), ...(x.children.get(f.subject.slice(5)) ?? [])]));
    for (const b of built) if (b.tasks.some((t) => incidentTasks.has(t)) && genOf.has(prKey(b.item.subject))) rework.add(genOf.get(prKey(b.item.subject))!);
    const opened = new Map<string, number>();
    for (const f of rows) if (f.type === "pr.opened" && !opened.has(prKey(f.subject))) opened.set(prKey(f.subject), ms(f.at));
    const lead = deployedPr.map((p) => { const o = opened.get(prKey(p.subject)); return o === undefined ? undefined : { at: ms(p.at), s: sec(ms(p.at) - o) }; }).filter((v) => v !== undefined);
    const restores = [
      ...all.filter(failedHealth).map((d) => { const n = all.find((g) => ms(g.at) > ms(d.at) && !failedHealth(g)); return n ? { at: ms(d.at), s: sec(ms(n.at) - ms(d.at)) } : undefined; }),
      ...incidents.map((f) => { const ids = new Set([f.subject.slice(5), ...(x.children.get(f.subject.slice(5)) ?? [])]); const d = deployedPr.find((p) => p.task && ids.has(p.task) && ms(p.at) > ms(f.at)); return d ? { at: ms(f.at), s: sec(ms(d.at) - ms(f.at)) } : undefined; }),
    ].filter((v) => v !== undefined);
    return (p0: number, p1: number): Dora => {
      const inP = (t: number) => t >= p0 && t < p1, ds = all.filter((d) => inP(ms(d.at)));
      return {
        deploys_per_day: all.length ? ds.filter((d) => !failedHealth(d)).length / Math.max((p1 - p0) / DAY, 1 / 24) : null,
        lead_time_s: p50(lead.filter((l) => inP(l.at)).map((l) => l.s)),
        change_fail_rate: ds.length ? ds.filter((d) => failed.has(String(d.data.generation))).length / ds.length : null,
        recovery_s: p50(restores.filter((r) => inP(r.at)).map((r) => r.s)),
        rework_rate: ds.length ? ds.filter((d) => rework.has(String(d.data.generation))).length / ds.length : null,
      };
    };
  }

  function summarize({ since, to, by = "stage", scope, journey }: { since: string; to?: string; by?: By; scope?: string; journey?: string }) {
    const t0 = ms(since), t1 = to ? ms(to) : now().getTime();
    const c = context(t0, t1), { rows, truncated, x, occs, idleFor } = c;
    const inWin = (f: { at: string } | FactRow) => ms(f.at) >= t0 && ms(f.at) < t1;
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

    // DORA (the existing four over the window; the insights carry all five with the period before)
    const d = c.dora(t0, t1);
    const dora = rows.some((f) => f.type === "deploy.applied" && inWin(f)) ? { deploys_per_day: d.deploys_per_day, lead_p50: d.lead_time_s, failure_rate: d.change_fail_rate, restore_p50: d.recovery_s } : null;

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
    const ended = w.filter((f) => f.type === "job.ended" && f.data.state !== "deferred"); // a deferred job never ran (facts.ts backfill)
    const cost = (fs: FactRow[]) => fs.reduce((a, f) => a + (Number(f.data.cost_usd) || 0), 0);
    // Each wake a job took that did nothing; its cost once per job (a job takes several wakes: its starter and the comments it consumed).
    const noAction = w.filter((f) => f.type === "wake.bound").map((f) => jobEnd.get(`job:${f.data.job}`) ?? jobEnd.get(String(f.data.job))).filter((j): j is FactRow => j?.data.acted === false);
    const noActionJobs = [...new Set(noAction)];
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
      no_action_cost: cost(noActionJobs),
      held_seconds_by_reason: held,
      first_pass_review: firstBy("record.decided", (f) => /^approve/.test(String(f.data.decision)), (f) => f.data.decider === "reviewer"),
      handoffs: assigned.filter((f) => str(f.data.from)).length,
      time_to_first_action_p50: p50(assigned.filter((f) => str(f.data.to)).map((a) => { const j = (x.byTask.get(taskOf(a)!) ?? []).find((f) => f.type === "job.started" && byTime(f, a) > 0); return j ? sec(ms(j.at) - ms(a.at)) : undefined; }).filter((v): v is number => v !== undefined)),
      owner_interventions_per_outcome: ratio(owner, done.size),
      cost_per_outcome: ratio(cost(ended), done.size),
      wasted_cost: cost(ended.filter((f) => f.data.acted === false || (f.task && lastStatus(f.task) === "cancelled"))),
    };
    // insights: the asked journey's, else the first declared one with items (flow-insights.md §3)
    const j = journey ? journeys().find((j) => j.name === journey) : journeys().find((j) => c.built.get(j.name)?.length);
    const idleNow = (b: Built) => b.tasks.map((t) => idleFor(t).at(-1)).find((i) => i && i.end === null)?.reason ?? null;
    const insight = j ? insights(j, c.built.get(j.name)!, { t0, t1, now: t1, previous: !truncated && t1 - t0 <= 90 * DAY, dora: c.dora, idleNow }) : null;
    return { since: iso(t0), to: iso(t1), by, scope: scope ?? "all", truncated, stages: stageRows, dora, churn, fleet, journey: j?.name ?? null, insights: insight };
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

    summary(q: { since: string; to?: string; by?: By; scope?: string; journey?: string }) {
      const minute = (t: number) => Math.floor(t / 60_000);
      const key = [minute(ms(q.since)), minute(q.to ? ms(q.to) : now().getTime()), q.by ?? "stage", q.scope ?? "all", q.journey ?? ""].join("|");
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < cacheMs) return hit.value;
      const value = summarize(q);
      for (const [k, v] of cache) if (Date.now() - v.at >= cacheMs) cache.delete(k);
      if (cacheMs > 0) cache.set(key, { at: Date.now(), value });
      return value;
    },

    /** The declared journeys and their phases. */
    journeys: () => ({ journeys: journeys().map((j) => ({ name: j.name, label: j.label, phases: j.phases.map((p) => ({ name: p.name, label: p.label })) })) }),

    /** A journey's items active in [since, to): undefined when no module declares it. */
    journey(q: { name: string; since: string; to?: string; authors?: AuthorKind[]; sort?: Sort; limit?: number }) {
      const j = journeys().find((j) => j.name === q.name);
      if (!j) return undefined;
      const t0 = ms(q.since), t1 = q.to ? ms(q.to) : now().getTime(), c = context(t0, t1);
      const list = listItems(c.built.get(j.name) ?? [], { t0, t1, authors: q.authors, sort: q.sort, limit: q.limit });
      return { journey: j.name, label: j.label, phases: j.phases.map((p) => ({ name: p.name, label: p.label })), items: list.items, truncated: list.truncated || c.truncated };
    },
  };
}
export type Flow = ReturnType<typeof createFlow>;
