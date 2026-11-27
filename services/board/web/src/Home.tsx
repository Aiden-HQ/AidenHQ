// Home (#/): the board's front page. What needs the owner, answered in place (J/K, E, S); what the team did since he last
// looked; his world (who he waits on, today's calendar); the teammates with news; one idea. One read (GET /api/home), and a
// block with no source or no data is left out, never shown empty. #/approvals/<id> opens that card in the detail pane.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnswerForm } from "./AnswerForm";
import { HttpStatusError, SignInRequired, api, type Session } from "./api";
import { ApprovalCard, BatchBar, Decide } from "./ApprovalCard";
import { useLive } from "./events";
import { askForNotifications, notificationsSupported } from "./notify";
import { doneAction, formOnly, useNeedsKeys } from "./needs";
import { QUERIES, homeFrom, useQuery } from "./queries";
import { MoreTeam, NextUp, WelcomeStepper } from "./GettingStarted";
import { Bone } from "./Skeleton";
import { TaskCheck, useCheckOff } from "./MyTasks";
import { chipOf } from "./own-tasks";
import type { Approval, Board, Card, FaceRef, Home, NeedRow, SinceItem } from "./types";
import { Banner, Button, DecisionRow, DetailPane, DigestList, Face, Kbd, Monogram, Page, SectionCard, TeammateChip, Tile, faceProps } from "./ui";
import { ago, clockOpts, clockText } from "./util";
import "./home.css";

type Toast = (text: string, action?: { label: string; run: () => void }) => void;
/** A row answered, decided or snoozed on this visit: its receipt, and the row itself (kept on screen after a refetch drops it). */
type Receipt = { text: string; onUndo?: () => void; row: NeedRow };
/** A receipt's key and a row's snooze key (home.ts): an answer row's task and wait (a follow-up question on the same task is a new row), else the row's id. */
const rkey = (r: NeedRow) => (r.kind === "answer" ? `${r.id}:${r.waitSince}` : r.id);
/** What the detail pane shows: a Needs row, or a card that isn't in Needs (#/approvals/<id>). */
type Pane = { kind: "row"; id: string } | { kind: "card"; id: string } | null;

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
const linkOf = (task: string | null) => (task ? { label: "Open", href: `#/t/${task}` } : undefined);

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
  const [pane, setPane] = useState<Pane>(null);
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
  const live = rows.filter((r) => !receipts.has(rkey(r)));

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
  // On a phone the pane is a full-screen sheet over Home: what is behind it hasn't been seen (a row's pane closes when the row leaves).
  const sheetOpen = !!pane && (pane.kind !== "row" || rows.some((r) => r.id === pane.id));
  const sinceReady = !data?.since || (sinceInView && !(mobile && sheetOpen));
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
  const paneOpen = !!pane && (pane.kind !== "row" || !!paneRow);
  const since = data.since && <SinceCard since={data.since} timezone={timezone} from={data.since_from} />;
  const idea = data.idea && <IdeaCard idea={data.idea} fail={fail} reload={reload} />;
  // Needs takes the full width when nothing sits beside it (the pane, Next up), so its edges line up with the sections below.
  const sideEmpty = !(paneOpen && !mobile) && !data.start?.nextUp;
  // Needs you shows only while something is in it (or a receipt from this visit); empty, the box is left out.
  const needsShown = rows.length > 0;
  // The rows still open here: an answered row leaves the count at once, before the kernel catches up.
  const n = live.length;
  // On a phone the pane is a full-screen sheet: outside the animated column, whose transform would hold a fixed child.
  const detail = paneOpen && (
    <DetailPane open title="Details" onClose={closePane}>
      {pane?.kind === "row" && paneRow && <RowDetail row={paneRow} answer={answer} done={done} receipt={receipts.get(rkey(paneRow))} />}
      {pane?.kind === "card" && <CardAlone key={pane.id} id={pane.id} />}
    </DetailPane>
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
      {(needsShown || !sideEmpty) && <div className={sideEmpty || !needsShown ? "home-top home-top-solo" : "home-top"}>
        {needsShown && <div className="home-needs enter" style={{ "--i": 1 } as CSSProperties}>
          <SectionCard
            title="Needs you"
            count={live.length || undefined}
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
              </>
            }
          >
            <div role="listbox" aria-label="Needs you" aria-activedescendant={keys.at ? `need-${keys.at}` : undefined} tabIndex={-1}>
              {rows.map((r, i) => (
                <div key={rkey(r)} id={`need-${r.id}`} role="option" aria-selected={keys.at === r.id} onClick={() => keys.setAt(r.id)}>
                  <DecisionRow
                    face={r.kind === "open" && r.reply?.person ? <Monogram name={r.reply.person} size={40} /> : face(r.teammate, 40, "needs")}
                    who={(r.kind === "open" && r.reply?.person) || r.teammate.name}
                    role={r.kind === "open" && r.reply ? replyRole(r.reply) : r.teammate.job}
                    question={r.question}
                    detail={r.kind === "answer" ? r.detail : undefined}
                    meta={r.kind === "open" && r.reply ? `Waiting ${ago(r.since)}` : ago(r.since)}
                    active={keys.at === r.id || (pane?.kind === "row" && pane.id === r.id)}
                    onOpen={() => (keys.setAt(r.id), setPane({ kind: "row", id: r.id }))}
                    i={i}
                    receipt={receipts.get(rkey(r)) ?? null}
                    actions={<RowActions row={r} answer={answer} decided={decided} snooze={snooze} done={done} open={() => setPane({ kind: "row", id: r.id })} pick={selecting && r.kind === "approval" ? { on: picked.includes(r.id), toggle: () => setPicked((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id])) } : undefined} />}
                  />
                </div>
              ))}
            </div>
            {selecting && chosen.length > 0 && (
              <BatchBar cards={chosen} busy={batching} setBusy={setBatching} hold={false} done={(failed) => (setUnbatched(failed.map((f) => f.why)), approvals.filter((r) => picked.includes(r.id) && !failed.some((f) => f.id === r.card.id)).forEach((r) => receipt(r, { text: "Decided" })), setPicked([]), void reload())} />
            )}
          </SectionCard>
        </div>}
        {!sideEmpty && <div className="home-side enter" style={{ "--i": 2 } as CSSProperties}>
          {paneOpen && !mobile ? detail : data.start?.nextUp && <NextUp next={data.start.nextUp} reload={reload} />}
        </div>}
      </div>}
      {mobile && detail}
      {data.start && <MoreTeam more={data.start.more} />}
      {day && onDone && <YourDay day={day} onDone={onDone} />}
      <World world={data.world} reload={reload} />
      {/* What changed is a glance, not a call to act: below the work, with the idea beside it, just above the team. */}
      {(since || idea) && (
        <div className="home-pair enter" style={{ "--i": 4 } as CSSProperties}>
          {since && <div ref={setSinceEl} className="home-pair-cell">{since}</div>}
          {idea && <div className="home-pair-cell">{idea}</div>}
        </div>
      )}
      <TeamRow team={data.team} />
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

