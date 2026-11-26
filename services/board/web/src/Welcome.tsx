// Onboarding. WelcomeGate wraps the app (main.tsx): every board route sits behind the model gate, and a new owner is sent
// to #/welcome, where the recovery key and organisation screens (when either applies) come first, full screen. Then the
// board's own page (Onboarding, in the app shell): start with one teammate, set up with TeammateSetup, everyone else Aiden
// can bring in, where the team reaches you (with a real test message), and Home on day one.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { SignInRequired, admin, api, type Session, type SetupFlowView, type WelcomeState } from "./api";
import { OrganisationPicker } from "./Organisation";
import { Page as SetupPage } from "./settings-ui";
import { SetupFlow } from "./SetupFlow";
import { RowFace, TeammateSetup, holdName, moduleTitle, pendingName, quoted } from "./TeammateSetup";
import type { HireRow, SettingRow, TeammateQueue, TrialView } from "./types";
import { Button, Card, Disclosure, Face, Input, OptionCard, Page, Stepper, Tag, faceProps } from "./ui";
import { teammateNameProblem } from "../../src/teammate-name";
import "./settings.css";
import "./setup-flow.css";
import "./onboarding.css";

const go = (hash: string) => {
  if (location.hash !== hash) location.hash = hash;
};

export function WelcomeGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(WelcomeState & { orgs: boolean }) | null>(null);
  const [hash, setHash] = useState(location.hash);
  // Whether the gate check has answered: #/welcome renders nothing until then, so onboarding never mounts ahead of the recovery key and organisation screens.
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    // Signed out, or a kernel that doesn't answer: the app shows its own sign-in or error.
    api
      .session()
      // Whether the catalog lists organisations: onboarding then asks for yours first.
      .then((s) => (s.account ? Promise.all([api.welcome(), api.organisations().then((o) => o.organisations.length > 0, () => false)]) : null))
      .then((r) => {
        const w = r && { ...r[0], orgs: r[1] };
        setState(w);
        if (w && w.modelReady && !w.finished && location.hash !== "#/welcome") go("#/welcome");
      })
      .catch(() => {})
      .finally(() => setChecked(true));
  }, []);

  if (!checked && hash === "#/welcome") return null;
  if (state && !state.modelReady) return <ModelGate />;
  if (state && !state.finished && hash === "#/welcome") return <Gates state={state}>{children}</Gates>;
  return <>{children}</>;
}

function ModelGate() {
  return (
    <div className="setup-overlay">
      <SetupPage title="Connect a model to start" sub="Aiden needs an AI model before anything else works. It takes a minute.">
        <section className="setup-card">
          <a className="btn primary" href={`${admin.url}/setup/model`}>Connect a model</a>
        </section>
      </SetupPage>
    </div>
  );
}

// Where onboarding is, kept across a reload and the round trip to the kernel's own pages (this tab only).
const STEP = "aidenhq.welcome.step";
const read = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* still works without it */ } };
/** Set while this tab finishes onboarding: Home shows "Step 3 of 3" above its getting-started band. */
export const WELCOME_SESSION = "aidenhq.welcome.home";

type Screen = { kind: "key" } | { kind: "org" } | { kind: "first" } | { kind: "reach" };
const STEPS = ["Your first teammate", "Where we reach you", "Your home"];

/** The recovery key and organisation screens before the board's onboarding page: a full-screen sheet each. */
function Gates({ state, children }: { state: WelcomeState & { orgs: boolean }; children: ReactNode }) {
  const gates: Screen[] = [...(state.recoveryKeyWaiting ? [{ kind: "key" as const }] : []), ...(state.orgs ? [{ kind: "org" as const }] : [])];
  const [at, setAt] = useState(() => {
    const was = read(STEP);
    return was === "first" || was === "reach" ? gates.length : Math.max(0, gates.findIndex((g) => g.kind === was));
  });
  const screen = gates[at];
  useEffect(() => void (screen && write(STEP, screen.kind)), [screen]);
  const next = () => {
    if (at + 1 >= gates.length) write(STEP, "first");
    setAt(at + 1);
  };
  if (!screen) return <>{children}</>;
  return (
    <div className="setup-overlay">
      {screen.kind === "key" && (
        <SetupPage title="Save your recovery key" sub="It opens your vault if the sealed password is ever lost. It is shown once.">
          <section className="setup-card">
            <a className="btn primary" href={`${admin.url}/recovery-key`}>Show my recovery key</a>
            <button className="btn" onClick={next}>Skip for now</button>
          </section>
        </SetupPage>
      )}
      {screen.kind === "org" && (
        <SetupPage title="Where do you work?" sub="Your organisation may already run the apps these connections sign in with.">
          <OrganisationPicker onContinue={next} />
        </SetupPage>
      )}
    </div>
  );
}

