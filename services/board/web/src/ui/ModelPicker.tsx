// The board's one model picker: a button showing the model, a searchable list under it. The list is OpenRouter's catalog
// (useModelCatalog), grouped Recommended / Latest aliases / by provider, newest first, with older versions of a model behind a
// toggle (model-catalog.ts `listing`). Only a listed id can be picked. With no catalog (loading, or it failed) it offers the
// recommended models alone. Keys: Down opens; Up/Down move, Enter picks, Escape closes (the dialog around it stays open).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { contextText, listing, priceText, shortId, type Accepts, type CatalogModel } from "../../../src/model-catalog";

interface Place { left: number; width: number; top?: number; bottom?: number; maxHeight: number }

const where = (anchor: HTMLElement): Place => {
  const r = anchor.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight, gap = 4, edge = 8;
  const narrow = vw <= 560;
  const width = narrow ? vw - 2 * edge : Math.min(Math.max(r.width, 400), vw - 2 * edge);
  const left = narrow ? edge : Math.max(edge, Math.min(r.left, vw - width - edge));
  const below = vh - r.bottom - gap - edge, above = r.top - gap - edge;
  return below >= 280 || below >= above
    ? { left, width, top: r.bottom + gap, maxHeight: Math.min(440, below) }
    : { left, width, bottom: vh - r.top + gap, maxHeight: Math.min(440, above) };
};

const Check = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

export function ModelPicker({ value, onChange, catalog, recommended, accepts, label, none, disabled }: {
  value: string;
  onChange: (id: string) => void;
  /** null while it loads, [] when it couldn't be read. */
  catalog: CatalogModel[] | null;
  /** The short list (the engine's, or the agents' own), shown first. */
  recommended: readonly string[];
  /** What the engine can run (its module's `accepts`). */
  accepts?: Accepts;
  label: string;
  /** Words for "no model of its own" (an empty value); without it a model is always chosen. */
  none?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [older, setOlder] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<Place | null>(null);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const list = useMemo(() => listing({ catalog: catalog ?? [], recommended, accepts, query, showOlder: older, current: value || undefined }), [catalog, recommended, accepts, query, older, value]);
  const rows = useMemo(() => [...(none && !query ? [{ id: "" } as const] : []), ...list.sections.flatMap((s) => s.rows)], [list, none, query]);
  const optId = (i: number) => `${id}-o${i}`;

  const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const pick = (to: string) => { close(true); if (to !== value) onChange(to); };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    setPlace(where(trigger.current));
    panel.current?.showPopover?.();
    const again = () => trigger.current && setPlace(where(trigger.current));
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false); };
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    document.addEventListener("pointerdown", away);
    return () => { setPlace(null); window.removeEventListener("resize", again); window.removeEventListener("scroll", again, true); document.removeEventListener("pointerdown", away); };
  }, [open]);
  useEffect(() => { if (place) input.current?.focus(); }, [place === null]);
  useEffect(() => { if (open) document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" }); }, [open, active]);

  const show = () => { setQuery(""); setOlder(false); setActive(Math.max(0, rows.findIndex((r) => r.id === value))); setOpen(true); };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return close(true); }
    if (e.target !== input.current) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % Math.max(1, rows.length)); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); setActive(rows.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[active]) pick(rows[active]!.id); }
  };

  let next = none && !query ? 1 : 0; // the option index of the next row (the "none" row is 0)
  const shown = value ? shortId(value) : none ?? "Choose a model";
  const style: CSSProperties | undefined = place ? { left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight } : { visibility: "hidden" };
  const unavailable = catalog !== null && !catalog.length;

  return (
    <div className="ui-mp">
      <button
        ref={trigger}
        type="button"
        className="ui-select ui-mp-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${shown}`}
        title={shown}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); show(); } }}
      >
        <span className={value ? "" : "ui-mp-none"}>{shown}</span>
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
              aria-activedescendant={rows.length ? optId(active) : undefined}
              aria-label={`Search models for ${label}`}
              placeholder="Search by name, id or provider"
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => (setQuery(e.target.value), setActive(0))}
            />
          </div>
          <div className="ui-mp-list" id={`${id}-list`} role="listbox" aria-label={label}>
            {none && !query && (
              <div id={optId(0)} role="option" aria-selected={!value} className="ui-mp-opt" data-active={active === 0} onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(0)} onClick={() => pick("")}>
                <span className="ui-mp-check">{!value && <Check />}</span>
                <span className="ui-mp-id">{none}</span>
              </div>
            )}
            {list.sections.map((s) => (
              <div key={s.title} role="group" aria-label={s.title}>
                <div className="ui-mp-head" aria-hidden>{s.title}</div>
                {s.rows.map((r) => {
                  const i = next++;
                  const m = r.model;
                  return (
                    <div key={r.id} id={optId(i)} role="option" aria-selected={r.id === value} className="ui-mp-opt" data-active={active === i} title={m ? `${m.name}${m.reasoning ? " · reasoning" : ""}${m.tools ? " · tools" : ""}` : undefined} onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => pick(r.id)}>
                      <span className="ui-mp-check">{r.id === value && <Check />}</span>
                      <span className="ui-mp-id">{shortId(r.id)}</span>
                      {m && <span className="ui-mp-name">{m.name.replace(/^[^:]+:\s*/, "")}</span>}
                      {m && <span className="ui-mp-meta">{m.context ? `${contextText(m.context)} · ` : ""}{priceText(m)}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            {!rows.length && (
              <p className="ui-mp-empty" role="status">
                {unavailable ? "OpenRouter's model list isn't available." : query ? `No model matches "${query}".` : "No models to show."}
              </p>
            )}
          </div>
          <div className="ui-mp-foot">
            <span>{unavailable ? "Showing the recommended models" : catalog === null ? "Loading the model list…" : `${rows.length} model${rows.length === 1 ? "" : "s"}`}</span>
            {!query && (older || list.older > 0) && (
              <button type="button" className="ui-mp-older" aria-pressed={older} onClick={() => setOlder(!older)}>
                {older ? "Hide older versions" : `Show older versions (${list.older})`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
