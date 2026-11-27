// Tasks › Mine and Delegated: one list of sections (New, Today, Upcoming, Later; Working, Waiting on you, Queued, Done today),
// each row the board's one compact row (ui/DigestList.tsx) in columns. A click or Enter opens the slide-over drawer (ui/RowDrawer.tsx);
// Done, Later and Dismiss lie over a row on hover. J/K move, 1-3 plan, X dismisses, Enter opens. The drawer reads the task
// (`GET /api/issues/<id>`) and writes through the same calls the rest of the board uses; its comment box is the one way to write.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MergeMenu, Popover } from "./components";
import { api } from "./api";
import { Markdown } from "./markdown";
import { DELEGATED, NEW_ROWS, SECTIONS, SOURCES, nextWeekOf, progressOf, sourceOf, upcomingGroups, waitingOf, type Buckets, type DelegatedGroup, type Section } from "./own-tasks";
import type { Assignee, Board, Bucket, Card, CommentView, Filters, IssueView, Milestone, WorkCard } from "./types";
import { Button, Kbd, Monogram, RowDrawer, DigestRow, buttonClass, safeHref } from "./ui";
import type { DigestItem } from "./ui/DigestList";
import { Icon, type IconName } from "./ui/icons";
import { ago, agoLabel, clockOpts, dayDate, shortName, sourceDate, todayIn, when } from "./util";
import "./tasks.css";

export interface TasksProps {
  tab: "mine" | "work";
  board: Board;
  /** The owner's own tasks by bucket, after the filters. */
  mine: Buckets;
  /** The tasks assigned to agents by group, after the filters. */
  delegated: Record<DelegatedGroup, WorkCard[]>;
  /** A filter or search is on: New shows every match. */
  narrowed: boolean;
  mergeTargets: Card[];
  onDone: (c: Card) => void;
  onDismiss: (c: Card) => void;
  onMove: (c: Card, b: Bucket) => void;
  onSnooze: (c: Card, date: string) => void;
  onMerge: (c: Card, into: Card) => void;
  /** The drawer changed something: read the board again. */
  onChanged: () => void;
  toast: (text: string) => void;
  /** A search is on: the completed tasks it found (Mine), and a way to read older ones. */
  closed?: Card[];
  moreDone?: () => void;
}

/** Rows a Delegated section shows before "Show all N". */
const DELEGATED_ROWS = 10;

type Glyph = "new" | "today" | "upcoming" | "later" | "working" | "waiting" | "queued" | "done";
type Item = { card: Card; glyph: Glyph; group: string; mine: boolean };
type Block = { id: string; name: string; glyph: Glyph; edge: string; count: number; note?: React.ReactNode; groups: { label?: string; items: Item[] }[]; /** Rows shown before "Show all N". */ limit?: number; cap?: number };

const EDGE: Record<Glyph, string> = { new: "var(--triage)", today: "var(--today)", upcoming: "var(--tomorrow)", later: "var(--later)", working: "var(--working)", waiting: "var(--warn)", queued: "var(--later)", done: "var(--working)" };