/** The first two onboarding screens (#/welcome, in the app shell); finishing lands on Home. */
export function Onboarding({ session, onSignIn }: { session: Session | null; onSignIn: () => void }) {
  const [screen, setScreen] = useState<"first" | "reach">(() => (read(STEP) === "reach" ? "reach" : "first"));
  useEffect(() => write(STEP, screen), [screen]);
  const [rows, setRows] = useState<HireRow[] | null>(null);
  const [first, setFirst] = useState<string | null>(null);
  const [queue, setQueue] = useState<TeammateQueue | null>(null);
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [error, setError] = useState("");
  const fail = useCallback((e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)), [onSignIn]);
  const load = useCallback(
    () =>
      Promise.all([api.teammates(), api.teammateQueue(), api.settings().catch(() => null), api.welcome()]).then(([t, q, s, w]) => {
        // Finished already (another tab, or a link back here): Home.
        if (w.finished) return go("#/");
        setRows(t.rows);
        setFirst(t.first);
        setQueue(q);
        setSettings(s?.settings ?? []);
      }, fail),
    [fail],
  );
  useEffect(() => void load(), [load]);

  const finishing = useRef(false);
  // The queue saves in order, and finishing waits for the last: Aiden's welcome task reads the saved choices.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const finish = async () => {
    if (finishing.current) return;
    finishing.current = true;
    setError("");
    try {
      await saving.current;
      await api.welcomeFinish();
      write(STEP, null);
      write(WELCOME_SESSION, "1");
      go("#/");
    } catch (e) {
      finishing.current = false;
      fail(e);
    }
  };
  const quiet = settings.find((s) => s.key === "quiet_start")?.value === true;
  const top = (current: number) => (
    <div className="wl-top">
      <Stepper steps={STEPS} current={current} label="Getting started" />
      <span className="wl-top-note">
        {quiet && <span>Nothing runs on its own until you say so.</span>}
        <Button variant="quiet" size="sm" onClick={() => void finish()}>Finish setup later</Button>
      </span>
    </div>
  );
  if (!rows || !queue)
    return (
      <Page className="wl" label="Getting started">
        {top(0)}
        {error ? <p className="tms-error" role="alert">Couldn't load your teammates: {error}</p> : <div className="wl-loading" aria-busy="true" />}
      </Page>
    );
  // The teammate this owner chose (Set up writes it before anything is filed), else the recommended one.
  const ref = queue.first ?? first;
  const row = rows.find((r) => r.ref === ref);
  const save = (q: TeammateQueue) => (setQueue(q), void (saving.current = saving.current.then(() => api.setTeammateQueue(q)).catch(fail)));
  return (
    <Page className="wl" label="Getting started">
      {top(screen === "first" ? 0 : 1)}
      {error && <p className="tms-error" role="alert">{error}</p>}
      {screen === "first" ? (
        <FirstScreen rows={rows} row={row} queue={queue} save={save} hello={session?.account?.name?.split(/\s+/)[0]} onNext={() => setScreen("reach")} onSignIn={onSignIn} />
      ) : (
        <ReachScreen row={row} settings={settings} onFinish={finish} onSignIn={onSignIn} fail={fail} />
      )}
    </Page>
  );
}

