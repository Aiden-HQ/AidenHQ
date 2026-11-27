// Home (#/): the board's front page. What needs the owner, answered in place (J/K, E, S); what the team did since he last
// looked; his world (who he waits on, today's calendar); the teammates with news. One read (GET /api/home), and a
// block with no source or no data is left out, never shown empty. #/approvals/<id> opens that card in the detail drawer.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnswerForm } from "./AnswerForm";
import { HttpStatusError, SignInRequired, api, type Session } from "./api";
import { ApprovalCard, BatchBar, Decide, TIER_WORDS } from "./ApprovalCard";
import { useLive } from "./events";
import { askForNotifications, notificationsSupported } from "./notify";
import { doneAction, formOnly, useNeedsKeys } from "./needs";
import { QUERIES, homeFrom, useQuery } from "./queries";
import { MoreTeam, NextUp, WelcomeStepper } from "./GettingStarted";
import { Bone } from "./Skeleton";
import { TaskCheck, useCheckOff } from "./MyTasks";
import { chipOf } from "./own-tasks";
import type { About, Approval, Board, Card, FaceRef, Home, NeedRow, SinceItem, Waiting } from "./types";
import { Markdown } from "./markdown";
import { Banner, Button, DigestList, DigestRow, Face, Facts, Kbd, Monogram, Page, SectionCard, Tag, Tags, TeammateChip, Tile, faceProps, safeHref } from "./ui";
import { ago, clockOpts, clockText, when } from "./util";
import "./home.css";

type Toast = (text: string, action?: { label: string; run: () => void }) => void;
/** A row answered, decided or snoozed on this visit: its receipt, and the row itself (kept on screen after a refetch drops it). */
type Receipt = { text: string; onUndo?: () => void; row: NeedRow };
/** A receipt's key and a row's snooze key (home.ts): an answer row's task and wait (a follow-up question on the same task is a new row), else the row's id. */
const rkey = (r: NeedRow) => (r.kind === "answer" ? `${r.id}:${r.waitSince}` : r.id);
/** What the detail drawer shows: a Needs row, a You're waiting on row (by its task's identifier), or a card that isn't in Needs (#/approvals/<id>). */
type Pane = { kind: "row"; id: string } | { kind: "waiting"; id: string } | { kind: "card"; id: string } | null;

/** The most rows Needs you and You're waiting on list (the newest); the rest is one click away in Tasks. */
const HOME_ROWS = 10;

