// The fleet header on Tasks: how many tasks need you, failed, or sit idle with nothing to wake them (the kernel's counts), and
// the tasks themselves, oldest first. Every row shows the kernel's task state and nothing the board worked out.
import { useRef, useState } from "react";
import { AnswerForm } from "./AnswerForm";
import { api } from "./api";
import { useLive } from "./events";
import { QUERIES, useQuery } from "./queries";
import { ago } from "./util";
import { ListRow, ListRows, Segmented } from "./ui";
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
 * `compact` (Agent work, whose lanes already show these tasks): one line of counts, each opening its list in place; the
 * list starts closed. Otherwise (My day) the counts and the list, open on Needs you: a row with an open question answers it in place.
 */
export function AttentionStrip({ onSignIn, compact }: { onSignIn: () => void; compact?: boolean }) {
  const q = useQuery(QUERIES.needsYou, onSignIn);
  useLive(["approvals", "chat", "tasks"], q.reload, 30_000);
  const [chosen, setChosen] = useState<Which | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const d = q.data;
  // The strip's own frame, at the height the loaded strip takes: the counts, then the open list's area, so a cold load
  // lands it in one place instead of pushing the board's columns down by its whole height (the Tasks page's layout shift).
  if (!d)
    return (
      <section className={compact ? "attn attn-compact" : "attn"} role="status" aria-busy="true" aria-label="Loading fleet attention">
        <div className="attn-head">
          <b className="attn-title">Fleet attention</b>
          {/* The loaded counts' segmented control, with a count-shaped placeholder in each of its three parts: the row keeps
              its width and its wrap points, so the heading is the same height before and after the counts arrive. */}
          <span className="ui-seg attn-counts-load" aria-hidden>
            {(["Needs you · ", "Failed · ", "Unexplained idle · "] as const).map((label) => (
              <span key={label} className="attn-count-load">
                {label}
                <Bone w={7} h={11} />
              </span>
            ))}
          </span>
          {!compact && <Bone className="attn-order-load" w={54} h="1.45em" />}
        </div>
        {!compact && (
          <div className="attn-list attn-list-load" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="attn-row-load">
                <Bone w="46%" h={13} />
                <Bone w="28%" h={10} />
                <Bone w="100%" h={30} />
              </div>
            ))}
          </div>
        )}
      </section>
    );
  const n: Record<Which, number> = { needs: d.counts.needs_you, failed: d.counts.failed, idle: d.counts.unexplained_idle };
  const which = chosen ?? (compact ? (n.needs ? "needs" : n.failed ? "failed" : n.idle ? "idle" : "needs") : "needs");
  const rows = d.items.filter(IN[which]);
  /** After an answer: the next row's first control, else the heading, so the keyboard never lands on a removed row. */
  const moveOn = (identifier: string) => {
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>(".attn-row, .ui-row") ?? [])];
    const next = els[els.findIndex((e) => e.dataset.task === identifier) + 1];
    const target = next?.matches(".ui-row") ? next : next?.querySelector<HTMLElement>("button, input");
    (target ?? headRef.current)?.focus();
  };
  const list = rows.length > 0 && (
    <div className={`attn-list${rows.some((i) => i.ask) ? " asks" : ""}`} ref={listRef}>
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
  if (compact) {
    const words: Record<Which, string> = { needs: `${n.needs} need you`, failed: `${n.failed} failed`, idle: `${n.idle} unexplained` };
    return (
      <section className="attn attn-compact" aria-label="What needs attention">
        <div className="attn-head">
          <b className="attn-title" tabIndex={-1} ref={headRef}>Fleet attention</b>
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
        <b className="attn-title" tabIndex={-1} ref={headRef}>Fleet attention</b>
        <Segmented
          label="Needs attention"
          value={which}
          onChange={setChosen}
          options={[["needs", `Needs you · ${n.needs}`], ["failed", `Failed · ${n.failed}`], ["idle", `Unexplained idle · ${n.idle}`]] as const}
        />
        <span className="attn-order">oldest first</span>
      </div>
      {list || <p className="attn-none">{EMPTY[which]}</p>}
    </section>
  );
}
