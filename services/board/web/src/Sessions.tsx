import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { chatQuery, QUERIES, useQuery } from "./queries";
import { Markdown } from "./markdown";
import { Bone } from "./Skeleton";
import type { ChatMessage, SessionRow, SessionState } from "./types";
import { Banner, Button, Card, Dialog, EmptyState, Facts, Field, Input, LinkButton, Page, PageHeader, Section, Segmented, StatusDot, type StatusTone } from "./ui";
import { agoLabel } from "./util";
import { Icon } from "./ui/icons";
import "./sessions.css";

// Sessions (#/sessions, #/sessions/<identifier>): long-lived coding harnesses on the always-on computer, each held by one task.
// The list shows what each is doing, what it waits for, who started it and what it cost; a session opens as a real terminal
// (ttyd through the board, only for the account that started it) beside its task thread; phones get the harness's web UI.

const STATE: Record<SessionState, { tone: StatusTone; word: string }> = {
  starting: { tone: "busy", word: "Starting" },
  running: { tone: "working", word: "Working" },
  waiting: { tone: "info", word: "Waiting" },
  stopped: { tone: "idle", word: "Stopped" },
  error: { tone: "failed", word: "Failed" },
};
const live = (s: SessionRow) => s.state === "starting" || s.state === "running" || s.state === "waiting";
const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
/** What it is doing, or why it is quiet, in one line. */
function doing(s: SessionRow): string {
  if (s.state === "running") return s.last_activity?.text ?? "Working";
  if (s.state === "waiting") return s.last_activity ? `Asleep, using no tokens. Last: ${s.last_activity.text}` : "Asleep, using no tokens. A comment wakes it.";
  if (s.state === "starting") return "The computer is preparing its folder and the harness.";
  if (s.state === "error") return s.error ?? "The session failed.";
  return s.last_activity?.text ?? "Ended.";
}
const POLL_MS = 5_000;
/** Ended sessions listed before "Show more". */
const ENDED_PAGE = 12;

export function SessionsView({ open, fresh, mobile, prefix, go, onSignIn, onChanged }: { open?: string; fresh?: boolean; mobile: boolean; prefix: string; go: (hash: string) => void; onSignIn: () => void; onChanged: () => void }) {
  const { data, error, reload } = useQuery(QUERIES.sessions, onSignIn);
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [reload]);
  const [starting, setStarting] = useState(false);
  const [endedShown, setEndedShown] = useState(ENDED_PAGE);
  const sessions = data?.sessions;
  if (data && !data.enabled)
    return (
      <Page>
        <PageHeader title="Sessions" sub="Real coding agents that keep working while you are away." />
        <EmptyState action={<LinkButton href="#/modules/sessions">Open the Sessions module</LinkButton>}>The sessions module isn't installed on this instance.</EmptyState>
      </Page>
    );
  if (open) return <SessionPage ident={open} error={error} fresh={fresh} row={sessions?.find((s) => s.identifier === open)} loaded={!!data} mobile={mobile} prefix={prefix} go={go} onSignIn={onSignIn} reload={() => void reload().then(onChanged)} />;

  const active = (sessions ?? []).filter(live).sort((a, b) => ["running", "starting", "waiting"].indexOf(a.state) - ["running", "starting", "waiting"].indexOf(b.state) || Date.parse(b.started_at) - Date.parse(a.started_at));
  const ended = (sessions ?? []).filter((s) => !live(s)).sort((a, b) => Number(b.state === "error") - Number(a.state === "error") || Date.parse(b.ended_at ?? b.started_at) - Date.parse(a.ended_at ?? a.started_at));
  const working = active.filter((s) => s.state === "running").length;
  const sub = !sessions ? "Looking for sessions…" : !sessions.length ? "Real coding agents that keep working while you are away." : `${working} working, ${active.length - working} waiting or starting. A waiting session costs no tokens until something wakes it.`;
  return (
    <Page>
      <PageHeader title="Sessions" sub={sub} actions={sessions?.length ? <Button variant="primary" onClick={() => setStarting(true)}><Icon name="plus" />Start a session</Button> : undefined} />
      {error && <Banner tone="danger" action={<Button size="sm" onClick={() => void reload()}>Try again</Button>}>Couldn't load sessions: {error}</Banner>}
      {!sessions ? (
        !error && <div className="ses-list" aria-busy="true">{[0, 1, 2].map((i) => <RowSkeleton key={i} />)}</div>
      ) : !sessions.length ? (
        <FirstSession onStart={() => setStarting(true)} />
      ) : (
        <>
          {active.length > 0 && <Section title="Active" count={active.length}><div className="ses-list">{active.map((s) => <Row key={s.task} s={s} />)}</div></Section>}
          {!active.length && <EmptyState action={<Button variant="primary" onClick={() => setStarting(true)}>Start a session</Button>}>Nothing is running. Start a session to put a coding agent to work.</EmptyState>}
          {ended.length > 0 && (
            <Section title="Ended" count={ended.length}>
              <div className="ses-list">{ended.slice(0, endedShown).map((s) => <Row key={s.task} s={s} />)}</div>
              {ended.length > endedShown && <div><Button onClick={() => setEndedShown((n) => n + ENDED_PAGE)}>Show {Math.min(ENDED_PAGE, ended.length - endedShown)} more</Button></div>}
            </Section>
          )}
        </>
      )}
      <StartDialog open={starting} agent={data?.agent ?? null} onClose={() => setStarting(false)} onStarted={(ident) => (setStarting(false), onChanged(), go(`#/sessions/${ident}?new=1`))} />
    </Page>
  );
}

