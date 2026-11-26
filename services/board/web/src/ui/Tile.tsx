// Items as tiles in a grid that adds columns as the screen grows. A tile is one target (the whole tile opens `href`, or
// calls `onOpen` for a dialog) with its action raised above it, so a button inside stays its own target. Its monogram takes the item's tone (hue.ts).
import { hueClass, tone } from "./hue";

/** Up to two letters: the first of the first two words ("Slack Scout" → "SS"), else the first two of one ("Aiden" → "Ai"). */
export function initials(name: string): string {
  const words = name.replace(/^Engineer · /, "").trim().split(/[\s·_-]+/).filter((w) => /\p{L}|\d/u.test(w));
  if (!words.length) return "?";
  if (words.length === 1) {
    const [a = "", b = ""] = [...words[0]!.replace(/[^\p{L}\d]/gu, "")];
    return (a.toUpperCase() + b.toLowerCase()) || "?";
  }
  return words.slice(0, 2).map((w) => [...w.replace(/[^\p{L}\d]/gu, "")][0]?.toUpperCase() ?? "").join("") || "?";
}

/** A rounded square with the item's initials on its tone (ui/tokens.css .tone-0…7, 7:1 in both themes); "chief-of-staff" → "CS". */
export function Monogram({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span className={`ui-mono tone-${tone(name)}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden>
      {initials(name.replace(/(^|[-_\s])(of|and|the)(?=[-_\s]|$)/g, "$1"))}
    </span>
  );
}

export function TileGrid({ children }: { children: React.ReactNode }) {
  return <div className="ui-tiles">{children}</div>;
}

export function Tile({ href, onOpen, name, title, status, children, facts, foot, action, tone: t, face }: { href?: string; onOpen?: () => void; face?: React.ReactNode; name: string; title: string; status?: React.ReactNode; children?: React.ReactNode; facts?: React.ReactNode; foot?: React.ReactNode; action?: React.ReactNode; /** needs, failed: a coloured edge; ghost: a dashed invitation ("Hire a teammate"). */ tone?: "needs" | "failed" | "ghost" }) {
  return (
    <article className={`ui-tile ${hueClass(name)}${t ? ` ui-tile-${t}` : ""}`}>
      <div className="ui-tile-head">
        {face ?? <Monogram name={name} />}
        <h3 className="ui-tile-title">
          {href ? <a href={href}>{title}</a> : <button type="button" onClick={onOpen}>{title}</button>}
        </h3>
        {status}
      </div>
      {children && <p className="ui-tile-desc">{children}</p>}
      {facts && <div className="ui-tile-facts">{facts}</div>}
      {(foot || action) && (
        <div className="ui-tile-foot">
          <span className="ui-tile-foot-text">{foot}</span>
          {action && <span className="ui-tile-action">{action}</span>}
        </div>
      )}
    </article>
  );
}