const WORDS = ["Nothing", "One thing", "Two things", "Three things", "Four things", "Five things", "Six things", "Seven things", "Eight things", "Nine things", "Ten things"];
/** "Three things need you; the rest is handled." Empty when nothing does: Needs you only counts what teammates ask, so "nothing" would overclaim. */
export function needsLine(n: number): string {
  if (!n) return "";
  return `${WORDS[n] ?? `${n} things`} need${n === 1 ? "s" : ""} you; the rest is handled.`;
}
const NOTIFY_KEY = "aidenhq.notify-ask";
const hourIn = (tz: string, d = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(d));
const dayIn = (tz: string, d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const timeIn = (tz: string, d: Date) => new Intl.DateTimeFormat(undefined, { ...clockOpts(), timeZone: tz }).format(d);
const face = (t: FaceRef, size: number, state = t.state) => <Face seed={t.key} {...faceProps(t.face)} state={state} size={size} label={t.name} />;
const chip = (t: FaceRef, size = 24, href?: string) => <TeammateChip agent={{ key: t.key, name: t.name, teammate: { job: t.job, face: t.face } }} state={t.state} size={size} href={href} />;
/** Where a person who waits on the owner wrote: "Slack", "Gmail", or just that they wait. */
const replyRole = (r: NonNullable<Extract<NeedRow, { kind: "open" }>["reply"]>) => (r.source === "slack" ? "Slack" : r.source === "gmail" ? "Gmail" : "Waiting for your reply");
/** "Overnight" when the window began before 06:00 today, "Since Tue" when before today, else "Since 2:20 PM". */
function sinceMeta(from: string, tz: string): string {
  const at = new Date(from);
  const today = dayIn(tz, new Date());
  if (dayIn(tz, at) < today) return Date.now() - at.getTime() < 36 * 3_600_000 ? "Overnight" : `Since ${at.toLocaleDateString(undefined, { weekday: "short", timeZone: tz })}`;
  return hourIn(tz, at) < 6 ? "Overnight" : `Since ${timeIn(tz, at)}`;
}

/** The owner's own tasks as Tasks counts them (mytasks.ts): today's, and the sizes of the Inbox and of This week. */
export type Day = { today: Card[]; triage: number; week: number; projects: Board["projects"]; /** Opens Tasks on My tasks (the list these counts come from). */ open: () => void };

/** `front`: Home is the page in front, no overlay (a task, a run) over it: only then do its keys work. `day`: the owner's tasks
 * (Your day); `onDone` checks one off, as Tasks does. */
export function HomeView({ card, session, onSignIn, toast, mobile, timezone, front, day, onDone }: { card?: string; session: Session | null; go: (h: string) => void; onSignIn: () => void; toast: Toast; mobile: boolean; timezone: string; front: boolean; day?: Day; onDone?: (c: Card) => void }) {
  const q = useQuery(QUERIES.home, onSignIn);
  const data = q.data;
  const reload = q.reload;
  const [pane, setPane] = useState<Pane>(null);
  const waitingOn = useWaitingOn(data?.world.waiting_on ?? null, reload, pane?.kind === "waiting" ? pane.id : null, (id) => setPane({ kind: "waiting", id }));
  useLive(["home", "approvals"], reload, 15_000);
  // The visit's since window: the first answer's start, sent back by every refetch while Home is open.
  useEffect(() => () => void (homeFrom.value = undefined), []);
  // A snapshot loaded before this visit (an earlier one's, pinned to its window) shows while this visit's own read runs; only
  // a read of this visit is pinned or marked seen.
  const fresh = !!data && !q.stale;
  useEffect(() => void (fresh && !homeFrom.value && (homeFrom.value = data.since_from)), [data, fresh]);
  // Answered and decided rows keep their receipt for this visit, even when a refetch still lists them.
  const [receipts, setReceipts] = useState<Map<string, Receipt>>(() => new Map());
  const receipt = useCallback((row: NeedRow, r: Omit<Receipt, "row"> | null) => setReceipts((m) => { const n = new Map(m); if (r) n.set(rkey(row), { ...r, row }); else n.delete(rkey(row)); return n; }), []);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [batching, setBatching] = useState<"approve" | "reject" | null>(null);
  const [unbatched, setUnbatched] = useState<string[]>([]);
  // A row with a receipt stays for the visit after a refetch leaves it out (answered, decided, snoozed), with its receipt; one
  // row per task (its newest receipt), as rows are picked and opened by id.
  const rows = useMemo(() => {
    const needs = data?.needs ?? [];
    const kept = new Map<string, NeedRow>();
    for (const { row } of receipts.values()) if (!needs.some((n) => n.id === row.id)) kept.set(row.id, row);
    return [...needs, ...kept.values()];
  }, [data?.needs, receipts]);
  const everyLive = rows.filter((r) => !receipts.has(rkey(r)));
  // "View all N" expands the card in place (as Since's "All N" does), so every row the count includes is on this page: the
  // Tasks page filters tasks by lane or label, and an approval card has no task to filter to.
  const [all, setAll] = useState(false);
  // The card lists the newest SHOWN of them; a row with a receipt stays for the visit. Expanded, it lists every open row.
  const shown = useMemo(() => {
    const newest = [...rows].sort((a, b) => b.since.localeCompare(a.since));
    // The newest ten still open, plus the rows answered this visit (their receipts), so acting on a row brings the next up.
    const top = new Set(newest.filter((r) => !receipts.has(rkey(r))).slice(0, HOME_ROWS).map((r) => r.id));
    return newest.filter((r) => (all && !receipts.has(rkey(r))) || top.has(r.id) || receipts.has(rkey(r)));
  }, [rows, receipts, all]);
  const live = shown.filter((r) => !receipts.has(rkey(r)));

  // The cursor moves to a snapshot's as_of once it has been on screen (never on leaving): the visit's first snapshot, then
  // only one that shows something newer than the last mark. (A mark emits `home`, which refetches: marking every snapshot
  // would loop.)
  const seen = useRef<string | null>(null);
  // Since is the digest the cursor stands for: with one on the page, the mark waits until it has been in the viewport.
  const [sinceEl, setSinceEl] = useState<HTMLElement | null>(null);
  const [sinceInView, setSinceInView] = useState(false);
  useEffect(() => {
    setSinceInView(false);
    if (!sinceEl) return;
    const io = new IntersectionObserver((es) => setSinceInView(es.some((e) => e.isIntersecting)), { threshold: 0.25 });
    io.observe(sinceEl);
    return () => io.disconnect();
  }, [sinceEl]);
  // The drawer covers Home (a sheet on a phone, a scrim and the right side elsewhere): what is behind it hasn't been seen (a row's pane closes when the row leaves).
  const sheetOpen = !!pane && (pane.kind === "row" ? rows.some((r) => r.id === pane.id) : pane.kind === "waiting" ? waitingOn.rows.some((w) => w.identifier === pane.id) : true);
  const sinceReady = !data?.since || (sinceInView && !sheetOpen);
  // Only while Home is in front: a task or run drawer over it (full screen on a phone) hides the snapshot.
  useLayoutEffect(() => {
    if (!front || !data || seen.current === data.as_of || !data.since_complete || !fresh || !sinceReady) return;
    const last = seen.current;
    if (last && !data.since?.items.some((i) => i.at > last)) return;
    const asOf = data.as_of;
    const f = requestAnimationFrame(() => {
      if (document.visibilityState !== "visible" || seen.current === asOf) return;
      seen.current = asOf;
      void api.homeSeen(asOf).catch(() => {});
    });
    return () => cancelAnimationFrame(f);
  }, [data?.as_of, fresh, front, sinceReady]);


  const fail = (e: unknown, what: string) => {
    if (e instanceof SignInRequired) return onSignIn();
    if (e instanceof HttpStatusError && e.status === 409) toast("Already answered, or the question changed");
    else toast(`Couldn't ${what}: ${(e as Error).message}`);
    void reload();
  };
  const answer = async (row: NeedRow & { kind: "answer" }, text: string) => {
    try {
      await api.answer(row.task.identifier, text, row.waitSince);
      receipt(row, { text: row.detail && text === row.options[0] ? `${row.teammate.name} is sending it` : `Sent: ${text}` });
    } catch (e) {
      fail(e, "answer");
      // The form keeps what was typed for another try.
      throw e;
    }
  };
  const decided = (row: NeedRow, d: "approve" | "reject") => receipt(row, { text: d === "approve" ? "Approved" : "Rejected" });
  const snooze = async (row: NeedRow) => {
    try {
      await api.homeSnooze(rkey(row), true);
      const undo = () => void api.homeSnooze(rkey(row), false).then(() => (receipt(row, null), reload()), (e) => fail(e, "undo"));
      receipt(row, { text: `Hidden until ${clockText(8)}`, onUndo: undo });
    } catch (e) {
      fail(e, "snooze");
    }
  };
  const done = async (row: NeedRow) => {
    if (receipts.has(rkey(row))) return;
    const act = doneAction(row);
    if (!act) return setPane({ kind: "row", id: row.id });
    try {
      if (act === "approve" && row.kind === "approval") (await api.decide(row.card.id, row.card.digest, "approve"), decided(row, "approve"));
      else if (act === "close" && row.kind === "open") (await api.update(row.task.identifier, { status: "done" }), receipt(row, { text: "Marked done" }));
      else if (typeof act === "object" && row.kind === "answer") await answer(row, act.answer).catch(() => {});
    } catch (e) {
      fail(e, "do that");
    }
  };
  const dismiss = async (row: NeedRow) => {
    if (receipts.has(rkey(row)) || row.kind !== "open") return;
    try {
      await api.update(row.task.identifier, { status: "cancelled" });
      receipt(row, { text: "Dismissed" });
    } catch (e) {
      fail(e, "dismiss");
    }
  };
  const keys = useNeedsKeys(live, { open: (id) => setPane({ kind: "row", id }), done: (r) => void done(r), snooze: (r) => void snooze(r) }, front);

  // #/approvals/<id>: that row's pane, or the card read alone when it isn't in Needs (decided, or someone else's).
  const cardInNeeds = !!card && rows.some((r) => r.id === card);
  useEffect(() => {
    if (!card || !data) return;
    setPane(cardInNeeds ? { kind: "row", id: card } : { kind: "card", id: card });
    // When the address names a card, and when its row comes or goes (decided here or elsewhere), not on every refetch.
  }, [card, !!data, cardInNeeds]);
  const closePane = () => {
    setPane(null);
    if (card) location.replace("#/");
  };

  const [notify, setNotify] = useState(() => {
    try {
      return notificationsSupported() && Notification.permission === "default" && localStorage.getItem(NOTIFY_KEY) !== "no";
    } catch {
      return notificationsSupported() && Notification.permission === "default";
    }
  });
  const dismissNotify = () => {
    setNotify(false);
    try {
      localStorage.setItem(NOTIFY_KEY, "no");
    } catch {}
  };

  const first = session?.account?.name?.split(/\s+/)[0];
  const h = hourIn(timezone);
  const hello = `Good ${h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"}${first ? `, ${first}` : ""}. `;
  const now = new Date();
  const date = `${now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: timezone })} · ${timeIn(timezone, now)}`;

  if (!data) return <HomeSkeleton error={q.error} retry={reload} />;
  const approvals = rows.filter((r): r is NeedRow & { kind: "approval" } => r.kind === "approval" && !receipts.has(rkey(r)));
  const chosen = approvals.filter((r) => picked.includes(r.id)).map((r) => r.card);
  const paneRow = pane?.kind === "row" ? rows.find((r) => r.id === pane.id) : undefined;
  const paneWaiting = pane?.kind === "waiting" ? waitingOn.rows.find((w) => w.identifier === pane.id) : undefined;
  const paneOpen = !!pane && (pane.kind === "row" ? !!paneRow : pane.kind === "waiting" ? !!paneWaiting : true);
  const projects = new Map((day?.projects ?? []).map((p) => [p.id, p.name]));
  const since = data.since && <SinceCard since={data.since} timezone={timezone} from={data.since_from} />;
  const sideShown = !!since;
  const waitingCard = waitingOn.card;
  const todayCard = data.world.today && data.world.today.events.length > 0 ? <TodayCard today={data.world.today} /> : null;
  // Needs you shows only while something is in it (or a receipt from this visit); empty, the box is left out.
  const needsShown = shown.length > 0;
  // The rows still open here: an answered row leaves the count at once, before the kernel catches up.
  const n = everyLive.length;
  // A row opens in a right drawer over the page (a full-screen sheet on a phone): Home underneath keeps its layout.
  const detail = paneOpen && pane && (
    pane.kind === "row" && paneRow ? (
      <RowDetail key={`row:${pane.id}`} row={paneRow} projects={projects} onClose={closePane} answer={answer} decided={decided} snooze={snooze} done={done} dismiss={dismiss} receipt={receipts.get(rkey(paneRow))} />
    ) : pane.kind === "waiting" && paneWaiting ? (
      <WaitingDetail key={`waiting:${pane.id}`} w={paneWaiting} projects={projects} onClose={closePane} close={waitingOn.close} later={waitingOn.later} />
    ) : pane.kind === "card" ? (
      <HomeDrawer key={`card:${pane.id}`} rowId={pane.id} onClose={closePane} head={<span className="home-drawer-who"><b>Card {pane.id}</b></span>}>
        <CardAlone id={pane.id} />
      </HomeDrawer>
    ) : null
  );

  return (
    <Page className="home" label="Home">
      {data.start && <WelcomeStepper />}
      <header className="home-head enter">
        <p className="home-date">{date}</p>
        <h1>{`${hello}${needsLine(n)}`.trim()}</h1>
      </header>
      {notify && (
        <Banner action={<span className="home-banner-actions"><Button size="sm" variant="primary" onClick={() => void askForNotifications().then(() => setNotify(false))}>Notify me</Button><Button size="sm" variant="quiet" onClick={dismissNotify}>Not now</Button></span>}>
          Get a browser notification when something needs you.
        </Banner>
      )}
      {unbatched.length > 0 && (
        <Banner tone="danger" action={<Button size="sm" variant="quiet" onClick={() => setUnbatched([])}>Dismiss</Button>}>
          Not decided: {unbatched.join("; ")}
        </Banner>
      )}
      {data.start?.nextUp && <div className="home-nextup enter" style={{ "--i": 1 } as CSSProperties}><NextUp next={data.start.nextUp} reload={reload} /></div>}
      {data.start && <MoreTeam more={data.start.more} />}
      {day && onDone && <YourDay day={day} onDone={onDone} />}
      {/* Two rows of two equal halves on one grid: Needs you | You're waiting on, then Today | Since you last looked. A lone card takes its row. */}
      {(needsShown || waitingCard) && (
        <div className="home-pair">
          {needsShown && <div className="home-needs home-pair-cell enter" style={{ "--i": 3 } as CSSProperties}>
            <SectionCard
              title="Needs you"
              count={everyLive.length || undefined}
              flush
              action={
                <>
                  {!mobile && live.length > 0 && (
                    <span className="home-keys" aria-hidden>
                      <Kbd>J</Kbd><Kbd>K</Kbd> move <Kbd>E</Kbd> done <Kbd>S</Kbd> snooze
                    </span>
                  )}
                  {approvals.length > 1 && (
                    <Button size="sm" variant="quiet" aria-pressed={selecting} onClick={() => (setSelecting(!selecting), setPicked([]))}>
                      {selecting ? "Done selecting" : "Select"}
                    </Button>
                  )}
                  {everyLive.length > HOME_ROWS && (
                    <button type="button" className="link-btn home-all" aria-expanded={all} onClick={() => setAll(!all)}>
                      {all ? "Fewer" : `View all ${everyLive.length} →`}
                    </button>
                  )}
                </>
              }
            >
              <div className="ui-digest" role="listbox" aria-label="Needs you" aria-activedescendant={keys.at ? `need-${keys.at}` : undefined} tabIndex={-1}>
                {shown.map((r, i) => {
                  const person = r.kind === "open" ? r.reply?.person : null;
                  const who = person || r.teammate.name;
                  const role = r.kind === "open" && r.reply ? replyRole(r.reply) : r.teammate.job;
                  const pick = selecting && r.kind === "approval" && !receipts.has(rkey(r));
                  const mark = person ? <Monogram name={person} size={24} /> : face(r.teammate, 24, "needs");
                  return (
                    <div key={rkey(r)} id={`need-${r.id}`} role="option" aria-selected={keys.at === r.id} onClick={() => keys.setAt(r.id)}>
                      <DigestRow
                        d={{
                          id: r.id,
                          i,
                          // Picking cards for a batch: the box sits before the face, always shown (the buttons show only on hover).
                          face: pick ? <><label className="approval-pick home-pick" title="Select for a batch decision"><input type="checkbox" checked={picked.includes(r.id)} onChange={() => setPicked((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]))} aria-label={`Select: ${r.question}`} /></label>{mark}</> : mark,
                          text: <><b>{who}</b> · {r.question}</>,
                          title: `${who} · ${role}: ${r.question}`,
                          meta: r.kind === "open" && r.reply ? `Waiting ${ago(r.since)}` : ago(r.since),
                          active: keys.at === r.id || (pane?.kind === "row" && pane.id === r.id),
                          onOpen: () => (keys.setAt(r.id), setPane({ kind: "row", id: r.id })),
                          receipt: receipts.get(rkey(r)) ?? null,
                          actions: <RowActions row={r} answer={answer} decided={decided} snooze={snooze} done={done} dismiss={dismiss} />,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              {selecting && chosen.length > 0 && (
                <BatchBar cards={chosen} busy={batching} setBusy={setBatching} hold={false} done={(failed) => (setUnbatched(failed.map((f) => f.why)), approvals.filter((r) => picked.includes(r.id) && !failed.some((f) => f.id === r.card.id)).forEach((r) => receipt(r, { text: "Decided" })), setPicked([]), void reload())} />
              )}
            </SectionCard>
          </div>}
          {waitingCard && <div className="home-pair-cell enter" style={{ "--i": 4 } as CSSProperties}>{waitingCard}</div>}
        </div>
      )}
      {(todayCard || sideShown) && (
        <div className="home-pair">
          {todayCard && <div className="home-pair-cell enter" style={{ "--i": 5 } as CSSProperties}>{todayCard}</div>}
          {sideShown && <div className="home-side home-pair-cell enter" style={{ "--i": 6 } as CSSProperties}>
            {since && <div ref={setSinceEl}>{since}</div>}
          </div>}
        </div>
      )}
      <TeamRow team={data.team} />
      {detail}
    </Page>
  );
}

/** Today's tasks, checked off in place, beside what waits in the Inbox and this week; both tiles open Tasks. Left out when there is nothing. */
const DAY_ROWS = 6;
function YourDay({ day, onDone }: { day: Day; onDone: (c: Card) => void }) {
  if (!day.today.length && !day.triage && !day.week) return null;
  return (
    <section className="home-day enter" style={{ "--i": 3 } as CSSProperties} aria-label="Your day">
      <div className="home-day-tasks">
        <header className="home-day-head">
          <h2 className="home-h2">Your day</h2>
          <span className="home-sub">{day.today.length === 1 ? "1 task" : `${day.today.length} tasks`} for today</span>
          <a className="home-day-open" href="#/tasks" onClick={day.open}>Open Tasks →</a>
        </header>
        {day.today.slice(0, DAY_ROWS).map((c) => (
          <DayRow key={c.id} card={c} chip={chipOf(c, day.projects)} onDone={onDone} />
        ))}
        {!day.today.length && <p className="home-clear">Nothing planned for today.</p>}
        {day.today.length > DAY_ROWS && <a className="home-day-more" href="#/tasks" onClick={day.open}>{day.today.length - DAY_ROWS} more in Tasks →</a>}
      </div>
      <div className="home-day-stats">
        <a className="home-stat" href="#/tasks" onClick={day.open} style={{ "--v": "var(--warn)" } as CSSProperties}>
          <span className="home-stat-k"><i />To triage</span>
          <b>{day.triage}</b>
          <span className="home-stat-go">Triage →</span>
        </a>
        <a className="home-stat" href="#/tasks" onClick={day.open} style={{ "--v": "var(--later)" } as CSSProperties}>
          <span className="home-stat-k"><i />This week</span>
          <b>{day.week}</b>
          <span className="home-stat-go">Plan the week →</span>
        </a>
      </div>
    </section>
  );
}

function DayRow({ card, chip, onDone }: { card: Card; chip?: string; onDone: (c: Card) => void }) {
  const { done, check } = useCheckOff(card, onDone);
  return (
    <div className={`home-day-row${done ? " done" : ""}`}>
      <TaskCheck card={card} done={done} onCheck={check} />
      <a className="home-day-ttl" href={`#/t/${card.identifier}`} title={card.title}>{card.title}</a>
      {chip && <span className="home-day-chip">{chip}</span>}
      {card.carried ? <span className="home-day-when">Carried {card.carried}d</span> : null}
    </div>
  );
}

type Acts = { answer: (r: NeedRow & { kind: "answer" }, t: string) => Promise<void>; decided: (r: NeedRow, d: "approve" | "reject") => void; snooze: (r: NeedRow) => Promise<void>; done: (r: NeedRow) => Promise<void>; dismiss: (r: NeedRow) => Promise<void> };

/** A row's buttons: Approve and Reject, the first option (a one-question ask), or Done and Dismiss for a person waiting; Later hides it. Anything else is answered in the drawer the row opens. */
function RowActions({ row, answer, decided, snooze, done, dismiss }: { row: NeedRow } & Acts) {
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<void>) => async () => {
    setBusy(true);
    // A failed answer was already said (a toast); the buttons come back for another try.
    await f().catch(() => {});
    setBusy(false);
  };
  const later = <Button size="sm" variant="quiet" className="press" disabled={busy} onClick={run(() => snooze(row))}>Later</Button>;
  if (row.kind === "approval")
    return (
      <>
        <Decide a={row.card} size="sm" onDecided={(d) => decided(row, d)} />
        {later}
      </>
    );
  if (row.kind === "open")
    return (
      <>
        <Button size="sm" variant="primary" className="press" disabled={busy} onClick={run(() => done(row))}>Done</Button>
        {row.reply && later}
        {row.reply && <Button size="sm" variant="quiet" className="press" disabled={busy} onClick={run(() => dismiss(row))}>Dismiss</Button>}
      </>
    );
  // Several questions, or one taking several options, are answered in the pane's form: an answer claims the whole wait.
  const first = formOnly(row) ? undefined : row.options.find((o) => !/^not now$/i.test(o));
  return (
    <>
      {first && <Button size="sm" variant="primary" className="press" disabled={busy} onClick={run(() => answer(row, first))}>{first}</Button>}
      {later}
    </>
  );
}

/** The right drawer a Home row opens (the board's drawer look: a scrim over the page, click outside or Esc closes). Focus moves
 * in and returns to the row. `head`: who it is from and how long it has waited; `foot`: the link to the whole task. */
function HomeDrawer({ rowId, onClose, head, foot, children }: { rowId: string; onClose: () => void; head: React.ReactNode; foot?: React.ReactNode; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const mine = ref.current;
      if (!mine || e.defaultPrevented) return;
      // Only the topmost layer takes the keyboard: a task drawer opened from this one covers it and owns Tab and Escape.
      const layers = document.querySelectorAll(".drawer-backdrop, dialog[open], .palette-backdrop");
      if (layers[layers.length - 1] !== mine.parentElement) return;
      if (e.key === "Tab") {
        // Focus stays in this drawer while it is the topmost one.
        const f = [...mine.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")];
        const first = f[0], last = f[f.length - 1];
        if (!first || !last) return e.preventDefault();
        const at = document.activeElement;
        if (e.shiftKey && (at === first || at === mine)) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && at === last) (e.preventDefault(), first.focus());
        else if (!mine.contains(at)) (e.preventDefault(), first.focus());
        return;
      }
      // Escape closes the topmost layer only: a task drawer opened from here is closed first.
      if (e.key === "Escape") (e.preventDefault(), close.current());
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const row = document.querySelector<HTMLElement>(`[id="need-${rowId}"] .ui-digest-open`);
      (row ?? (opener?.isConnected ? opener : null))?.focus({ preventScroll: true });
    };
  }, [rowId]);
  return (
    <div className="drawer-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close.current()}>
      <aside ref={ref} tabIndex={-1} className="drawer home-drawer" role="dialog" aria-modal="true" aria-label="Details">
        <header className="drawer-head home-drawer-head">
          {head}
          <span className="spacer" />
          <button type="button" className="btn quiet sm" onClick={onClose} aria-label="Close details">Close <Kbd>Esc</Kbd></button>
        </header>
        <div className="drawer-scroll">{children}</div>
        {foot && <footer className="home-drawer-foot">{foot}</footer>}
      </aside>
    </div>
  );
}

type Fact = readonly [string, React.ReactNode] | false | null | undefined;

/** How long something has waited: "40m", "5h", "9d" (never a date, as `ago` gives past a week). */
const waited = (iso: string) => {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
/** An http(s) address as a link that opens in a new tab; any other value as text. */
const value = (v: string) => (/^https?:\/\/\S+$/i.test(v) ? <a href={safeHref(v)} target="_blank" rel="noopener noreferrer">{v}</a> : v);
const taskLink = (t: { identifier: string; title: string }) => <a href={`#/t/${t.identifier}`}><span className="home-ident">{t.identifier}</span> {t.title}</a>;

/** The details every row's task gives: where it came from (with a link to the original message when the source has one), when it
 * arrived and how long it has waited, the task and its parent, project, labels and who holds it. */
function taskFacts(a: About | undefined, o: { from: string | null; task: { identifier: string; title: string } | null; since: string; waitLabel: string; holder: string | null; projects: Map<string, string> }): Fact[] {
  const src = a?.source;
  const project = a?.project ? o.projects.get(a.project) : undefined;
  return [
    src ? ["Source", <>{src.type ?? "A message"}{src.url && <> · <a href={safeHref(src.url)} target="_blank" rel="noopener noreferrer">Open the original ↗</a></>}</>] : o.from ? ["Source", o.from] : null,
    ...(src?.fields ?? []).map(([k, v]): Fact => [k, value(v)]),
    ["Arrived", when(a?.created ?? o.since)],
    [o.waitLabel, waited(o.since)],
    o.task ? ["Task", taskLink(o.task)] : null,
    a?.parent ? ["Part of", taskLink(a.parent)] : null,
    project ? ["Project", project] : null,
    a?.labels.length ? ["Labels", <Tags>{a.labels.map((l) => <Tag key={l}>{l}</Tag>)}</Tags>] : null,
    o.holder ? ["Handled by", o.holder] : null,
  ];
}

/** The drawer's areas, top to bottom: the ask, every action, what it is about, its details. */
function DetailBody({ title, actions, children, facts }: { title: string; actions: React.ReactNode; children?: React.ReactNode; facts: Fact[] }) {
  return (
    <div className="home-detail">
      <h3 className="home-detail-title">{title}</h3>
      <div className="home-detail-actions">{actions}</div>
      {children && <section className="home-detail-content" aria-label="About this">{children}</section>}
      <section className="home-detail-facts" aria-label="Details">
        <h4 className="home-detail-h">Details</h4>
        <Facts items={facts} />
      </section>
    </div>
  );
}

/** A task's own words in the drawer: why it was filed and what to do (Intake's and the meeting notes' format), else its opening. */
function AboutText({ a, prefix }: { a?: About; prefix: string }) {
  if (!a || (!a.reason && !a.suggested && !a.body)) return null;
  return (
    <>
      {a.reason && <div className="home-detail-part"><h4 className="home-detail-h">Why</h4><p>{a.reason}</p></div>}
      {a.suggested && <div className="home-detail-part"><h4 className="home-detail-h">Suggested</h4><p>{a.suggested}</p></div>}
      {a.body && <div className="home-detail-part"><h4 className="home-detail-h">The task</h4><Markdown className="home-detail-md" text={a.body} prefix={prefix} /></div>}
    </>
  );
}

/** A Needs row in the drawer: who asks and since when, the ask, every action of its kind, the draft or the card, and the task's details. */
function RowDetail({ row, projects, onClose, receipt, ...acts }: { row: NeedRow; projects: Map<string, string>; onClose: () => void; receipt?: Receipt } & Acts) {
  const person = row.kind === "open" ? row.reply?.person : null;
  const reply = row.kind === "open" && row.reply ? row.reply : null;
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<void>) => async () => {
    setBusy(true);
    await f().catch(() => {});
    setBusy(false);
  };
  const later = <Button variant="quiet" disabled={busy} title={`Hide it until ${clockText(8)} tomorrow`} onClick={run(() => acts.snooze(row))}>Later</Button>;
  const age = row.kind === "answer" ? `Asked ${waited(row.since)} ago` : row.kind === "approval" ? `Filed ${waited(row.since)} ago` : reply ? `Waiting ${waited(row.since)}` : `Handed back ${waited(row.since)} ago`;
  const head = (
    <>
      {person ? <span className="ui-mate"><Monogram name={person} size={32} /><span className="ui-mate-text"><b>{person}</b> · {replyRole(reply!)}</span></span> : chip(row.teammate, 32, `#/team/${row.teammate.key}`)}
      <span className="home-drawer-age">{age}</span>
    </>
  );
  const actions = receipt ? (
    <p className="home-done" role="status">
      {receipt.text}
      {receipt.onUndo && <Button size="sm" variant="quiet" onClick={receipt.onUndo}>Undo</Button>}
    </p>
  ) : row.kind === "answer" ? (
    <div className="home-detail-answer">
      <AnswerForm key={row.waitSince} questions={row.questions.length ? row.questions : [{ question: row.question, options: row.options }]} askedAbove onAnswer={(t) => acts.answer(row, t)} />
      {later}
    </div>
  ) : row.kind === "approval" ? (
    <>
      {row.card.state === "pending" && <Decide a={row.card} onDecided={(d) => acts.decided(row, d)} />}
      {later}
    </>
  ) : (
    <>
      <Button variant="primary" disabled={busy} onClick={run(() => acts.done(row))}>Done</Button>
      {reply && later}
      {reply && <Button variant="quiet" disabled={busy} title="Close it as cancelled: it stays in history" onClick={run(() => acts.dismiss(row))}>Dismiss</Button>}
    </>
  );
  const facts = taskFacts(row.about, {
    from: row.kind === "approval" ? `${row.teammate.name}'s approval card` : `${row.teammate.name}, your teammate`,
    task: row.task,
    since: row.since,
    waitLabel: row.kind === "answer" ? "Asked" : "Waiting",
    holder: `${row.teammate.name}${row.teammate.job ? ` · ${row.teammate.job}` : ""}`,
    projects,
  });
  if (row.kind === "approval") {
    const c = row.card;
    facts.push(["Reads", c.reads], ["Cost", c.cost], ["Who decides", TIER_WORDS[c.tier] ?? `Tier ${c.tier}`], ["Card", <a href={`#/approvals/${c.id}`}>{c.id}</a>]);
  }
  return (
    <HomeDrawer rowId={row.id} onClose={onClose} head={head} foot={row.task && <a className="home-drawer-open" href={`#/t/${row.task.identifier}`}>Open task <span aria-hidden>→</span></a>}>
      <DetailBody title={row.kind === "open" && reply ? (row.task.title || row.question) : row.question} actions={actions} facts={facts}>
        {row.kind === "answer" && row.detail && (
          <div className="home-detail-part">
            <h4 className="home-detail-h">Draft</h4>
            <blockquote className="home-draft">{row.detail}</blockquote>
          </div>
        )}
        {row.kind === "approval" && (
          <>
            <div className="home-detail-part"><h4 className="home-detail-h">What changes</h4><pre className="home-pre">{row.card.changes}</pre></div>
            {row.card.review && <div className="home-detail-part"><h4 className="home-detail-h">Reviewer's note</h4><p className="home-pre-line">{row.card.review}</p></div>}
            {row.card.details && <div className="home-detail-part"><h4 className="home-detail-h">The exact request</h4><pre className="home-pre">{row.card.details}</pre></div>}
          </>
        )}
        {row.kind !== "approval" && <AboutText a={row.about} prefix={row.task.identifier} />}
      </DetailBody>
    </HomeDrawer>
  );
}

/** A You're waiting on row in the drawer: what is owed, Done, Later and Dismiss, its task's details. */
function WaitingDetail({ w, projects, onClose, close, later }: { w: Waiting; projects: Map<string, string>; onClose: () => void; close: (id: string, status: "done" | "cancelled") => void; later: (w: Waiting) => void }) {
  const head = (
    <>
      <span className="ui-mate"><Monogram name={w.title} size={32} /><span className="ui-mate-text"><b>You're waiting on</b></span></span>
      <span className="home-drawer-age">{`Open ${w.age_days}d`}{w.quiet_days >= 1 ? ` · ${w.quiet_days}d quiet` : ""}</span>
    </>
  );
  // Each action closes the drawer: the row leaves the card at once (and comes back with an error if refused).
  const act = (f: () => void) => () => (f(), onClose());
  return (
    <HomeDrawer rowId={w.identifier} onClose={onClose} head={head} foot={<a className="home-drawer-open" href={`#/t/${w.identifier}`}>Open task <span aria-hidden>→</span></a>}>
      <DetailBody
        title={w.title}
        actions={
          <>
            <Button variant="primary" title="It arrived: close it" onClick={act(() => close(w.identifier, "done"))}>Done</Button>
            <Button variant="quiet" title={`Hide it until ${clockText(8)} tomorrow`} onClick={act(() => later(w))}>Later</Button>
            <Button variant="quiet" title="No longer waiting on it: cancel the task" onClick={act(() => close(w.identifier, "cancelled"))}>Dismiss</Button>
          </>
        }
        facts={taskFacts(w.about, { from: null, task: { identifier: w.identifier, title: w.title }, since: w.about?.created ?? new Date(Date.now() - w.age_days * 86_400_000).toISOString(), waitLabel: "Waiting", holder: w.about?.holder ?? null, projects })}
      >
        <AboutText a={w.about} prefix={w.identifier} />
      </DetailBody>
    </HomeDrawer>
  );
}

/** A card not in Needs (#/approvals/<id>): read alone, whatever its age, with its outcome. */
function CardAlone({ id }: { id: string }) {
  const [a, setA] = useState<Approval | null | undefined>(undefined);
  const [error, setError] = useState("");
  const load = useCallback(() => api.approval(id).then((r) => (setA(r.approval), setError("")), (e: Error & { status?: number }) => (e.status === 404 ? setA(null) : setError(e.message))), [id]);
  useLive(["approvals"], load, 15_000);
  if (error) return <p className="alert">{error}</p>;
  if (a === undefined) return <Bone h={120} />;
  if (a === null) return <p className="home-clear">There is no card {id}.</p>;
  return (
    <ul className="approval-list">
      <ApprovalCard a={a} open={(ref) => (location.hash = `#/t/${ref}`)} unfold />
    </ul>
  );
}

/** The top of what changed, grouped by teammate; "All N" opens every item in place, under the card. */
function SinceCard({ since, timezone, from }: { since: NonNullable<Home["since"]>; timezone: string; from: string }) {
  const [all, setAll] = useState(false);
  return (
    <SectionCard
      title="Since you last looked"
      meta={sinceMeta(from, timezone)}
      flush
      action={since.total > Math.min(3, since.groups.length) ? <button type="button" className="link-btn home-all" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Fewer" : `All ${since.total} →`}</button> : undefined}
    >
      {all ? <SinceAll items={since.items} total={since.total} /> : <DigestList items={since.groups.map((g) => ({ id: g.teammate.key, face: face(g.teammate, 26, "idle"), text: g.count > 1 ? <>{g.latest.text} <span className="home-more">+{g.count - 1} more</span></> : g.latest.text, open: g.latest.task ? `#/t/${g.latest.task}` : undefined }))} limit={3} />}
    </SectionCard>
  );
}

/** Every Since item the read carries (the newest 200), grouped by teammate, newest first. */
function SinceAll({ items, total }: { items: SinceItem[]; total: number }) {
  const groups = useMemo(() => {
    const by = new Map<string, SinceItem[]>();
    for (const i of items) by.set(i.teammate.key, [...(by.get(i.teammate.key) ?? []), i]);
    return [...by.values()];
  }, [items]);
  return (
    <div className="home-since-all">
      {items.length < total && <p className="home-sub">Showing the newest {items.length} of {total}</p>}
      {groups.map((g) => (
        <section key={g[0]!.teammate.key}>
          {chip(g[0]!.teammate, 24, `#/team/${g[0]!.teammate.key}`)}
          <DigestList items={g.map((i, n) => ({ id: `${i.at}-${n}`, text: i.text, meta: ago(i.at), open: i.task ? `#/t/${i.task}` : undefined }))} limit={g.length} />
        </section>
      ))}
    </div>
  );
}

/** You're waiting on: the owner's open waiting-on tasks as a card (null when there are none), closed or snoozed in place. */
function useWaitingOn(waitingOn: Home["world"]["waiting_on"], reload: () => Promise<void>, opened: string | null, open: (identifier: string) => void) {
  // Rows the owner closed here: hidden at once, back with the error if the close is refused.
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const forget = (id: string) => setClosed((s) => (s.delete(id), new Set(s)));
  // The row hides at once; the read after the close is the truth, so the entry is dropped then (a task reopened later
  // shows again), and a refused close brings the row back with the error.
  const close = (id: string, status: "done" | "cancelled") => {
    setError("");
    setClosed((s) => new Set(s).add(id));
    api.update(id, { status }).then(
      () => reload().then(() => forget(id)),
      (e) => (forget(id), setError(`Couldn't close ${id}: ${(e as Error).message}`)),
    );
  };
  // Later: off Home until 08:00 tomorrow, the same snooze as Needs you's (keyed by the task's id).
  const later = (w: Waiting) => {
    setError("");
    setClosed((s) => new Set(s).add(w.identifier));
    api.homeSnooze(w.id, true).then(
      () => reload().then(() => forget(w.identifier)),
      (e) => (forget(w.identifier), setError(`Couldn't hide ${w.identifier}: ${(e as Error).message}`)),
    );
  };
  const waiting = (waitingOn?.filter((w) => !closed.has(w.identifier)) ?? []).sort((x, y) => x.age_days - y.age_days);
  const card = waiting.length > 0 && (
    <SectionCard title="You're waiting on" meta={`${waiting.length} open`} action={waiting.length > HOME_ROWS ? <a className="home-all" href="#/tasks?show=waiting">View all {waiting.length} →</a> : undefined} flush>
      {error && <Banner tone="danger">{error}</Banner>}
      <DigestList
        items={waiting.map((w) => ({
          id: w.identifier,
          face: <Monogram name={w.title} size={24} />,
          text: w.title,
          title: w.title,
          meta: w.quiet_days >= 3 ? `${w.quiet_days}d quiet` : `${w.age_days}d`,
          onOpen: () => open(w.identifier),
          active: opened === w.identifier,
          actions: (
            <>
              <Button size="sm" variant="primary" title="It arrived: close it" onClick={() => close(w.identifier, "done")}>Done</Button>
              <Button size="sm" variant="quiet" title="Hide it until tomorrow morning" onClick={() => later(w)}>Later</Button>
              <Button size="sm" variant="quiet" title="No longer waiting on it: cancel the task" onClick={() => close(w.identifier, "cancelled")}>Dismiss</Button>
            </>
          ),
        }))}
        limit={HOME_ROWS}
      />
    </SectionCard>
  );
  return { card, rows: waiting, close, later };
}

/** Today's calendar: each event opens its meeting (the video call, else the calendar page) in a new tab. */
function TodayCard({ today }: { today: NonNullable<Home["world"]["today"]> }) {
  return (
    <SectionCard title="Today" meta={`${today.events.length} event${today.events.length === 1 ? "" : "s"}`} flush>
      <DigestList
        items={today.events.map((e) => ({ id: e.id, face: <span className="home-time">{e.all_day ? "All day" : timeIn(today.timezone, new Date(e.start))}</span>, text: e.title, external: e.url, link: e.prep ? { label: "Prep ready", href: `#/t/${e.prep}` } : undefined }))}
        limit={today.events.length}
      />
    </SectionCard>
  );
}

/** The whole team (those with news first), then Hire a teammate (#/team/hire). */
function TeamRow({ team }: { team: Home["team"] }) {
  return (
    <section className="home-team enter" style={{ "--i": 4 } as CSSProperties} aria-label="Your team">
      <header className="home-team-head">
        <h2 className="home-h2">Your team</h2>
        <a className="home-team-all" href="#/team">See the whole team →</a>
      </header>
      <div className="home-team-grid">
        {team.map((t) => (
          <Tile key={t.teammate.key} href={`#/team/${t.teammate.key}`} name={t.teammate.key} title={`${t.teammate.name} · ${t.teammate.job}`} face={face(t.teammate, 40)}>
            {t.line}
          </Tile>
        ))}
        <Tile tone="ghost" href="#/team/hire" name="hire" title="Hire a teammate" face={<span className="home-plus" aria-hidden>+</span>}>
          Security, repo upkeep, or describe your own.
        </Tile>
      </div>
    </section>
  );
}

/** Home's shape while its one read is on its way: the grid's blocks, never a spinner. */
function HomeSkeleton({ error, retry }: { error: string; retry: () => void }) {
  return (
    <Page className="home" label="Home">
      <header className="home-head">
        <Bone w={180} h={14} />
        <Bone w="min(640px, 90%)" h={34} />
      </header>
      {error && (
        <Banner tone="danger" action={<Button size="sm" onClick={retry}>Retry</Button>}>
          Couldn't load Home: {error}
        </Banner>
      )}
      <div className="home-pair" aria-busy="true" aria-label="Loading">
        <Bone h={340} className="home-bone" />
        <div className="home-side">
          <Bone h={190} className="home-bone" />
          <Bone h={130} className="home-bone" />
        </div>
      </div>
    </Page>
  );
}
