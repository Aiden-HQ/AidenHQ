// One line above a page's content: what is new or wrong, and the one thing to do about it (an action on the right).
export function Banner({ tone = "info", children, action }: { tone?: "info" | "warn" | "danger"; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={`ui-banner${tone === "info" ? "" : ` ui-banner-${tone}`}`} role={tone === "danger" ? "alert" : "status"}>
      <span className="ui-banner-text">{children}</span>
      {action}
    </div>
  );
}
