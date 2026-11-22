// Tasks' Agent work layout: every task the fleet holds, one card each, in the lane the kernel gives it (state.lane), read-only.
// The board never works a lane out: a card sits where its row says, a task with no row is Idle ("No reported state"). Each
// card shows the one line its lane needs, linked to what it names (the question, the approval, the run, the blocker).
import { useMemo, useState } from "react";
import { LANES, LANE_NAMES, laneOf } from "./filters";
import { admin } from "./api";
import { Bone } from "./Skeleton";
import { Monogram } from "./ui";
import { hueClass } from "./ui/hue";
import { stateWords } from "./ui/TaskState";
import type { Assignee, Board, Lane, ShownState, WorkCard } from "./types";
import { ago, elapsed } from "./util";
import "./agent-work.css";

/** Cards a lane draws before "Show N more". */
const PAGE = 25;
const LANE_TITLE: Record<Lane, string> = { ...LANE_NAMES, done: "Done, last 48h" };
const STUCK: Record<string, string> = { stalled_wait: "Stalled", unpolled: "No dispatcher", orphaned: "Nothing will wake it", unknown: "Stuck", history_expired: "History expired" };

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const jobOf = (ref: string | undefined) => (ref?.startsWith("job:") ? ref.slice(4) : undefined);
const taskOf = (ref: string | undefined) => (ref?.startsWith("task:") ? ref.slice(5) : undefined);

/** Who holds a card: an agent's name, You, or Unassigned. */
export function holderName(c: WorkCard, crew: Assignee[]): string {
  if (c.assignee === null) return "Unassigned";
  if (c.assignee === "me") return "You";
  return crew.find((a) => a.key === c.assignee)?.name ?? (c.state?.holder_name ? `${c.state.holder_name} (removed)` : "Removed agent");
}

/** The amber or red callout: what the card waits on, linked to it. */
function Callout({ tone, head, body, href, external }: { tone: "needs" | "bad"; head: string; body?: string; href: string; /** The kernel's approval page: a page of its own. */ external?: boolean }) {
  return (
    <a className={`aw-callout ${tone}`} href={href} onClick={stop} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      <b>{head}</b>
      {body && <q>{body}</q>}
    </a>
  );
}

/** The one line a card's lane needs, read from its attention entries and refs (never only the primary reason). */
function LaneLine({ c, s }: { c: WorkCard; s: ShownState | null }) {
  const lane = laneOf(c);
  const self = `#/t/${c.identifier}`;
  const named = (ref: string) => s?.refs?.[ref];
  if (!s) return <Status tone="idle" text="No reported state" />;
  if (lane === "needs_you") {
    const a = s.attention.find((x) => x.who === "owner")!;
    if (a.why === "card") return <Callout tone="needs" head="Needs you" body={`Your approval: ${named(a.ref) ?? "a card waits"}`} href={`${admin.url}/approvals/${encodeURIComponent(a.ref.replace(/^record:/, ""))}`} external />;
    if (a.why === "handback") return <Callout tone="needs" head="Needs you" body="Handed back to you" href={self} />;
    return <Callout tone="needs" head="Needs you" body={s.question ?? "Your answer"} href={self} />;
  }
  if (lane === "working") return <Status tone="working" text={s.stage ?? "Working"} live />;
  if (lane === "blocked") {
    const failed = s.attention.find((x) => x.why === "failed");
    if (failed?.ref === "no_reply") return <Callout tone="bad" head="Failed" body="Run ended without a reply" href={self} />;
    if (failed) return <Callout tone="bad" head="Failed" body={named(failed.ref) ? cap(named(failed.ref)!) : "The run failed"} href={jobOf(failed.ref) ? `#/r/${jobOf(failed.ref)}` : self} />;
    if (s.blocker) {
      const ident = named(s.blocker);
      return <Callout tone="bad" head={`Blocked by ${ident ?? "another task"}`} body={s.note} href={`#/t/${ident ?? taskOf(s.blocker)}`} />;
    }
    const stuck = s.attention.find((x) => x.who === "agent" && STUCK[x.why]);
    return <Callout tone="bad" head={stuck ? STUCK[stuck.why]! : "Blocked"} body={cap(stateWords(s).detail)} href={self} />;
  }
  if (lane === "done") return <Status tone="done" text={s.reason === "cancelled" ? "Stopped" : s.grade ? `Done, graded ${s.grade}` : "Done"} />;
  return <Status tone={lane === "waiting" ? "wait" : "idle"} text={cap(stateWords(s).detail) || (lane === "waiting" ? "Waiting" : "Idle")} />;
}

