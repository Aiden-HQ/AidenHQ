import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignInRequired, api } from "./api";
import type { AuthorKind, FlowSummary, IdleItem, Insights, JourneyInfo, JourneyItem, JourneyList, JourneySort, Metric, Waterfall } from "../../src/flow";
import { BarList, Columns, DotPlot, EMPTY, Legend, Lines, Sparkline, TipBody, TipLayer, day, logScale, series, tipProps, useTip, useWidth } from "./flow-charts";
import { Banner, Dialog, EmptyState, Page, PageHeader, Section, Segmented, Select, StatBlock, Tabs } from "./ui";
import { agoLabel } from "./util";
import "./flow.css";

// The Flow page (#/insight/flow/<tab>, docs/design/flow-insights.md §4): where time goes between an issue and its deploy. Tabs share one
// period and one journey (a module declares each: a piece of work's by default, a PR's). Timeline: one row per item, its phases as
// coloured blocks, loops folded into rounds, idle hatched. The other tabs draw the kernel's insights over the picked journey (GET
// /v1/flow summary). The kernel computes everything; this only draws.

/* ----------------------------------------------------------------------------- formatting */
/** Seconds as "40s", "12m", "1h 40m", "2d 3h". */
export function dur(s: number | null | undefined): string {
  if (s == null) return "—";
  const t = Math.round(s);
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.round(t / 60)}m`;
  const two = (a: number, b: number, u: string, v: string) => (b ? `${a}${u} ${b}${v}` : `${a}${u}`);
  if (t < 86_400 - 30) {
    const m = Math.round(t / 60);
    return two(Math.floor(m / 60), m % 60, "h", "m");
  }
  const h = Math.round(t / 3600);
  return two(Math.floor(h / 24), h % 24, "d", "h");
}
const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const words = (reason: string) => reason.replace(/_/g, " ");
const week = (w: string) => `Week of ${day(w)}`;

const PERIODS = [["7", "7d"], ["30", "30d"], ["90", "90d"]] as const;
const TABS = [["overview", "Overview"], ["timeline", "Timeline"], ["stages", "Stages"], ["rework", "Rework"], ["queue", "Queue"], ["cost", "Cost"]] as const;
type Tab = (typeof TABS)[number][0];
const AUTHORS: [AuthorKind, string][] = [["agent", "Agent"], ["owner", "Owner"], ["outside", "Outside"]];
const AUTHOR_COLOR: Record<string, string> = { agent: series(0), owner: series(1), outside: series(2) };
const SORTS = [["recent", "Newest"], ["slowest", "Slowest"], ["rounds", "Most rounds"]] as const;
const ALL_AUTHORS = AUTHORS.map(([k]) => k);

/** How an item reads: a piece of work by its task's identifier, a PR (or any other subject) by its key, `acme/widgets#12`. */
export const nameOf = (x: { subject: string; identifier: string | null }) => (x.subject.startsWith("task:") ? x.identifier ?? x.subject.slice(5, 13) : x.subject.slice(x.subject.indexOf(":") + 1));
/** A linked PR or issue, short: `PR #12`, `issue #7`. */
const linkName = (subject: string) => `${subject.startsWith("pr:") ? "PR" : subject.slice(0, subject.indexOf(":"))} #${subject.split("#")[1] ?? ""}`;

const tabOf = (): Tab => {
  const t = /^#\/?insight\/flow\/([a-z]+)/.exec(location.hash)?.[1];
  return TABS.some(([k]) => k === t) ? (t as Tab) : "overview";
};

/** Each phase's colour, by its place in the journey's declared order (never by name: journeys are a module's). */
function phaseColors(phases: { name: string }[]) {
  const m = new Map(phases.map((p, i) => [p.name, series(i)]));
  return (name: string) => m.get(name) ?? "var(--faint)";
}

/* ----------------------------------------------------------------------------- the page */
let mounted = 0;

