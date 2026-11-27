// The fleet strip on Team › All agents: how many tasks failed or sit idle with nothing to wake them (the kernel's counts), and
// the tasks themselves, oldest first, once a count is opened. Every row shows the kernel's task state and nothing the board
// worked out. What needs the owner is Home's (Needs you), never here.
import { useState } from "react";
import { useLive } from "./events";
import { QUERIES, useQuery } from "./queries";
import { ago, stampOpts } from "./util";
import { ListRow, ListRows } from "./ui";
import { TaskState } from "./ui/TaskState";
import { Bone } from "./Skeleton";
import type { NeedsYou } from "./types";

type Item = NeedsYou["items"][number];
const EMPTY = { failed: "No task has failed.", idle: "No task sits idle unexplained." } as const;
type Which = "failed" | "idle";
const UNEXPLAINED = new Set(["unpolled", "orphaned", "unknown", "history_expired"]);
const IN: Record<Which, (i: Item) => boolean> = {
  failed: (i) => i.state.attention.some((a) => a.why === "failed"),
  idle: (i) => i.state.attention.some((a) => UNEXPLAINED.has(a.why)),
};
const LABELS = ["failed", "unexplained"] as const;

/**
 * One line of counts, each opening its list in place; the list starts closed. The line is the same height in every state
 * (loading, all-clear and with tasks), so the page below it lands where it stays. The counts never wrap to a second row: on a
 * narrow phone the line scrolls sideways. Opening a list grows the strip: that is a click, not a cold-load shift.
 */
export function AttentionStrip({ onSignIn }: { onSignIn: () => void }) {
  const q = useQuery(QUERIES.needsYou, onSignIn);
  useLive(["approvals", "chat", "tasks"], q.reload, 30_000);
  const [chosen, setChosen] = useState<Which | null>(null);
  const d = q.data;
  // A failed read is not a load: no busy frame, just the one line.
  if (!d && q.error)
    return (
      <section className="attn attn-compact" aria-label="What needs attention">
        <div className="attn-head">
          <b className="attn-title">Fleet attention</b>
          <span className="attn-failed" role="status">Unavailable: {q.error}</span>
        </div>
      </section>
    );
  // The loaded line with a bone where each number goes, so the row is the width and height it will be once the counts arrive.
  if (!d)
    return (
      <section className="attn attn-compact" role="status" aria-busy="true" aria-label="Loading fleet attention">
        <div className="attn-head">
          <b className="attn-title">Fleet attention</b>
          <span className="attn-counts">
            {LABELS.map((label) => (
              <button key={label} type="button" className="attn-count attn-count-load" tabIndex={-1} disabled aria-hidden>
                <Bone w={7} h={11} /> {label}
              </button>
            ))}
          </span>
        </div>
      </section>
    );
  const n: Record<Which, number> = { failed: d.counts.failed, idle: d.counts.unexplained_idle };
  const rows = chosen ? d.items.filter(IN[chosen]) : [];
  const words: Record<Which, string> = { failed: `${n.failed} failed`, idle: `${n.idle} unexplained` };
  return (
    <section className="attn attn-compact" aria-label="What needs attention">
      <div className="attn-head">
        <b className="attn-title">Fleet attention</b>
        <span className="attn-counts">
          {(["failed", "idle"] as const).map((w) => (
            <button key={w} type="button" className={`attn-count attn-${w}${n[w] ? " on" : ""}`} aria-expanded={chosen === w} onClick={() => setChosen(chosen === w ? null : w)}>
              {words[w]}
            </button>
          ))}
        </span>
        {chosen && rows.length > 0 && <span className="attn-order">oldest first</span>}
      </div>
      {chosen && rows.length > 0 && (
        <div className="attn-list">
          <ListRows>
            {rows.map((i) => (
              <ListRow key={i.identifier} href={`#/t/${i.identifier}`} status={<TaskState state={i.state} />} title={i.title} id={i.identifier} time={ago(i.state.since)} timeTitle={new Date(i.state.since).toLocaleString(undefined, stampOpts())} />
            ))}
          </ListRows>
        </div>
      )}
      {chosen && rows.length === 0 && <p className="attn-none">{EMPTY[chosen]}</p>}
    </section>
  );
}