/** A row's buttons by kind: the options (first is primary), Approve and Reject, or Open and Mark done; Not now snoozes. */
function RowActions({ row, answer, decided, snooze, done, open, pick }: { row: NeedRow; answer: (r: NeedRow & { kind: "answer" }, t: string) => Promise<void>; decided: (r: NeedRow, d: "approve" | "reject") => void; snooze: (r: NeedRow) => Promise<void>; done: (r: NeedRow) => Promise<void>; open: () => void; pick?: { on: boolean; toggle: () => void } }) {
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<void>) => async () => {
    setBusy(true);
    // A failed answer was already said (a toast); the buttons come back for another try.
    await f().catch(() => {});
    setBusy(false);
  };
  if (row.kind === "approval")
    return (
      <>
        {pick && (
          <label className="approval-pick">
            <input type="checkbox" checked={pick.on} onChange={pick.toggle} /> <span>Select</span>
          </label>
        )}
        <Decide a={row.card} onDecided={(d) => decided(row, d)} />
        {row.card.reads && <span className="home-reads">{row.card.reads}</span>}
      </>
    );
  if (row.kind === "open")
    return (
      <>
        {row.reply ? <Button variant="primary" className="press" onClick={() => (location.hash = `#/t/${row.task.identifier}`)}>Open</Button> : <Button variant="primary" className="press" onClick={open}>Open</Button>}
        <Button className="press" disabled={busy} onClick={run(() => done(row))}>Mark done</Button>
        {row.reply && <Button variant="quiet" className="press" disabled={busy} onClick={run(() => snooze(row))}>Not now</Button>}
      </>
    );
  const notNow = row.options.find((o) => /^not now$/i.test(o));
  // Several questions, or one taking several options, are answered in the pane's form: an answer claims the whole wait.
  if (formOnly(row))
    return (
      <>
        <Button variant="primary" className="press" onClick={open}>Answer</Button>
        <Button variant="quiet" className="press" disabled={busy} onClick={run(() => snooze(row))}>Not now</Button>
      </>
    );
  return (
    <>
      {row.options.map((o, i) => (
        <Button key={o} variant={i === 0 ? "primary" : o === notNow ? "quiet" : "default"} className="press" disabled={busy} onClick={run(() => answer(row, o))}>
          {o}
        </Button>
      ))}
      <Button variant="quiet" className="press" onClick={open}>Something else…</Button>
      {!notNow && <Button variant="quiet" className="press" disabled={busy} onClick={run(() => snooze(row))}>Not now</Button>}
    </>
  );
}

