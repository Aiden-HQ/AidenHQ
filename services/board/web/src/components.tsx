import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ConnectButton } from "./Connect";
import { api } from "./api";
import { BUCKETS, BUCKET_NAMES, type Assignee, type Board, type Bucket, type Card, type CrewMember, type CrewState, type PlanItem, type SignInStatus, type Working } from "./types";
import { Face, faceProps, type FaceState } from "./ui";
import { TaskState } from "./ui/TaskState";
import { SOURCE_NAMES, addDays, agentShort, ago, dayDate, elapsed, matches, shortDate, shortName, snoozeOptions, todayIn, untilLabel } from "./util";

/** A crew member's face (ui/Face: its kit or shipped image, by its seed), or a letter for you. */
export function Avatar({ assignee, size = 18, state }: { assignee: Assignee | undefined; size?: number; state?: FaceState }) {
  if (!assignee) return null;
  if (assignee.kind !== "me") return <Face seed={assignee.seed} {...faceProps(assignee.face)} state={state} size={size} label={assignee.name} />;
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.5) } : undefined;
  return (
    <span className="avatar avatar-me" title={assignee.name} style={style}>
      Y
    </span>
  );
}

const STATE_WORDS: Record<CrewState, string> = { needs: "needs you", failed: "got stuck", working: "working", queued: "queued", waiting: "waiting", done: "done" };

/** An agent's face seed and face, found in the crew by its Paperclip id, then its name; one not found (a deleted agent) is seeded by its name. */
export const faceOf = (crew: Assignee[], keyOrName: string) => {
  const a = crew.find((c) => c.key === keyOrName) ?? crew.find((c) => c.name === keyOrName);
  return { seed: a?.seed ?? keyOrName, face: a?.face };
};

/** An agent's face (ui/Face), looked up in the crew by its Paperclip id or name. */
export function AgentFace({ crew, agent, name, size = 28 }: { crew: Assignee[]; agent: string; name: string; size?: number }) {
  const f = faceOf(crew, agent);
  return <Face seed={f.seed} {...faceProps(f.face)} size={size} label={name} />;
}

const FACE_STATE: Record<CrewState, FaceState> = { needs: "needs", failed: "idle", working: "working", queued: "working", waiting: "idle", done: "idle" };

/** A crew member's face with a ring for where they stand. */
export function CrewAvatar({ member, assignee, size }: { member: Pick<CrewMember, "state" | "since">; assignee: Assignee | undefined; size?: number }) {
  return (
    <span className={`crew-av st-${member.state}`} title={`${shortName(assignee)}: ${STATE_WORDS[member.state]}${member.state === "working" && member.since ? ` · ${elapsed(member.since)}` : ""}`}>
      <Avatar assignee={assignee} size={size ?? 22} state={FACE_STATE[member.state]} />
      <span className="pip" />
    </span>
  );
}

/** The issue to open for a crew member: the one that wants the user, else the first. */
export const memberIssue = (m: CrewMember) => (m.issues.find((i) => i.state === m.state) ?? m.issues[0])!.identifier;

/** The line under a card's title: the most urgent crew member, in words. */
export function crewLine(crew: CrewMember[], assignees: Assignee[]): { text: string; tone: CrewState } | undefined {
  const order: CrewState[] = ["needs", "failed", "working", "queued"];
  for (const state of order) {
    const m = crew.find((x) => x.state === state);
    if (!m) continue;
    const name = shortName(assignees.find((a) => a.key === m.agent));
    const fan = m.issues.length > 1 ? ` · ${m.finished ?? 0}/${m.issues.length}` : "";
    const text = { needs: `${name} needs you`, failed: `${name} got stuck`, working: `${name} is working${m.since ? ` · ${elapsed(m.since)}` : ""}`, queued: `${name} is queued`, waiting: "", done: "" }[state];
    return { text: text + fan, tone: state };
  }
  return undefined;
}

