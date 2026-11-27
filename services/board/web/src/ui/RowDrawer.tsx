import { useEffect, useRef } from "react";
import { Kbd } from "./Kbd";

/** The right drawer a list row opens (Home's, Tasks') (the board's drawer look: a scrim over the page, click outside or Esc closes). Focus moves
 * in and returns to the row. `head`: who it is from and how long it has waited; `foot`: the link to the whole task. */
export function RowDrawer({ rowId, onClose, head, foot, className, children }: { rowId: string; className?: string; onClose: () => void; head: React.ReactNode; foot?: React.ReactNode; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const mine = ref.current;
      if (!mine || e.defaultPrevented) return;
      // Only the topmost layer takes the keyboard: a task drawer opened from this one covers it and owns Tab and Escape.
      const layers = document.querySelectorAll(".drawer-backdrop, dialog[open], .palette-backdrop");
      if (layers[layers.length - 1] !== mine.parentElement) return;
      if (e.key === "Tab") {
        // A menu opened from the drawer (portaled to the page) keeps its own Tab order.
        if (document.activeElement?.closest(".popover")) return;
        // Focus stays in this drawer while it is the topmost one.
        const f = [...mine.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")];
        const first = f[0], last = f[f.length - 1];
        if (!first || !last) return e.preventDefault();
        const at = document.activeElement;
        if (e.shiftKey && (at === first || at === mine)) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && at === last) (e.preventDefault(), first.focus());
        else if (!mine.contains(at)) (e.preventDefault(), first.focus());
        return;
      }
      // Escape closes the topmost layer only: a task drawer opened from here is closed first.
      if (e.key === "Escape") (e.preventDefault(), close.current());
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const row = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(rowId)}"] .ui-digest-open`);
      (row ?? (opener?.isConnected ? opener : null))?.focus({ preventScroll: true });
    };
  }, [rowId]);
  return (
    <div className="drawer-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close.current()}>
      <aside ref={ref} tabIndex={-1} className={`drawer home-drawer${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label="Details">
        <header className="drawer-head home-drawer-head">
          {head}
          <span className="spacer" />
          <button type="button" className="btn quiet sm" onClick={onClose} aria-label="Close details">Close <Kbd>Esc</Kbd></button>
        </header>
        <div className="drawer-scroll">{children}</div>
        {foot && <footer className="home-drawer-foot">{foot}</footer>}
      </aside>
    </div>
  );
}
