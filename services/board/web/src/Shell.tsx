// The board's frame: a slim top bar (Home · Tasks · Apps · Team · Insight, then Search ⌘K, Ask Aiden ⌘J and Settings), a
// section's own page list on its left, the phone's bottom bar, and the ⌘K palette that jumps anywhere from what the board
// already has cached. Home is the heart: nothing in the frame crowds it. Navigation only: every page is App.tsx's.
import { useEffect, useMemo, useRef, useState } from "react";
import { load, peek } from "./cache";
import { prefetchView, QUERIES } from "./queries";
import { CATEGORIES } from "./settings-layout";
import { openAsk, useAskOpen } from "./AskAiden";
import type { ChatRow, ModuleRow, PageRow, RosterAgent, SpendNow } from "./types";
import { Face, Kbd, faceProps } from "./ui";
import { Icon, type IconName } from "./ui/icons";
import { Ticker } from "./ui/Ticker";

export type NavView = "home" | "tasks" | "sessions" | "apps" | "team" | "agents" | "modules" | "costs" | "flow" | "decisions" | "settings";
type Item = { view: NavView; name: string; icon: IconName };
type Panel = { name: string; label: string; url: string };

const ITEMS: Item[] = [
  { view: "home", name: "Home", icon: "brief" },
  { view: "tasks", name: "Tasks", icon: "tasks" },
  { view: "sessions", name: "Sessions", icon: "terminal" },
  { view: "apps", name: "Apps", icon: "apps" },
  { view: "team", name: "Teammates", icon: "agents" },
  { view: "agents", name: "All agents", icon: "agents" },
  { view: "modules", name: "Modules", icon: "modules" },
  { view: "costs", name: "Costs", icon: "costs" },
  { view: "flow", name: "Flow", icon: "flow" },
  { view: "decisions", name: "Decisions", icon: "approvals" },
];
const item = (v: NavView) => ITEMS.find((i) => i.view === v)!;
const TEAM = "Team";
/** The top bar's sections; one of several pages opens on its first and lists the rest on its left (SubNav). */
const SECTIONS: { name: string; views: NavView[] }[] = [
  { name: "Home", views: ["home"] },
  { name: "Tasks", views: ["tasks", "sessions"] },
  { name: "Apps", views: ["apps"] },
  { name: TEAM, views: ["team", "agents", "modules"] },
  { name: "Insight", views: ["costs", "flow", "decisions"] },
];
const HREF: Record<NavView, string> = {
  home: "#/",
  tasks: "#/tasks",
  sessions: "#/tasks/sessions",
  apps: "#/apps",
  team: "#/team",
  agents: "#/team/agents",
  modules: "#/team/modules",
  costs: "#/insight/costs",
  flow: "#/insight/flow",
  decisions: "#/insight/decisions",
  settings: "#/settings",
};
export const hrefOf = (v: NavView) => HREF[v];
/** A module's page (board.pages): Team lists them after its own, from the modules' declarations. */
export const pageHref = (p: PageRow) => `#/team/m/${p.id}`;
/** A module page's view is "page": its section is Team. */
const sectionOf = (view: string) => SECTIONS.find((t) => t.views.includes(view as NavView) || (view === "page" && t.name === TEAM));
/** The section's pages to list: Sessions only while the sessions module is on. */
const viewsOf = (sec: { views: NavView[] }, sessions?: boolean) => sec.views.filter((v) => v !== "sessions" || sessions);

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const paletteKey = isMac ? "⌘K" : "Ctrl K";
export const askKey = isMac ? "⌘J" : "Ctrl J";

/** The chief of staff's face, for Ask Aiden (the roster's front agent; seeded when it isn't loaded yet). */
function AidenFace({ size }: { size: number }) {
  const roster = peek<{ roster: RosterAgent[] }>(QUERIES.roster.key)?.data.roster ?? [];
  const a = roster.find((r) => r.key === "chief-of-staff");
  return <Face seed="chief-of-staff" {...faceProps(a?.teammate?.face)} size={size} label={a?.name ?? "Aiden"} />;
}

