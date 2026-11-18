// A small square-cornered label for a fact: a count, a kind, a version, a grant. Not a status (that is StatusDot).
export type TagTone = "neutral" | "accent" | "ok" | "needs" | "failed";

export function Tag({ tone = "neutral", children, title, href }: { tone?: TagTone; children: React.ReactNode; title?: string; href?: string }) {
  const cls = `ui-tag${tone === "neutral" ? "" : ` ui-tag-${tone}`}`;
  return href ? <a className={cls} href={href} title={title}>{children}</a> : <span className={cls} title={title}>{children}</span>;
}

export const Tags = ({ children }: { children: React.ReactNode }) => <span className="ui-tags">{children}</span>;
