// One thing that needs the owner, as a row: who asks (face, name, role), the question, the text it is about (a draft,
// quoted and clamped to four lines), and the caller's buttons inline. Answered, it collapses to a receipt ("Sent as you.")
// with Undo when the caller can undo. A click on the row opens its detail (onOpen); `active` marks the row the keyboard is on.
import type { CSSProperties } from "react";
import { Button } from "./Button";

export function DecisionRow({ face, who, role, question, detail, meta, overdue, actions, receipt, active, onOpen, i }: {
  face: React.ReactNode; who: string; role?: string;
  question: React.ReactNode; detail?: string;
  meta?: React.ReactNode; overdue?: boolean;
  actions?: React.ReactNode;
  receipt?: { text: string; onUndo?: () => void } | null;
  active?: boolean; onOpen?: () => void; i?: number;
}) {
  const top = (
    <>
      {face}
      <span className="ui-dr-main">
        <span className="ui-dr-who"><b>{who}</b>{role && ` · ${role}`}</span>
        <span className="ui-dr-q">{question}</span>
      </span>
      {meta && <span className={`ui-dr-meta${overdue ? " overdue" : ""}`}>{meta}</span>}
    </>
  );
  return (
    <div className={`ui-dr enter${active ? " on" : ""}`} style={{ "--i": i ?? 0 } as CSSProperties}>
      {onOpen ? <button type="button" className="ui-dr-top" onClick={onOpen}>{top}</button> : <div className="ui-dr-top">{top}</div>}
      {receipt ? (
        <div className="ui-dr-receipt" role="status">
          <span className="ui-dr-done">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden><path d="m5 12 5 5L20 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {receipt.text}
          </span>
          {receipt.onUndo && <Button variant="quiet" size="sm" onClick={receipt.onUndo}>Undo</Button>}
        </div>
      ) : (
        <>
          {detail && <blockquote className="ui-dr-detail">{detail}</blockquote>}
          {actions && <div className="ui-dr-actions">{actions}</div>}
        </>
      )}
    </div>
  );
}