function CrewRow({ card, crew, assignees }: { card: Card; crew: CrewMember[]; assignees: Assignee[] }) {
  const line = crewLine(crew, assignees);
  return (
    <div className="card-crew">
      <span className="crew-stack">
        {crew.map((m) => (
          <a
            key={m.agent}
            href={`#/t/${card.identifier}/${memberIssue(m)}`}
            className="crew-link"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Open ${shortName(assignees.find((a) => a.key === m.agent))}'s work`}
          >
            <CrewAvatar member={m} assignee={assignees.find((a) => a.key === m.agent)} />
            {m.issues.length > 1 && <span className="fan">{m.finished ?? 0}/{m.issues.length}</span>}
          </a>
        ))}
      </span>
      {line && <span className={`crew-line tone-${line.tone}`}>{line.text}</span>}
    </div>
  );
}

/** A running agent's own task list: done, the one it's on, and what's next. */
export function Plan({ items }: { items: PlanItem[] }) {
  const done = items.filter((i) => i.state === "done").length;
  return (
    <ol className="plan" aria-label={`Task list, ${done} of ${items.length} done`}>
      {items.map((i, n) => (
        <li key={n} className={`plan-${i.state}`}>
          {i.text}
        </li>
      ))}
    </ol>
  );
}

/** An agent working on the task right now (pulsing), or the runner holding it in its queue. */
export function WorkingBadge({ working }: { working: Working }) {
  const who = agentShort(working.agent);
  const title = working.queued ? `${working.agent}: queued, waiting for a free slot` : `${working.agent} is working on this${working.since ? ` (started ${new Date(working.since).toLocaleTimeString()})` : ""}`;
  return (
    <span className={`badge ${working.queued ? "badge-queued" : "badge-live"}`} title={title}>
      {working.queued ? `${who} queued` : `${who}${working.since ? ` · ${elapsed(working.since)}` : ""}`}
    </span>
  );
}

/** A card's chips: who is working on it now, the kernel's state (the dot and word; `full` adds what it waits for), and where it came from. */
export function Chips({ card, full }: { card: Pick<Card, "state" | "labels"> & { working?: Working | null }; full?: boolean }) {
  return (
    <>
      {card.working && <WorkingBadge working={card.working} />}
      {!(card.working && card.state?.kind === "working") && <TaskState state={card.state} bare={!full} />}
      {card.labels
        .filter((l) => l.name !== "daily-brief")
        .map((l) => (
          <span key={l.name} className="tag" data-color={l.color}>
            <i style={{ background: l.color }} />
            {SOURCE_NAMES[l.name] ?? l.name}
          </span>
        ))}
    </>
  );
}

interface CardProps {
  card: Card;
  assignees: Assignee[];
  selected?: boolean;
  overlay?: boolean;
  closed?: boolean;
  onOpen: (card: Card) => void;
  onDone?: (card: Card) => void;
  onMove?: (card: Card, bucket: Bucket) => void;
  /** Snooze until a date, parked by it (Tomorrow, Later or Backlog); needs the board's timezone for the presets. */
  onSnooze?: (card: Card, date: string) => void;
  /** Merge into another of your tasks, picked from `targets`. */
  onMerge?: (card: Card, into: Card) => void;
  targets?: Card[];
  timezone?: string;
  current?: Bucket;
}

