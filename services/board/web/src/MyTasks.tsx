// Tasks › My tasks: what the owner himself acts on, in one dense list (Today, Tomorrow, This week, Backlog) with an Inbox and a
// Delegated summary in a rail beside it. Tasks assigned to an agent are not here (Delegated has them); an agent that waits on
// the owner shows once in the amber strip and in the Inbox, and opens its task. Check a task off in place; Move, Snooze and
// Merge sit on each row's hover menu (the board's kit, components.tsx). Drag between buckets is the move menu and the keys 1-5.
import { useEffect, useState } from "react";
import { MergeMenu, MoveMenu, SnoozeMenu } from "./components";
import { GROUPS, QUICK_MOVES, chipOf, delegatedOf, hintOf, needsSummary, visibleOf, type Buckets } from "./own-tasks";
import { BUCKET_NAMES, type Board, type Bucket, type Card, type NeedRow } from "./types";
import { Dialog, Face, Kbd, faceProps } from "./ui";
import { SOURCE_NAMES, ago, agoLabel, todayIn, untilLabel, stampOpts } from "./util";
import "./my-tasks.css";

const INBOX_OWN = 5;
const INBOX_TEAM = 3;

const whenOf = (c: Card, timezone: string) =>
  c.carried ? `Carried ${c.carried}d` : c.scheduled ? (c.scheduled.bucket === "today" ? `until ${untilLabel(todayIn(timezone), c.scheduled.date)}` : `${BUCKET_NAMES[c.scheduled.bucket]} ${untilLabel(todayIn(timezone), c.scheduled.date)}`) : ago(c.activityAt);
const sourceOf = (c: Card) => {
  const l = c.labels.find((x) => x.name !== "daily-brief")?.name;
  return l ? SOURCE_NAMES[l] ?? l : "Task";
};
const taskLink = (r: NeedRow) => (r.kind !== "approval" && r.task ? `#/t/${r.task.identifier}` : `#/approvals/${r.id}`);

export interface MyTasksProps {
  board: Board;
  /** The owner's own tasks by bucket, after the search. */
  mine: Buckets;
  /** A search or filter is on: no caps, every match shows. */
  narrowed: boolean;
  /** Backlog's "Show all N" was pressed. */
  allBacklog: boolean;
  onAllBacklog: () => void;
  selected: string | null;
  /** What teammates wait on the owner for (Home's Needs you rows). */
  needs: NeedRow[];
  delegated: ReturnType<typeof delegatedOf>;
  mergeTargets: Card[];
  drafts: Record<Bucket, string>;
  onDraft: (b: Bucket, title: string) => void;
  onAdd: (title: string, b: Bucket) => Promise<void>;
  onOpen: (c: Card) => void;
  onDone: (c: Card) => void;
  onMove: (c: Card, b: Bucket) => void;
  onSnooze: (c: Card, date: string) => void;
  onMerge: (c: Card, into: Card) => void;
  onCarried?: (action: "keep" | "tomorrow" | "later") => void;
  onTriage: () => void;
  onDelegated: () => void;
}

