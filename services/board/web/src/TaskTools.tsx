// The Tasks page's tools, shared by both layouts: the layout switch, saved boards as tabs (a draft until saved; a stale write
// keeps the draft), and the filter bar (one chip per filter, `+ Filter` to add one). What the page shows is one spec,
// `{layout, filters, groupBy}`; a saved board stores it (api.views), the unsaved default ("All tasks") keeps its layout here.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ViewConflict } from "./api";
import { FILTER_KEYS, FILTER_NAMES, LANES, LANE_NAMES, UPDATED_NAMES, cardMatches, chipCount, compact, sameFilters, type FilterKey } from "./filters";
import { Banner, Dialog, Menu, Monogram, Segmented } from "./ui";
import type { Board, Card, Filters, Layout, SavedView, ViewSpec } from "./types";
import { PRIORITIES, PRIORITY_NAMES } from "./util";
import "./agent-work.css";

const LAYOUT_KEY = "aidenhq.tasks.layout";
/** Tabs shown before the rest go behind "More". */
const TABS = 6;

const savedLayout = (): Layout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "work" ? "work" : "day";
  } catch {
    return "day";
  }
};

export type Conflict = { view: SavedView; current: SavedView | null };

/**
 * The page's spec and its saved boards. `ready`: the session is confirmed (tabs render only then); `routed`: the board the
 * address names, followed once the boards have loaded: an id (#/board?view=<id>; an unknown one falls back to All tasks), null
 * for #/board (All tasks), undefined for any other address (the selection stays, e.g. while a task's drawer is open).
 */
export function useTaskBoard({ ready, routed, toast, go }: { ready: boolean; routed: string | null | undefined; toast: (t: string) => void; go: (hash: string) => void }) {
  const [layout, setLayoutState] = useState<Layout>(savedLayout);
  const [filters, setFilters] = useState<Filters>({});
  const [groupBy, setGroupBy] = useState<"none" | "agent">("none");
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const view = views?.find((v) => v.id === selected) ?? null;
  // The selection as it is when a write answers: a late 409 for a board the owner has left is not his concern now.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const setLayout = useCallback((l: Layout) => {
    setLayoutState(l);
    if (!selected) try { localStorage.setItem(LAYOUT_KEY, l); } catch {}
  }, [selected]);
  const apply = useCallback((spec: ViewSpec) => (setLayoutState(spec.layout), setFilters(spec.filters), setGroupBy(spec.groupBy)), []);
  const load = useCallback(() => api.views().then((r) => (setViews(r.views), r.views), (e) => (toast(`Couldn't load saved boards: ${(e as Error).message}`), null)), [toast]);
  useEffect(() => void (ready && load()), [ready, load]);

  /** Show a saved board (null: All tasks, the unsaved default, in `layout` when given). Any draft is dropped. */
  const select = useCallback((id: string | null, list = views, layout?: Layout) => {
    const v = id ? list?.find((x) => x.id === id) : undefined;
    setConflict(null);
    setSelected(v?.id ?? null);
    if (v) apply(v.spec);
    else {
      if (layout) try { localStorage.setItem(LAYOUT_KEY, layout); } catch {}
      setFilters({}), setGroupBy("none"), setLayoutState(layout ?? savedLayout());
    }
    go(v ? `#/board?view=${v.id}` : "#/board");
  }, [views, apply, go]);
  // The address names a board (a link, Back and Forward): show it once the boards are known.
  useEffect(() => {
    if (!views || routed === undefined || routed === selected) return;
    if (routed === null || views.some((v) => v.id === routed)) select(routed, views);
    else (toast("That saved board no longer exists: showing All tasks"), select(null, views));
  }, [views, routed]);

  const spec: ViewSpec = { layout, filters: compact(filters), groupBy: layout === "work" ? groupBy : "none" };
  const dirty = view ? view.spec.layout !== spec.layout || view.spec.groupBy !== spec.groupBy || !sameFilters(view.spec.filters, spec.filters) : chipCount(filters) > 0 || !!filters.text;

  const replace = (v: SavedView) => setViews((vs) => (vs ?? []).map((x) => (x.id === v.id ? v : x)));
  const fail = (v: SavedView, e: unknown) => {
    if (e instanceof ViewConflict) {
      if (selectedRef.current === v.id) setConflict({ view: v, current: e.current });
      if (e.current) replace(e.current);
      else setViews((vs) => (vs ?? []).filter((x) => x.id !== v.id));
    } else toast(`Couldn't save the board: ${(e as Error).message}`);
  };
  const saveNew = async (name: string) => {
    try {
      const v = await api.addView(name, spec);
      setViews((vs) => [...(vs ?? []), v]);
      setConflict(null);
      setSelected(v.id);
      go(`#/board?view=${v.id}`);
      toast(`Saved “${v.name}”`);
    } catch (e) {
      toast(`Couldn't save the board: ${(e as Error).message}`);
    }
  };
  const update = async () => {
    if (!view) return;
    try {
      replace(await api.updateView({ id: view.id, rev: view.rev, spec }));
      setConflict(null);
      toast(`Updated “${view.name}”`);
    } catch (e) {
      fail(view, e);
    }
  };
  const rename = async (name: string) => {
    if (!view) return;
    try {
      replace(await api.updateView({ id: view.id, rev: view.rev, name }));
    } catch (e) {
      fail(view, e);
    }
  };
  const remove = async () => {
    if (!view) return;
    try {
      await api.deleteView(view);
      setViews((vs) => (vs ?? []).filter((x) => x.id !== view.id));
      toast(`Deleted “${view.name}”`);
      select(null, (views ?? []).filter((x) => x.id !== view.id));
    } catch (e) {
      fail(view, e);
    }
  };
  /** After a conflict: take the board as saved now, dropping the draft. */
  const reload = () => {
    const c = conflict;
    setConflict(null);
    if (c?.current && c.view.id === selectedRef.current) apply(c.current.spec);
  };
  return { layout, setLayout, filters, setFilters, groupBy, setGroupBy, views, view, select, dirty, saveNew, update, rename, remove, conflict, reload, spec };
}
export type TaskBoard = ReturnType<typeof useTaskBoard>;

