// Journeys (docs/design/flow-insights.md §2): the ordered phases a subject's facts pass through, as a module declares them in
// module.yaml `journeys:`; the kernel knows none by name. One item per subject `<subject>:<key>` (its `<subject>:<key>@<head>`
// facts included), with the facts of its task (a `record.filed` whose data field named like the subject kind names it, or the
// subject's own `task`) and of the issue that task came from (its `source_marker` ends in `:<owner>/<repo>#<n>`).
//   - A phase starts at its first fact after the previous present phase began; a phase with no fact is absent. The subject's
//     own facts count from its first fact in its earliest phase (a branch's commits before the PR opened are its prehistory).
//   - Rounds (1 = done the first time): a fact type repeating later within the current round starts a new round, and so does
//     an earlier phase's fact after the round saw the phase's own (a refile after a rejection, a push during merge review). So
//     a push and the CI run it starts are one round, and a rework job and its refile are one.
//   - The item ends at its first `end` fact, or is open (now).
// Insights are computed from the items in one pass over the window the summary already loaded. Durations are seconds.
import type { FactRow } from "./facts.ts";

export type Phase = { name: string; label: string; from: string[]; where?: Record<string, string[]> };
export type JourneyDecl = { name: string; label: string; subject: string; phases: Phase[]; end: string[] };
export type Journey = JourneyDecl & { module: string };
export type AuthorKind = "agent" | "owner" | "outside";
export const AUTHOR_KINDS: AuthorKind[] = ["agent", "owner", "outside"];
export type Block = { phase: string; start: string; end: string; rounds: number; idle_s: number; idle: Record<string, number> };
export type JourneyItem = {
  subject: string; repo: string; number: number; url: string | null; title: string | null; author: string | null; author_kind: AuthorKind | null;
  task: string | null; identifier: string | null; state: "open" | "merged" | "closed" | "deployed"; start: string; end: string | null; total_s: number; blocks: Block[];
};
/** An item and what insights read besides its row: its facts (time order), tasks, and when it was born, merged and ended. */
export type Built = { item: JourneyItem; facts: FactRow[]; tasks: string[]; born: number; merged: number | null; ended: number | null };
/** What items are built from: the window's facts and Flow's indexes, and the idle seconds by reason a task and subject spent in [s, e]. */
export type Ctx = {
  rows: FactRow[]; bySubject: Map<string, FactRow[]>; byTask: Map<string, FactRow[]>; ident: Map<string, string>; now: number;
  /** Tasks known to have filed a write on a subject (lowercase `<subject>:<key>`) that no fact names: the records' own links. */
  links: Map<string, string[]>;
  idle: (tasks: string[], subject: string, s: number, e: number) => Record<string, number>;
};

const DAY = 864e5;
const ms = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();
const sec = (n: number) => Math.round(n / 1000);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Nearest-rank percentile; null when empty. */
const pct = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(q * s.length) - 1)]!; };
const key = (subject: string) => subject.toLowerCase().replace(/@.*$/, "");

/** The journeys of the enabled modules, one per name (two modules may declare the same one; the compiler holds them equal). */
export function journeysOf(modules: Record<string, { journeys?: JourneyDecl[] }>): Journey[] {
  const out = new Map<string, Journey>();
  for (const [module, m] of Object.entries(modules)) for (const j of m.journeys ?? []) if (!out.has(j.name)) out.set(j.name, { ...j, module });
  return [...out.values()];
}

