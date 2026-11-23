// A button that opens a searchable list under it (a combobox): the one picker behind the model and repository pickers. The caller
// owns the search text and the sections (it filters, groups and words the rows); this owns the popover, placement, the highlighted
// row and the keys: Down opens; Up/Down move, Enter picks, Escape closes (a dialog around it stays open). A disabled row is shown
// but can't be picked or reached by the arrows.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

export interface PickItem { id: string; node: ReactNode; title?: string; disabled?: boolean }
export interface PickSection { title: string; items: PickItem[] }

interface Place { left: number; width: number; top?: number; bottom?: number; maxHeight: number }

const where = (anchor: HTMLElement): Place => {
  // The visual viewport: on a phone the keyboard shrinks it without changing window.innerHeight.
  const vv = window.visualViewport, top = vv?.offsetTop ?? 0, bottom = top + (vv?.height ?? window.innerHeight);
  const r = anchor.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight, gap = 4, edge = 8;
  const narrow = vw <= 560;
  const width = narrow ? vw - 2 * edge : Math.min(Math.max(r.width, 400), vw - 2 * edge);
  const left = narrow ? edge : Math.max(edge, Math.min(r.left, vw - width - edge));
  const below = bottom - r.bottom - gap - edge, above = r.top - top - gap - edge;
  return below >= 280 || below >= above
    ? { left, width, top: r.bottom + gap, maxHeight: Math.min(440, below) }
    : { left, width, bottom: vh - r.top + gap, maxHeight: Math.min(440, above) };
};

export const Check = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export function SearchPicker({ label, triggerLabel, value, display, sections, query, onQuery, searchPlaceholder, onPick, footer, empty, onOpen, disabled, autoFocus }: {
  label: string;
  /** The button's accessible name, naming what is picked (default: the label). */
  triggerLabel?: string;
  /** The id picked now (its row shows a check). */
  value: string;
  /** What the button shows. */
  display: ReactNode;
  sections: PickSection[];
  query: string;
  onQuery: (q: string) => void;
  searchPlaceholder: string;
  onPick: (id: string) => void;
  /** A line under the list. */
  footer?: ReactNode;
  /** What the list says when it has no row. */
  empty?: ReactNode;
  /** The picker opened (the search text is empty again). */
  onOpen?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [place, setPlace] = useState<Place | null>(null);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const pickable = useMemo(() => rows.filter((r) => !r.disabled), [rows]);
  // The highlighted row is tracked by id, so a list that changes under it (a search, older versions) keeps it right.
  const active = pickable.find((r) => r.id === activeId) ?? pickable[0];
  const optId = (rowId: string) => `${id}-${rows.findIndex((r) => r.id === rowId)}`;

  const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const pick = (to: string) => { close(true); if (to !== value) onPick(to); };
  const show = () => { onQuery(""); setActiveId(value || undefined); setOpen(true); onOpen?.(); };

  useEffect(() => { if (autoFocus) trigger.current?.focus(); }, [autoFocus]);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    setPlace(where(trigger.current));
    panel.current?.showPopover?.();
    const again = () => trigger.current && setPlace(where(trigger.current));
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false); };
    window.addEventListener("resize", again);
    window.visualViewport?.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    document.addEventListener("pointerdown", away);
    return () => { setPlace(null); window.removeEventListener("resize", again); window.visualViewport?.removeEventListener("resize", again); window.removeEventListener("scroll", again, true); document.removeEventListener("pointerdown", away); };
  }, [open]);
  useEffect(() => { if (place) input.current?.focus(); }, [place === null]);
  useEffect(() => { if (open && active) document.getElementById(optId(active.id))?.scrollIntoView({ block: "nearest" }); }, [open, active?.id]);

  const move = (to: number) => setActiveId(pickable[Math.max(0, Math.min(pickable.length - 1, to))]?.id);
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return close(true); }
    if (e.target !== input.current) return;
    const at = active ? pickable.indexOf(active) : 0;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (pickable.length) setActiveId(pickable[(at + (e.key === "ArrowDown" ? 1 : pickable.length - 1)) % pickable.length]!.id); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); move(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); move(pickable.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (active) pick(active.id); }
  };

  const style: CSSProperties = place ? { left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight } : { visibility: "hidden" };
  return (
    <div className="ui-mp">
      <button
        ref={trigger}
        type="button"
        className="ui-select ui-mp-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerLabel ?? label}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); show(); } }}
      >
        {display}
      </button>
      {open && (
        <div ref={panel} popover="manual" className="ui-mp-panel" style={style} onKeyDown={keys} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node) && e.relatedTarget !== trigger.current) setOpen(false); }}>
          <div className="ui-mp-search">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <input
              ref={input}
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-activedescendant={active ? optId(active.id) : undefined}
              aria-label={`Search ${label}`}
              placeholder={searchPlaceholder}
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => (onQuery(e.target.value), setActiveId(undefined))}
            />
          </div>
          <div className="ui-mp-list" id={`${id}-list`} role="listbox" aria-label={label}>
            {sections.map((s) => (
              <div key={s.title} role="group" aria-label={s.title}>
                <div className="ui-mp-head" aria-hidden>{s.title}</div>
                {s.items.map((it) => (
                  <div key={it.id} id={optId(it.id)} role="option" aria-selected={it.id === value} aria-disabled={it.disabled || undefined} className="ui-mp-opt" data-active={active?.id === it.id} title={it.title} onMouseDown={(e) => e.preventDefault()} onMouseMove={() => !it.disabled && setActiveId(it.id)} onClick={() => !it.disabled && pick(it.id)}>
                    <span className="ui-mp-check">{it.id === value && <Check />}</span>
                    {it.node}
                  </div>
                ))}
              </div>
            ))}
            {!rows.length && <p className="ui-mp-empty" role="status">{empty ?? "Nothing to show."}</p>}
          </div>
          {footer && <div className="ui-mp-foot">{footer}</div>}
        </div>
      )}
    </div>
  );
}