function RowSkeleton() {
  return (
    <div className="ses-row" aria-hidden>
      <Bone w={84} />
      <div className="ses-main"><Bone w="48%" h={14} /><Bone w="72%" /></div>
      <Bone w="70%" className="ses-doing-col" />
      <Bone w={70} className="ses-by" />
      <Bone w={44} className="ses-cost" />
      <Bone w={52} className="ses-when" />
    </div>
  );
}

function Row({ s }: { s: SessionRow }) {
  const st = STATE[s.state];
  return (
    <a className={`ses-row ses-${s.state}`} href={`#/sessions/${s.identifier}`}>
      <StatusDot tone={st.tone}>{st.word}</StatusDot>
      <div className="ses-main">
        <div className="ses-title">
          <span className="ses-name" title={s.title}>{s.title}</span>
          <code>{s.identifier}</code>
        </div>
        <div className="ses-doing ses-doing-under">{doing(s)}</div>
      </div>
      <span className="ses-doing ses-doing-col" title={doing(s)}>{doing(s)}</span>
      <span className="ses-by" title={`Started by ${s.creator.name}`}>{s.creator.name}</span>
      <span className="ses-cost" title="Spend so far">{usd(s.cost_usd)}</span>
      <time className="ses-when" dateTime={s.started_at} title={`Started ${new Date(s.started_at).toLocaleString()}`}>{agoLabel(live(s) ? s.started_at : s.ended_at ?? s.started_at)}</time>
    </a>
  );
}

/** A fresh install: what a session is, with the console it opens drawn out, and the one way to start. */
function FirstSession({ onStart }: { onStart: () => void }) {
  return (
    <div className="ses-first">
      <div className="ses-first-copy">
        <h2>Put a coding agent to work on your own computer</h2>
        <p>A session is a real coding agent with its own folder, a terminal you can open from any browser and the same tools Aiden has. Tell it what to do, close the tab and come back later.</p>
        <ul>
          <li><b>Waiting is free.</b> It can watch a pull request or a timer and sleeps at zero tokens until it fires.</li>
          <li><b>Yours alone.</b> Only the person who started a session can open its terminal.</li>
          <li><b>On your phone too.</b> The same session opens in the harness's web view.</li>
        </ul>
        <div><Button variant="primary" onClick={onStart}><Icon name="plus" />Start a session</Button></div>
      </div>
      <div className="ses-first-term" aria-hidden>
        <div className="ses-term-bar"><i /><i /><i /><span>session</span></div>
        <pre>{`$ opencode
> Watch acme/widgets#412. When it merges,
  merge #413 and tell me.

  Armed a watch on #412.
  Going to sleep: no tokens until it fires.`}<span className="ses-caret" /></pre>
      </div>
    </div>
  );
}

