// Loading placeholders shaped like the content they stand for, built from the same layout classes (.fleet,
// .activity-day, .approval-card), so nothing shifts when the data lands. A subtle sheen, off with reduced motion.
import type { CSSProperties } from "react";

/** One placeholder block: `w` is a width (px or a CSS length), `h` a height. */
export function Bone({ w, h, round, className = "" }: { w?: number | string; h?: number | string; round?: boolean; className?: string }) {
  const style: CSSProperties = { ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}) };
  return <span className={`sk${round ? " round" : ""} ${className}`} style={style} aria-hidden />;
}

/** A few lines of text, the last one shorter. */
export function SkeletonLines({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`sk-stack ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <Bone key={i} className="line" w={i === lines - 1 ? "62%" : `${92 - ((i * 13) % 20)}%`} />
      ))}
    </div>
  );
}

const widths = ["58%", "44%", "66%", "50%", "38%", "61%"];

/** One Agents-page row: face, name and title, status pill, then the Now / Next run / Last result cells. */
export function FleetRowSkeleton({ i = 0, cells = true }: { i?: number; cells?: boolean }) {
  return (
    <div className="fleet-row" aria-hidden>
      <div className="fleet-main sk-row">
        <div className="fleet-who">
          <Bone round w={36} h={36} />
          <div className="fleet-name" style={{ flex: 1 }}>
            <Bone w={widths[i % widths.length]} h={13} />
            <Bone w={widths[(i + 2) % widths.length]} h={11} className="line" />
          </div>
        </div>
        <div className="fleet-status">
          <Bone className="tag-sk" />
        </div>
        <div className="fleet-now">{cells && <Bone w={widths[(i + 1) % widths.length]} />}</div>
        <div className="fleet-next">{cells && <Bone w="55%" />}</div>
        <div className="fleet-last">{cells && <Bone w={widths[(i + 3) % widths.length]} />}</div>
        <span className="fleet-toggle" />
      </div>
    </div>
  );
}

/** The Agents list before the roster arrives: its header and two groups of rows. */
export function FleetSkeleton({ groups = [4, 3] }: { groups?: number[] }) {
  let n = 0;
  return (
    <div className="fleet" role="status" aria-label="Loading agents" aria-busy>
      <div className="fleet-cols">
        <span>Agent</span>
        <span>Status</span>
        <span>Now</span>
        <span>Next run</span>
        <span>Last result</span>
        <span />
      </div>
      {groups.map((rows, g) => (
        <div key={g} className="fleet-group">
          <div className="fleet-group-head">
            <Bone w={120} h={13} />
          </div>
          {Array.from({ length: rows }, () => (
            <FleetRowSkeleton key={n} i={n++} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Cards in a list (Approvals). */
export function CardListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <ul className="sk-list" role="status" aria-label="Loading" aria-busy>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="sk-card" aria-hidden>
          <Bone w={140} h={12} />
          <Bone w={widths[i % widths.length]} h={15} />
          <Bone w="40%" />
        </li>
      ))}
    </ul>
  );
}

/** The chat list in the workspace sidebar. */
export function ChatListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="sk-chats" role="status" aria-label="Loading chats" aria-busy>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk-chat" aria-hidden>
          <Bone round w={26} h={26} />
          <div className="sk-stack" style={{ flex: 1, gap: 6 }}>
            <Bone w={widths[i % widths.length]} h={12} />
            <Bone w={widths[(i + 3) % widths.length]} h={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Beside a page's subtitle while cached data is shown and fresh data loads. */
export function Updating({ on }: { on: boolean }) {
  return on ? (
    <span className="updating" role="status">
      Updating
    </span>
  ) : null;
}