/** A name field in a small dialog (Save board, Rename). */
function NameDialog({ title, action, initial, onSave, onClose }: { title: string; action: string; initial: string; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const ok = name.trim().length > 0 && name.trim().length <= 60;
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="tt-name" className="btn primary" disabled={!ok}>{action}</button>
        </>
      }
    >
      <form id="tt-name" onSubmit={(e) => (e.preventDefault(), ok && (onSave(name.trim()), onClose()))}>
        <label className="tt-field">
          <span>Name</span>
          <input className="ui-input" autoFocus value={name} maxLength={60} placeholder="Engineering" onChange={(e) => setName(e.target.value)} />
        </label>
      </form>
    </Dialog>
  );
}

/** The layout switch and the saved boards' tabs (only once the session is confirmed). */
export function BoardTabs({ tb, ready, mobile, saveSignal }: { tb: TaskBoard; ready: boolean; mobile: boolean; /** Bumped to open Save board from elsewhere (the Save button, the palette). */ saveSignal: number }) {
  const [dialog, setDialog] = useState<"save" | "rename" | "delete" | null>(null);
  useEffect(() => void (saveSignal && setDialog("save")), [saveSignal]);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return;
    const away = (e: PointerEvent) => !moreRef.current?.contains(e.target as Node) && setMore(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [more]);
  const views = tb.views ?? [];
  // The selected board always shows as a tab, even past the first six.
  const shown = views.slice(0, TABS);
  if (tb.view && !shown.includes(tb.view)) shown[TABS - 1] = tb.view;
  const rest = views.filter((v) => !shown.includes(v));
  return (
    <>
      <Segmented label="Layout" value={tb.layout} onChange={tb.setLayout} options={[["day", "My day"], ["work", "Agent work"]] as const} />
      {ready && tb.views && (
        // The strip scrolls sideways; its menus sit beside it, outside the scroller, so they never clip.
        <div className={`tt-boards${mobile ? " phone" : ""}`}>
        <div className="tt-tabs" role="tablist" aria-label="Saved boards">
          <button type="button" role="tab" className="tt-tab" aria-selected={!tb.view} onClick={() => tb.select(null)}>
            All tasks{!tb.view && tb.dirty && <i className="tt-dirty" title="Changed: not saved" />}
          </button>
          {shown.map((v) => (
            <span key={v.id} className="tt-tab-wrap">
              <button type="button" role="tab" className="tt-tab" aria-selected={tb.view?.id === v.id} onClick={() => tb.view?.id !== v.id && tb.select(v.id)}>
                {v.name}
                {tb.view?.id === v.id && tb.dirty && <i className="tt-dirty" title="Changed: not saved" />}
              </button>
            </span>
          ))}
        </div>
          <button type="button" className="tt-tab tt-add" onClick={() => setDialog("save")}>+ Save board</button>
          {rest.length > 0 && (
            <div className="tt-more" ref={moreRef}>
              <button type="button" className="tt-tab" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}>More</button>
              {more && (
                <div className="tt-pop" role="menu">
                  {rest.map((v) => (
                    <button key={v.id} type="button" role="menuitem" className="tt-item" onClick={() => (setMore(false), tb.select(v.id))}>{v.name}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          {tb.view && <Menu label="Board actions" items={[{ label: "Rename…", onSelect: () => setDialog("rename") }, { label: "Save as new…", onSelect: () => setDialog("save") }, { label: "Delete board", onSelect: () => setDialog("delete"), danger: true }]} />}
        </div>
      )}
      {dialog === "save" && <NameDialog title="Save board" action="Save board" initial="" onSave={(n) => void tb.saveNew(n)} onClose={() => setDialog(null)} />}
      {dialog === "rename" && tb.view && <NameDialog title="Rename board" action="Rename" initial={tb.view.name} onSave={(n) => void tb.rename(n)} onClose={() => setDialog(null)} />}
      {dialog === "delete" && tb.view && (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title="Delete board"
          actions={
            <>
              <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
              <button type="button" className="btn danger" onClick={() => (setDialog(null), void tb.remove())}>Delete board</button>
            </>
          }
        >
          <p className="tt-confirm">Delete “{tb.view.name}”? The tasks stay.</p>
        </Dialog>
      )}
    </>
  );
}

/** "Update board" on a changed saved board, "Save" on a changed All tasks. */
export function SaveButton({ tb, onSave }: { tb: TaskBoard; onSave: () => void }) {
  if (!tb.dirty || !tb.views) return null;
  return tb.view ? (
    <button type="button" className="btn tt-save" onClick={() => void tb.update()}>Update board</button>
  ) : (
    <button type="button" className="btn tt-save" onClick={onSave}>Save</button>
  );
}

/** A conflict on a saved board: the draft stays, the board as saved now is one click away. */
export function ConflictBanner({ tb, onSaveNew }: { tb: TaskBoard; onSaveNew: () => void }) {
  if (!tb.conflict) return null;
  return tb.conflict.current ? (
    <Banner tone="warn" action={<button type="button" className="btn sm" onClick={tb.reload}>Reload</button>}>This board changed elsewhere; your edits are kept.</Banner>
  ) : (
    <Banner tone="warn" action={<button type="button" className="btn sm" onClick={onSaveNew}>Save as new</button>}>This board was deleted elsewhere; your edits are kept.</Banner>
  );
}

type Value = { id: string; name: string; count?: number; face?: string };

/** Each filter's values (names from the catalogs, counts from the cards the layout draws). */
function valuesOf(key: FilterKey, board: Board, cards: Card[]): Value[] | "unavailable" {
  const count = (test: (c: Card) => boolean) => cards.filter(test).length;
  switch (key) {
    case "agent":
      return [
        ...board.assignees.filter((a) => a.kind !== "me").map((a) => ({ id: a.key, name: a.name, face: a.name, count: count((c) => cardMatches(c, { agent: [a.key] })) })),
        { id: "me", name: "You", face: "You", count: count((c) => cardMatches(c, { agent: ["me"] })) },
        { id: "none", name: "Unassigned", count: count((c) => cardMatches(c, { agent: ["none"] })) },
      ];
    case "state":
      return LANES.map((l) => ({ id: l, name: LANE_NAMES[l] }));
    case "label":
      return board.labels.map((l) => ({ id: l.id, name: l.name, count: count((c) => c.labelIds.includes(l.id)) }));
    case "priority":
      return PRIORITIES.map((p) => ({ id: p, name: PRIORITY_NAMES[p] ?? p, count: count((c) => c.priority === p) }));
    case "project":
      if (!board.projects) return "unavailable";
      return [...board.projects.map((p) => ({ id: p.id, name: p.name, count: count((c) => c.projectId === p.id) })), { id: "none", name: "No project", count: count((c) => c.projectId === null) }];
    case "updated":
      return (Object.keys(UPDATED_NAMES) as (keyof typeof UPDATED_NAMES)[]).map((u) => ({ id: u, name: UPDATED_NAMES[u] }));
  }
}

const chosen = (f: Filters, k: FilterKey): string[] => (k === "updated" ? (f.updated ? [f.updated] : []) : ((f[k] as string[] | undefined) ?? []));

/** The filter bar: a chip per filter (`name | values | ✕`), `+ Filter`, and Clear all with two or more. */
export function FilterChips({ tb, board, cards }: { tb: TaskBoard; board: Board; cards: Card[] }) {
  const [menu, setMenu] = useState<{ key: FilterKey | null } | null>(null);
  const f = tb.filters;
  const set = (k: FilterKey, vals: string[]) => tb.setFilters({ ...f, [k]: k === "updated" ? vals[0] ?? null : vals });
  const active = FILTER_KEYS.filter((k) => chosen(f, k).length);
  const projectsOff = board.projects !== null && board.projects.length === 0;
  return (
    <>
      {active.map((k) => {
        const vals = valuesOf(k, board, cards);
        const names = chosen(f, k).map((id) => ({ id, name: vals === "unavailable" ? undefined : vals.find((v) => v.id === id)?.name }));
        return (
          <span key={k} className="tt-chip">
            <button type="button" className="tt-chip-k" onClick={() => setMenu({ key: k })}>{FILTER_NAMES[k]}</button>
            <button type="button" className="tt-chip-v" onClick={() => setMenu({ key: k })}>
              {names.map((n, i) => (
                <span key={n.id}>
                  {i ? ", " : ""}
                  {n.name ?? <s title="No longer exists: matches nothing">{vals === "unavailable" ? "unavailable" : "deleted"}</s>}
                </span>
              ))}
            </button>
            <button type="button" className="tt-chip-x" aria-label={`Remove ${FILTER_NAMES[k]} filter`} onClick={() => set(k, [])}>✕</button>
          </span>
        );
      })}
      <span className="tt-add-wrap">
        <button type="button" className="tt-fbtn" aria-haspopup="menu" aria-expanded={!!menu} onClick={() => setMenu(menu ? null : { key: null })}>+ Filter</button>
        {menu && <FilterMenu k={menu.key} board={board} cards={cards} hideProject={projectsOff} filters={f} onPick={(k) => setMenu({ key: k })} onSet={set} onClose={() => setMenu(null)} />}
      </span>
      {active.length >= 2 && (
        <button type="button" className="tt-clear" onClick={() => tb.setFilters({ text: f.text })}>Clear all</button>
      )}
    </>
  );
}

/** `+ Filter`: the six filters with a type-to-find field, then the picked one's values (multi-select with counts). */
function FilterMenu({ k, board, cards, filters, hideProject, onPick, onSet, onClose }: { k: FilterKey | null; board: Board; cards: Card[]; filters: Filters; hideProject: boolean; onPick: (k: FilterKey) => void; onSet: (k: FilterKey, vals: string[]) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setQ(""), [k]);
  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);
  const t = q.trim().toLowerCase();
  const keys = FILTER_KEYS.filter((x) => !(x === "project" && hideProject) && FILTER_NAMES[x].toLowerCase().includes(t));
  const vals = k ? valuesOf(k, board, cards) : null;
  const on = k ? chosen(filters, k) : [];
  const toggle = (id: string) => k && onSet(k, k === "updated" ? (on.includes(id) ? [] : [id]) : on.includes(id) ? on.filter((x) => x !== id) : [...on, id]);
  return (
    <div className="tt-pop tt-filter" ref={ref} role="menu" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <input className="tt-find" autoFocus value={q} placeholder={k ? `${FILTER_NAMES[k]}…` : "Filter by…"} aria-label={k ? FILTER_NAMES[k] : "Filter by"} onChange={(e) => setQ(e.target.value)} />
      {!k &&
        keys.map((x) => (
          <button key={x} type="button" role="menuitem" className="tt-item" disabled={x === "project" && board.projects === null} onClick={() => onPick(x)}>
            {FILTER_NAMES[x]}
            {x === "project" && board.projects === null && <span className="tt-ct">unavailable</span>}
          </button>
        ))}
      {k && vals === "unavailable" && <p className="tt-note">The project list couldn't be read.</p>}
      {k &&
        vals !== "unavailable" &&
        vals!
          .filter((v) => v.name.toLowerCase().includes(t))
          .map((v) => (
            <button key={v.id} type="button" role="menuitemcheckbox" aria-checked={on.includes(v.id)} className="tt-item" onClick={() => toggle(v.id)}>
              <span className={`tt-box${on.includes(v.id) ? " on" : ""}`} aria-hidden>{on.includes(v.id) ? "✓" : ""}</span>
              {v.face && <Monogram name={v.face} size={18} />}
              <span className="tt-name">{v.name}</span>
              {v.count !== undefined && <span className="tt-ct">{v.count}</span>}
            </button>
          ))}
    </div>
  );
}

/** Phone: the chips live in a sheet behind "Filters (n)". */
export function FilterSheet({ tb, board, cards }: { tb: TaskBoard; board: Board; cards: Card[] }) {
  const [open, setOpen] = useState(false);
  const n = chipCount(tb.filters);
  return (
    <>
      <button type="button" className="tt-fbtn" onClick={() => setOpen(true)}>Filters{n ? ` (${n})` : ""}</button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Filters"
        actions={
          <>
            <button type="button" className="btn" onClick={() => tb.setFilters({ text: tb.filters.text })}>Clear</button>
            {tb.view && tb.dirty && <button type="button" className="btn" onClick={() => (void tb.update(), setOpen(false))}>Update board</button>}
            <button type="button" className="btn primary" onClick={() => setOpen(false)}>Done</button>
          </>
        }
      >
        <div className="tt-sheet">
          <FilterChips tb={tb} board={board} cards={cards} />
        </div>
      </Dialog>
    </>
  );
}
