// Show or hide a block under a one-line summary ("Team behind Max (2)"). The body collapses with its height; while closed
// it is inert, so focus and screen readers skip it.
import { useId, useState } from "react";

export function Disclosure({ summary, defaultOpen = false, children }: { summary: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={`ui-disc${open ? " open" : ""}`}>
      <button type="button" className="ui-disc-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {summary}
      </button>
      <div className="ui-disc-body" id={id} inert={!open}>
        <div>
          <div className="ui-disc-inner">{children}</div>
        </div>
      </div>
    </div>
  );
}
