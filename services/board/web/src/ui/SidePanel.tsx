// A panel at the right edge for a conversation beside the page (Ask Aiden): a header with a face, title, a line under it
// and its own buttons (history, close), the body, and a footer for the composer. Non-modal: the page stays usable; Escape
// closes it and focus goes back to what opened it. Full height of its slot, --pane-w wide; a full-screen sheet on a phone.
import { useId } from "react";
import { usePane } from "./DetailPane";

export function SidePanel({ open, onClose, title, sub, face, headerActions, footer, children }: { open: boolean; onClose: () => void; title: React.ReactNode; sub?: React.ReactNode; face?: React.ReactNode; headerActions?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) {
  const p = usePane(open, onClose);
  const id = useId();
  if (!p.shown) return null;
  return (
    <aside ref={p.ref} className={`ui-pane ui-side${p.leaving ? " leaving" : ""}`} aria-labelledby={id} onAnimationEnd={p.onAnimationEnd}>
      <header className="ui-side-head">
        {face}
        <span className="ui-side-title">
          <b id={id}>{title}</b>
          {sub && <span>{sub}</span>}
        </span>
        {headerActions}
        <button type="button" className="btn quiet" onClick={onClose} aria-label="Close panel">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </header>
      <div className="ui-side-body">{children}</div>
      {footer && <footer className="ui-side-foot">{footer}</footer>}
    </aside>
  );
}
