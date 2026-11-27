// The board's one compact row, one line per item: a face or monogram, the text, the caller's buttons inline, and the age or
// a link on the right. The whole row is the click target (`onOpen`, or `open`: an address to go to); `active` marks the row
// the keyboard is on; `receipt` replaces the text once the row is answered. Shows the first `limit` (3); `more` links to all.
import type { CSSProperties } from "react";
import { Button, safeHref } from "./Button";

export type DigestItem = {
  id: string;
  face?: React.ReactNode;
  text: React.ReactNode;
  /** Plain text of the row, the tooltip of a clamped line. */
  title?: string;
  meta?: React.ReactNode;
  link?: { label: string; href: string };
  actions?: React.ReactNode;
  /** The buttons stay visible (an answer is the point of the row); otherwise they show on hover. */
  persist?: boolean;
  onOpen?: () => void;
  open?: string;
  /** A web address that opens in a new tab (a meeting); the row text is its link. */
  external?: string;
  active?: boolean;
  receipt?: { text: string; onUndo?: () => void } | null;
  i?: number;
};

/** A click on the row opens it, unless it landed on a control inside it. */
const skip = "button, a, input, textarea, select, label, form";

export function DigestRow({ d }: { d: DigestItem }) {
  const out = d.external && safeHref(d.external) !== "#" ? d.external : undefined;
  const open = d.onOpen ?? (d.open ? () => void (location.hash = safeHref(d.open!)) : out ? () => void window.open(out, "_blank", "noopener,noreferrer") : undefined);
  return (
    <div
      className={`ui-digest-row${open ? " openable" : ""}${d.active ? " on" : ""}`}
      style={d.i === undefined ? undefined : ({ "--i": d.i } as CSSProperties)}
      onClick={open && !d.receipt ? (e) => !(e.target as Element).closest(skip) && open() : undefined}
    >
      {d.face}
      {d.receipt ? (
        <span className="ui-digest-text ui-digest-receipt" role="status">
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden><path d="m5 12 5 5L20 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {d.receipt.text}
          {d.receipt.onUndo && <Button variant="quiet" size="sm" onClick={d.receipt.onUndo}>Undo</Button>}
        </span>
      ) : (
        <>
          {d.onOpen ? (
            <button type="button" className="ui-digest-text ui-digest-open" title={d.title} onClick={d.onOpen}>{d.text}</button>
          ) : d.open ? (
            <a className="ui-digest-text ui-digest-open" title={d.title} href={safeHref(d.open)}>{d.text}</a>
          ) : out ? (
            <a className="ui-digest-text ui-digest-open" title={d.title} href={out} target="_blank" rel="noopener noreferrer">{d.text}</a>
          ) : (
            <span className="ui-digest-text" title={d.title}>{d.text}</span>
          )}
          {d.actions && <span className={`ui-digest-actions${d.persist ? " persist" : ""}`}>{d.actions}</span>}
          {d.meta && <span className="ui-digest-meta">{d.meta}</span>}
          {d.link && <a href={safeHref(d.link.href)}>{d.link.label}</a>}
        </>
      )}
    </div>
  );
}

export function DigestList({ items, limit = 3, more }: { items: DigestItem[]; limit?: number; more?: { label: string; href: string } }) {
  return (
    <div className="ui-digest">
      {items.slice(0, limit).map((d) => <DigestRow key={d.id} d={d} />)}
      {more && (
        <a className="ui-digest-more" href={safeHref(more.href)}>
          {more.label} <span aria-hidden>→</span>
        </a>
      )}
    </div>
  );
}
