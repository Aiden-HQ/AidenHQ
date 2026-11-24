// The board's frame: a slim top bar of sections (a section of several pages lists them on its own left), the phone's
// bottom bar, and the ⌘K palette that jumps anywhere from what the board already has cached. Chat, the heart of the board,
// keeps the full width under the bar. Navigation only: every page is App.tsx's.
import { useEffect, useMemo, useRef, useState } from "react";
import { peek } from "./cache";
import { prefetchView, QUERIES } from "./queries";
import { CATEGORIES } from "./Settings";
import type { Assignee, ChatRow, ModuleRow, PageRow, SpendNow } from "./types";
import { Icon, type IconName } from "./ui/icons";
import { Ticker } from "./ui/Ticker";

export type NavView = "chat" | "approvals" | "board" | "agents" | "apps" | "modules" | "costs" | "flow" | "settings";
type Item = { view: NavView; name: string; icon: IconName };
type Panel = { name: string; label: string; url: string };

const ITEMS: Item[] = [
  { view: "chat", name: "Chat", icon: "chat" },
  { view: "approvals", name: "Approvals", icon: "approvals" },
  { view: "board", name: "Tasks", icon: "tasks" },
  { view: "agents", name: "Agents", icon: "agents" },
  { view: "apps", name: "Apps", icon: "apps" },
  { view: "modules", name: "Modules", icon: "modules" },
  { view: "costs", name: "Costs", icon: "costs" },
  { view: "flow", name: "Flow", icon: "flow" },
];
const item = (v: NavView) => ITEMS.find((i) => i.view === v)!;
/** The section that lists the modules' pages (board.pages) after its own. */
const FLEET = "Fleet";
/** The top bar's sections; one of several pages opens on its first and lists the rest on its left (SubNav). */
const SECTIONS: { name: string; views: NavView[] }[] = [
  { name: "Chat", views: ["chat"] },
  { name: "Approvals", views: ["approvals"] },
  { name: "Tasks", views: ["board"] },
  { name: FLEET, views: ["agents", "apps", "modules"] },
  { name: "Insight", views: ["costs", "flow"] },
];
export const hrefOf = (v: NavView) => `#/${v}`;
/** A module's page (board.pages): Fleet lists them after its own, from the modules' declarations. */
export const pageHref = (p: PageRow) => `#/fleet/${p.id}`;
/** A module page's view is "fleet": its section is Fleet. */
const sectionOf = (view: string) => SECTIONS.find((t) => t.views.includes(view as NavView) || (view === "fleet" && t.name === FLEET));

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const paletteKey = isMac ? "⌘K" : "Ctrl K";

interface Common {
  view: string;
  approvals: number;
  agentsActive: number;
  onNav: (v: NavView) => void;
}

export function TopNav({ view, approvals, agentsActive, onNav, spend, settingsAlert, notify, brief, onPalette }: Common & {
  spend: SpendNow | null | undefined;
  settingsAlert: boolean;
  notify?: () => void;
  brief: boolean;
  onPalette: () => void;
}) {
  const share = spend ? Math.min(1, Math.max(spend.day.spent / spend.day.cap, spend.month.spent / spend.month.cap)) : 0;
  const money = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`;
  return (
    <header className="topnav">
      <a className="tn-brand" href="#/c/" onClick={(e) => (e.preventDefault(), onNav("chat"))} title="AidenHQ">
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
              onPointerEnter={() => sec.views.forEach(prefetchView)}
              onFocus={() => sec.views.forEach(prefetchView)}
            >
              {sec.name}
              {first === "approvals" && approvals > 0 && <span className="tn-badge" key={approvals}>{approvals}</span>}
              {sec.name === FLEET && agentsActive > 0 && (
                <span className="tn-live" title={`${agentsActive} agent job${agentsActive === 1 ? "" : "s"} running now`}>
                  <i />
                  {agentsActive} active run{agentsActive === 1 ? "" : "s"}
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
        <kbd>{paletteKey}</kbd>
      </button>
      {spend && (
        <a className={`tn-spend${spend.day.spent >= spend.day.cap || spend.month.spent >= spend.month.cap ? " over" : ""}`} href="#/costs" onClick={(e) => (e.preventDefault(), onNav("costs"))} title={`Model spend against the install's limits: ${money(spend.month.spent)} of ${money(spend.month.cap)} this UTC month; change the limits in Settings`}>
          <span className="tn-spend-row">
            <b>
              <Ticker value={spend.day.spent} format={(n) => `$${n.toFixed(2)}`} />
            </b>
            <span>of {money(spend.day.cap)} today</span>
          </span>
          <span className="tn-meter" aria-hidden>
            <i style={{ width: `${share * 100}%` }} />
          </span>
        </a>
      )}
      {notify && (
        <button type="button" className="btn sm" onClick={notify} title="Get a browser notification when something needs you">
          Notify me
        </button>
      )}
      {brief && (
        <a className="tn-icon" href="#/brief" title="Today's brief (b)" aria-label="Today's brief">
          <Icon name="brief" />
        </a>
      )}
      <a className="tn-icon" href="#/help" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        <Icon name="help" />
      </a>
      <a className={`tn-item tn-settings${view === "settings" ? " on" : ""}`} href="#/settings" onClick={(e) => (e.preventDefault(), onNav("settings"))} aria-current={view === "settings" ? "page" : undefined} title="Settings: connections, approvals, accounts and the instance" aria-label="Settings">
        <Icon name="settings" />
        Settings
        {settingsAlert && <span className="tn-dot" title="A connection needs you" />}
      </a>
    </header>
  );
}

