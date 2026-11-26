// The detail of one item beside its list, sliding in from the right. Non-modal: no backdrop, the page stays usable.
// Escape closes it and focus goes back to what opened it; on a phone it fills the screen. The caller places it (e.g.
// Home's side column); it is --pane-w wide where there is room.
import { useEffect, useId, useRef, useState } from "react";
import { Kbd } from "./Kbd";

/** A pane that animates out before it unmounts, closes on Escape, and returns focus to its opener. */
export function usePane(open: boolean, onClose: () => void) {
  const [shown, setShown] = useState(open);
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  if (open && !shown) setShown(true);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && close.current();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Back to the opener only when focus was in the pane (a click elsewhere keeps its own focus).
      const at = document.activeElement;
      if (opener?.isConnected && (!at || at === document.body || ref.current?.contains(at))) opener.focus({ preventScroll: true });
    };
  }, [open]);
  return {
    ref,
    shown,
    leaving: shown && !open,
    onAnimationEnd: (e: React.AnimationEvent) => e.target === e.currentTarget && !open && setShown(false),
  };
}

export function DetailPane({ open, title, onClose, actions, children }: { open: boolean; title: React.ReactNode; onClose: () => void; actions?: React.ReactNode; children: React.ReactNode }) {
  const p = usePane(open, onClose);
  const id = useId();
  if (!p.shown) return null;
  return (
    <aside ref={p.ref} className={`ui-pane ui-detail${p.leaving ? " leaving" : ""}`} aria-labelledby={id} onAnimationEnd={p.onAnimationEnd}>
      <header className="ui-detail-head">
        <h2 id={id}>{title}</h2>
        <button type="button" className="btn quiet sm" onClick={onClose} aria-label="Close details">Close <Kbd>Esc</Kbd></button>
      </header>
      <div className="ui-detail-body">{children}</div>
      {actions && <footer className="ui-detail-actions">{actions}</footer>}
    </aside>
  );
}
