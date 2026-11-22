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

export function AttentionStrip({ onSignIn }: { onSignIn: () => void }) {
  const q = useQuery(QUERIES.needsYou, onSignIn);
  useLive(["approvals", "chat", "tasks"], q.reload, 30_000);
  const [chosen, setChosen] = useState<Which | null>(null);
  const d = q.data;
  if (!d) return null;
  const n: Record<Which, number> = { needs: d.counts.needs_you, failed: d.counts.failed, idle: d.counts.unexplained_idle };
  const which = chosen ?? (n.needs ? "needs" : n.failed ? "failed" : n.idle ? "idle" : "needs");
  const rows = d.items.filter(IN[which]);
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
      {rows.length > 0 && (
        <div className="attn-list">
          <ListRows>
            {rows.map((i) => (
              <ListRow key={i.identifier} href={`#/t/${i.identifier}`} status={<TaskState state={i.state} />} title={i.title} id={i.identifier} note={toYou(i) || undefined} time={ago(i.state.since)} timeTitle={new Date(i.state.since).toLocaleString()} />
            ))}
          </ListRows>
        </div>
      )}
    </section>
  );
}