/** Screen 1: start with one teammate (or, everyone hired, only the roster), and everyone else Aiden can bring in. */
function FirstScreen({ rows, row, queue, save, hello, onNext, onSignIn }: { rows: HireRow[]; row?: HireRow; queue: TeammateQueue; save: (q: TeammateQueue) => void; hello?: string; onNext: () => void; onSignIn: () => void }) {
  const setting = !!row && queue.first === row.ref;
  const [trial, setTrial] = useState<TrialView | null>(null);
  const others = rows.filter((r) => r !== row && !r.onTeam);
  // The suggestion: the first catalog teammate that is neither the one being set up nor on the team (pre-queued once).
  const suggested = others[0];
  useEffect(() => {
    if (!suggested || queue.next.length || queue.later.length || read("aidenhq.welcome.suggested")) return;
    write("aidenhq.welcome.suggested", "1");
    save({ ...queue, next: [suggested.ref] });
  }, [suggested, queue, save]);
  const toggle = (r: HireRow, list: "next" | "later") => {
    const on = queue[list].includes(r.ref);
    const other = list === "next" ? "later" : "next";
    save({ ...queue, [list]: on ? queue[list].filter((x) => x !== r.ref) : [...queue[list], r.ref].slice(-20), [other]: queue[other].filter((x) => x !== r.ref) });
  };
  return (
    <>
      {row ? (
        <>
          <header className="wl-head enter">
            <p className="wl-eyebrow">{hello ? `Welcome, ${hello}` : "Welcome"}</p>
            <h1>Start with {pendingName(row.ref) ?? row.name}.</h1>
            <p className="wl-sub">Most people start here: a first result on day one. You'll see it on your own data before {row.name} does anything on its own.</p>
          </header>
          {setting ? (
            <Card className="wl-rec enter">
              <div className="wl-rec-who">
                <Face seed={row.key} {...faceProps(row.face)} size={56} state={trial ? "idle" : "working"} label={row.name} />
                <span><b>{pendingName(row.ref) ?? row.name}</b> · {row.job}</span>
              </div>
              <TeammateSetup row={row} onDone={(r) => setTrial(r.trial)} onSignIn={onSignIn} />
              {trial && <TrialResult row={row} trial={trial} />}
              {trial && (
                <div className="wl-actions">
                  <Button variant="primary" className="press" onClick={onNext}>Continue</Button>
                </div>
              )}
            </Card>
          ) : (
            <Recommended row={row} rows={rows} onSetUp={(name) => (holdName(row.ref, name === row.name ? null : name), save({ ...queue, first: row.ref }))} />
          )}
        </>
      ) : (
        <header className="wl-head enter">
          <h1>Your team is all here.</h1>
          <p className="wl-sub">Everyone in your marketplaces is already on your team. Describe someone new from the hiring page any time.</p>
          <div className="wl-actions">
            <Button variant="primary" className="press" onClick={onNext}>Continue</Button>
          </div>
        </header>
      )}
      {others.length > 0 && (
        <section className="wl-roster">
          <header className="wl-roster-head">
            <h2>Everyone Aiden can bring in</h2>
            <span className="wl-roster-sub">Set them up one at a time, whenever you're ready.</span>
            <a className="wl-link" href="#/team/hire">Browse all teammates <span aria-hidden>→</span></a>
          </header>
          <div className="wl-grid">
            {others.map((r, i) => {
              const next = queue.next.includes(r.ref);
              const later = queue.later.includes(r.ref);
              return (
                <article key={r.ref} className="wl-mate ui-card lift enter" style={{ "--i": i } as CSSProperties}>
                  <div className="wl-mate-head">
                    <span className="ui-mate">
                      <RowFace row={r} size={36} />
                      <span className="ui-mate-text"><b>{r.name}</b> · {r.job}</span>
                    </span>
                    {r === suggested && <Tag tone="accent">Suggested for you</Tag>}
                  </div>
                  <p className="wl-mate-desc">{r.description}</p>
                  {r.sample && <blockquote className="wl-quote">{quoted(r.sample)}</blockquote>}
                  <div className="wl-mate-actions">
                    <Button variant="quiet" size="sm" className="press" aria-pressed={later} onClick={() => toggle(r, "later")}>{later ? "Later ✓" : "Later"}</Button>
                    <Button size="sm" variant={next ? "primary" : "default"} className="press" aria-pressed={next} onClick={() => toggle(r, "next")}>{next ? "Next ✓" : "Set up next"}</Button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

/** The recommended teammate: its face and a rename, what it does and connects, the first result to expect, and Set up. */
function Recommended({ row, rows, onSetUp }: { row: HireRow; rows: HireRow[]; onSetUp: (name: string) => void }) {
  const [name, setName] = useState(() => pendingName(row.ref) ?? row.name);
  const [editing, setEditing] = useState(false);
  // On a fresh install the catalog's teammates stand in for the compiled agents the server checks against again.
  const others = Object.fromEntries(rows.filter((r) => r.onTeam).map((r) => [r.key, { name: r.name }]));
  const problem = name === row.name ? undefined : teammateNameProblem(name, row.key, others);
  const connects = row.connections.length ? `${row.connections.map((m) => moduleTitle(m)).join(", ")} · read-only until you say otherwise` : "Nothing new to connect";
  return (
    <Card className="wl-rec enter">
      <div className="wl-rec-grid">
        <Face seed={row.key} {...faceProps(row.face)} size={96} label={name} />
        <div className="wl-rec-main">
          {editing ? (
            <label className="wl-rename">
              <span className="sr-only">Name your {row.job}</span>
              <Input value={name} maxLength={24} autoFocus aria-invalid={!!problem} onChange={(e) => setName(e.target.value)} onBlur={() => !problem && setEditing(false)} onKeyDown={(e) => e.key === "Enter" && !problem && setEditing(false)} />
              {problem && <span className="ui-field-error" role="alert">{problem}</span>}
            </label>
          ) : (
            <h2 className="wl-rec-name">
              {name}
              <button type="button" className="wl-edit" aria-label={`Rename ${name}`} title="Rename" onClick={() => setEditing(true)}>
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
              </button>
            </h2>
          )}
          <p className="wl-rec-job">{row.job}</p>
          <dl className="wl-facts">
            <dt>Does</dt>
            <dd>{row.description}</dd>
            <dt>Connects</dt>
            <dd>{connects}</dd>
          </dl>
        </div>
        <div className="wl-rec-side">
          {row.sample && (
            <div className="wl-first">
              <span className="wl-label">First result you'll see</span>
              <p>{quoted(row.sample)}</p>
            </div>
          )}
          <Button variant="primary" className="press wl-go" disabled={!!problem} onClick={() => onSetUp(name)}>Set up {name}</Button>
        </div>
      </div>
    </Card>
  );
}

/** What the trial found: one row per task it filed, or the empty line. */
export function TrialResult({ row, trial }: { row: Pick<HireRow, "name">; trial: TrialView }) {
  if (trial.state === "failed") return null;
  if (!trial.found.length) return <p className="wl-empty">Nothing to show yet; {row.name} keeps watching.</p>;
  return (
    <div className="wl-found" role="list" aria-label={`What ${row.name} found`}>
      {trial.found.map((f, i) => (
        <a key={f.identifier} role="listitem" className="wl-found-row enter" style={{ "--i": i } as CSSProperties} href={`#/t/${f.identifier}`}>
          <span className="wl-found-title">{f.title}</span>
          {f.labels.map((l) => <Tag key={l}>{l}</Tag>)}
        </a>
      ))}
    </div>
  );
}

type Reach = "channel-telegram" | "slack" | "board";
const TEST = { text: "Test from AidenHQ: this is how a decision reaches you. The buttons do nothing.", buttons: ["Looks good", "Not now"] };

/** Screen 2: where the team reaches the owner, set up inline, with a real test message through the picked transport only. */
function ReachScreen({ row, settings, onFinish, onSignIn, fail }: { row?: HireRow; settings: SettingRow[]; onFinish: () => Promise<void>; onSignIn: () => void; fail: (e: unknown) => void }) {
  const current = (settings.find((s) => s.key === "notify_transports")?.value ?? null) as string[] | null;
  const [pick, setPick] = useState<Reach>(() => (current && current.length === 0 ? "board" : current?.[0] === "slack" ? "slack" : "channel-telegram"));
  const [flows, setFlows] = useState<SetupFlowView[] | null>(null);
  // Each channel's own test: an answer that arrives after the owner picked another channel stays with the one it tested.
  type Test = { busy: boolean; sent?: boolean; reason?: string };
  const [tests, setTests] = useState<Partial<Record<Reach, Test>>>({});
  const test: Test = tests[pick] ?? { busy: false };
  const [busy, setBusy] = useState(false);
  const readFlows = useCallback(() => api.setupFlows().then((r) => setFlows(r.flows), fail), [fail]);
  useEffect(() => void readFlows(), [readFlows]);
  const flow = pick === "board" ? undefined : flows?.find((f) => f.module === pick);
  // A channel with no setup flow isn't installed here: never ready, and never saved over the one that works.
  const missing = pick !== "board" && !!flows && !flow;
  const ready = pick === "board" || (!!flow && (pick === "slack" ? !!flow.advanced?.done : flow.done));
  const send = async () => {
    if (pick === "board") return;
    const to = pick;
    const set = (t: Test) => setTests((all) => ({ ...all, [to]: t }));
    set({ busy: true });
    try {
      const r = await api.notifyTest(to);
      set({ busy: false, sent: r.sent, reason: r.sent ? undefined : r.off ? "not set up yet" : (r.reason ?? "it wasn't delivered") });
    } catch (e) {
      if (e instanceof SignInRequired) onSignIn();
      set({ busy: false, sent: false, reason: (e as Error).message });
    }
  };
  const go = async () => {
    setBusy(true);
    try {
      // A channel that isn't set up yet is not saved: the working one keeps delivering.
      const want = pick === "board" ? [] : ready ? [pick] : current;
      if (want && JSON.stringify(want) !== JSON.stringify(current)) await api.changeSettings([{ kind: "setting", key: "notify_transports", value: want }]);
      await onFinish();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  const title = pick === "slack" ? "Slack" : "Telegram";
  const flowEl = flow && <SetupFlow key={pick} inline module={pick} path={pick === "slack" ? "advanced" : undefined} onDone={() => void readFlows()} onSignIn={onSignIn} />;
  return (
    <div className="wl-reach">
      <div className="wl-reach-main">
        <header className="wl-head enter">
          {row && (
            <p className="wl-ready">
              <Face seed={row.key} {...faceProps(row.face)} size={40} state="working" label={row.name} />
              <span>{row.name} is connected and reading. First result in about a minute.</span>
            </p>
          )}
          <h1>Where should your team reach you?</h1>
          <p className="wl-sub">Your morning brief and anything that needs you arrive here, with buttons so you can decide in one tap. Everything also shows on this board.</p>
        </header>
        <div className="wl-options enter" role="radiogroup" aria-label="Where your team reaches you" style={{ "--i": 1 } as CSSProperties}>
          <OptionCard type="radio" name="reach" value="channel-telegram" checked={pick === "channel-telegram"} onChange={() => setPick("channel-telegram")} title="Telegram" badge={<Tag tone="ok">Recommended</Tag>} sub="Your morning brief, plus one-tap decisions: send, allow, pick. Fastest on your phone." />
          <OptionCard type="radio" name="reach" value="slack" checked={pick === "slack"} onChange={() => setPick("slack")} title="Slack DM" sub="The same messages as a direct message from AidenHQ in your Slack. Needs the Slack app installed." />
          <OptionCard type="radio" name="reach" value="board" checked={pick === "board"} onChange={() => setPick("board")} title="Only this board" sub="Nothing is pushed to you; check Home when you want." />
        </div>
        {flowEl && (ready ? <Disclosure summary={`${title} is set up`}>{flowEl}</Disclosure> : <section className="wl-flow ui-card enter">{flowEl}</section>)}
        <div className="wl-actions">
          {pick !== "board" && (
            <Button className="press" disabled={test.busy || !ready} onClick={() => void send()}>
              {test.busy ? "Sending…" : test.sent ? "Sent ✓ · Send again" : test.reason ? "Try again" : "Send a test"}
            </Button>
          )}
          <Button variant="primary" className="press" disabled={busy || missing} onClick={() => void go()}>{busy ? "Saving…" : pick !== "board" && !ready ? `Continue without ${title}` : "Continue"}</Button>
          <span className="wl-hint">{missing ? <span className="wl-bad" role="alert">{title} isn't installed on this instance: pick another way.</span> : test.reason ? <span className="wl-bad" role="alert">Not sent: {test.reason}.</span> : pick !== "board" && !ready ? `${title} isn't set up yet: you keep your current way of reaching you.` : "You can change this any time in Settings."}</span>
        </div>
      </div>
      {pick !== "board" && (
        <aside className="wl-preview enter" aria-label={`Preview: ${title}`} style={{ "--i": 2 } as CSSProperties}>
          <span className="wl-label">Preview: {title}</span>
          <div className="wl-phone">
            <div className="wl-msg">
              <div className="wl-msg-head"><b>AidenHQ</b><time>now</time></div>
              <p>{TEST.text}</p>
              <div className="wl-msg-buttons">{TEST.buttons.map((b) => <span key={b}>{b}</span>)}</div>
            </div>
          </div>
          <p className="wl-hint">{test.sent ? `Sent through ${title}: check your ${pick === "slack" ? "Slack DMs" : "phone"}.` : "Press “Send a test” to see how a decision arrives."}</p>
        </aside>
      )}
    </div>
  );
}
