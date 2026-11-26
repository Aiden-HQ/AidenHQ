// The fleet header on Tasks: how many tasks need you, failed, or sit idle with nothing to wake them (the kernel's counts), and
// the tasks themselves, oldest first, once a count is opened. Every row shows the kernel's task state and nothing the board
// worked out.
import { useRef, useState } from "react";
import { AnswerForm } from "./AnswerForm";
import { api } from "./api";
import { useLive } from "./events";
import { QUERIES, useQuery } from "./queries";
import { ago } from "./util";
import { ListRow, ListRows } from "./ui";
import { TaskState, needsOwner } from "./ui/TaskState";
import { Bone } from "./Skeleton";
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
 * One line of counts, each opening its list in place; the list starts closed. The line is the same height in every state —
 * loading, all-clear and with tasks — so the board below it lands where it stays and nothing waits on the needs-you query.
 * The counts never wrap to a second row (a longer count would move the board after the query answered): on a narrow phone the
 * line scrolls sideways, as the board's tabs do. Opening a list grows the strip: that is a click, not a cold-load shift.
 */
export function AttentionStrip({ onSignIn }: { onSignIn: () => void }) {
  const q = useQuery(QUERIES.needsYou, onSignIn);
  useLive(["approvals", "chat", "tasks"], q.reload, 30_000);
  const [chosen, setChosen] = useState<Which | null>(null);
  // The lane whose list stays mounted once it has been opened: closing hides it, it is not torn down (see `list`).
  const [lane, setLane] = useState<Which | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const d = q.data;
  // A failed read is not a load: no busy frame, just the one line (the base code showed nothing at all).
  if (!d && q.error)
    return (
      <section className="attn attn-compact" aria-label="What needs attention">
        <div className="attn-head">
          <b className="attn-title">Fleet attention</b>
          <span className="attn-failed" role="status">Unavailable: {q.error}</span>
        </div>
      </section>
    );
  // The loaded line, with a count-shaped placeholder in each of its three parts, so the row is the width and height it will
  // be once the counts arrive. No list area: the list only exists after a click, and reserving it would push the board down.
  if (!d)
    return (
      <section className="attn attn-compact" role="status" aria-busy="true" aria-label="Loading fleet attention">
        <div className="attn-head">
          <b className="attn-title">Fleet attention</b>
          {/* The loaded buttons themselves, disabled, with a bone where each number goes: the same words and the same box, on the
              row that never wraps, so the line is the height it will be once the counts arrive. */}
          <span className="attn-counts">
            {(["need you", "failed", "unexplained"] as const).map((label) => (
              <button key={label} type="button" className="attn-count attn-count-load" tabIndex={-1} disabled aria-hidden>
                <Bone w={7} h={11} /> {label}
              </button>
            ))}
          </span>
        </div>
      </section>
    );
  const n: Record<Which, number> = { needs: d.counts.needs_you, failed: d.counts.failed, idle: d.counts.unexplained_idle };
  const rows = lane ? d.items.filter(IN[lane]) : [];
  /** After an answer: the next row's first control, else the heading, so the keyboard never lands on a removed row. */
  const moveOn = (identifier: string) => {
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>(".attn-row, .ui-row") ?? [])];
    const next = els[els.findIndex((e) => e.dataset.task === identifier) + 1];
    const target = next?.matches(".ui-row") ? next : next?.querySelector<HTMLElement>("button, input");
    (target ?? headRef.current)?.focus();
  };
  // Kept mounted and only hidden when closed: collapsing must not unmount the answer forms, which hold the owner's drafted
  // reply and picks in their own state. `hidden` also takes the closed list out of the reading order.
  const list = (
    <div className="attn-list" ref={listRef} hidden={!chosen}>
      <ListRows>
        {rows.map((i) => {
          const ask = needsOwner(i.state) ? i.ask : undefined;
          if (!ask) return <ListRow key={i.identifier} href={`#/t/${i.identifier}`} status={<TaskState state={i.state} />} title={i.title} id={i.identifier} note={toYou(i) || undefined} time={ago(i.state.since)} timeTitle={new Date(i.state.since).toLocaleString()} />;
          return (
            <div key={i.identifier} className="attn-row" data-task={i.identifier}>
              <b className="attn-q">{ask.question || i.title}</b>
              <div className="attn-meta">
                <span>{i.agent}</span>
                <a href={`#/t/${i.identifier}`}>{i.identifier}</a>
                <time title={new Date(ask.waitSince).toLocaleString()}>{ago(ask.waitSince)}</time>
              </div>
              <AnswerForm
                key={`${ask.waitSince}:${ask.questions.length}`}
                questions={ask.questions}
                askedAbove
                onAnswer={(text) => api.answer(i.identifier, text, ask.waitSince).then(() => (void q.reload(), moveOn(i.identifier)))}
              />
            </div>
          );
        })}
      </ListRows>
    </div>
  );
  const words: Record<Which, string> = { needs: `${n.needs} need you`, failed: `${n.failed} failed`, idle: `${n.idle} unexplained` };
  return (
    <section className="attn attn-compact" aria-label="What needs attention">
      <div className="attn-head">
        <b className="attn-title" tabIndex={-1} ref={headRef}>Fleet attention</b>
        <span className="attn-counts">
          {(["needs", "failed", "idle"] as const).map((w) => (
            <button
              key={w}
              type="button"
              className={`attn-count attn-${w}${n[w] ? " on" : ""}`}
              aria-expanded={chosen === w}
              onClick={() => {
                setLane(w);
                setChosen(chosen === w ? null : w);
              }}
            >
              {words[w]}
            </button>
          ))}
        </span>
        {chosen && rows.length > 0 && <span className="attn-order">oldest first</span>}
      </div>
      {lane && rows.length > 0 && list}
      {chosen && rows.length === 0 && <p className="attn-none">{EMPTY[chosen]}</p>}
    </section>
  );
}
