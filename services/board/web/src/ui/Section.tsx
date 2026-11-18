// A titled block of a page: a sentence-case heading, an optional count and hint, tools on the right.
export function Section({ title, count, aside, info, hint, children, className = "" }: { title: string; count?: number; aside?: React.ReactNode; info?: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`ui-section ${className}`}>
      <header className="ui-section-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="ui-count">{count}</span>}
        {info && (
          <span className="ui-info" tabIndex={0} title={info} aria-label={info} role="img">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7.2v3.8M8 4.9v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </span>
        )}
        {hint && <span className="ui-section-hint">{hint}</span>}
        {aside && <div className="ui-section-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}