/** A row in the pane: the question, the full draft, the task, and every question of the ask (or the whole card). */
function RowDetail({ row, answer, done, receipt }: { row: NeedRow; answer: (r: NeedRow & { kind: "answer" }, t: string) => Promise<void>; done: (r: NeedRow) => Promise<void>; receipt?: Receipt }) {
  return (
    <div className="home-detail">
      <div className="home-detail-who">
        {chip(row.teammate, 32)}
        {row.task && <a href={`#/t/${row.task.identifier}`}>{row.task.title}</a>}
      </div>
      <h3>{row.question}</h3>
      {row.kind === "answer" && row.detail && <blockquote className="home-draft">{row.detail}</blockquote>}
      {receipt ? (
        <p className="home-done" role="status">{receipt.text}</p>
      ) : row.kind === "answer" ? (
        <AnswerForm key={row.waitSince} questions={row.questions.length ? row.questions : [{ question: row.question, options: row.options }]} askedAbove onAnswer={(t) => answer(row, t)} />
      ) : row.kind === "approval" ? (
        <ul className="approval-list">
          <ApprovalCard a={row.card} open={(id) => (location.hash = `#/t/${id}`)} unfold />
        </ul>
      ) : (
        <div className="home-detail-actions">
          <Button variant="primary" onClick={() => void done(row)}>Mark done</Button>
        </div>
      )}
    </div>
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
      {all ? <SinceAll items={since.items} total={since.total} /> : <DigestList items={since.groups.map((g) => ({ id: g.teammate.key, face: face(g.teammate, 24, "idle"), text: g.count > 1 ? <>{g.latest.text} <span className="home-more">+{g.count - 1} more</span></> : g.latest.text, link: linkOf(g.latest.task) }))} limit={3} />}
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
          <DigestList items={g.map((i, n) => ({ id: `${i.at}-${n}`, text: <>{i.text} <span className="home-more">{ago(i.at)}</span></>, link: linkOf(i.task) }))} limit={g.length} />
        </section>
      ))}
    </div>
  );
}

function IdeaCard({ idea, fail, reload }: { idea: NonNullable<Home["idea"]>; fail: (e: unknown, what: string) => void; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const say = async (text: string) => {
    setBusy(true);
    try {
      await api.answer(idea.identifier, text, idea.waitSince);
      await reload();
    } catch (e) {
      fail(e, "answer");
    }
    setBusy(false);
  };
  const yes = idea.options.find((o) => !/^not now$/i.test(o));
  return (
    <SectionCard title="Idea for you" meta={chip(idea.teammate, 20)}>
      <p className="home-idea">{idea.question}</p>
      <div className="home-idea-actions">
        {yes && <Button variant="primary" className="press" disabled={busy} onClick={() => void say(yes)}>{yes}</Button>}
        <Button variant="quiet" className="press" disabled={busy} onClick={() => void say("Not now")}>Not now</Button>
      </div>
    </SectionCard>
  );
}

/** Who the owner waits on and today's calendar: each only with a source and something in it. */
function World({ world, reload }: { world: Home["world"]; reload: () => Promise<void> }) {
  const tz = world.today?.timezone;
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
  const waiting = world.waiting_on?.filter((w) => !closed.has(w.identifier)) ?? [];
  if (!waiting.length && !world.today?.events.length) return null;
  return (
    <section className="home-world enter" style={{ "--i": 3 } as CSSProperties} aria-label="Your world">
      <h2 className="home-h2">Your world</h2>
      <div className="home-world-grid">
        {waiting.length > 0 && (
          <SectionCard title="You're waiting on" count={undefined} meta={`${waiting.length} open`} flush>
            {error && <Banner tone="danger">{error}</Banner>}
            <DigestList
              items={waiting.map((w) => ({
                id: w.identifier,
                face: <Monogram name={w.title} size={26} />,
                text: w.title,
                link: { label: w.quiet_days >= 3 ? `${w.quiet_days}d quiet` : `${w.age_days}d`, href: `#/t/${w.identifier}` },
                actions: (
                  <>
                    <Button size="sm" variant="quiet" title="It arrived: close it" onClick={() => close(w.identifier, "done")}>Done</Button>
                    <Button size="sm" variant="danger" title="No longer waiting on it: cancel the task" onClick={() => close(w.identifier, "cancelled")}>Drop</Button>
                  </>
                ),
              }))}
              limit={waiting.length}
            />
          </SectionCard>
        )}
        {world.today && world.today.events.length > 0 && (
          <SectionCard title="Today" meta={`${world.today.events.length} event${world.today.events.length === 1 ? "" : "s"}`} flush>
            <DigestList
              items={world.today.events.map((e) => ({ id: e.id, face: <span className="home-time">{e.all_day ? "All day" : timeIn(tz!, new Date(e.start))}</span>, text: e.title, link: e.prep ? { label: "Prep ready", href: `#/t/${e.prep}` } : undefined }))}
              limit={world.today.events.length}
            />
          </SectionCard>
        )}
      </div>
    </section>
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
      <div className="home-top" aria-busy="true" aria-label="Loading">
        <Bone h={340} className="home-bone" />
        <div className="home-side">
          <Bone h={190} className="home-bone" />
          <Bone h={130} className="home-bone" />
        </div>
      </div>
    </Page>
  );
}