/** Every item of journey `j` with a fact in the window. */
export function buildItems(j: Journey, c: Ctx): Built[] {
  const prefix = `${j.subject}:`;
  const phaseOf = (f: FactRow) => j.phases.findIndex((p) => p.from.includes(f.type) && Object.entries(p.where ?? {}).every(([k, vs]) => vs.includes(String(f.data[k]))));
  const own = new Map<string, FactRow[]>(), lower = new Map<string, FactRow[]>(), recordOf = new Map<string, string>(), tasksOf = new Map<string, Set<string>>();
  const uuid = new Map([...c.ident].map(([id, ident]) => [ident, id]));
  for (const f of c.rows) {
    const s = f.subject.toLowerCase();
    push(lower, s, f);
    if (s.startsWith(prefix)) push(own, key(s), f);
    // A record names its subject in the data field of the subject's kind (record.filed data.pr = "<owner>/<repo>#<n>").
    if (f.type === "record.filed" && str(f.data[j.subject])) {
      const k = `${prefix}${String(f.data[j.subject]).toLowerCase()}`;
      recordOf.set(f.subject, k);
      if (f.task) tasksOf.set(k, (tasksOf.get(k) ?? new Set()).add(f.task));
    }
  }
  const out: Built[] = [];
  for (const [k, mine] of own) {
    const tasks = new Set([...(tasksOf.get(k) ?? []), ...(c.links.get(k) ?? [])]);
    for (const f of mine) if (f.task) tasks.add(uuid.get(f.task) ?? f.task);
    const facts = new Map(mine.map((f) => [f.seq, f]));
    for (const t of tasks) {
      for (const f of c.byTask.get(t) ?? []) {
        // another subject of this journey on the same task, and its records, are that item's
        const s = key(f.subject);
        if ((s.startsWith(prefix) && s !== k) || (recordOf.has(f.subject) && recordOf.get(f.subject) !== k)) continue;
        facts.set(f.seq, f);
      }
      const created = (c.bySubject.get(`task:${t}`) ?? []).find((f) => f.type === "task.created");
      const issue = /:([\w.-]+\/[\w.-]+#\d+)$/.exec(str(created?.data.source_marker) ?? "")?.[1];
      if (issue) for (const f of lower.get(`issue:${issue.toLowerCase()}`) ?? []) facts.set(f.seq, f);
    }
    // one event per type, subject and time, its newest row (a source that re-sent a fact at a new version leaves the old row too)
    const event = (f: FactRow) => `${f.type}\0${f.subject.toLowerCase()}\0${ms(f.at)}`, once = new Set<string>();
    for (const f of [...facts.values()].sort((a, b) => b.seq - a.seq)) if (once.has(event(f))) facts.delete(f.seq); else once.add(event(f));
    const phase = new Map([...facts.values()].map((f) => [f.seq, phaseOf(f)]));
    const at = (f: FactRow) => ms(f.at);
    const sorted = [...facts.values()].sort((a, b) => at(a) - at(b) || (phase.get(a.seq)! + 1 || 1e9) - (phase.get(b.seq)! + 1 || 1e9) || a.seq - b.seq);
    const isOwn = (f: FactRow) => key(f.subject) === k;
    const first = Math.min(...sorted.filter((f) => isOwn(f) && phase.get(f.seq)! >= 0).map((f) => phase.get(f.seq)!));
    if (!Number.isFinite(first)) continue;
    const born = Math.min(...sorted.filter((f) => isOwn(f) && phase.get(f.seq) === first).map(at));
    const blocks: { p: number; s: number; rounds: number; seen: Map<string, number>; own: boolean }[] = [];
    let ended: number | null = null, endType = "", merged: number | null = null;
    for (const f of sorted) {
      const t = at(f);
      if (isOwn(f) && t < born) continue;
      if (blocks.length && j.end.includes(f.type)) { ended = t; endType = f.type; break; }
      if (isOwn(f) && f.type === `${j.subject}.merged` && merged === null) merged = t;
      const p = phase.get(f.seq)!;
      if (p < 0) continue;
      const cur = blocks.at(-1), type = `${p}:${f.type}`;
      if (!cur || p > cur.p) { blocks.push({ p, s: t, rounds: 1, seen: new Map([[type, t]]), own: true }); continue; }
      const earlier = p < cur.p;
      if ((cur.seen.get(type) ?? t) < t || (earlier && cur.own)) { cur.rounds++; cur.seen = new Map(); cur.own = false; }
      if (!cur.seen.has(type)) cur.seen.set(type, t);
      if (!earlier) cur.own = true;
    }
    if (!blocks.length) continue;
    const meta = (field: string) => { for (const f of mine) if (str(f.data[field])) return f.data[field] as string; return null; };
    const [repo0, num] = k.slice(prefix.length).split("#");
    const repo = meta("repo") ?? repo0!, number = Number(num) || 0, task = [...tasks][0] ?? null, last = ended ?? c.now;
    const kind = meta("author_kind");
    out.push({
      item: {
        subject: k, repo, number, url: meta("url") ?? (repo.toLowerCase().startsWith("local/") || !number ? null : `https://github.com/${repo}/pull/${number}`),
        title: meta("title"), author: meta("author"), author_kind: (AUTHOR_KINDS as string[]).includes(kind ?? "") ? (kind as AuthorKind) : null,
        task, identifier: task ? c.ident.get(task) ?? null : null,
        state: ended !== null && /\.deployed$/.test(endType) ? "deployed" : ended !== null && /\.closed$/.test(endType) ? (merged !== null ? "merged" : "closed") : merged !== null ? "merged" : "open",
        start: iso(blocks[0]!.s), end: ended === null ? null : iso(ended), total_s: sec(last - blocks[0]!.s),
        blocks: blocks.map((b, i) => {
          const e = blocks[i + 1]?.s ?? last, idle = c.idle([...tasks], k, b.s, e);
          return { phase: j.phases[b.p]!.name, start: iso(b.s), end: iso(e), rounds: b.rounds, idle_s: sec(sum(Object.values(idle))), idle: Object.fromEntries(Object.entries(idle).map(([r, v]) => [r, sec(v)])) };
        }),
      },
      facts: sorted, tasks: [...tasks], born, merged, ended,
    });
  }
  return out;
}

export type Sort = "recent" | "slowest" | "rounds";
export const SORTS: Sort[] = ["recent", "slowest", "rounds"];
const extra = (i: JourneyItem) => sum(i.blocks.map((b) => b.rounds - 1));

/** The journey list: items active in [t0, t1) of the given author kinds (all, and those with none, when every kind is asked), sorted. */
export function listItems(built: Built[], { t0, t1, authors, sort = "recent", limit = 200 }: { t0: number; t1: number; authors?: AuthorKind[]; sort?: Sort; limit?: number }) {
  const every = !authors || AUTHOR_KINDS.every((a) => authors.includes(a));
  const items = built.map((b) => b.item).filter((i) => ms(i.start) < t1 && (i.end === null || ms(i.end) >= t0) && (every || (i.author_kind !== null && authors!.includes(i.author_kind))));
  const end = (i: JourneyItem) => (i.end ? ms(i.end) : Infinity);
  items.sort(sort === "slowest" ? (a, b) => b.total_s - a.total_s : sort === "rounds" ? (a, b) => extra(b) - extra(a) || b.total_s - a.total_s : (a, b) => end(b) - end(a) || ms(b.start) - ms(a.start));
  return { items: items.slice(0, limit), truncated: items.length > limit };
}

export type Metric = { value: number | null; previous: number | null; weekly: { week: string; value: number | null }[] };
export type Dora = { deploys_per_day: number | null; lead_time_s: number | null; change_fail_rate: number | null; recovery_s: number | null; rework_rate: number | null };

/** Monday-started UTC weeks and UTC days overlapping [t0, t1). */
function buckets(t0: number, t1: number) {
  const day0 = Math.floor(t0 / DAY) * DAY, dow = (new Date(day0).getUTCDay() + 6) % 7;
  const weeks: number[] = [], days: number[] = [];
  for (let w = day0 - dow * DAY; w < t1; w += 7 * DAY) weeks.push(w);
  for (let d = day0; d < t1; d += DAY) days.push(d);
  return { weeks, days };
}
const ymd = (n: number) => iso(n).slice(0, 10);

/**
 * Insights over the journey's items for [t0, t1) (flow-insights.md §3). A block counts once it is over (a later block began or
 * the item ended), in the window its end falls in; an open item's last block is still running and counts only in `aging` and
 * the cumulative flow. `dora`: Flow's five over any period; `previous`: whether the period before is inside what was loaded.
 */
export function insights(j: Journey, built: Built[], { t0, t1, now, previous, dora, idleNow }: {
  t0: number; t1: number; now: number; previous: boolean; dora: (p0: number, p1: number) => Dora;
  /** Why an open item is idle now, if it is. */
  idleNow: (b: Built) => string | null;
}) {
  const inWin = (t: number | null) => t !== null && t >= t0 && t < t1;
  const { weeks, days } = buckets(t0, t1);
  const weekOf = (t: number) => weeks.findLast((w) => w <= t)!;
  const label = new Map(j.phases.map((p) => [p.name, p.label]));
  // finished blocks, by the window their end falls in
  const done = built.flatMap((b) => b.item.blocks.filter((_, i) => i < b.item.blocks.length - 1 || b.ended !== null).map((k) => ({ b, k, end: ms(k.end), s: (ms(k.end) - ms(k.start)) / 1000 })));
  const finished = done.filter((d) => inWin(d.end));
  const endedIn = built.filter((b) => inWin(b.ended));
  const phases = j.phases.map((p) => {
    const ds = finished.filter((d) => d.k.phase === p.name), xs = ds.map((d) => Math.round(d.s));
    return {
      name: p.name, label: p.label, n: ds.length, p50: pct(xs, 0.5), p85: pct(xs, 0.85), p95: pct(xs, 0.95),
      idle_s: sum(ds.map((d) => d.k.idle_s)), rounds_mean: ds.length ? sum(ds.map((d) => d.k.rounds)) / ds.length : 0,
      weekly: weeks.map((w) => { const ws = ds.filter((d) => weekOf(d.end) === w).map((d) => Math.round(d.s)); return { week: ymd(w), p50: pct(ws, 0.5), n: ws.length }; }),
      idle: ds.reduce<Record<string, number>>((a, d) => { for (const [r, v] of Object.entries(d.k.idle)) a[r] = (a[r] ?? 0) + v; return a; }, {}),
    };
  });
  const rounds: Record<string, Record<string, number>> = {};
  for (const d of finished) { const h = (rounds[d.k.phase] ??= {}); h[d.k.rounds] = (h[d.k.rounds] ?? 0) + 1; }

  // reviewer rejections in the window by reason code (`code` on record.decided)
  const rejected = new Map<string, number>(), seenRec = new Set<number>();
  for (const b of built) for (const f of b.facts) if (f.type === "record.decided" && f.data.decider === "reviewer" && f.data.decision === "rejected" && inWin(ms(f.at)) && !seenRec.has(f.seq)) {
    seenRec.add(f.seq); const r = str(f.data.code) ?? "unspecified"; rejected.set(r, (rejected.get(r) ?? 0) + 1);
  }
  const has = (b: Built, type: string, ok: (f: FactRow) => boolean = () => true) => b.facts.some((f) => f.type === type && ok(f));
  const p = j.subject;

  // cost: each job's cost split evenly over the items its task served (failed attempts included)
  const served = new Map<string, number>();
  for (const b of built) for (const t of b.tasks) served.set(t, (served.get(t) ?? 0) + 1);
  const jobs = new Map<number, { usd: number; agent: string; model: string; at: number; share: number }>();
  const costOf = (b: Built, keep: (at: number) => boolean = () => true) => {
    let usd = 0;
    for (const f of b.facts) if (f.type === "job.ended" && f.task && b.tasks.includes(f.task) && keep(ms(f.at))) {
      const share = (Number(f.data.cost_usd) || 0) / (served.get(f.task) ?? 1);
      usd += share;
      if (!jobs.has(f.seq)) jobs.set(f.seq, { usd: Number(f.data.cost_usd) || 0, agent: f.actor.replace(/^agent:/, ""), model: str(f.data.model) ?? "-", at: ms(f.at), share });
    }
    return usd;
  };
  const itemCost = new Map(built.map((b) => [b, costOf(b)]));
  const mergedIn = built.filter((b) => inWin(b.merged));
  const byKey = (pick: "agent" | "model") => {
    const m = new Map<string, { usd: number; merged: Set<Built> }>();
    for (const b of built) for (const f of b.facts) {
      const jb = jobs.get(f.seq);
      if (!jb || !inWin(jb.at) || !b.tasks.includes(f.task ?? "")) continue;
      const e = m.get(jb[pick]) ?? { usd: 0, merged: new Set() };
      e.usd += jb.share; if (inWin(b.merged)) e.merged.add(b);
      m.set(jb[pick], e);
    }
    return [...m].map(([k, v]) => ({ key: k, usd: v.usd, merged: v.merged.size })).sort((a, b) => b.usd - a.usd);
  };

  const L = t1 - t0, cur = dora(t0, t1), prev = previous ? dora(t0 - L, t0) : null, wk = weeks.map((w) => ({ w, d: dora(Math.max(w, t0), Math.min(w + 7 * DAY, t1)) }));
  const metric = (k: keyof Dora): Metric => ({ value: cur[k], previous: prev ? prev[k] : null, weekly: wk.map(({ w, d }) => ({ week: ymd(w), value: d[k] })) });

  // bottlenecks: the phase idle longest, the one reworked most, the slowest at p85
  const bottlenecks: { phase: string; kind: "idle" | "rounds" | "slow"; text: string }[] = [];
  const top = <T>(xs: T[], v: (x: T) => number) => xs.reduce<T | undefined>((a, x) => (v(x) > (a ? v(a) : 0) ? x : a), undefined);
  const idle = top(phases, (x) => x.idle_s);
  if (idle) {
    const [r, v] = Object.entries(idle.idle).sort((a, b) => b[1] - a[1])[0] ?? ["unknown", 0];
    bottlenecks.push({ phase: idle.name, kind: "idle", text: `${idle.label} sat idle ${dur(idle.idle_s)} in total over ${idle.n} items, most of it ${r} (${Math.round((100 * v) / idle.idle_s)}%).` });
  }
  const reworked = top(phases.filter((x) => x.n), (x) => x.rounds_mean - 1);
  if (reworked) {
    const again = finished.filter((d) => d.k.phase === reworked.name && d.k.rounds > 1).length;
    bottlenecks.push({ phase: reworked.name, kind: "rounds", text: `${reworked.label} took ${reworked.rounds_mean.toFixed(1)} rounds on average; ${Math.round((100 * again) / reworked.n)}% of items went round more than once.` });
  }
  const slow = top(phases, (x) => x.p85 ?? 0);
  if (slow) bottlenecks.push({ phase: slow.name, kind: "slow", text: `${slow.label} is the slowest phase: 85% of items finish it within ${dur(slow.p85!)} (median ${dur(slow.p50!)}).` });

  const openNow = built.filter((b) => b.item.state === "open");
  return {
    phases: phases.map(({ idle: _idle, ...x }) => x),
    scatter: [...endedIn].sort((a, b) => b.ended! - a.ended!).slice(0, 1000).map((b) => ({ subject: b.item.subject, end: b.item.end!, total_s: b.item.total_s, author_kind: b.item.author_kind })),
    rounds,
    rejections: [...rejected].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    first_pass: weeks.map((w) => { const bs = endedIn.filter((b) => weekOf(b.ended!) === w); return { week: ymd(w), rate: bs.length ? bs.filter((b) => b.item.blocks.every((k) => k.rounds === 1)).length / bs.length : null, n: bs.length }; }),
    aging: openNow.map((b) => ({ subject: b.item.subject, title: b.item.title, phase: b.item.blocks.at(-1)!.phase, age_s: sec(now - ms(b.item.start)), idle_reason: idleNow(b) })).sort((a, b) => b.age_s - a.age_s).slice(0, 200),
    cfd: days.map((d) => {
      const t = Math.min(d + DAY, t1) - 1, counts: Record<string, number> = {};
      for (const b of built) {
        if (ms(b.item.start) > t) continue;
        if (b.ended !== null && b.ended <= t) { counts.done = (counts.done ?? 0) + 1; continue; }
        const k = b.item.blocks.findLast((k) => ms(k.start) <= t)!;
        counts[k.phase] = (counts[k.phase] ?? 0) + 1;
      }
      return { day: ymd(d), counts };
    }),
    funnel: (() => {
      const bs = built.filter((b) => inWin(b.born));
      const n = (ok: (b: Built) => boolean) => bs.filter(ok).length;
      return [
        { step: "issue", n: n((b) => b.facts.some((f) => f.type === "issue.opened")) },
        { step: `${p}_opened`, n: n((b) => has(b, `${p}.opened`)) },
        { step: "ci_passed", n: n((b) => has(b, `${p}.checks_completed`, (f) => f.data.conclusion === "success")) },
        { step: "review_passed", n: n((b) => b.merged !== null || has(b, "record.decided", (f) => f.data.decision === "approved")) },
        { step: "merged", n: n((b) => b.merged !== null) },
        { step: "deployed", n: n((b) => b.item.state === "deployed") },
      ];
    })(),
    cost: {
      per_merged: weeks.map((w) => { const bs = mergedIn.filter((b) => b.tasks.length && weekOf(b.merged!) === w); return { week: ymd(w), usd: bs.length ? sum(bs.map((b) => itemCost.get(b)!)) / bs.length : null }; }),
      by_agent: byKey("agent"), by_model: byKey("model"),
      unmerged_usd: sum(built.filter((b) => b.item.state === "closed" && inWin(b.ended)).map((b) => itemCost.get(b)!)),
    },
    dora5: { deploys_per_day: metric("deploys_per_day"), lead_time_s: metric("lead_time_s"), change_fail_rate: metric("change_fail_rate"), recovery_s: metric("recovery_s"), rework_rate: metric("rework_rate") },
    throughput: days.map((d) => ({ day: ymd(d), merged: built.filter((b) => b.merged !== null && b.merged >= d && b.merged < d + DAY).length, opened: built.filter((b) => b.born >= d && b.born < d + DAY).length })),
    bottlenecks,
  };
}
export type Insights = ReturnType<typeof insights>;

/** A duration in words: 45s, 12m, 3h10m, 2d4h. */
export function dur(s: number) {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return m ? `${h}h${m}m` : `${h}h`; }
  const d = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600);
  return h ? `${d}d${h}h` : `${d}d`;
}