export function TopNav({ view, needs, working, onNav, spend, settingsAlert, onPalette, sessions }: {
  view: string;
  /** Home's badge: the rows in Needs you. */
  needs: number;
  /** Agent jobs running now: Team's live dot. */
  working: number;
  onNav: (v: NavView) => void;
  /** Live sessions (the sessions module is on): Tasks lists the page; undefined: the module is off. */
  sessions?: { live: number };
  spend: SpendNow | null | undefined;
  settingsAlert: boolean;
  onPalette: () => void;
}) {
  const askOpen = useAskOpen();
  const over = !!spend && (spend.day.spent >= spend.day.cap || spend.month.spent >= spend.month.cap);
  return (
    <header className="topnav">
      <a className="tn-brand" href="#/" onClick={(e) => (e.preventDefault(), onNav("home"))} title="AidenHQ">
        <img src="/icon.png" alt="" />
        <span>AidenHQ</span>
      </a>
      <nav className="tn-items" aria-label="Sections">
        {SECTIONS.map((sec) => {
          const on = sectionOf(view) === sec;
          const first = sec.views[0]!;
          return (
            <a
              key={sec.name}
              className={`tn-item${on ? " on" : ""}`}
              href={hrefOf(first)}
              aria-current={on ? "page" : undefined}
              onClick={(e) => (e.preventDefault(), onNav(first))}
              onPointerEnter={() => viewsOf(sec, !!sessions).forEach(prefetchView)}
              onFocus={() => viewsOf(sec, !!sessions).forEach(prefetchView)}
            >
              {sec.name}
              {/* A count of zero keeps its space, so the item is the width it will be once the first poll answers. */}
              {first === "home" && <span className="tn-badge" key={needs} hidden={needs === 0} aria-hidden={needs === 0 || undefined} title={`${needs} need${needs === 1 ? "s" : ""} you`}>{needs || 0}</span>}
              {sec.name === TEAM && working > 0 && <span className="tn-live" title={`${working} agent job${working === 1 ? "" : "s"} running now`}><i /></span>}
              {sec.name === "Insight" && spend && (
                <span className={`tn-spend${over ? " over" : ""}`} title={`Model spend today against the day limit; $${spend.month.spent.toFixed(2)} of $${spend.month.cap} this month`}>
                  <Ticker value={spend.day.spent} format={(n) => `$${n.toFixed(2)}`} />
                </span>
              )}
            </a>
          );
        })}
      </nav>
      <span className="spacer" />
      <button type="button" className="tn-search" onClick={onPalette} title={`Search and jump (${paletteKey})`}>
        <Icon name="search" />
        <span>Search</span>
        <Kbd>{paletteKey}</Kbd>
      </button>
      <button type="button" className={`tn-ask${askOpen ? " on" : ""}`} aria-expanded={askOpen} aria-controls="ask-aiden" onClick={() => openAsk({ toggle: true })} title={`Ask Aiden (${askKey})`}>
        <AidenFace size={20} />
        <span>Ask Aiden</span>
        <Kbd>{askKey}</Kbd>
      </button>
      <a className={`tn-icon tn-settings${view === "settings" ? " on" : ""}`} href="#/settings" onClick={(e) => (e.preventDefault(), onNav("settings"))} aria-current={view === "settings" ? "page" : undefined} title="Settings: your profile, agents, connections and the server" aria-label="Settings">
        <Icon name="settings" />
        {settingsAlert && <span className="tn-dot" title="A connection needs you" />}
      </a>
    </header>
  );
}

/** The pages of the open section, on its left (Tasks with Sessions, Team, Insight, Apps with panels); nothing for one page. */
export function SubNav({ view, onNav, panels, pages, page, go, sessions }: { view: string; onNav: (v: NavView) => void; panels: Panel[]; pages: PageRow[]; page?: string; go: (hash: string) => void; sessions?: boolean }) {
  const sec = sectionOf(view);
  if (!sec) return null;
  const views = viewsOf(sec, sessions);
  const apps = sec.name === "Apps";
  if (views.length < 2 && !(apps && panels.length) && sec.name !== TEAM) return null;
  return (
    <nav className="subnav" aria-label={sec.name}>
      <div className="sn-name">{sec.name}</div>
      {views.map((v) => {
        const it = item(v);
        return (
          <a key={v} className={`sn-item${view === v ? " on" : ""}`} href={hrefOf(v)} title={it.name} aria-current={view === v ? "page" : undefined} onClick={(e) => (e.preventDefault(), onNav(v))} onPointerEnter={() => prefetchView(v)} onFocus={() => prefetchView(v)}>
            <Icon name={it.icon} />
            <span className="sn-label">{it.name}</span>
          </a>
        );
      })}
      {apps &&
        panels.map((p) => (
          <a key={p.name} className="sn-item sn-sub" href={p.url} target="_blank" rel="noopener noreferrer" title={`${p.label} opens in a new tab`}>
            <Icon name="external" size={14} />
            <span className="sn-label">{p.label}</span>
          </a>
        ))}
      {sec.name === TEAM &&
        pages.map((p) => {
          const on = view === "page" && page === p.id;
          return (
            <a key={p.id} className={`sn-item${on ? " on" : ""}`} href={pageHref(p)} title={p.title} aria-current={on ? "page" : undefined} onClick={(e) => (e.preventDefault(), go(pageHref(p)))}>
              <Icon name={p.icon} />
              <span className="sn-label">{p.title}</span>
            </a>
          );
        })}
    </nav>
  );
}

