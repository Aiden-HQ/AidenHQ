// A card with a header: its title, a count of what needs the owner (amber), a muted note, and one action on the right.
// `flush` drops the body's padding for a list of rows (DecisionRow, DigestList).
export function SectionCard({ title, meta, count, action, flush, children }: { title: React.ReactNode; meta?: React.ReactNode; count?: number; action?: React.ReactNode; flush?: boolean; children: React.ReactNode }) {
  return (
    <section className="ui-sc">
      <header className="ui-sc-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="ui-badge">{count}</span>}
        {meta && <span className="ui-sc-meta">{meta}</span>}
        {action && <span className="ui-sc-action">{action}</span>}
      </header>
      <div className={flush ? "ui-sc-flush" : "ui-sc-body"}>{children}</div>
    </section>
  );
}