function StartDialog({ open, agent, onClose, onStarted }: { open: boolean; agent: string | null; onClose: () => void; onStarted: (identifier: string) => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const repoBad = repo.trim() !== "" && !/^[\w.-]+\/[\w.-]+$/.test(repo.trim());
  const ready = !!agent && !!title.trim() && !repoBad && !busy;
  const made = useRef<{ id: string; identifier: string } | null>(null);
  async function start() {
    if (!ready || !agent) return;
    setBusy(true);
    setError("");
    try {
      // The board's ordinary task path: the task is yours, so the terminal is too. A retry reuses the task already made.
      const task = made.current ?? (made.current = await api.create(title.trim(), "triage"));
      const instruction = [text.trim() || title.trim(), repo.trim() && `Work in the repository ${repo.trim()}.`].filter(Boolean).join("\n\n");
      // The agent's own part of the task is the session: open that one.
      const view = await api.addAgent(task.id, agent, instruction);
      const part = view.crew?.find((c) => c.agent === agent)?.issues[0]?.identifier ?? task.identifier;
      made.current = null;
      setTitle(""), setText(""), setRepo("");
      onStarted(part);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title="Start a session" actions={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" disabled={!ready} onClick={() => void start()}>{busy ? "Starting…" : "Start session"}</Button></>}>
      <form className="ses-form" onSubmit={(e) => (e.preventDefault(), void start())}>
        {!agent && <Banner tone="warn">The Session agent isn't set up on this instance yet.</Banner>}
        <Field label="Name">{(id) => <Input id={id} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Merge the widgets stack" maxLength={120} />}</Field>
        <Field label="First instruction" help="What to do, and what to report back. Leave empty to use the name.">
          {(id, d) => <textarea id={id} aria-describedby={d} className="ses-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), void start())} placeholder="Watch acme/widgets#412. When it merges, merge #413 and tell me here." />}
        </Field>
        <Field label="Repository (optional)" error={repoBad ? "Use org/name, like acme/widgets." : null}>
          {(id) => <Input id={id} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="acme/widgets" aria-invalid={repoBad} spellCheck={false} />}
        </Field>
        {error && <Banner tone="danger">Couldn't start it: {error}</Banner>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ one session

type Mode = "term" | "web";
type Link = "connecting" | "live" | "reconnecting" | "lost";

function SessionPage({ ident, error, fresh, row, loaded, mobile, prefix, go, onSignIn, reload }: { ident: string; error: string; fresh?: boolean; row?: SessionRow; loaded: boolean; mobile: boolean; prefix: string; go: (hash: string) => void; onSignIn: () => void; reload: () => void }) {
  const [mode, setMode] = useState<Mode>(mobile ? "web" : "term");
  const [panel, setPanel] = useState<"session" | "thread" | "details">("session");
  const [stopping, setStopping] = useState(false);
  const [copied, setCopied] = useState(false);
  // The message being typed lives here: the phone's panel switch unmounts the thread.
  const [draft, setDraft] = useState("");
  const crumb = <><a href="#/sessions">Sessions</a> / {ident}</>;
  // Just started: the kernel admits the job in a moment, so the row isn't there yet.
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (row || !fresh) return;
    const t = setInterval(() => setWaited((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [row, fresh]);
  if (!row) {
    const stuck = fresh && waited > 45;
    return (
      <Page>
        <PageHeader crumb={crumb} title={ident} sub={!error && (!loaded || (fresh && !stuck)) ? "Starting the session…" : undefined} />
        {error ? <Banner tone="danger" action={<Button size="sm" onClick={reload}>Try again</Button>}>Couldn't load sessions: {error}</Banner> : !loaded || (fresh && !stuck) ? (
          <div className="ses-stage" aria-busy="true"><Bone h={14} w="30%" /><Bone h={14} w="55%" /></div>
        ) : (
          <EmptyState action={<LinkButton href="#/sessions">All sessions</LinkButton>}>{stuck ? `${ident} hasn't started a session yet. Its task is in Tasks; the session agent may be busy or paused.` : `There is no session ${ident}.`}</EmptyState>
        )}
      </Page>
    );
  }
  const st = STATE[row.state];
  // The page's own address: a phone that isn't signed in signs in first, then lands on this session.
  const phoneLink = () => void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#/sessions/${row.identifier}`).then(() => (setCopied(true), setTimeout(() => setCopied(false), 2000)));
  const console_ = <Console row={row} mode={mode} setMode={setMode} mobile={mobile} />;
  const thread = <Thread row={row} prefix={prefix} onSignIn={onSignIn} text={draft} setText={setDraft} />;
  const details = <Details row={row} go={go} />;
  return (
    <Page className="ses-page">
      <PageHeader
        crumb={crumb}
        title={row.title}
        status={<><StatusDot tone={st.tone}>{st.word}</StatusDot><span>Started by {row.creator.name} {agoLabel(row.started_at)}</span></>}
        actions={
          <>
            {row.mine && live(row) && <Button onClick={phoneLink}><Icon name="phone" />{copied ? "Link copied" : "Copy phone link"}</Button>}
            {live(row) && <Button variant="quiet" onClick={() => setStopping(true)}><Icon name="stop" />Stop</Button>}
          </>
        }
      />
      {row.state === "error" && <Banner tone="danger">{row.error ?? "The session failed."} Start a new session to continue; its task keeps the history.</Banner>}
      {mobile ? (
        <>
          <Segmented label="Session part" value={panel} onChange={setPanel} options={[["session", "Session"], ["thread", "Thread"], ["details", "Details"]]} />
          <div className="ses-mobile">{panel === "session" ? console_ : panel === "thread" ? thread : details}</div>
        </>
      ) : (
        <div className="ses-split">
          <div className="ses-left">{console_}</div>
          <div className="ses-rail">{details}{thread}</div>
        </div>
      )}
      <StopDialog open={stopping} row={row} onClose={() => setStopping(false)} onStopped={() => (setStopping(false), reload())} />
    </Page>
  );
}

function StopDialog({ open, row, onClose, onStopped }: { open: boolean; row: SessionRow; onClose: () => void; onStopped: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog open={open} onClose={onClose} title="Stop this session?" actions={<><Button onClick={onClose}>Keep it running</Button><Button variant="danger" disabled={busy} onClick={() => { setBusy(true); setError(""); api.stop(row.identifier).then(onStopped, (e: Error) => setError(e.message)).finally(() => setBusy(false)); }}>Stop session</Button></>}>
      <p>{row.title} ends: its harness and terminal end. The folder and the task thread stay.</p>
      {error && <Banner tone="danger">{error}</Banner>}
    </Dialog>
  );
}

/** The terminal (ttyd) or the harness's web view in a frame, with the link's own state: connecting, live, reconnecting, lost. */
function Console({ row, mode, setMode, mobile }: { row: SessionRow; mode: Mode; setMode: (m: Mode) => void; mobile: boolean }) {
  const [nonce, setNonce] = useState(0);
  const [link, setLink] = useState<Link>("connecting");
  /** The signed paths the frame loaded with (they last 10 minutes: a 401 below loads the frame again with new ones). */
  const [frame, setFrame] = useState<{ term: string; web: string } | null>(null);
  const down = useRef(0);
  const usable = row.mine && live(row) && row.state !== "starting";
  const mint = useCallback(() => api.sessionOpen(row.task), [row.task]);
  useEffect(() => {
    if (!usable) return;
    let off = false;
    setLink("connecting");
    mint().then((p) => !off && setFrame(p), () => !off && (down.current = 3, setLink("lost")));
    return () => {
      off = true;
    };
  }, [usable, nonce, mint]);
  // Probe the proxy (headers only) while the pane is open: is the session's computer answering? A frame can't report its own
  // socket (it runs sandboxed), so a dead terminal is noticed here instead of sitting on a frozen screen. The probe uses the
  // frame's own path: an expired one (401) reloads the frame with a new one.
  useEffect(() => {
    if (!usable || !frame) return;
    down.current = 0;
    let stopped = false;
    const tick = async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      let ok = false, expired = false;
      try {
        const r = await fetch(frame[mode], { cache: "no-store", headers: { range: "bytes=0-0" }, signal: ctl.signal });
        ok = r.ok || r.status === 206;
        expired = r.status === 401;
        ctl.abort();
      } catch {
        ok = false;
      }
      clearTimeout(timer);
      if (stopped) return;
      if (expired) return setNonce((n) => n + 1);
      if (ok) {
        // Back after a gap: the frame's own socket is dead, so load it again.
        if (down.current > 0) setNonce((n) => n + 1);
        down.current = 0;
        setLink("live");
      } else {
        down.current += 1;
        setLink(down.current >= 3 ? "lost" : "reconnecting");
      }
    };
    void tick();
    const t = setInterval(() => document.visibilityState === "visible" && void tick(), 4000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [frame, mode, usable]);
  const fullScreen = () => {
    const w = window.open("", "_blank");
    if (!w) return;
    w.opener = null;
    mint().then((p) => (w.location.href = p[mode]), () => w.close());
  };

  const word = { connecting: "Checking", live: "Online", reconnecting: "Retrying", lost: "Offline" }[link];
  const tone: StatusTone = link === "live" ? "ok" : link === "lost" ? "failed" : "busy";
  const src = frame?.[mode];
  return (
    <div className={`ses-console${usable ? "" : " off"}`}>
      <div className="ses-bar">
        <Segmented label="View" value={mode} onChange={setMode} options={[["term", "Terminal"], ["web", mobile ? "Chat view" : "Web view"]]} />
        <span className="ses-bar-fill" />
        {usable && <span className={`ses-link ses-link-${link}`} title="Whether the board can reach the session's computer"><StatusDot tone={tone}>{word}</StatusDot></span>}
        {usable && <Button size="sm" variant="quiet" onClick={() => setNonce((n) => n + 1)} title="Load the frame again" aria-label="Reload"><Icon name="refresh" /><span className="ses-lbl">Reload</span></Button>}
        {usable && <Button size="sm" variant="quiet" onClick={fullScreen} title="Open in its own tab" aria-label="Full screen"><span className="ses-lbl">Full screen</span> <Icon name="external" size={14} /></Button>}
      </div>
      <div className="ses-screen">
        {usable && src && link !== "lost" && <iframe key={`${src}|${nonce}`} title={mode === "term" ? "Session terminal" : "Session web view"} src={src} sandbox="allow-scripts allow-forms allow-popups allow-downloads" allow="clipboard-write" />}
        {usable && link === "reconnecting" && <div className="ses-veil soft" role="status"><i />Reconnecting to the {mode === "term" ? "terminal" : "web view"}…</div>}
        {usable && link === "lost" && (
          <div className="ses-veil" role="alert">
            <b>The {mode === "term" ? "terminal" : "web view"} isn't answering</b>
            <span>The session may be restarting after an update. Its work is kept; the harness resumes the same conversation.</span>
            <Button variant="primary" onClick={() => (down.current = 0, setLink("connecting"), setNonce((n) => n + 1))}>Reconnect</Button>
          </div>
        )}
        {!usable && <Veil row={row} />}
      </div>
    </div>
  );
}

/** Why there is no terminal: it hasn't started, it ended, or it isn't yours. */
function Veil({ row }: { row: SessionRow }) {
  if (!row.mine)
    return <div className="ses-veil"><b>This session belongs to {row.creator.name}</b><span>Only the person who started a session can open its terminal. You can still read its thread.</span></div>;
  if (row.state === "starting")
    return <div className="ses-veil"><i /><b>Starting the session</b><span>The computer is preparing its folder and the harness. The terminal opens here in a few seconds.</span></div>;
  if (row.state === "error")
    return <div className="ses-veil"><b>The session failed</b><span>Its folder stays on the computer and the task thread has the history. Start a new session to pick the work up.</span></div>;
  return <div className="ses-veil"><b>This session ended {agoLabel(row.ended_at ?? row.started_at)}</b><span>Its folder stays on the computer. Start a new session to pick the work up again.</span></div>;
}

function Details({ row, go }: { row: SessionRow; go: (hash: string) => void }) {
  return (
    <>
      <Card>
        <Facts
          items={[
            live(row) && ["Doing", doing(row)],
            row.last_activity && ["Last activity", <time key="a" dateTime={row.last_activity.at}>{agoLabel(row.last_activity.at)}</time>],
            ["Spend", usd(row.cost_usd)],
            ["Started by", `${row.creator.name}${row.creator.kind === "agent" ? " (agent)" : ""}`],
            ["Started", <time key="s" dateTime={row.started_at}>{new Date(row.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>],
                        ["Task", <a key="t" href={`#/t/${row.identifier}`} onClick={(e) => (e.preventDefault(), go(`#/t/${row.identifier}`))}>{row.identifier}</a>],
          ]}
        />
      </Card>
    </>
  );
}

const who = (m: ChatMessage) => (m.kind === "owner" ? m.by ?? "You" : m.kind === "reply" ? m.agent : m.kind === "notes" ? m.agent : "Update");
const words = (m: ChatMessage) => (m.kind === "notes" ? m.notes.map((n) => n.text).join("\n\n") : m.text);

/** The task's thread: what was said to the session and what it answered, and a box to say more (it wakes the session). */
function Thread({ row, prefix, onSignIn, text, setText }: { row: SessionRow; prefix: string; onSignIn: () => void; text: string; setText: React.Dispatch<React.SetStateAction<string>> }) {
  const q = useMemo(() => chatQuery(row.identifier), [row.identifier]);
  const { data, reload } = useQuery(q, onSignIn);
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [reload]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const messages = (data?.messages ?? []).filter((m) => words(m).trim());
  const send = useCallback(async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.comment(row.identifier, body, false, true);
      // What was typed while it sent stays.
      setText((cur) => (cur === body ? "" : cur));
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [text, busy, row.identifier, reload]);
  const open = live(row);
  return (
    <Section title="Thread" count={messages.length || undefined} className="ses-thread">
      <div className="ses-msgs" aria-label="Task thread">
        {!data ? <><Bone h={14} w="40%" /><Bone h={14} w="80%" /></> : !messages.length ? <p className="ses-none">Nothing has been said on the task yet.</p> : messages.slice(-40).map((m) => (
          <div key={m.id} className={`ses-msg ${m.kind}`}>
            <div className="ses-msg-head"><b>{who(m)}</b><time dateTime={m.at}>{agoLabel(m.at)}</time></div>
            <Markdown text={words(m)} prefix={prefix} />
          </div>
        ))}
      </div>
      <form className="ses-say" onSubmit={(e) => (e.preventDefault(), void send())}>
        <textarea
          className="ses-text"
          rows={2}
          value={text}
          disabled={!open}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), void send())}
          placeholder={open ? "Tell the session something. It wakes up to read it." : "This session has ended."}
          aria-label="Message the session"
        />
        <Button variant="primary" type="submit" disabled={!open || !text.trim() || busy}>Send</Button>
      </form>
      {error && <Banner tone="danger">Couldn't send: {error}</Banner>}
    </Section>
  );
}