/** The phone's sections (V2PhoneHome): Home · Tasks · Ask Aiden (centre) · Team, the rest behind More. */
export function BottomBar({ view, needs, working, onNav, panels, pages, go, sessions }: { view: string; needs: number; working: number; onNav: (v: NavView) => void; panels: Panel[]; pages: PageRow[]; go: (hash: string) => void; sessions?: boolean }) {
  const [more, setMore] = useState(false);
  const askOpen = useAskOpen();
  const team = ["team", "agents", "modules", "page"].includes(view);
  const inMore = !["home", "tasks", "sessions"].includes(view) && !team;
  const rest: Item[] = [item("apps"), ...(sessions ? [item("sessions")] : []), item("costs"), item("flow"), item("decisions"), item("agents"), item("modules"), { view: "settings", name: "Settings", icon: "settings" }];
  const tab = (v: NavView, name: string, icon: IconName, on: boolean, extra?: React.ReactNode) => (
    <a className={`bb-item${on ? " on" : ""}`} href={hrefOf(v)} aria-current={on ? "page" : undefined} onClick={(e) => (e.preventDefault(), setMore(false), onNav(v))}>
      <span className="bb-icon">
        <Icon name={icon} size={20} />
        {extra}
      </span>
      <span>{name}</span>
    </a>
  );
  return (
    <>
      <nav className="bottombar" aria-label="Sections">
        {tab("home", "Home", "brief", view === "home", needs > 0 && <span className="tn-badge">{needs}</span>)}
        {tab("tasks", "Tasks", "tasks", view === "tasks" || view === "sessions")}
        <button type="button" className={`bb-item bb-ask${askOpen ? " on" : ""}`} aria-expanded={askOpen} aria-controls="ask-aiden" onClick={() => (setMore(false), openAsk({ toggle: true }))}>
          <span className="bb-icon">
            <AidenFace size={28} />
          </span>
          <span>Ask Aiden</span>
        </button>
        {tab("team", "Team", "agents", team, working > 0 && <span className="bb-live" />)}
        <button type="button" className={`bb-item${inMore || more ? " on" : ""}`} aria-expanded={more} onClick={() => setMore(!more)}>
          <span className="bb-icon">
            <Icon name="more" size={20} />
          </span>
          <span>More</span>
        </button>
      </nav>
      {more && (
        <div className="bb-sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setMore(false)}>
          <div className="bb-sheet" role="dialog" aria-label="More sections">
            {rest.map((it) => (
              <a key={it.view} className={`sn-item${view === it.view ? " on" : ""}`} href={hrefOf(it.view)} onClick={(e) => (e.preventDefault(), setMore(false), onNav(it.view))}>
                <Icon name={it.icon} />
                <span className="sn-label">{it.name}</span>
              </a>
            ))}
            {pages.map((p) => (
              <a key={p.id} className="sn-item" href={pageHref(p)} onClick={(e) => (e.preventDefault(), setMore(false), go(pageHref(p)))}>
                <Icon name={p.icon} />
                <span className="sn-label">{p.title}</span>
              </a>
            ))}
            {panels.map((p) => (
              <a key={p.name} className="sn-item" href={p.url} target="_blank" rel="noopener noreferrer">
                <Icon name="external" />
                <span className="sn-label">{p.label}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

type Entry = { id: string; kind: string; label: string; hint?: string; icon: IconName; run: () => void };
export type PaletteEntry = Entry;

/** Characters of `q` in order inside `s`; earlier, tighter and word-start matches score higher. -1: no match. */
function score(s: string, q: string): number {
  if (!q) return 0;
  const t = s.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (direct > 0 && t[direct - 1] !== " " ? 50 : 0);
  let at = -1, gaps = 0;
  for (const c of q) {
    const i = t.indexOf(c, at + 1);
    if (i < 0) return -1;
    if (at >= 0) gaps += i - at - 1;
    at = i;
  }
  return gaps > q.length * 3 ? -1 : 500 - gaps;
}

export function Palette({ open, onClose, go, roster, apps, onNewTask, tasks = [], sessions }: { sessions?: boolean; open: boolean; onClose: () => void; go: (hash: string) => void; roster: RosterAgent[]; apps: { name: string }[]; onNewTask: () => void; /** Tasks' own entries (Agent work, saved boards, Save board), from cached data. */ tasks?: PaletteEntry[] }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!open) return;
    setQ("");
    setAt(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  // Every chat, for search: read on opening (no page loads the fleet-wide list any more); the entries redraw when it lands.
  const [chatsAt, setChatsAt] = useState(0);
  useEffect(() => {
    if (open) void load(QUERIES.chats.key, QUERIES.chats.fetch, QUERIES.chats.persist).then(() => setChatsAt(Date.now()), () => {});
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    if (!open) return [];
    const nav = (hash: string) => () => (onClose(), go(hash));
    const chats = peek<{ chats: ChatRow[] }>(QUERIES.chats.key)?.data.chats ?? [];
    const modules = peek<{ modules: ModuleRow[] }>(QUERIES.modules.key)?.data.modules ?? [];
    const pages = peek<{ pages: PageRow[] }>(QUERIES.pages.key)?.data.pages ?? [];
    return [
      { id: "ask", kind: "Action", label: "Ask Aiden", hint: askKey, icon: "chat", run: () => (onClose(), openAsk()) },
      { id: "new-task", kind: "Action", label: "New task", icon: "plus", run: () => (onClose(), onNewTask()) },
      ...tasks.map((t) => ({ ...t, run: () => (onClose(), t.run()) })),
      ...ITEMS.filter((i) => i.view !== "sessions" || sessions).map((i) => ({ id: `v-${i.view}`, kind: "Go to", label: i.name, icon: i.icon, run: nav(hrefOf(i.view)) })),
      ...pages.map((p) => ({ id: `pg-${p.id}`, kind: "Go to", label: p.title, icon: p.icon, run: nav(pageHref(p)) })),
      { id: "v-settings", kind: "Go to", label: "Settings", icon: "settings", run: nav("#/settings") },
      ...CATEGORIES.map((c) => ({ id: `s-${c.key}`, kind: "Settings", label: c.name, icon: "settings" as const, run: nav(`#/settings/${c.key}`) })),
      ...roster.filter((a) => a.key && a.teammate).map((a) => ({ id: `a-${a.key}`, kind: "Teammate", label: `${a.name} · ${a.teammate!.job}`, icon: "agents" as const, run: nav(`#/team/${a.key}`) })),
      ...roster.filter((a) => a.key && !a.teammate).map((a) => ({ id: `a-${a.key}`, kind: "Agent", label: a.name, icon: "agents" as const, run: nav(`#/team/agents/${a.key}`) })),
      { id: "brief", kind: "Go to", label: "Today's brief", hint: "b", icon: "brief", run: nav("#/brief") },
      ...chats.map((c) => ({ id: `c-${c.identifier}`, kind: "Chat", label: c.title, hint: `${c.agent.name} · ${c.identifier}`, icon: "chat" as const, run: nav(`#/t/${c.identifier}`) })),
      ...apps.map((a) => ({ id: `p-${a.name}`, kind: "App", label: a.name, icon: "apps" as const, run: nav(`#/apps/${a.name}`) })),
      ...modules.map((m) => ({ id: `m-${m.id}`, kind: "Module", label: m.id, hint: m.description, icon: "modules" as const, run: nav(`#/team/modules/${m.id}`) })),
      { id: "help", kind: "Go to", label: "Keyboard shortcuts", icon: "help", run: nav("#/help") },
    ];
  }, [open, roster, apps, go, onClose, onNewTask, tasks, sessions, chatsAt]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return entries.filter((e) => e.kind !== "Module" && e.kind !== "Settings").slice(0, 14);
    return entries
      .map((e) => ({ e, s: Math.max(score(e.label, t), score(e.hint ?? "", t) - 300, e.kind.toLowerCase().startsWith(t) ? 100 : -1) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((x) => x.e);
  }, [entries, q]);
  useEffect(() => setAt(0), [q]);
  useEffect(() => list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" }), [at]);

  if (!open) return null;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") return e.preventDefault(), setAt((i) => Math.min(shown.length - 1, i + 1));
    if (e.key === "ArrowUp") return e.preventDefault(), setAt((i) => Math.max(0, i - 1));
    if (e.key === "Enter") return e.preventDefault(), shown[at]?.run();
    if (e.key === "Escape") return e.preventDefault(), onClose();
  };
  return (
    <div className="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and jump">
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Jump to a page, teammate, chat or app…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[at] ? `pal-${shown[at].id}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" ref={list}>
          {shown.map((e, i) => (
            <li key={e.id} id={`pal-${e.id}`} data-i={i} role="option" aria-selected={i === at} className={i === at ? "on" : ""} onPointerMove={() => setAt(i)} onClick={e.run}>
              <Icon name={e.icon} />
              <span className="pal-label">{e.label}</span>
              {e.hint && <span className="pal-hint">{e.hint}</span>}
              <span className="pal-kind">{e.kind}</span>
            </li>
          ))}
          {!shown.length && <li className="palette-empty">Nothing matches “{q}”.</li>}
        </ul>
      </div>
    </div>
  );
}