function Status({ tone, text, live }: { tone: "working" | "wait" | "idle" | "done"; text: string; live?: boolean }) {
  return (
    <div className={`aw-status ${tone}`}>
      <i className={live ? "live" : undefined} aria-hidden />
      <span>{text}</span>
    </div>
  );
}

export function WorkCardView({ c, board }: { c: WorkCard; board: Board }) {
  const s = c.state;
  const lane = laneOf(c);
  const who = holderName(c, board.assignees);
  const project = c.projectId ? board.projects?.find((p) => p.id === c.projectId)?.name : undefined;
  const run = jobOf(s?.ref);
  const age = lane === "working" && s ? elapsed(s.since) : ago(c.closedAt ?? c.activityAt);
  // The title is the card's link; a click anywhere else on the card opens it too.
  const open = () => (location.hash = `#/t/${c.identifier}`);
  return (
    <article className={`aw-card p-${c.priority}${lane === "done" ? " done" : ""}`} onClick={open}>
      <div className="aw-top">
        <span className="aw-id">{c.identifier}</span>
        {project && <span className={`aw-proj ${hueClass(project)}`}>{project}</span>}
      </div>
      <a className="aw-title" href={`#/t/${c.identifier}`} onClick={stop}>
        {c.title}
      </a>
      {c.parent && (
        <a className="aw-parent" href={`#/t/${c.parent}`} onClick={stop}>
          part of {c.parent}
        </a>
      )}
      <LaneLine c={c} s={s} />
      <div className="aw-foot">
        <Monogram name={who} size={18} />
        <span className="aw-who">{who}</span>
        {c.crewIds.length > 0 && <span className="aw-crew" title={c.crewIds.map((id) => board.assignees.find((a) => a.key === id)?.name ?? "Agent").join(", ")}>+{c.crewIds.length}</span>}
        <span className="aw-sp" />
        <span className="aw-age" title={lane === "working" ? "Running for" : "Last activity"}>{age}</span>
        {run && (
          <a className="aw-run" href={`#/r/${run}`} onClick={stop} title="Open the run" aria-label="Open the run">
            ↗
          </a>
        )}
      </div>
    </article>
  );
}

function LaneColumn({ lane, cards, board, loading }: { lane: Lane; cards: WorkCard[]; board: Board; loading?: boolean }) {
  const [shown, setShown] = useState(PAGE);
  return (
    <section className={`aw-lane l-${lane}`} aria-label={LANE_TITLE[lane]}>
      <header className="aw-lane-h">
        <h2>{LANE_TITLE[lane]}</h2>
        <span className="aw-n" title="matching cards">{loading ? "" : cards.length}</span>
      </header>
      <div className="aw-cards">
        {loading ? (
          <>
            <Bone h={92} className="aw-sk" />
            <Bone h={76} className="aw-sk" />
          </>
        ) : cards.length ? (
          cards.slice(0, shown).map((c) => <WorkCardView key={c.id} c={c} board={board} />)
        ) : (
          <p className="aw-empty-lane">No tasks in {LANE_NAMES[lane]}</p>
        )}
      </div>
      {cards.length > shown && (
        <button type="button" className="aw-more" onClick={() => setShown(shown + PAGE * 4)}>
          Show {cards.length - shown} more
        </button>
      )}
    </section>
  );
}

/**
 * Cards by lane. Needs you and Blocked: the longest outstanding first, by when the ask or trouble the card shows began (its
 * attention entry's `since`), so the oldest ask is never behind "Show more"; Done: newest close first; the rest: newest activity.
 */
const OLDEST_FIRST = new Set<Lane>(["needs_you", "blocked"]);
const askedAt = (c: WorkCard, l: Lane) => {
  const at = (c.state?.attention ?? []).filter((a) => (l === "needs_you" ? a.who === "owner" : a.who === "agent")).map((a) => a.since ?? "").filter(Boolean).sort()[0];
  return at ?? c.state?.since ?? c.activityAt;
};
function byLane(cards: WorkCard[]): Record<Lane, WorkCard[]> {
  const out = Object.fromEntries(LANES.map((l) => [l, [] as WorkCard[]])) as Record<Lane, WorkCard[]>;
  for (const c of cards) out[laneOf(c)].push(c);
  for (const l of LANES)
    out[l].sort((a, b) =>
      OLDEST_FIRST.has(l) ? askedAt(a, l).localeCompare(askedAt(b, l))
      : l === "done" ? (b.closedAt ?? "").localeCompare(a.closedAt ?? "")
      : b.activityAt.localeCompare(a.activityAt));
  return out;
}