/** The status glyph of a section: the same drawing in a header, on a row and in the drawer. */
export function SectionGlyph({ glyph }: { glyph: Glyph }) {
  const c = EDGE[glyph];
  return (
    <svg className="tk-glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      {glyph === "new" && <><circle cx="8" cy="8" r="6.2" stroke={c} strokeWidth="1.6" strokeDasharray="2.2 2.2" /><circle cx="8" cy="8" r="2" fill={c} /></>}
      {glyph === "today" && <><circle cx="8" cy="8" r="6.2" stroke={c} strokeWidth="1.6" /><path d="M8 4a4 4 0 0 1 0 8z" fill={c} /></>}
      {glyph === "upcoming" && <><circle cx="8" cy="8" r="6.2" stroke={c} strokeWidth="1.6" /><path d="M8 4v4l2.4 1.4" stroke={c} strokeWidth="1.5" strokeLinecap="round" /></>}
      {glyph === "later" && <circle cx="8" cy="8" r="6.2" stroke={c} strokeWidth="1.6" strokeDasharray="1 3" strokeLinecap="round" />}
      {glyph === "working" && <><circle cx="8" cy="8" r="6.2" stroke={c} strokeOpacity=".3" strokeWidth="1.6" /><path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" stroke={c} strokeWidth="1.8" strokeLinecap="round" /></>}
      {glyph === "waiting" && <><circle cx="8" cy="8" r="6.2" stroke={c} strokeWidth="1.6" /><path d="M8 4.6v3.8M8 10.6v.4" stroke={c} strokeWidth="1.7" strokeLinecap="round" /></>}
      {glyph === "queued" && <circle cx="8" cy="8" r="6.2" stroke={c} strokeWidth="1.6" strokeDasharray="2.2 2.2" />}
      {glyph === "done" && <><circle cx="8" cy="8" r="6.8" fill={c} /><path d="m5 8.3 2.2 2.2L11 6.2" stroke="var(--accent-text)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>}
    </svg>
  );
}

const KIND_ICON: Record<string, IconName> = { chat: "chat", mail: "mail", calendar: "calendar", pr: "reviews", doc: "brief" };

const person = (assignees: Assignee[], key: string | null | undefined) => (key ? assignees.find((a) => a.key === key) : undefined);

/** The rows of the sections: Mine's, or Delegated's. */
function blocksOf(p: TasksProps, open: Set<string>): Block[] {
  const cap = (id: string, limit: number) => (open.has(id) || p.narrowed ? undefined : limit);
  if (p.tab === "work") {
    return DELEGATED.map(({ id, name }) => ({
      id,
      name: id === "done" && p.narrowed ? "Done" : name,
      glyph: id,
      edge: EDGE[id],
      count: p.delegated[id].length,
      groups: [{ items: [...p.delegated[id]].sort((a, b) => b.activityAt.localeCompare(a.activityAt)).map((card) => ({ card, glyph: id, group: id, mine: false })) }],
      limit: DELEGATED_ROWS,
      cap: cap(id, DELEGATED_ROWS),
    }));
  }
  const tag = (id: Section, glyph: Glyph) => (card: Card): Item => ({ card, glyph, group: id, mine: true });
  const closed = p.closed ?? [];
  const of = (id: Section) => SECTIONS.find((s) => s.id === id)!.buckets.flatMap((b) => p.mine[b]);
  const news = of("new");
  return [
    { id: "new", name: "New", glyph: "new", edge: EDGE.new, count: news.length, note: <><span className="tk-tag">Triage</span><span className="tk-note">filed by agents and Intake</span></>, groups: [{ items: news.map(tag("new", "new")) }], limit: NEW_ROWS, cap: cap("new", NEW_ROWS) },
    { id: "today", name: "Today", glyph: "today", edge: EDGE.today, count: of("today").length, groups: [{ items: of("today").map(tag("today", "today")) }] },
    { id: "upcoming", name: "Upcoming", glyph: "upcoming", edge: EDGE.upcoming, count: of("upcoming").length, groups: upcomingGroups(p.mine, p.board).map((g) => ({ label: g.label, items: g.cards.map(tag("upcoming", "upcoming")) })) },
    { id: "later", name: "Later", glyph: "later", edge: EDGE.later, count: of("later").length, groups: [{ items: of("later").map(tag("later", "later")) }] },
    ...(closed.length || p.moreDone ? [{ id: "done", name: "Done", glyph: "done" as const, edge: EDGE.done, count: closed.length, groups: [{ items: closed.map((card): Item => ({ card, glyph: "done", group: "done", mine: false })) }] }] : []),
  ];
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, clockOpts());

/** The one time column of a row: how long ago for New and delegated work, a clock time for today's activity, else how long ago. */
function timeOf(it: Item, board: Board): string {
  const c = it.card as WorkCard;
  if (!it.mine) return it.group === "done" && c.closedAt ? (new Date(c.closedAt).toDateString() === new Date().toDateString() ? clock(c.closedAt) : when(c.closedAt)) : agoLabel(c.activityAt);
  if (it.group === "new") return ago(c.createdAt);
  if (c.carried) return `Carried ${c.carried}d`;
  if (it.group === "later" && !c.scheduled) return "Someday";
  return new Date(c.activityAt).toDateString() === new Date().toDateString() ? clock(c.activityAt) : ago(c.activityAt);
}

/** Later's three places: Tomorrow, Next week and Someday. */
function LaterMenu({ timezone, tomorrow, onTomorrow, onWeek, onSomeday, size }: { timezone: string; /** The date the Tomorrow bucket rolls into Today (the next workday). */ tomorrow: string; onTomorrow: () => void; onWeek: (date: string) => void; onSomeday: () => void; size?: "sm" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const today = todayIn(timezone);
  const week = nextWeekOf(today);
  const hint = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
  const pick = (f: () => void) => () => (setOpen(false), f());
  return (
    <div className={`menu-wrap${open ? " open" : ""}`}>
      <button ref={ref} type="button" className={buttonClass(undefined, size)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Later <Icon name="chevron" size={12} />
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)}>
          <button role="menuitem" onClick={pick(onTomorrow)}><span>Tomorrow</span><span className="menu-hint">{hint(tomorrow)}</span></button>
          <button role="menuitem" onClick={pick(() => onWeek(week))}><span>Next week</span><span className="menu-hint">{hint(week)}</span></button>
          <button role="menuitem" onClick={pick(onSomeday)}><span>Someday</span></button>
        </Popover>
      )}
    </div>
  );
}

