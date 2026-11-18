// An overflow menu (⋯): a button that opens a short list of actions. Escape or a click outside closes it; arrows move.
import { useEffect, useRef, useState } from "react";

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean }

export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return (setOpen(false), button.current?.focus());
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
  };
  return (
    <div className="ui-menu" ref={root} onKeyDown={keys}>
      <button ref={button} type="button" className="btn ui-menu-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="3.5" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="12.5" cy="8" r="1.4" fill="currentColor" /></svg>
      </button>
      {open && (
        <div className="ui-menu-list" role="menu">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={it.danger ? "danger" : ""} onClick={() => (setOpen(false), it.onSelect())}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
