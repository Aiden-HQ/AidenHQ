// What happened while the owner was away, one line each: who, what, and a link to look. Shows the first `limit` (3);
// `more` links to all of them ("All 9 →").
import { safeHref } from "./Button";

export function DigestList({ items, limit = 3, more }: { items: { id: string; face?: React.ReactNode; text: React.ReactNode; link?: { label: string; href: string } }[]; limit?: number; more?: { label: string; href: string } }) {
  return (
    <div className="ui-digest">
      {items.slice(0, limit).map((d) => (
        <div key={d.id} className="ui-digest-row">
          {d.face}
          <span className="ui-digest-text">{d.text}</span>
          {d.link && <a href={safeHref(d.link.href)}>{d.link.label}</a>}
        </div>
      ))}
      {more && (
        <a className="ui-digest-more" href={safeHref(more.href)}>
          {more.label} <span aria-hidden>→</span>
        </a>
      )}
    </div>
  );
}
