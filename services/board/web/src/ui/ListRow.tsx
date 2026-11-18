// One clickable row of a list: status, a one-line title (full text on hover), its id, where it came from, and when.
import { StatusDot, taskStatus } from "./StatusDot";

export function ListRow({ href, state, title, id, from, time, timeTitle }: { href: string; state: string; title: string; id: string; from?: string | null; time: string; timeTitle?: string }) {
  const s = taskStatus(state);
  return (
    <a className="ui-row" href={href}>
      <StatusDot tone={s.tone}>{s.word}</StatusDot>
      <span className="ui-row-title" title={title}>{title}</span>
      <span className="ui-row-meta">
        <span className="ui-row-id">{id}</span>
        {from !== undefined && <span className="ui-row-from" title={from ? `from ${from}` : undefined}>{from && `from ${from}`}</span>}
      </span>
      <time className="ui-row-time" title={timeTitle}>{time}</time>
    </a>
  );
}

export const ListRows = ({ children }: { children: React.ReactNode }) => <div className="ui-rows">{children}</div>;
