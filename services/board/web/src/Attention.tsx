// The fleet header on Tasks: how many tasks need you, failed, or sit idle with nothing to wake them (the kernel's counts), and
// the tasks themselves, oldest first. Every row shows the kernel's task state and nothing the board worked out.
import { useState } from "react";
import { useLive } from "./events";
import { QUERIES, useQuery } from "./queries";
import { ago } from "./util";
import { ListRow, ListRows, Segmented } from "./ui";
import { TaskState, needsOwner } from "./ui/TaskState";
import type { NeedsYou } from "./types";

type Item = NeedsYou["items"][number];
const EMPTY = { needs: "Nothing needs you right now.", failed: "No task has failed.", idle: "No task sits idle unexplained." } as const;
type Which = "needs" | "failed" | "idle";
const UNEXPLAINED = new Set(["unpolled", "orphaned", "unknown", "history_expired"]);
const IN: Record<Which, (i: Item) => boolean> = {
  needs: (i) => needsOwner(i.state),
  failed: (i) => i.state.attention.some((a) => a.why === "failed"),
  idle: (i) => i.state.attention.some((a) => UNEXPLAINED.has(a.why)),
};

/** Where the task goes next: to the owner (with the card's sentence when it is one) or, when an agent must act, nowhere yet (the chip's ⚠). */
const toYou = (i: Item) => {
  if (!needsOwner(i.state)) return "";
  const card = i.state.attention.some((a) => a.who === "owner" && a.why === "card") && i.state.refLabel;
  return card ? `→ you: ${card}` : "→ you";
};

/**
 * `compact` (Agent work, whose lanes already show these tasks): one line of counts, each opening its list in place; the
 * list starts closed. Otherwise (My day) the counts and the list, open.
 */
export function AttentionStrip({ onSignIn, compact }: { onSignIn: () => void; compact?: boolean }) {
  const q = useQuery(QUERIES.needsYou, onSignIn);
  useLive(["approvals", "chat", "tasks"], q.reload, 30_000);
  const [chosen, setChosen] = useState<Which | null>(null);
  const d = q.data;
  if (!d) return null;
  const n: Record<Which, number> = { needs: d.counts.needs_you, failed: d.counts.failed, idle: d.counts.unexplained_idle };
  const which = chosen ?? (n.needs ? "needs" : n.failed ? "failed" : n.idle ? "idle" : "needs");
  const rows = d.items.filter(IN[which]);
  const list = rows.length > 0 && (
    <div className="attn-list">
      <ListRows>
        {rows.map((i) => (
          <ListRow key={i.identifier} href={`#/t/${i.identifier}`} status={<TaskState state={i.state} />} title={i.title} id={i.identifier} note={toYou(i) || undefined} time={ago(i.state.since)} timeTitle={new Date(i.state.since).toLocaleString()} />
        ))}
      </ListRows>
    </div>
  );
  if (compact) {
    const words: Record<Which, string> = { needs: `${n.needs} need you`, failed: `${n.failed} failed`, idle: `${n.idle} unexplained` };
    return (
      <section className="attn attn-compact" aria-label="What needs attention">
        <div className="attn-head">
          <b className="attn-title">Fleet attention</b>
          {(["needs", "failed", "idle"] as const).map((w) => (
            <button key={w} type="button" className={`attn-count attn-${w}${n[w] ? " on" : ""}`} aria-expanded={chosen === w} onClick={() => setChosen(chosen === w ? null : w)}>
              {words[w]}
            </button>
          ))}
          {chosen && rows.length > 0 && <span className="attn-order">oldest first</span>}
        </div>
        {chosen && (list || <p className="attn-none">{EMPTY[chosen]}</p>)}
      </section>
    );
  }
  return (
    <section className="attn" aria-label="What needs attention">
      <div className="attn-head">
        <b className="attn-title">Fleet attention</b>
        <Segmented
          label="Needs attention"
          value={which}
          onChange={setChosen}
          options={[["needs", `Needs you · ${n.needs}`], ["failed", `Failed · ${n.failed}`], ["idle", `Unexplained idle · ${n.idle}`]] as const}
        />
        <span className="attn-order">oldest first</span>
      </div>
      {list}
    </section>
  );
}