export function MyTasks(p: MyTasksProps) {
  const { board, mine, needs } = p;
  const [adding, setAdding] = useState<Bucket | null>(null);
  const inbox = mine.triage;
  const visible = visibleOf(mine, p.narrowed, p.allBacklog);
  return (
    <main className="mt">
      {needs.length > 0 && (
        <div className="mt-needs" role="status">
          <i className="mt-dot" />
          <span>
            <b>{needs.length === 1 ? "1 thing from your team needs you" : `${needs.length} things from your team need you`}</b>
            {needsSummary(needs) && <> · {needsSummary(needs)}</>}
          </span>
          <a href="#/">Open on Home →</a>
        </div>
      )}
      <div className="mt-split">
        <section className="mt-list mt-card" aria-label="My tasks">
          {GROUPS.map((b) => {
            const cards = mine[b];
            const shown = visible[b];
            const capped = shown.length < cards.length;
            const carried = b === "today" && !p.narrowed ? cards.filter((c) => c.carried).length : 0;
            return (
              <div key={b} className={`mt-group mt-${b}`}>
                <header className="mt-gh">
                  <i className="mt-dot" />
                  <h2>{BUCKET_NAMES[b]}</h2>
                  <span className="mt-count">{cards.length}</span>
                  <span className="mt-sub">{hintOf(b, board)}</span>
                  <button type="button" className="mt-plus icon-btn subtle" title={`Add to ${BUCKET_NAMES[b]}`} aria-label={`Add to ${BUCKET_NAMES[b]}`} onClick={() => setAdding(adding === b ? null : b)}>
                    +
                  </button>
                </header>
                {adding === b && (
                  <form
                    className="mt-add"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const t = p.drafts[b].trim();
                      if (!t) return;
                      p.onDraft(b, "");
                      void p.onAdd(t, b);
                    }}
                  >
                    <input autoFocus value={p.drafts[b]} placeholder={`Add to ${BUCKET_NAMES[b]}…`} onChange={(e) => p.onDraft(b, e.target.value)} onKeyDown={(e) => e.key === "Escape" && (p.onDraft(b, ""), setAdding(null))} />
                  </form>
                )}
                {carried > 0 && p.onCarried && (
                  <div className="carried-bar" title="Left unfinished from earlier days: keep them for today, or move them on">
                    <span className="carried-text">
                      <b>{carried}</b> carried over
                    </span>
                    <span className="carried-actions">
                      <button className="btn" title="Keep them for today" onClick={() => p.onCarried?.("keep")}>Keep</button>
                      <button className="btn" title="Move them to Tomorrow" onClick={() => p.onCarried?.("tomorrow")}>→ Tomorrow</button>
                      <button className="btn" title="Move them to This week" onClick={() => p.onCarried?.("later")}>→ This week</button>
                    </span>
                  </div>
                )}
                {shown.map((c) => (
                  <TaskRow key={c.id} card={c} board={board} bucket={b} selected={c.id === p.selected} mergeTargets={p.mergeTargets} onOpen={p.onOpen} onDone={p.onDone} onMove={p.onMove} onSnooze={p.onSnooze} onMerge={p.onMerge} />
                ))}
                {!cards.length && <p className="mt-empty">{p.narrowed ? "No matches." : "Nothing here."}</p>}
                {capped && (
                  <button type="button" className="mt-more" onClick={p.onAllBacklog}>
                    Show all {cards.length} →
                  </button>
                )}
              </div>
            );
          })}
        </section>
        <aside className="mt-rail">
          <section className="mt-card mt-inbox" aria-label="Inbox">
            <header className="mt-hd">
              <i className="mt-dot mt-dot-triage" />
              <h2>Inbox</h2>
              <span className="mt-count">{inbox.length}</span>
              <span className="mt-sub">to triage</span>
              <Kbd>T</Kbd>
            </header>
            {needs.slice(0, INBOX_TEAM).map((r) => (
              <a key={r.id} className="mt-tri mt-team" href={taskLink(r)}>
                <span className="mt-ttl">{r.question}</span>
                <span className="mt-src">
                  <Face seed={r.teammate.key} {...faceProps(r.teammate.face)} state="needs" size={20} label={r.teammate.name} />
                  <span>{r.teammate.name} · waiting on you · {ago(r.since)}</span>
                </span>
              </a>
            ))}
            {inbox.slice(0, INBOX_OWN).map((c) => (
              <div key={c.id} className="mt-tri" data-card={c.id}>
                <button type="button" className="mt-ttl" onClick={() => p.onOpen(c)}>{c.title}</button>
                <span className="mt-src">
                  <span>{sourceOf(c)} · {ago(c.createdAt)}</span>
                  <span className="mt-mv">
                    {QUICK_MOVES.map(([b, name]) => (
                      <button key={b} type="button" title={`Move to ${BUCKET_NAMES[b]}`} onClick={() => p.onMove(c, b)}>
                        {name}
                      </button>
                    ))}
                  </span>
                </span>
              </div>
            ))}
            {!inbox.length && !needs.length && <p className="mt-empty">{p.narrowed ? "No matches." : "All sorted."}</p>}
            {inbox.length > INBOX_OWN && <p className="mt-rest">{inbox.length - INBOX_OWN} more in the inbox</p>}
            {inbox.length > 0 && (
              <div className="mt-ft">
                <button type="button" className="btn primary" onClick={p.onTriage}>
                  Triage all {inbox.length} <Kbd>T</Kbd>
                </button>
              </div>
            )}
          </section>
          <section className="mt-card mt-deleg" aria-label="Delegated">
            <header className="mt-hd">
              <h2>Delegated</h2>
              <span className="mt-sub">your team is on it</span>
              <button type="button" className="link-btn mt-open" onClick={p.onDelegated}>Open →</button>
            </header>
            <div className="mt-stat"><i className="mt-dot mt-dot-working" /><span>Running</span><b>{p.delegated.running}</b></div>
            <div className="mt-stat"><i className="mt-dot mt-dot-warn" /><span>Waiting on you <small>(on Home)</small></span><b>{needs.length}</b></div>
            <div className="mt-stat"><i className="mt-dot mt-dot-faint" /><span>Queued</span><b>{p.delegated.queued}</b></div>
          </section>
        </aside>
      </div>
    </main>
  );
}

