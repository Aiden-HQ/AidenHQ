// The top of an item's page (an agent, a module): its face with a hue ring, its name, a live status line, one line of
// description, and its actions on the right. Put hueClass(name) on the page so the ring takes the item's colour.
export function PageHeader({ crumb, face, square, title, status, sub, actions }: { crumb?: React.ReactNode; face?: React.ReactNode; square?: boolean; title: string; status?: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="ui-head">
      {crumb && <nav className="ui-crumb" aria-label="Breadcrumb">{crumb}</nav>}
      <div className="ui-head-row">
        {face && <div className={`ui-head-face${square ? " square" : ""}`}>{face}</div>}
        <div className="ui-head-text">
          <h1>{title}</h1>
          {status && <div className="ui-head-status">{status}</div>}
          {sub && <p className="ui-head-sub">{sub}</p>}
        </div>
        {actions && <div className="ui-head-actions">{actions}</div>}
      </div>
    </header>
  );
}