export function FlowView({ onSignIn }: { onSignIn: () => void }) {
  const [tab, setTab] = useState<Tab>(tabOf);
  const [days, setDays] = useState<(typeof PERIODS)[number][0]>("7");
  const [data, setData] = useState<{ summary: FlowSummary | null; idle: IdleItem[] } | null>(null);
  // The declared journeys (null until read): the first, a piece of work's, is the default.
  const [journeys, setJourneys] = useState<JourneyInfo[] | null>(null);
  const [journey, setJourneyState] = useState("");
  const [authors, setAuthors] = useState<AuthorKind[]>(ALL_AUTHORS);
  const setJourney = useCallback((j: string) => (setJourneyState(j), setAuthors(ALL_AUTHORS)), []);
  const [sort, setSort] = useState<JourneySort>("recent");
  const [list, setList] = useState<JourneyList | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [item, setItem] = useState<string | null>(null);
  // Every item seen, by subject: a dot in a chart (which carries only the subject) opens its PR from here.
  const known = useRef(new Map<string, JourneyItem>());

  useEffect(() => {
    const on = () => location.hash.startsWith("#/insight/flow") && setTab(tabOf());
    window.addEventListener("hashchange", on);
    mounted++;
    return () => {
      window.removeEventListener("hashchange", on);
      mounted--;
      // The top tabs switch without touching the hash (as Costs): leaving Flow drops its link. Deferred for StrictMode's remount.
      setTimeout(() => !mounted && location.hash.startsWith("#/insight/flow/") && history.replaceState(null, "", "#/insight/flow"));
    };
  }, []);

  const fail = useCallback((e: unknown) => {
    if (e instanceof SignInRequired) onSignIn();
    else setError((e as Error).message);
  }, [onSignIn]);

  useEffect(() => {
    api.flowJourneys().then((j) => (setJourneys(j.journeys), setJourneyState((cur) => cur || j.journeys[0]?.name || "")), (e) => (setJourneys([]), fail(e)));
  }, [fail]);
  useEffect(() => {
    let live = true;
    if (journeys === null) return;
    api.flow(Number(days), "all", journey).then((d) => live && (setData(d), setError("")), (e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [days, journey, journeys, fail]);
  useEffect(() => {
    let live = true;
    if (!journey) return setList(journeys === null ? undefined : null);
    if (!authors.length) return setList(null);
    setList(undefined);
    api.flowJourney(journey, Number(days), authors, sort).then(
      (l) => {
        if (!live) return;
        for (const x of l?.items ?? []) known.current.set(x.subject, x);
        setList(l);
      },
      (e) => live && fail(e),
    );
    return () => {
      live = false;
    };
  }, [journey, journeys, days, authors, sort, fail]);

  const ins = data?.summary?.insights ?? null;
  const decl = journeys?.find((j) => j.name === journey) ?? (list ? { name: list.journey, label: list.label, phases: list.phases } : null);
  const phases = decl?.phases ?? ins?.phases ?? [];
  const color = useMemo(() => phaseColors(phases), [phases]);
  const openSubject = useCallback((subject: string, p?: { url: string | null; task: string | null }) => {
    const x = known.current.get(subject) ?? p;
    if (x?.url) window.open(x.url, "_blank", "noopener");
    else if (x?.task) setItem(x.task);
  }, []);
  const ctx: Ctx = { ins, summary: data?.summary ?? null, idle: data?.idle ?? [], color, phases, days: Number(days), openSubject, openTask: setItem };

  return (
    <Page className="flow-page" label="Flow">
      <PageHeader
        title="Flow"
        sub="Where time goes between an issue and its deploy, per piece of work and in aggregate."
        actions={
          <>
            {journeys && journeys.length > 1 && <Select aria-label="Journey" value={journey} options={journeys.map((j): [string, string] => [j.name, j.label])} onChange={setJourney} />}
            <Segmented label="Period" options={PERIODS} value={days} onChange={setDays} />
          </>
        }
      />
      <Tabs label="Flow views" tabs={TABS} value={tab} href={(t) => `#/insight/flow/${t}`} />
      {error && <Banner tone="danger">Couldn't load Flow: {error}</Banner>}
      <TipLayer key={tab}>
        {!data ? (
          !error && <div className="flow-loading" aria-busy="true" />
        ) : tab === "timeline" ? (
          <TimelineTab
            list={list}
            label={decl?.label ?? "Items"}
            authors={authors}
            setAuthors={setAuthors}
            sort={sort}
            setSort={setSort}
            color={color}
            onTask={setItem}
          />
        ) : !ins && !(tab === "queue" && ctx.idle.length) ? (
          <FlowEmpty />
        ) : tab === "overview" ? (
          <Overview c={ctx} />
        ) : tab === "stages" ? (
          <Stages c={ctx} />
        ) : tab === "rework" ? (
          <Rework c={ctx} />
        ) : tab === "queue" ? (
          <Queue c={ctx} />
        ) : (
          <Cost c={ctx} />
        )}
      </TipLayer>
      <ItemDialog id={item} onClose={() => setItem(null)} />
    </Page>
  );
}

interface Ctx {
  ins: Insights | null;
  summary: FlowSummary | null;
  idle: IdleItem[];
  color: (phase: string) => string;
  phases: { name: string; label: string }[];
  days: number;
  openSubject: (subject: string, p?: { url: string | null; task: string | null }) => void;
  openTask: (task: string) => void;
}

/** Nothing recorded yet: Flow fills in as work happens. */
export function FlowEmpty() {
  return <EmptyState>{EMPTY}</EmptyState>;
}

/* ----------------------------------------------------------------------------- Timeline */
const PAGE = 100;

function TimelineTab(p: {
  list: JourneyList | null | undefined; label: string; authors: AuthorKind[]; setAuthors: (a: AuthorKind[]) => void;
  sort: JourneySort; setSort: (s: JourneySort) => void; color: (phase: string) => string; onTask: (task: string) => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const [view, setViewState] = useState<"bars" | "table">(viewOf);
  const setView = (v: "bars" | "table") => {
    setViewState(v);
    history.replaceState(null, "", v === "table" ? "#/insight/flow/timeline?view=table" : "#/insight/flow/timeline");
  };
  const items = p.list?.items ?? [];
  useEffect(() => setShown(PAGE), [p.list]);
  useEffect(() => {
    const on = () => setViewState(viewOf());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const toggle = (a: AuthorKind) => p.setAuthors(p.authors.includes(a) ? p.authors.filter((x) => x !== a) : ALL_AUTHORS.filter((k) => k === a || p.authors.includes(k)));
  const label = p.label;
  // The author chips filter items that have an author (PRs); a piece of work has none.
  const authored = items.some((x) => x.author_kind) || p.authors.length < ALL_AUTHORS.length;
  return (
    <div className="fl-prs">
      <div className="fl-toolbar">
        {authored && (
          <div className="fl-chips" role="group" aria-label="Author">
            {AUTHORS.map(([k, name]) => (
              <button key={k} type="button" aria-pressed={p.authors.includes(k)} onClick={() => toggle(k)}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="0.75" y="0.75" width="10.5" height="10.5" rx="2.5" /><path d="M3.2 6.2l1.9 1.9 3.7-4" /></svg>
                {name}
              </button>
            ))}
          </div>
        )}
        <Segmented label="Sort" options={SORTS} value={p.sort} onChange={p.setSort} />
        <Segmented label="View" options={[["bars", "Bars"], ["table", "Table"]] as const} value={view} onChange={setView} />
        <span className="fl-count">
          {p.list ? `${items.length}${p.list.truncated ? "+" : ""} ${items.length === 1 ? "item" : "items"}` : ""}
        </span>
      </div>
      {p.list === undefined ? (
        <div className="flow-loading" aria-busy="true" />
      ) : !p.list || !items.length ? (
        <FlowEmpty />
      ) : view === "table" ? (
        <ItemTable items={items} phases={p.list.phases} color={p.color} onTask={p.onTask} label={label} truncated={p.list.truncated} />
      ) : (
        <div className="fl-timeline">
          <Legend items={[...p.list.phases.map((ph) => ({ label: ph.label, color: p.color(ph.name) })), { label: "Idle", color: "var(--faint)", hatch: true }]} />
          <div className="fl-axisrow" aria-hidden>
            <span>Item</span>
            <span className="fl-axisrow-title">Title</span>
            <span>Phases, as a share of each item's own time</span>
            <span className="fl-axisrow-total">Total</span>
          </div>
          <ol className="fl-rows" aria-label={label}>
            {items.slice(0, shown).map((x) => (
              <ItemRow key={x.subject} x={x} phases={p.list!.phases} color={p.color} onTask={p.onTask} />
            ))}
          </ol>
          {(items.length > shown || p.list.truncated) && (
            <div className="fl-more">
              {items.length > shown && (
                <button type="button" className="btn sm" onClick={() => setShown(shown + PAGE)}>
                  Show {Math.min(PAGE, items.length - shown)} more
                </button>
              )}
              {p.list.truncated && <span className="flow-dim">The newest {items.length} are listed; pick a shorter period to see the rest.</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const viewOf = () => (/[?&]view=table\b/.test(location.hash) ? "table" : "bars");

const KIND_LABEL: Record<string, string> = { agent: "Agent", owner: "Owner", outside: "Outside" };
type Col = { key: string; label: string; num: boolean; get: (x: JourneyItem) => number | string | null };

/** An item's name: a PR's number linking to the PR, a piece of work's identifier (its row opens the waterfall). */
function Ref({ x, title }: { x: JourneyItem; title: string }) {
  const text = x.number != null ? `#${x.number}` : nameOf(x);
  return x.url ? <a href={x.url} target="_blank" rel="noopener noreferrer" title={title} onClick={(e) => e.stopPropagation()}>{text}</a> : <span title={title}>{text}</span>;
}

/** The PRs and the issue an item holds, each linking to it. */
function Links({ x }: { x: JourneyItem }) {
  if (!x.links.length) return null;
  return (
    <span className="fl-links">
      {x.links.map((l) =>
        l.url ? (
          <a key={l.subject} href={l.url} target="_blank" rel="noopener noreferrer" title={l.subject} onClick={(e) => e.stopPropagation()}>{linkName(l.subject)}</a>
        ) : (
          <span key={l.subject} title={l.subject}>{linkName(l.subject)}</span>
        ),
      )}
    </span>
  );
}

/**
 * The items as a table: one column per phase of the journey (its duration, ↻n for rounds, tinted by a heat scale per column so
 * slow cells stand out), every header sorts. Sorting is over the loaded rows; the kernel's sort picks which rows load. The author
 * column shows only for items that have one (PRs), the links column for items that hold PRs or an issue.
 */
export function ItemTable({ items, phases, color, onTask, label, truncated }: { items: JourneyItem[]; phases: { name: string; label: string }[]; color: (p: string) => string; onTask: (t: string) => void; label: string; truncated: boolean }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [shown, setShown] = useState(PAGE);
  const secs = (x: JourneyItem, ph: string) => {
    const b = x.blocks.find((y) => y.phase === ph);
    return b ? (Date.parse(b.end) - Date.parse(b.start)) / 1000 : null;
  };
  const authored = items.some((x) => x.author_kind), linked = items.some((x) => x.links.length);
  const cols: Col[] = [
    { key: "name", label: "Item", num: false, get: (x) => x.number ?? nameOf(x) },
    ...(authored ? [{ key: "author", label: "Author", num: false, get: (x: JourneyItem) => x.author_kind }] : []),
    ...(linked ? [{ key: "links", label: "PRs and issue", num: false, get: (x: JourneyItem) => x.links.length || null }] : []),
    ...phases.map((ph): Col => ({ key: `ph:${ph.name}`, label: ph.label, num: true, get: (x) => secs(x, ph.name) })),
    { key: "total", label: "Total", num: true, get: (x) => x.total_s },
  ];
  // Per phase column, a log scale from its fastest to its slowest cell: the heat a cell's tint carries.
  const heat = new Map(
    phases.map((ph) => {
      const v = items.map((x) => secs(x, ph.name)).filter((n): n is number => n != null && n > 0);
      const lo = Math.log(Math.max(1, Math.min(...v))), hi = Math.log(Math.max(2, ...v));
      return [ph.name, (n: number) => (v.length < 2 || hi <= lo ? 0 : Math.max(0, (Math.log(Math.max(1, n)) - lo) / (hi - lo)))];
    }),
  );
  const rows = sort
    ? [...items].sort((a, b) => {
        const c = cols.find((k) => k.key === sort.key)!;
        const va = c.get(a), vb = c.get(b);
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
      })
    : items;
  const click = (key: string) => setSort(sort?.key === key ? (sort.dir === -1 ? { key, dir: 1 } : null) : { key, dir: -1 });
  return (
    <div className="fl-tablewrap">
      <table className="fl-table" aria-label={label}>
        <thead>
          <tr>
            {cols.map((c) => {
              const ph = c.key.startsWith("ph:") ? c.key.slice(3) : null;
              const on = sort?.key === c.key;
              return (
                <th key={c.key} className={c.num ? "num" : ""} aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : "none"} scope="col">
                  <button type="button" onClick={() => click(c.key)}>
                    {ph && <i style={{ background: color(ph) }} />}
                    {c.label}
                    <span className="fl-sort" aria-hidden>{on ? (sort!.dir === 1 ? "▲" : "▼") : ""}</span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map((x) => (
            <tr key={x.subject} className={`${x.task ? "has-task" : ""} fl-${x.state}`} onClick={() => x.task && onTask(x.task)}>
              <th scope="row">
                <Ref x={x} title={x.title ?? x.subject} />
              </th>
              {authored && <td className="fl-td-author">{x.author_kind ? KIND_LABEL[x.author_kind] : "—"}</td>}
              {linked && <td className="fl-td-links"><Links x={x} /></td>}
              {phases.map((ph) => {
                const b = x.blocks.find((y) => y.phase === ph.name);
                if (!b) return <td key={ph.name} className="num fl-td-none">—</td>;
                const v = (Date.parse(b.end) - Date.parse(b.start)) / 1000;
                const h = heat.get(ph.name)!(v);
                return (
                  <td key={ph.name} className="num" style={{ ["--h" as string]: `${Math.round(h * h * 100)}%` }} title={b.idle_s ? `${dur(b.idle_s)} idle: ${Object.entries(b.idle).map(([r, s2]) => `${words(r)} ${dur(s2)}`).join(", ")}` : undefined}>
                    {b.rounds > 1 && <span className="fl-rounds">↻{b.rounds}</span>}
                    {dur(v)}
                  </td>
                );
              })}
              <td className="num fl-td-total">
                {dur(x.total_s)}
                {(x.state === "open" || x.state === "closed" || x.state === "cancelled") && <small> {x.state}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(rows.length > shown || truncated) && (
        <div className="fl-more">
          {rows.length > shown && (
            <button type="button" className="btn sm" onClick={() => setShown(shown + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown)} more
            </button>
          )}
          {truncated && <span className="flow-dim">The newest {items.length} are listed; pick a shorter period to see the rest.</span>}
        </div>
      )}
    </div>
  );
}

function ItemRow({ x, phases, color, onTask }: { x: JourneyItem; phases: { name: string; label: string }[]; color: (p: string) => string; onTask: (t: string) => void }) {
  const tip = useTip();
  const [ref, w] = useWidth<HTMLSpanElement>();
  const label = (ph: string) => phases.find((p) => p.name === ph)?.label ?? ph;
  // The bar is always the full width: each block takes its share of this item's own time, at least 4px so it stays hoverable
  // (the blocks above the minimum give up the room the small ones take).
  const secs = x.blocks.map((b) => Math.max(0, (Date.parse(b.end) - Date.parse(b.start)) / 1000));
  const span = secs.reduce((a, v) => a + v, 0) || 1;
  const gap = 1, MIN = 4;
  const room = Math.max(0, w - gap * (x.blocks.length - 1));
  const small = secs.map((v) => (v / span) * room < MIN);
  const fixed = small.filter(Boolean).length * MIN;
  const bigSpan = secs.reduce((a, v, i) => a + (small[i] ? 0 : v), 0) || 1;
  let left = 0;
  const px = x.blocks.map((b, i) => {
    const wd = small[i] ? MIN : (secs[i]! / bigSpan) * Math.max(0, room - fixed);
    const g = { b, s: secs[i]!, l: left, wd, share: secs[i]! / span };
    left += wd + gap;
    return g;
  });
  const by = x.author ? ` by ${x.author}` : "";
  const open = () => x.task && onTask(x.task);
  const summary = `${x.number != null ? `#${x.number}` : nameOf(x)}${x.title ? ` ${x.title}` : ""}${by}: ${x.blocks.map((b) => `${label(b.phase)} ${dur((Date.parse(b.end) - Date.parse(b.start)) / 1000)}${b.rounds > 1 ? `, ${b.rounds} rounds` : ""}`).join("; ")}; total ${dur(x.total_s)}`;
  return (
    <li className={`fl-row${x.task ? " has-task" : ""} fl-${x.state}`} onClick={open}>
      <span className="fl-num">
        <Ref x={x} title={`${x.title ?? x.subject}${by}`} />
      </span>
      <span className="fl-title" title={x.title ?? undefined}>
        <span className="fl-title-text">{x.title ?? <span className="flow-dim">{x.repo ?? x.identifier ?? ""}</span>}</span>
        <Links x={x} />
      </span>
      <span className="fl-track" ref={ref} role="img" aria-label={summary}>
        {w > 0 &&
          px.map(({ b, s, l, wd, share }, i) => {
            const idleShare = s ? Math.min(1, b.idle_s / s) : 0;
            const body = () => (
              <TipBody
                head={<><i className="fl-tip-key" style={{ background: color(b.phase) }} />{label(b.phase)}</>}
                rows={[
                  ["Duration", `${dur(s)} · ${pct(share)} of total`],
                  ...(b.rounds > 1 ? [["Rounds", `↻${b.rounds}`] as [string, string]] : []),
                  ...(b.idle_s > 0 ? [["Idle", `${dur(b.idle_s)} · ${pct(idleShare)}`] as [string, string]] : []),
                  ...Object.entries(b.idle).sort((a2, b2) => b2[1] - a2[1]).map(([r, v]): [string, string] => [`  ${words(r)}`, dur(v)]),
                ]}
                foot={x.task ? "Click for the waterfall" : undefined}
              />
            );
            return (
              <span
                key={i}
                className="fl-block"
                tabIndex={0}
                aria-label={`${label(b.phase)} ${dur(s)}`}
                style={{ left: l, width: wd, background: color(b.phase) }}
                onKeyDown={(e) => e.key === "Enter" && open()}
                {...tipProps(tip, body)}
              >
                {idleShare > 0 && <i className="fl-idle" style={{ width: `${idleShare * 100}%` }} />}
                {b.rounds > 1 && wd > 26 && <b>↻{b.rounds}</b>}
              </span>
            );
          })}
      </span>
      <span className="fl-total">
        {dur(x.total_s)}
        {x.state === "open" && <small><i className="fl-live" />open</small>}
        {(x.state === "closed" || x.state === "cancelled") && <small>{x.state}</small>}
      </span>
    </li>
  );
}

/* ----------------------------------------------------------------------------- Overview */
const DORA: { key: keyof Insights["dora5"]; label: string; fmt: (v: number | null) => string; better: "up" | "down" }[] = [
  { key: "deploys_per_day", label: "Deploys per day", fmt: (v) => (v == null ? "—" : v.toFixed(1)), better: "up" },
  { key: "lead_time_s", label: "Lead time", fmt: dur, better: "down" },
  { key: "change_fail_rate", label: "Change fail rate", fmt: pct, better: "down" },
  { key: "recovery_s", label: "Time to recover", fmt: dur, better: "down" },
  { key: "rework_rate", label: "Rework rate", fmt: pct, better: "down" },
];

function Delta({ m, better, days }: { m: Metric; better: "up" | "down"; days: number }) {
  if (m.value == null || m.previous == null || m.previous === 0) return <span className="fl-delta">no earlier period</span>;
  const change = (m.value - m.previous) / Math.abs(m.previous);
  if (Math.abs(change) < 0.005) return <span className="fl-delta">same as previous {days}d</span>;
  const good = (change > 0) === (better === "up");
  return (
    <span className={`fl-delta ${good ? "good" : "bad"}`}>
      <b>{change > 0 ? "▲" : "▼"} {Math.round(Math.abs(change) * 100)}%</b> vs previous {days}d
    </span>
  );
}

const KIND_WORD = { idle: "Idle", rounds: "Rework", slow: "Slow" } as const;

function Overview({ c }: { c: Ctx }) {
  const ins = c.ins!;
  const label = (ph: string) => c.phases.find((p) => p.name === ph)?.label ?? ph;
  const funnelTop = ins.funnel[0]?.n ?? 0;
  return (
    <>
      <div className="fl-dora" aria-label="DORA metrics">
        {DORA.map((d) => {
          const m = ins.dora5[d.key];
          return (
            <div key={d.key} className="fl-kpi">
              <div className="fl-kpi-label">{d.label}</div>
              <div className="fl-kpi-value">{d.fmt(m.value)}</div>
              <Delta m={m} better={d.better} days={c.days} />
              <Sparkline values={m.weekly.map((w) => w.value)} label={`${d.label} by week: ${m.weekly.map((w) => `${day(w.week)} ${d.fmt(w.value)}`).join(", ")}`} />
            </div>
          );
        })}
      </div>
      <div className="fl-split">
        <Section title="Bottlenecks" hint="Where to look first">
          {ins.bottlenecks.length ? (
            <ol className="fl-bottlenecks">
              {ins.bottlenecks.slice(0, 3).map((b) => (
                <li key={`${b.phase}-${b.kind}`} style={{ ["--ph" as string]: c.color(b.phase) }}>
                  <span className="fl-bn-tag">
                    <i />
                    {label(b.phase)}
                    <em>{KIND_WORD[b.kind]}</em>
                  </span>
                  <p>{b.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <FlowEmpty />
          )}
        </Section>
        <Section title="Funnel" hint="Started this period, through each phase, delivered">
          <BarList
            label="Funnel"
            fmt={(v) => String(v)}
            rows={ins.funnel.map((f, i) => ({
              key: f.step,
              label: f.label,
              value: f.n,
              color: series(0),
              sub: i && funnelTop ? pct(f.n / funnelTop) : "",
            }))}
          />
        </Section>
      </div>
      <Section title="Throughput" hint="Items per day">
        <Columns
          label="Items delivered and started per day"
          xs={ins.throughput.map((t) => t.day)}
          series={[{ key: "delivered", label: "Delivered", color: series(0) }, { key: "started", label: "Started", color: series(2) }]}
          value={(i, s) => ins.throughput[i]![s as "delivered" | "started"]}
          mode="group"
          fmt={(v) => String(Math.round(v))}
        />
      </Section>
    </>
  );
}

/* ----------------------------------------------------------------------------- Stages */
function Stages({ c }: { c: Ctx }) {
  const ins = c.ins!;
  const ph = ins.phases.filter((p) => p.n > 0);
  const weeks = [...new Set(ins.phases.flatMap((p) => p.weekly.map((w) => w.week)))].sort();
  const pts = ins.scatter.map((s) => s.total_s).sort((a, b) => a - b);
  const q = (p: number) => pts[Math.min(pts.length - 1, Math.floor(p * pts.length))]!;
  const lo = Math.max(30, Math.min(...ph.map((p) => p.p50 ?? Infinity)) * 0.7);
  const hi = Math.max(...ph.map((p) => p.p95 ?? 0)) * 1.1;
  const sc = logScale(lo, hi, 0, 100);
  return (
    <>
      <Section title="Median time per phase" hint="Stacked by week">
        <Columns
          label="Median duration of each phase, stacked per week"
          xs={weeks}
          series={ph.map((p) => ({ key: p.name, label: p.label, color: c.color(p.name) }))}
          value={(i, s) => ins.phases.find((p) => p.name === s)?.weekly.find((w) => w.week === weeks[i])?.p50 ?? null}
          fmt={dur}
          durations
          xLabel={week}
          height={240}
        />
      </Section>
      <Section title="Percentiles per phase" hint="Bar from p50 to p95, tick at p85 (log scale)">
        {ph.length ? (
          <div className="fl-pct" role="table" aria-label="Phase percentiles">
            <div className="fl-pct-row head" role="row">
              <span role="columnheader">Phase</span>
              <span role="columnheader">Items</span>
              <span role="columnheader">p50</span>
              <span role="columnheader">p85</span>
              <span role="columnheader">p95</span>
              <span role="columnheader" className="fl-pct-range">Spread</span>
              <span role="columnheader">Idle</span>
              <span role="columnheader">Rounds</span>
            </div>
            {ph.map((p) => (
              <div key={p.name} className="fl-pct-row" role="row">
                <span role="cell" className="fl-pct-name"><i style={{ background: c.color(p.name) }} />{p.label}</span>
                <span role="cell">{p.n}</span>
                <span role="cell">{dur(p.p50)}</span>
                <span role="cell">{dur(p.p85)}</span>
                <span role="cell">{dur(p.p95)}</span>
                <span role="cell" className="fl-pct-range" aria-label={`p50 ${dur(p.p50)} to p95 ${dur(p.p95)}`}>
                  {p.p50 != null && p.p95 != null && (
                    <span className="fl-range">
                      <i style={{ left: `${sc.f(p.p50)}%`, width: `${Math.max(0.6, sc.f(p.p95) - sc.f(p.p50))}%`, background: c.color(p.name) }} />
                      {p.p85 != null && <b style={{ left: `${sc.f(p.p85)}%` }} />}
                    </span>
                  )}
                </span>
                <span role="cell">{dur(p.idle_s)}</span>
                <span role="cell">{p.rounds_mean ? p.rounds_mean.toFixed(1) : "—"}</span>
              </div>
            ))}
          </div>
        ) : (
          <FlowEmpty />
        )}
      </Section>
      <Section title="Cycle time" hint="Each finished item, end to end (log scale); click a dot to open it">
        <DotPlot
          label={`Cycle time of ${ins.scatter.length} items by end date; p50 ${dur(pts.length ? q(0.5) : null)}, p85 ${dur(pts.length ? q(0.85) : null)}`}
          legend={AUTHORS.map(([k, name]) => ({ label: name, color: AUTHOR_COLOR[k]! }))}
          fmtY={dur}
          height={300}
          lines={pts.length ? [{ y: q(0.5), label: `p50 ${dur(q(0.5))}` }, { y: q(0.85), label: `p85 ${dur(q(0.85))}` }, { y: q(0.95), label: `p95 ${dur(q(0.95))}` }] : []}
          dots={ins.scatter.map((s) => ({
            key: s.subject,
            x: Date.parse(s.end),
            y: s.total_s,
            color: s.author_kind ? AUTHOR_COLOR[s.author_kind] ?? "var(--faint)" : "var(--faint)",
            label: `${nameOf(s)}: ${dur(s.total_s)}, ended ${day(s.end)}`,
            onClick: () => c.openSubject(s.subject, s),
            tip: () => <TipBody head={s.title ? `${nameOf(s)} ${s.title}` : nameOf(s)} rows={[["Total", dur(s.total_s)], ["Ended", day(s.end)], ...(s.author_kind ? [["Author", s.author_kind] as [string, string]] : [])]} />,
          }))}
        />
      </Section>
    </>
  );
}

/* ----------------------------------------------------------------------------- Rework */
function Rework({ c }: { c: Ctx }) {
  const ins = c.ins!;
  const churn = c.summary?.churn;
  const hist = c.phases.filter((p) => ins.rounds[p.name] && Object.keys(ins.rounds[p.name]!).length);
  return (
    <>
      <Section title="Rounds per phase" hint="How many tries each phase took; 1 is first pass">
        {hist.length ? (
          <div className="fl-hists">
            {hist.map((p) => (
              <RoundsHist key={p.name} label={p.label} color={c.color(p.name)} counts={ins.rounds[p.name]!} />
            ))}
          </div>
        ) : (
          <FlowEmpty />
        )}
      </Section>
      <div className="fl-split">
        <Section title="First pass" hint="Share of finished items with every phase done the first time, by week">
          <Lines label="First-pass rate by week" xs={ins.first_pass.map((f) => f.week)} series={[{ key: "rate", label: "First pass", color: series(0) }]} value={(i) => ins.first_pass[i]!.rate} fmt={pct} yMax={1} xLabel={(w) => day(w)} />
        </Section>
        <Section title="Why the AI reviewer rejected" hint="Reason codes, this period">
          <BarList label="Rejection reasons" fmt={(v) => String(v)} rows={ins.rejections.map((r) => ({ key: r.reason, label: words(r.reason), value: r.n, color: series(7) }))} />
        </Section>
      </div>
      {churn && (
        <div className="fl-tiles">
          <StatBlock label="Churn, 30 days" value={pct(churn.rewritten_30d)} sub={`${churn.hot_lines} lines rewritten 3+ times`} />
          <StatBlock label="First pass, AI review" value={pct(c.summary?.fleet.first_pass_review)} sub="filed without a rejection" />
        </div>
      )}
    </>
  );
}

function RoundsHist({ label, color, counts: raw }: { label: string; color: string; counts: Record<string, number> }) {
  const tip = useTip();
  const keys = ["1", "2", "3", "4"];
  const counts: Record<string, number> = Object.fromEntries(keys.map((k) => [k, Object.entries(raw).filter(([c]) => (k === "4" ? Number(c) >= 4 : c === k)).reduce((a, [, v]) => a + v, 0)]));
  const total = keys.reduce((a, k) => a + counts[k]!, 0);
  const max = Math.max(...keys.map((k) => counts[k]!));
  const mean = keys.reduce((a, k) => a + Number(k) * counts[k]!, 0) / (total || 1);
  return (
    <figure className="fl-hist" aria-label={`${label}: ${keys.map((k) => `${counts[k]} with ${k}${k === "4" ? " or more" : ""} round${k === "1" ? "" : "s"}`).join(", ")}`}>
      <figcaption>
        <span><i style={{ background: color }} />{label}</span>
        <b>{mean.toFixed(1)}</b>
      </figcaption>
      <div className="fl-hist-bars">
        {keys.map((k) => (
          <span key={k} tabIndex={0} {...tipProps(tip, () => <TipBody head={`${label}: ${k}${Number(k) >= 4 ? "+" : ""} round${k === "1" ? "" : "s"}`} rows={[["Items", String(counts[k])], ["Share", pct(counts[k]! / total)]]} />)}>
            <i style={{ height: counts[k] ? `${Math.max(4, (counts[k]! / max) * 100)}%` : 0, background: color, opacity: k === "1" ? 0.5 : 1 }} />
            <small>{k}{Number(k) >= 4 ? "+" : ""}</small>
          </span>
        ))}
      </div>
    </figure>
  );
}

/* ----------------------------------------------------------------------------- Queue */
function Queue({ c }: { c: Ctx }) {
  const ins = c.ins;
  const cats = c.phases.map((p) => ({ label: p.label, color: c.color(p.name) }));
  const idx = (ph: string) => c.phases.findIndex((p) => p.name === ph);
  const cfdPhases = [...c.phases].reverse();
  return (
    <>
      {ins && (
        <Section title="Open work by age" hint="Each open item in its current phase; the line is that phase's p85 (log scale)" count={ins.aging.length}>
          <DotPlot
            label={`${ins.aging.length} open items by current phase and age`}
            cats={cats}
            fmtY={dur}
            height={300}
            lines={ins.phases.filter((p) => p.p85 != null && idx(p.name) >= 0).map((p) => ({ y: p.p85!, cat: idx(p.name), label: `${p.label} p85 ${dur(p.p85)}` }))}
            dots={ins.aging.filter((a) => idx(a.phase) >= 0).map((a) => {
              const p85 = ins.phases.find((p) => p.name === a.phase)?.p85;
              return {
                key: a.subject,
                x: idx(a.phase),
                y: a.age_s,
                color: c.color(a.phase),
                label: `${a.title ?? nameOf(a)}: ${dur(a.age_s)} in ${a.phase}${a.idle_reason ? `, waiting on ${words(a.idle_reason)}` : ""}`,
                onClick: () => c.openSubject(a.subject, a),
                tip: () => (
                  <TipBody
                    head={a.title ? `${nameOf(a)} ${a.title}` : nameOf(a)}
                    rows={[["Age", dur(a.age_s)], ["Phase", c.phases[idx(a.phase)]!.label], ...(a.idle_reason ? [["Waiting on", words(a.idle_reason)] as [string, string]] : [])]}
                    foot={p85 != null && a.age_s > p85 ? "Older than 85% of finished items in this phase" : undefined}
                  />
                ),
              };
            })}
          />
        </Section>
      )}
      {ins && (
        <Section title="Cumulative flow" hint="Items in each phase per day">
          <Lines label="Items per phase per day, stacked" stacked xs={ins.cfd.map((d) => d.day)} series={cfdPhases.map((p) => ({ key: p.name, label: p.label, color: c.color(p.name) }))} value={(i, s) => ins.cfd[i]!.counts[s] ?? 0} fmt={(v) => String(Math.round(v))} height={240} />
        </Section>
      )}
      <Section title="Idle now" count={c.idle.length} hint="Oldest first">
        {c.idle.length === 0 ? <EmptyState>Nothing is waiting without a reason.</EmptyState> : <IdleList items={c.idle} onOpen={c.openTask} />}
      </Section>
    </>
  );
}

function IdleList({ items, onOpen }: { items: IdleItem[]; onOpen: (id: string) => void }) {
  return (
    <ul className="flow-idle">
      {items.map((i) => (
        <li key={i.task}>
          <button type="button" onClick={() => onOpen(i.task)}>
            <span className="flow-idle-id">{i.identifier ?? i.task}</span>
            <span className="flow-idle-since">{agoLabel(i.since).replace(" ago", "")}</span>
            <span className="flow-idle-why">{words(i.reason)}</span>
            <span className="flow-dim">{i.holder ?? ""}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------------------- Cost */
function Cost({ c }: { c: Ctx }) {
  const cost = c.ins!.cost;
  const spent = cost.by_agent.reduce((a, x) => a + x.usd, 0);
  const delivered = cost.by_agent.reduce((a, x) => a + x.delivered, 0);
  const rows = (xs: { key: string; usd: number; delivered: number }[], color: string) =>
    [...xs].sort((a, b) => b.usd - a.usd).map((x) => ({
      key: x.key,
      label: x.key,
      value: x.usd,
      color,
      sub: x.delivered ? `${x.delivered} delivered · ${usd(x.usd / x.delivered)} each` : "nothing delivered",
    }));
  return (
    <>
      <div className="fl-tiles">
        <StatBlock label="Per delivered item" value={usd(delivered ? spent / delivered : null)} sub={`${delivered} delivered this period (a PR merged, a piece of work done)`} />
        <StatBlock label="Spent" value={usd(spent)} sub="all agent runs, failed attempts included" />
        <StatBlock label="Never delivered" value={usd(cost.undelivered_usd)} sub={spent ? `${pct(cost.undelivered_usd / spent)} of spend went to attempts that didn't land` : "attempts that didn't land"} tone={spent && cost.undelivered_usd / spent > 0.25 ? "bad" : undefined} />
      </div>
      <Section title="Cost per delivered item" hint="By week">
        <Columns label="Cost per delivered item by week" xs={cost.per_delivered.map((w) => w.week)} series={[{ key: "usd", label: "Per delivered item", color: series(0) }]} value={(i) => cost.per_delivered[i]!.usd} fmt={(v) => `$${v.toFixed(v < 10 ? 2 : 0)}`} xLabel={week} height={200} />
      </Section>
      <div className="fl-split">
        <Section title="By agent">
          <BarList label="Spend by agent" fmt={usd} rows={rows(cost.by_agent, series(0))} />
        </Section>
        <Section title="By model">
          <BarList label="Spend by model" fmt={usd} rows={rows(cost.by_model, series(6))} />
        </Section>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------------------- waterfall */
function ItemDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [w, setW] = useState<{ id: string; data?: Waterfall; error?: string } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    api.flowItem(id).then((data) => live && setW({ id, data }), (e: Error) => live && setW({ id, error: e.message }));
    return () => {
      live = false;
    };
  }, [id]);
  const cur = w && w.id === id ? w : null;
  return (
    <Dialog open={!!id} onClose={onClose} title={cur?.data ? `Waterfall · ${cur.data.root}` : "Waterfall"} wide>
      {cur?.error ? <Banner tone="danger">{cur.error}</Banner> : cur?.data ? <WaterfallView w={cur.data} /> : <p className="flow-note">Loading…</p>}
    </Dialog>
  );
}

type Span = { key: string; kind: "stage" | "idle"; label: string; who: string; start: number; end: number | null; open: boolean };

export function WaterfallView({ w }: { w: Waterfall }) {
  const spans: Span[] = [
    ...w.stages.map((x, i): Span => ({ key: `s${i}`, kind: "stage", label: x.label, who: x.actor ?? "unknown", start: Date.parse(x.start), end: x.end ? Date.parse(x.end) : null, open: !x.end })),
    ...w.idle.map((x, i): Span => ({ key: `i${i}`, kind: "idle", label: `idle: ${x.blocked_on ? `blocked on ${x.blocked_on}` : words(x.reason)}`, who: x.holder ?? "", start: Date.parse(x.start), end: x.end ? Date.parse(x.end) : null, open: !x.end })),
  ].sort((a, b) => a.start - b.start);
  if (!spans.length) return <p className="flow-note">Nothing recorded for this item yet.</p>;
  const t0 = spans[0]!.start;
  const now = Date.now();
  const t1 = Math.max(...spans.map((x) => x.end ?? now), t0 + 1);
  return (
    <ol className="flow-fall" aria-label="Stages and idle gaps">
      {spans.map((x) => {
        const end = x.end ?? now;
        return (
          <li key={x.key} className={x.kind}>
            <span className="flow-fall-label">{x.label}{x.who && <span className="flow-dim"> · {x.who}</span>}</span>
            <span className="flow-fall-track" aria-hidden>
              <i style={{ left: `${((x.start - t0) / (t1 - t0)) * 100}%`, width: `${Math.max(0.8, ((end - x.start) / (t1 - t0)) * 100)}%` }} />
            </span>
            <span className="flow-fall-dur">{dur((end - x.start) / 1000)}{x.open && " so far"}</span>
          </li>
        );
      })}
    </ol>
  );
}