/** The pages of the open section, on its left (Fleet, Insight); nothing for a section of one page. */
export function SubNav({ view, onNav, panels, pages, page, go }: { view: string; onNav: (v: NavView) => void; panels: Panel[]; pages: PageRow[]; page?: string; go: (hash: string) => void }) {
  const sec = sectionOf(view);
  if (!sec || sec.views.length < 2) return null;
  return (
    <nav className="subnav" aria-label={sec.name}>
      <div className="sn-name">{sec.name}</div>
      {sec.views.map((v) => {
        const it = item(v);
        return (
          <div key={v}>
            <a className={`sn-item${view === v ? " on" : ""}`} href={hrefOf(v)} title={it.name} aria-current={view === v ? "page" : undefined} onClick={(e) => (e.preventDefault(), onNav(v))} onPointerEnter={() => prefetchView(v)} onFocus={() => prefetchView(v)}>
              <Icon name={it.icon} />
              <span className="sn-label">{it.name}</span>
            </a>
            {v === "apps" &&
              panels.map((p) => (
                <a key={p.name} className="sn-item sn-sub" href={p.url} target="_blank" rel="noopener noreferrer" title={`${p.label} opens in a new tab`}>
                  <Icon name="external" size={14} />
                  <span className="sn-label">{p.label}</span>
                </a>
              ))}
          </div>
        );
      })}
      {sec.name === FLEET &&
        pages.map((p) => {
          const on = view === "fleet" && page === p.id;
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

/** The phone's sections: four at hand, the rest behind More. */
const PHONE: NavView[] = ["chat", "approvals", "agents", "board"];
export function BottomBar({ view, approvals, agentsActive, onNav, panels, notify, pages, go }: Common & { panels: Panel[]; notify?: () => void; pages: PageRow[]; go: (hash: string) => void }) {
  const [more, setMore] = useState(false);
  const rest = ITEMS.filter((i) => !PHONE.includes(i.view));
  const inMore = !PHONE.includes(view as NavView);
  return (
    <>
      <nav className="bottombar" aria-label="Sections">
        {PHONE.map((v) => {
          const it = item(v);
          return (
            <a key={v} className={`bb-item${view === v ? " on" : ""}`} href={hrefOf(v)} aria-current={view === v ? "page" : undefined} onClick={(e) => (e.preventDefault(), setMore(false), onNav(v))}>
              <span className="bb-icon">
                <Icon name={it.icon} size={20} />
                {v === "approvals" && approvals > 0 && <span className="tn-badge">{approvals}</span>}
                {v === "agents" && agentsActive > 0 && <span className="bb-live" />}
              </span>
              <span>{it.name}</span>
            </a>
          );
        })}
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
            {[...rest, { view: "settings" as const, name: "Settings", icon: "settings" as const }].map((it) => (
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
            {notify && (
              <button type="button" className="sn-item" onClick={() => (setMore(false), notify())}>
                <Icon name="bell" />
                <span className="sn-label">Notify me</span>
              </button>
            )}
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

export function Palette({ open, onClose, go, crew, apps, onNewTask, tasks = [] }: { open: boolean; onClose: () => void; go: (hash: string) => void; crew: Assignee[]; apps: { name: string }[]; onNewTask: () => void; /** Tasks' own entries (Agent work, saved boards, Save board), from cached data. */ tasks?: PaletteEntry[] }) {
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

  const entries = useMemo<Entry[]>(() => {
    if (!open) return [];
    const nav = (hash: string) => () => (onClose(), go(hash));
    const chats = peek<{ chats: ChatRow[] }>(QUERIES.chats.key)?.data.chats ?? [];
    const modules = peek<{ modules: ModuleRow[] }>(QUERIES.modules.key)?.data.modules ?? [];
    const pages = peek<{ pages: PageRow[] }>(QUERIES.pages.key)?.data.pages ?? [];
    return [
      { id: "new-chat", kind: "Action", label: "New chat with Aiden", icon: "chat", run: nav("#/c/") },
      { id: "new-task", kind: "Action", label: "New task", icon: "plus", run: () => (onClose(), onNewTask()) },
      ...tasks.map((t) => ({ ...t, run: () => (onClose(), t.run()) })),
      ...ITEMS.map((i) => ({ id: `v-${i.view}`, kind: "Go to", label: i.name, icon: i.icon, run: nav(hrefOf(i.view)) })),
      ...pages.map((p) => ({ id: `pg-${p.id}`, kind: "Go to", label: p.title, icon: p.icon, run: nav(pageHref(p)) })),
      { id: "v-settings", kind: "Go to", label: "Settings", icon: "settings", run: nav("#/settings") },
      ...CATEGORIES.map((c) => ({ id: `s-${c.key}`, kind: "Settings", label: c.name, icon: "settings" as const, run: nav(`#/settings/${c.key}`) })),
      ...crew.filter((a) => a.kind !== "me").map((a) => ({ id: `a-${a.key}`, kind: "Agent", label: a.name, icon: "agents" as const, run: nav(`#/agents/${a.key}`) })),
      ...chats.map((c) => ({ id: `c-${c.identifier}`, kind: "Chat", label: c.title, hint: `${c.agent.name} · ${c.identifier}`, icon: "chat" as const, run: nav(`#/c/${c.identifier}`) })),
      ...apps.map((a) => ({ id: `p-${a.name}`, kind: "App", label: a.name, icon: "apps" as const, run: nav(`#/apps/${a.name}`) })),
      ...modules.map((m) => ({ id: `m-${m.name}`, kind: "Module", label: m.name, hint: m.description, icon: "modules" as const, run: nav(`#/modules/${m.name}`) })),
      { id: "help", kind: "Go to", label: "Keyboard shortcuts", icon: "help", run: nav("#/help") },
    ];
  }, [open, crew, apps, go, onClose, onNewTask, tasks]);

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
            placeholder="Jump to a page, agent, chat or app…"
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

