// A modal dialog (the native <dialog>: focus is trapped, Escape closes it). A click on the scrim closes it too.
import { useEffect, useRef } from "react";

export function Dialog({ open, onClose, title, children, actions, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; actions?: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`ui-dialog${wide ? " wide" : ""}`} aria-label={title} onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      {open && (
        <div className="ui-dialog-body">
          <header className="ui-dialog-head">
            <h2>{title}</h2>
            <button type="button" className="btn quiet sm" onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
          </header>
          {children}
          {actions && <div className="ui-dialog-actions">{actions}</div>}
        </div>
      )}
    </dialog>
  );
}