export function CardView({ card, assignees, selected, overlay, closed, onOpen, onDone, onMove, onSnooze, onMerge, targets, timezone, current }: CardProps) {
  const assignee = assignees.find((a) => a.key === card.assignee);
  const executor = card.executor && [card.executor.model, card.executor.effort].filter(Boolean).join(" · ");
  return (
    <div
      className={`card prio-${card.priority}${selected ? " selected" : ""}${overlay ? " overlay" : ""}${card.unread ? " unread" : ""}${closed ? ` closed closed-${card.status}` : ""}`}
      data-card={card.id}
      onClick={() => onOpen(card)}
    >
      <div className="card-title">{card.title}</div>
      {card.crew && <CrewRow card={card} crew={card.crew} assignees={assignees} />}
      <div className="card-foot">
        <div className="card-meta">
          <span className="ident">{card.identifier}</span>
          {card.by && <span className="by">by {card.by}</span>}
          <Chips card={card.crew ? { ...card, working: undefined } : card} />
          {card.scheduled && (
            <span className="tag when" title={`Moves to the top of ${BUCKET_NAMES[card.scheduled.bucket]} on ${card.scheduled.date}`}>
              {/* A move to Today is a snooze. */}
              {card.scheduled.bucket === "today" && timezone ? `⏰ until ${untilLabel(todayIn(timezone), card.scheduled.date)}` : `↑ ${BUCKET_NAMES[card.scheduled.bucket]} ${shortDate(card.scheduled.date)}`}
            </span>
          )}
          {card.carried ? (
            <span className="tag carried" title={`Left unfinished in Today for ${card.carried} workday${card.carried === 1 ? "" : "s"}`}>
              Carried {card.carried}d
            </span>
          ) : null}
          {card.recurring && (
            <span className="tag when" title={card.recurring.summary}>
              ↻ {card.recurring.paused ? "Paused" : card.recurring.nextRun ? `Next ${shortDate(card.recurring.nextRun)}` : card.recurring.summary}
            </span>
          )}
          <span className="spacer" />
          {executor && <span className="exec" title="Model override">{executor}</span>}
          <span className="time" title={new Date(card.activityAt).toLocaleString()}>
            {ago(card.activityAt)}
          </span>
          {assignee?.kind !== "me" && !card.crew && <Avatar assignee={assignee} />}
        </div>
        {/* On a phone the actions sit at the end of the meta row; elsewhere they float over the card on hover. */}
        {!overlay && !closed && (onDone || onMove) && (
          <div className="card-actions" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            {onSnooze && timezone && !card.recurring && <SnoozeMenu timezone={timezone} onPick={(d) => onSnooze(card, d)} />}
            {onMove && <MoveMenu current={current} onPick={(b) => onMove(card, b)} />}
            {onMerge && targets && card.assignee === "me" && !card.recurring && <MergeMenu card={card} targets={targets} onPick={(into) => onMerge(card, into)} />}
            {onDone && (
              <button className="icon-btn" title="Done (e)" aria-label="Mark done" onClick={() => onDone(card)}>
                <CheckIcon />
              </button>
            )}
          </div>
        )}
      </div>
      {card.unread && <span className="dot" title="New activity" />}
    </div>
  );
}