export function TasksList(p: TasksProps) {
  const { board } = p;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const flip = (id: string) => setExpanded((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const [at, setAt] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const blocks = useMemo(() => blocksOf(p, expanded), [p.tab, p.mine, p.delegated, p.closed, p.moreDone, p.narrowed, p.board.rollsOn, expanded]);
  // Every row on screen in order: what J and K walk and the drawer steps through.
  const rows = useMemo(() => blocks.flatMap((b) => (collapsed.has(b.id) ? [] : b.groups.flatMap((g) => g.items)).slice(0, b.cap ?? Infinity)), [blocks, collapsed]);
  const cardOf = (id: string | null) => rows.find((r) => r.card.id === id);
  const openItem = cardOf(open);
  // A row that leaves (done, moved) closes its drawer.
  useEffect(() => void (open && !openItem && setOpen(null)), [open, openItem]);
  useEffect(() => void (at && !cardOf(at) && setAt(null)), [at, rows]);

  /** The task the keys act on: the open drawer's, else the row holding focus, else the one J/K picked. */
  const current = (el: Element) => open ?? el.closest<HTMLElement>("[data-row]")?.dataset.row ?? at;
  const step = useCallback((delta: number) => {
    const cur = rows.findIndex((r) => r.card.id === (open ?? (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-row]")?.dataset.row ?? at));
    const next = rows[Math.min(rows.length - 1, Math.max(0, cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta))];
    if (!next) return;
    setAt(next.card.id);
    if (open) setOpen(next.card.id);
    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-row="${CSS.escape(next.card.id)}"]`);
      row?.scrollIntoView({ block: "nearest" });
      // Focus follows the pick, so Enter and the action keys act on the row that is highlighted.
      if (!open) row?.querySelector<HTMLElement>(".ui-digest-open")?.focus({ preventScroll: true });
    });
  }, [rows, at, open]);

  // The list's keys. Typing, a modifier or another layer (a dialog, the palette, the task page) over the list turns them off;
  // inside the drawer J and K step to the next task.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      if (document.querySelector("dialog[open], .palette-backdrop, .drawer-backdrop:not(:has(.tasks-drawer))")) return;
      const k = e.key;
      const cur = cardOf(current(el));
      if (k === "j" || k === "ArrowDown") return e.preventDefault(), step(1);
      if (k === "k" || k === "ArrowUp") return e.preventDefault(), step(-1);
      if (!cur) return;
      if (k === "Enter" && !open && !el.closest("button,a")) return e.preventDefault(), setOpen(cur.card.id);
      if (!cur.mine) return;
      const into = { 1: "today", 2: "upcoming", 3: "later" }[k] as Section | undefined;
      if (into) return e.preventDefault(), void p.onMove(cur.card, SECTIONS.find((s) => s.id === into)!.into);
      if (k === "x") return e.preventDefault(), p.onDismiss(cur.card);
      if (k === "e") return e.preventDefault(), p.onDone(cur.card);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const total = blocks.reduce((n, b) => n + b.count, 0);
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const phone = (a: () => void) => () => (setOpen(null), a());

  const rowOf = (it: Item): DigestItem => {
    const c = it.card;
    const wait = it.mine ? waitingOf(c) : undefined;
    const src = sourceOf(c);
    const w = c as WorkCard;
    const agent = it.mine ? person(board.assignees, c.filedBy) : person(board.assignees, c.assignee);
    const progress = it.mine ? undefined : progressOf(w);
    const ctx = it.mine ? (wait ?? src.name) : progress;
    const acts = it.mine && (
      <>
        <Button size="sm" onClick={() => p.onDone(c)}><Icon name="check" size={14} /> Done</Button>
        <LaterMenu size="sm" timezone={board.timezone} tomorrow={board.rollsOn} onTomorrow={() => p.onMove(c, "tomorrow")} onWeek={(d) => p.onSnooze(c, d)} onSomeday={() => p.onMove(c, "backlog")} />
        <Button size="sm" onClick={() => p.onDismiss(c)}>Dismiss</Button>
      </>
    );
    return {
      id: c.id,
      cols: true,
      active: at === c.id || open === c.id,
      lead: <span className="tk-id" title={c.identifier}>{c.identifier}</span>,
      face: (
        <>
          <span className="tk-g"><SectionGlyph glyph={it.glyph} /></span>
          <span className="tk-kind">{it.mine && <Icon name={KIND_ICON[src.kind]!} size={14} />}</span>
        </>
      ),
      text: <>{c.title}{(wait || (!it.mine && it.group === "waiting")) && <i className="tk-wdot" aria-label="Waiting" />}</>,
      title: c.title,
      onOpen: () => (setAt(c.id), setOpen(c.id)),
      meta: (
        <>
          <span className={`tk-ctx${wait || it.group === "waiting" ? " warn" : ""}`}>{ctx}</span>
          <span className="tk-chip">{board.projects?.find((x) => x.id === c.projectId) && <ProjectChip name={board.projects.find((x) => x.id === c.projectId)!.name} />}</span>
          <span className="tk-by">{agent && <><Monogram name={agent.name} size={18} /><span className="tk-byn">{shortName(agent)}</span></>}</span>
          <span className="tk-when">{timeOf(it, board)}</span>
        </>
      ),
      actions: acts || undefined,
    };
  };

  if (!total && p.tab === "work" && !p.narrowed) return <div className="tk-empty"><b>Nothing is delegated yet.</b><span>Ask Aiden to take a task and it shows up here.</span></div>;

  return (
    <main className="tk" aria-label={p.tab === "mine" ? "Mine" : "Delegated"}>
      <div className="tk-card">
        {blocks.map((b) => (
          <section key={b.id} className="tk-grp" style={{ "--e": b.edge } as React.CSSProperties}>
            <header className="tk-sh" onClick={() => toggle(b.id)}>
              <button type="button" className="tk-tog" aria-expanded={!collapsed.has(b.id)} aria-label={`${collapsed.has(b.id) ? "Expand" : "Collapse"} ${b.name}`}>
                <Icon name="chevron" size={14} />
              </button>
              <SectionGlyph glyph={b.glyph} />
              <b>{b.name}</b>
              <span className="tk-cnt">{b.count}</span>
              {b.note}
            </header>
            {!collapsed.has(b.id) && (
              <>
                {!b.count && <p className="tk-none">{p.narrowed ? "No matches." : "Nothing here."}</p>}
                {b.groups.map((g, gi) => {
                  const items = gi === 0 && b.cap ? g.items.slice(0, b.cap) : g.items;
                  return items.length ? (
                    <div key={g.label ?? gi} className="ui-digest" role="list" aria-label={g.label ?? b.name}>
                      {g.label && <div className="tk-date">{g.label}</div>}
                      {items.map((it) => <DigestRow key={it.card.id} d={rowOf(it)} />)}
                    </div>
                  ) : null;
                })}
                {b.id === "done" && p.moreDone && <button type="button" className="tk-more" onClick={p.moreDone}>Show more</button>}
                {b.cap && b.count > b.cap && <button type="button" className="tk-more" onClick={() => flip(b.id)}>Show all {b.count}</button>}
                {expanded.has(b.id) && b.limit && b.count > b.limit && !p.narrowed && <button type="button" className="tk-more" onClick={() => flip(b.id)}>Show fewer</button>}
              </>
            )}
          </section>
        ))}
      </div>
      {openItem && (
        <TaskDrawer
          key={openItem.card.id}
          item={openItem}
          board={board}
          mergeTargets={p.mergeTargets}
          onClose={() => setOpen(null)}
          onDone={phone(() => p.onDone(openItem.card))}
          onDismiss={phone(() => p.onDismiss(openItem.card))}
          onMove={(b) => phone(() => p.onMove(openItem.card, b))()}
          onSnooze={(d) => phone(() => p.onSnooze(openItem.card, d))()}
          onMerge={(into) => phone(() => p.onMerge(openItem.card, into))()}
          onChanged={p.onChanged}
          toast={p.toast}
        />
      )}
    </main>
  );
}

function ProjectChip({ name }: { name: string }) {
  return <span className="tk-proj"><i aria-hidden />{name}</span>;
}

/** Pairs "Filed by Intake": the monogram and the name, or nothing. */
const Who = ({ a }: { a?: Assignee }) => (a ? <span className="tk-who"><Monogram name={a.name} size={20} />{shortName(a)}</span> : null);

type Event = { at: string; who: string; by?: string; text: string; id: string };
const eventsOf = (issue: IssueView): Event[] => [
  ...issue.comments.map((c: CommentView): Event => ({ id: c.id, at: c.createdAt, who: c.author.kind === "me" ? "You" : c.author.name, by: c.by, text: c.body })),
  ...issue.milestones.map((m: Milestone, i): Event => ({ id: `m${i}`, at: m.at, who: "", text: m.text })),
].sort((a, b) => a.at.localeCompare(b.at));

function TaskDrawer({ item, board, mergeTargets, onClose, onDone, onDismiss, onMove, onSnooze, onMerge, onChanged, toast }: {
  item: Item;
  board: Board;
  mergeTargets: Card[];
  onClose: () => void;
  onDone: () => void;
  onDismiss: () => void;
  onMove: (b: Bucket) => void;
  onSnooze: (date: string) => void;
  onMerge: (into: Card) => void;
  onChanged: () => void;
  toast: (text: string) => void;
}) {
  const card = item.card;
  const [issue, setIssue] = useState<IssueView | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const load = useCallback(() => api.issue(card.identifier).then((v) => (setIssue(v), setError("")), (e: Error) => setError(e.message)), [card.identifier]);
  useEffect(() => void load(), [load]);
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      const v = await api.comment(card.identifier, text);
      setIssue(v);
      if (v.movedTo) toast(`Sent to ${v.movedTo}`);
      setText("");
      onChanged();
    } catch (e) {
      toast(`Couldn't send: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };
  const w = card as WorkCard;
  const wait = item.mine ? waitingOf(card) : progressOf(w);
  const section = (item.mine ? SECTIONS.find((s) => s.id === item.group) : DELEGATED.find((s) => s.id === item.group))?.name;
  const head = (
    <>
      <SectionGlyph glyph={item.glyph} />
      <span className="tk-path">{section} · <b>{card.identifier}</b></span>
      <span className="tk-kb"><Kbd>J</Kbd><Kbd>K</Kbd></span>
    </>
  );
  const owner = person(board.assignees, card.assignee);
  const filer = person(board.assignees, card.filedBy);
  const project = board.projects?.find((x) => x.id === card.projectId)?.name;
  const next = issue?.recurring?.nextRun;
  const cells: [string, React.ReactNode][] = [
    ["Assignee", <Who a={owner} />],
    ["Project", project && <ProjectChip name={project} />],
    ["Filed by", <Who a={filer} />],
    ["When", issue ? (issue.scheduled ? `${dayDate(issue.scheduled.date)}` : when(issue.createdAt)) : null],
    ["Reminder", next && when(next)],
  ];
  const shown = cells.filter(([, v]) => v);
  const about = issue?.about;
  const quote = about?.source?.fields.find(([k]) => /quote|message|text/i.test(k));
  const rest = about?.source?.fields.filter((f) => f !== quote) ?? [];
  const subtasks = issue?.crew.flatMap((m) => m.issues.map((i) => ({ ...i, agent: person(board.assignees, m.agent)?.name ?? "Agent" }))) ?? [];
  const events = issue ? eventsOf(issue) : [];
  return (
    <RowDrawer rowId={card.id} onClose={onClose} className="tasks-drawer" head={head} foot={<><span className="tk-upd">Updated {when(card.activityAt)}</span><a className="home-drawer-open" href={`#/t/${card.identifier}`}>Open task <span aria-hidden>→</span></a></>}>
      <div className="tk-d">
        <h2 className="tk-title">{card.title}</h2>
        {wait && <p className={`tk-dwait${item.mine || item.group === "waiting" ? "" : " calm"}`}>{wait}</p>}
        {item.mine && (
          <div className="tk-acts">
            <Button variant="primary" onClick={onDone}><Icon name="check" size={14} /> Done</Button>
            <Button onClick={() => onMove("tomorrow")}>Tomorrow</Button>
            <Button onClick={() => onSnooze(nextWeekOf(todayIn(board.timezone)))}>Next week</Button>
            <Button onClick={() => onMove("backlog")}>Someday</Button>
            <MergeMenu card={card} targets={mergeTargets} onPick={onMerge} label="Merge…" />
            <span className="tk-grow" />
            <Button onClick={onDismiss}>Dismiss</Button>
          </div>
        )}
        {shown.length > 0 && <dl className="tk-fields">{shown.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
        {error && <p className="alert">{error}</p>}
        {!issue && !error && <p className="tk-none">Loading…</p>}
        {issue && (
          <div className="tk-cols">
            <div>
              {about?.source && (
                <section className="tk-area">
                  <h3>Source · {about.source.type ?? "A message"}</h3>
                  {(quote || rest.length > 0) && (
                    <blockquote className="tk-quote">
                      {rest.map(([k, v]) => <span key={k} className="tk-qk"><b>{k}</b> {sourceDate(v) ?? v}</span>)}
                      {quote && <p>{quote[1]}</p>}
                    </blockquote>
                  )}
                  {about.source.url && <a href={safeHref(about.source.url)} target="_blank" rel="noopener noreferrer">Open in {about.source.type ?? "the source"}… <Icon name="external" size={12} /></a>}
                </section>
              )}
              {(about?.reason || about?.suggested || about?.body) && (
                <section className="tk-area">
                  <h3>About</h3>
                  {about.reason && <p><b>Why</b> {about.reason}</p>}
                  {about.suggested && <p><b>Suggested</b> {about.suggested}</p>}
                  {about.body && <Markdown className="tk-md" text={about.body} prefix={board.prefix} />}
                </section>
              )}
              {subtasks.length > 0 && (
                <section className="tk-area">
                  <h3>Subtasks</h3>
                  <ul className="tk-subs">
                    {subtasks.map((s) => (
                      <li key={s.id} className={s.state === "done" ? "done" : ""}>
                        <i className="tk-ck" aria-hidden>{s.state === "done" && <Icon name="check" size={10} />}</i>
                        <a href={`#/t/${s.identifier}`}>{s.title}</a>
                        <small>{s.identifier} · {s.agent} · {s.state}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {issue.parent && (
                <section className="tk-area">
                  <h3>Linked task</h3>
                  <div className="tk-link"><div><b>{issue.parent.title}</b><small>{issue.parent.identifier}</small></div><a className="btn" href={`#/t/${issue.parent.identifier}`}>Open</a></div>
                </section>
              )}
            </div>
            <div>
              <section className="tk-area tk-act">
                <h3>Activity</h3>
                <ol>
                  {events.map((e) => (
                    <li key={e.id}>
                      {e.who && <Monogram name={e.who} size={20} />}
                      <div><span className="tk-etext">{e.who && <b>{e.who}{e.by ? ` · by ${e.by}` : ""} </b>}{e.text}</span><small>{when(e.at)}</small></div>
                    </li>
                  ))}
                  {!events.length && <li className="tk-none">No activity yet.</li>}
                </ol>
                <form className="tk-cmt" onSubmit={(e) => (e.preventDefault(), void send())}>
                  <textarea rows={1} readOnly={sending} value={text} placeholder="Write a comment" aria-label="Write a comment" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), void send())} />
                  <button type="submit" className="icon-btn" aria-label="Send" disabled={sending || !text.trim()}><Icon name="send" size={16} /></button>
                </form>
              </section>
            </div>
          </div>
        )}
      </div>
    </RowDrawer>
  );
}

/** Project, Source and Agent: one choice each, kept in the page's filters (a project id, a source label's id, an agent's key). */
export function TaskFilters({ filters, onChange, board }: { filters: Filters; onChange: (f: Filters) => void; board: Board }) {
  const pick = (k: "project" | "label" | "agent", v: string) => onChange({ ...filters, [k]: v ? [v] : undefined });
  const sel = (k: "project" | "label" | "agent", name: string, options: [string, string][]) => {
    const v = filters[k]?.[0] ?? "";
    return (
      <label className="tk-sel" key={k}>
        <select className={v ? "on" : ""} aria-label={name} value={v} onChange={(e) => pick(k, e.target.value)}>
          <option value="">{name}</option>
          {options.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <Icon name="chevron" size={12} />
      </label>
    );
  };
  return (
    <div className="tk-filters">
      {sel("project", "Project", (board.projects ?? []).map((x): [string, string] => [x.id, x.name]))}
      {sel("label", "Source", board.labels.filter((l) => SOURCES[l.name] || filters.label?.includes(l.id)).map((l): [string, string] => [l.id, SOURCES[l.name]?.name ?? l.name]))}
      {sel("agent", "Agent", board.assignees.filter((a) => a.kind !== "me").map((a): [string, string] => [a.key, shortName(a)]))}
    </div>
  );
}

/** The list's keys, beside the filters. */
export const TaskKeys = () => (
  <span className="tk-keys" aria-hidden>
    <Kbd>J</Kbd><Kbd>K</Kbd> move <Kbd>1</Kbd> Today <Kbd>2</Kbd> Upcoming <Kbd>3</Kbd> Later <Kbd>X</Kbd> Dismiss
  </span>
);
