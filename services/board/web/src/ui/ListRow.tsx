// One clickable row of a list: status, a one-line title (full text on hover), its id, where it came from (or a short note), and when.
export function ListRow({ href, status, title, id, from, note, time, timeTitle }: { href: string; status: React.ReactNode; title: string; id: string; from?: string | null; note?: React.ReactNode; time: string; timeTitle?: string }) {
  return (
    <a className="ui-row" href={href}>
      {status}
      <span className="ui-row-title" title={title}>{title}</span>
      <span className="ui-row-meta">
        <span className="ui-row-id">{id}</span>
        {note !== undefined && <span className="ui-row-note">{note}</span>}
        {from !== undefined && <span className="ui-row-from" title={from ? `from ${from}` : undefined}>{from && `from ${from}`}</span>}
      </span>
      <time className="ui-row-time" title={timeTitle}>{time}</time>
    </a>
  );
}

export const ListRows = ({ children }: { children: React.ReactNode }) => <div className="ui-rows">{children}</div>;