export function AgentWork({ board, cards, groupBy, mobile, filtered, onClear }: { board: Board; cards: WorkCard[]; groupBy: "none" | "agent"; mobile: boolean; filtered: boolean; onClear: () => void }) {
  const lanes = useMemo(() => byLane(cards), [cards]);
  const first = LANES.find((l) => lanes[l].length) ?? "needs_you";
  // A phone shows one lane: the first populated one until the owner picks another (kept, even when it empties).
  const [phoneLane, setPhoneLane] = useState<Lane | null>(null);
  const current = phoneLane ?? first;

  if (!board.work.length)
    return (
      <div className="aw-empty">
        <b>Nothing is running yet.</b>
        <span>Ask Aiden to take a task and it shows up here, lane by lane.</span>
      </div>
    );
  if (!cards.length && filtered)
    return (
      <div className="aw-empty">
        <b>No tasks match these filters</b>
        <button type="button" className="btn" onClick={onClear}>
          Clear all
        </button>
      </div>
    );
  if (mobile)
    return (
      <>
        <nav className="aw-phone-tabs" role="tablist" aria-label="Lanes">
          {LANES.map((l) => (
            <button key={l} type="button" role="tab" className={`l-${l}`} aria-selected={l === current} onClick={() => setPhoneLane(l)}>
              <i aria-hidden />
              {LANE_NAMES[l]} <em>{lanes[l].length}</em>
            </button>
          ))}
        </nav>
        <main className="aw-lanes phone" aria-label="Agent work">
          <LaneColumn key={current} lane={current} cards={lanes[current]} board={board} />
        </main>
      </>
    );
  if (groupBy === "agent") return <Swimlanes cards={cards} board={board} />;
  return (
    <main className="aw-lanes" aria-label="Agent work">
      {LANES.map((l) => (
        <LaneColumn key={l} lane={l} cards={lanes[l]} board={board} />
      ))}
    </main>
  );
}

/** The lanes with headers and skeleton cards: what the layout looks like before its first board arrives. */
export function AgentWorkLoading() {
  const board = { assignees: [], projects: null, prefix: "" } as unknown as Board;
  return (
    <main className="aw-lanes" aria-label="Agent work" aria-busy="true">
      {LANES.map((l) => (
        <LaneColumn key={l} lane={l} cards={[]} board={board} loading />
      ))}
    </main>
  );
}

/** Group by agent: a row per holder (agents, You, Unassigned), most owner attention first, then most working. */
function Swimlanes({ cards, board }: { cards: WorkCard[]; board: Board }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const rows = useMemo(() => {
    const by = new Map<string, WorkCard[]>();
    for (const c of cards) {
      const k = c.assignee ?? "none";
      by.set(k, [...(by.get(k) ?? []), c]);
    }
    return [...by.entries()]
      .map(([key, list]) => ({ key, name: list[0] ? holderName(list[0], board.assignees) : key, lanes: byLane(list) }))
      .sort((a, b) => b.lanes.needs_you.length - a.lanes.needs_you.length || b.lanes.working.length - a.lanes.working.length || a.name.localeCompare(b.name));
  }, [cards, board.assignees]);
  const toggle = (k: string) => setClosed((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  });
  return (
    <main className="aw-swim" aria-label="Agent work by agent">
      <div className="aw-swim-heads" aria-hidden>
        {LANES.map((l) => (
          <span key={l} className={`l-${l}`}>{LANE_TITLE[l]}</span>
        ))}
      </div>
      {rows.map((r) => {
        const open = !closed.has(r.key);
        return (
          <section key={r.key} className="aw-swim-row" aria-label={r.name}>
            <button type="button" className="aw-swim-h" aria-expanded={open} onClick={() => toggle(r.key)}>
              <span className="aw-chev" aria-hidden>{open ? "▾" : "▸"}</span>
              <Monogram name={r.name} size={20} />
              <span className="aw-swim-name">{r.name}</span>
              <span className="aw-swim-counts">
                {LANES.filter((l) => r.lanes[l].length).map((l) => (
                  <span key={l} className={`l-${l}`}>
                    {r.lanes[l].length} {LANE_NAMES[l].toLowerCase()}
                  </span>
                ))}
              </span>
            </button>
            {open && (
              <div className="aw-swim-body">
                {LANES.map((l) => (
                  <div key={l} className={`aw-cell${r.lanes[l].length ? "" : " empty"}`} aria-label={LANE_NAMES[l]}>
                    {r.lanes[l].map((c) => (
                      <WorkCardView key={c.id} c={c} board={board} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}