export function SortableCard(props: CardProps & { disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.card.id, disabled: props.disabled });
  return (
    <div
      ref={setNodeRef}
      className={`sortable${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      tabIndex={-1}
    >
      <CardView {...props} />
    </div>
  );
}

/**
 * A menu opened from a button. It's drawn on the page itself, over everything (the drawer too), below
 * the button or above it when there's no room, and always inside the window: drawn inside a card, the
 * column's scroll box used to cut it off. Clicks inside still reach the button's own handlers (a portal
 * keeps React's event tree), so a card doesn't open when you pick something.
 */
function Popover({ anchor, onClose, className, children }: { anchor: HTMLElement | null; onClose: () => void; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      if (!a.width && !a.height) return; // the button is hidden for a moment: stay put
      const { width, height } = el.getBoundingClientRect();
      const m = 8;
      const left = Math.max(m, Math.min(a.right - width, innerWidth - width - m));
      const below = a.bottom + 4;
      const above = a.top - 4 - height;
      const top = below + height <= innerHeight - m ? below : above >= m ? above : Math.max(m, innerHeight - height - m);
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    const sizes = new ResizeObserver(place);
    sizes.observe(el);
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => {
      sizes.disconnect();
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
    };
  }, [anchor]);
  useEffect(() => {
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node) && close.current();
    // Escape closes the menu only, not the task behind it.
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), close.current());
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc, true);
    };
  }, [anchor]);
  return createPortal(
    <div ref={ref} className={`menu popover${className ? ` ${className}` : ""}`} role="menu" style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}

export function MoveMenu({ current, onPick, label }: { current?: Bucket; onPick: (b: Bucket) => void; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div className={`menu-wrap${open ? " open" : ""}`}>
      <button ref={ref} className={label ? "btn" : "icon-btn"} title="Move to…" aria-label="Move to" onClick={() => setOpen(!open)}>
        {label ?? <MoveIcon />}
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)}>
          {BUCKETS.map((b, i) => (
            <button
              key={b}
              role="menuitem"
              className={b === current ? "current" : ""}
              onClick={() => {
                setOpen(false);
                onPick(b);
              }}
            >
              <span>{BUCKET_NAMES[b]}</span>
              <kbd>{i + 1}</kbd>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

/** Snooze: park the task by its date (Tomorrow, Later or Backlog) and bring it back on top of Today on a date. */
export function SnoozeMenu({ timezone, onPick, label }: { timezone: string; onPick: (date: string) => void; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [date, setDate] = useState("");
  const ref = useRef<HTMLButtonElement>(null);
  const today = todayIn(timezone);
  const pick = (d: string) => {
    setOpen(false);
    onPick(d);
  };
  return (
    <div className={`menu-wrap${open ? " open" : ""}`}>
      <button
        ref={ref}
        className={label ? "btn" : "icon-btn"}
        title="Snooze: back on top of Today on…"
        aria-label="Snooze"
        onClick={() => (setOpen(!open), setPicking(false), setDate(""))}
      >
        {label ?? <ClockIcon />}
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)}>
          <div className="menu-head">Back on top of Today</div>
          {snoozeOptions(today).map((o) => (
            <button key={o.label} role="menuitem" onClick={() => pick(o.date)}>
              <span>{o.label}</span>
              <span className="menu-hint">{dayDate(o.date)}</span>
            </button>
          ))}
          {picking ? (
            <form className="menu-date" onSubmit={(e) => (e.preventDefault(), date && pick(date))}>
              <input type="date" autoFocus min={addDays(today, 1)} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
              <button type="submit" className="btn" disabled={!date}>
                Snooze
              </button>
            </form>
          ) : (
            <button role="menuitem" onClick={() => setPicking(true)}>
              <span>Pick a date…</span>
            </button>
          )}
        </Popover>
      )}
    </div>
  );
}

/**
 * Merge this task into another of yours, without opening it: type to find the other task, pick it,
 * then confirm (merging cancels this one). The board does the merge in code.
 */
export function MergeMenu({ card, targets, onPick, label }: { card: Pick<Card, "id" | "identifier">; targets: Card[]; onPick: (into: Card) => void; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Card | null>(null);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLButtonElement>(null);
  const found = open ? targets.filter((c) => c.id !== card.id && matches(c, query)).slice(0, 8) : [];
  const toggle = () => (setOpen(!open), setQuery(""), setChosen(null), setHi(0));
  const merge = (into: Card) => {
    setOpen(false);
    onPick(into);
  };
  return (
    <div className={`menu-wrap${open ? " open" : ""}`}>
      <button ref={ref} className={label ? "btn" : "icon-btn"} title="Merge into another task (m)" aria-label="Merge into" onClick={toggle}>
        {label ?? <MergeIcon />}
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} className="merge-menu">
          {chosen ? (
            <div className="merge-confirm">
              <p>
                Merge <b>{card.identifier}</b> into <b>{chosen.identifier}</b>?
              </p>
              <p className="muted small">Its description and files join {chosen.identifier}, and {card.identifier} is cancelled.</p>
              <div className="row-end">
                <button className="btn" onClick={() => setChosen(null)}>
                  Back
                </button>
                <button className="btn primary" autoFocus onClick={() => merge(chosen)}>
                  Merge
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="menu-head">Merge {card.identifier} into…</div>
              <input
                className="menu-search"
                autoFocus
                placeholder="Search your tasks"
                value={query}
                onChange={(e) => (setQuery(e.target.value), setHi(0))}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") e.preventDefault(), setHi((h) => Math.max(0, Math.min(found.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
                  if (e.key === "Enter" && found[hi]) e.preventDefault(), setChosen(found[hi]!);
                }}
                aria-label="Task to merge into"
              />
              <div className="merge-list">
                {found.map((c, i) => (
                  <button key={c.id} role="menuitem" className={i === hi ? "hi" : ""} onMouseEnter={() => setHi(i)} onClick={() => setChosen(c)}>
                    <span className="merge-title">{c.title}</span>
                    <span className="ident">{c.identifier}</span>
                  </button>
                ))}
                {!found.length && <p className="menu-head">No other tasks of yours match.</p>}
              </div>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}

export const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const MoveIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M3 8h9M9 4.5L12.5 8 9 11.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const ClockIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 5v3.2l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const MergeIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M4 2.5v2c0 2.5 4 3.2 4 6v3M12 2.5v2c0 2.5-4 3.2-4 6M5.8 11.4L8 13.6l2.2-2.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const CloseIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const PlusIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const GearIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
    <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8L3.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="8" cy="8" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/**
 * Google accounts whose sign-in Google refused: what's paused, and a way back (Google not connected at all is no alert: it is
 * an optional connection, offered in Settings > Connections like the others). Reconnect works from any address
 * (the address is pasted back).
 */
export function GoogleBanner({ google }: { google: Board["google"] }) {
  if (!google) return null;
  const expired = google.accounts.filter((a) => a.state === "expired");
  if (!expired.length) return null;
  return (
    <div className="alert" role="alert">
      {expired.map((a) => (
        <div key={a.email} className="alert-row">
          <span>
            Google sign-in for <b>{a.email}</b> stopped working on {new Date(a.since).toLocaleDateString(undefined, { weekday: "long" })} at{" "}
            {new Date(a.since).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}.{" "}
            {a.primary ? "Meeting notes, calendar, email and Drive from it are paused." : "Email and Drive from it are paused."}
          </span>
          <a className="btn" href={`/google/connect?account=${encodeURIComponent(a.email)}`}>
            Reconnect
          </a>
        </div>
      ))}
    </div>
  );
}

/**
 * A banner when a service behind an MCP proxy (a module's board.signins) stopped accepting the sign-in, with Reconnect where it works (the board's https address, or loopback).
 */
function SignInBanner({ name, path, status, offer, mode, canConnect, stopped }: { name: string; path: string; status: SignInStatus | null; offer?: boolean; mode?: "device"; canConnect: boolean; stopped: string }) {
  // Only a sign-in that worked and stopped alarms; one never connected is calm, in Settings > Connections.
  if (!status?.configured || status.state !== "expired") return null;
  const since = new Date(status.since);
  return (
    <div className="alert" role="alert">
      <div className="alert-row">
        <span>
          {name} sign-in stopped working on {since.toLocaleDateString(undefined, { weekday: "long" })} at{" "}
          {since.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}. {stopped}
        </span>
        {canConnect && <ConnectButton c={{ id: path, label: name, signIn: { state: status.state, offer, mode } }} />}
      </div>
    </div>
  );
}

export function SignInBanners({ board, canConnect }: { board: Board; canConnect: boolean }) {
  return (
    <>
      {(board.signIns ?? []).map((s) => (
        <SignInBanner key={s.id} name={s.label} path={s.id} status={s.status} offer={s.offer} mode={s.mode} canConnect={canConnect} stopped={s.stopped} />
      ))}
    </>
  );
}

/** A small "Powered by AidenHQ" credit with a link to the project, shown by default. */
export const AIDENHQ_REPO = "https://github.com/Aiden-HQ/AidenHQ";
export function PoweredBy() {
  return (
    <p className="powered-by">
      <a href={AIDENHQ_REPO} target="_blank" rel="noopener noreferrer">
        Powered by AidenHQ
      </a>
    </p>
  );
}