/** Checking a task off in place: the row strikes through for a beat, then `onDone` runs (and the row leaves). Home's Your day uses it too. */
export function useCheckOff(card: Card, onDone: (c: Card) => void) {
  const [done, setDone] = useState(false);
  // The update runs even if the row has unmounted by then (a tab switch, a search): only the strike-through is the row's.
  const check = () => {
    setDone(true);
    setTimeout(() => onDone(card), 320);
  };
  return { done, check };
}

export const TaskCheck = ({ card, done, onCheck }: { card: Card; done: boolean; onCheck: () => void }) => (
  <button type="button" role="checkbox" aria-checked={done} aria-label={`Mark ${card.identifier} done`} className="mt-chk" onClick={onCheck} />
);

/** One task: check it off in place (the row strikes through, then leaves), open it, and its Snooze / Move / Merge on hover. */
function TaskRow({ card, board, bucket, selected, mergeTargets, onOpen, onDone, onMove, onSnooze, onMerge }: { card: Card; board: Board; bucket: Bucket; selected: boolean; mergeTargets: Card[]; onOpen: (c: Card) => void; onDone: (c: Card) => void; onMove: (c: Card, b: Bucket) => void; onSnooze: (c: Card, date: string) => void; onMerge: (c: Card, into: Card) => void }) {
  const { done, check } = useCheckOff(card, onDone);
  const chip = chipOf(card, board.projects);
  return (
    <div className={`mt-row prio-${card.priority}${selected ? " selected" : ""}${done ? " done" : ""}`} data-card={card.id} role="group" aria-label={card.title}>
      <TaskCheck card={card} done={done} onCheck={check} />
      <button type="button" className="mt-ttl" title={card.title} onClick={() => onOpen(card)}>
        {card.unread && <i className="mt-unread" title="New activity" />}
        <span>{card.title}</span>
      </button>
      {chip && <span className="mt-chip">{chip}</span>}
      <span className={`mt-when${card.carried ? " carried" : ""}`} title={`Last activity ${new Date(card.activityAt).toLocaleString(undefined, stampOpts())}`}>{whenOf(card, board.timezone)}</span>
      {!done && (
        <span className="mt-acts">
          {!card.recurring && <SnoozeMenu timezone={board.timezone} onPick={(d) => onSnooze(card, d)} />}
          <MoveMenu current={bucket} onPick={(b) => onMove(card, b)} />
          {!card.recurring && <MergeMenu card={card} targets={mergeTargets} onPick={(into) => onMerge(card, into)} />}
        </span>
      )}
    </div>
  );
}

/**
 * Triage all: the owner's untriaged tasks one at a time, each moved on (1-4, or the buttons), skipped (S) or opened (O); the
 * next appears at once. The list is the Inbox as it was when this opened, so a move never reshuffles what is still ahead.
 */
export function TriageDialog({ cards, onMove, onOpen, onClose }: { cards: Card[]; onMove: (c: Card, b: Bucket) => void; onOpen: (c: Card) => void; onClose: () => void }) {
  const [queue] = useState(cards);
  const [at, setAt] = useState(0);
  const card = queue[at];
  const next = () => (at + 1 >= queue.length ? onClose() : setAt(at + 1));
  const move = (b: Bucket) => card && (onMove(card, b), next());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input,textarea")) return;
      const n = Number(e.key);
      if (n >= 1 && n <= QUICK_MOVES.length) return e.preventDefault(), move(QUICK_MOVES[n - 1]![0]);
      if (e.key === "s") return e.preventDefault(), next();
      if ((e.key === "o" || (e.key === "Enter" && !(e.target as HTMLElement).closest("button"))) && card) return e.preventDefault(), onClose(), onOpen(card);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!card) return null;
  return (
    <Dialog open onClose={onClose} title={`Triage · ${at + 1} of ${queue.length}`}>
      <div className="mt-triage">
        <p className="mt-triage-title">{card.title}</p>
        <p className="mt-triage-meta">{sourceOf(card)} · {agoLabel(card.createdAt)} · {card.identifier}</p>
        <div className="mt-triage-moves">
          {QUICK_MOVES.map(([b, name], i) => (
            <button key={b} type="button" className="btn" onClick={() => move(b)}>
              {name} <Kbd>{i + 1}</Kbd>
            </button>
          ))}
        </div>
        <div className="mt-triage-foot">
          <button type="button" className="btn quiet" onClick={() => (onClose(), onOpen(card))}>Open <Kbd>O</Kbd></button>
          <button type="button" className="btn quiet" onClick={next}>Skip <Kbd>S</Kbd></button>
        </div>
      </div>
    </Dialog>
  );
}
