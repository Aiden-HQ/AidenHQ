// A module's guided setup at #/setup/<module>, rendered from its board.setup_flows declaration: why and effort, the steps (with
// the board's address and the sign-in's exact redirect, each copyable) and the vendor's console link, one paste field per
// secret, then the sign-in's Connect button or a pairing code, as numbered stages. Nothing here knows which module it is.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SignInRequired, api, type SetupFlowView } from "./api";
import { ConnectButton } from "./Connect";
import { useEvents } from "./events";
import { Markdown } from "./markdown";
import { Page } from "./settings-ui";
import { PageHeader } from "./ui/PageHeader";
import "./settings.css";
import "./setup-flow.css";

type Board = { url: string; named: boolean };

export function SetupFlow({ module, onDone, onSignIn }: { module: string; onDone: () => void; onSignIn: () => void }) {
  const [flow, setFlow] = useState<SetupFlowView | null | undefined>(undefined);
  const [board, setBoard] = useState<Board>({ url: location.origin, named: true });
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api.setupFlows().then(
        (r) => {
          setBoard({ url: r.board_url, named: r.named });
          setFlow(r.flows.find((f) => f.module === module) ?? null);
        },
        (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)),
      ),
    [module, onSignIn],
  );
  useEffect(() => void load(), [load]);
  // Its sign-in finished in the tab Connect opened.
  useEvents(["connections"], load);
  // No flow: a module whose sign-in is one Connect (an old #/setup link), on Settings > Connections.
  useEffect(() => {
    if (flow === null) location.replace("#/settings/connections");
  }, [flow]);

  return (
    <div className="setup-overlay">
      {flow === undefined || flow === null ? (
        <Page title="Setup" sub={error ? `Couldn't load setup: ${error}` : flow === null ? "This module has no setup." : "Loading…"}>
          {flow === null && <button className="btn" onClick={onDone}>Back</button>}
        </Page>
      ) : (
        <FlowBody flow={flow} board={board} reload={load} onDone={onDone} onSignIn={onSignIn} />
      )}
    </div>
  );
}

/** A field's value against its declared pattern (the kernel checks again on save); a pattern the browser can't read passes. */
function valid(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

function FlowBody({ flow, board, reload, onDone, onSignIn }: { flow: SetupFlowView; board: Board; reload: () => Promise<void>; onDone: () => void; onSignIn: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fields = flow.fields ?? [];
  const secretsDone = flow.done || fields.every((f) => flow.present[f.secret]);
  const filled = fields.filter((f) => values[f.secret]?.trim());
  const bad = new Set(filled.filter((f) => !valid(f.pattern, values[f.secret]!.trim())).map((f) => f.secret));
  const fail = (e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message));
  const later = (
    <button className="btn" onClick={() => api.setupDismiss(flow.module).then(onDone, fail)}>
      Later
    </button>
  );
  const head = <PageHeader title={flow.title} sub={flow.why} status={<span className="setup-effort">{flow.effort}</span>} />;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      // All at once, so one slow or failed save never keeps the others from being sent.
      const results = await Promise.allSettled(filled.map((f) => api.setupSecret(flow.module, f.secret, values[f.secret]!.trim())));
      const failed = results.find((r) => r.status === "rejected");
      const kept = Object.fromEntries(filled.filter((_, i) => results[i]!.status === "rejected").map((f) => [f.secret, values[f.secret]!]));
      setValues(kept);
      await reload();
      if (failed) fail((failed as PromiseRejectedResult).reason);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  // A setup that needs a named address, on a board reached by its IP: only why, and the way back.
  if (flow.needs_name && !board.named) {
    return (
      <main className="st-page setup-page">
        {head}
        <section className="setup-card setup-stop">
          <p>{flow.needs_name}</p>
        </section>
        <footer className="setup-foot">{later}</footer>
      </main>
    );
  }

  const connect = flow.signin ? `/${flow.signin}/connect` : flow.connect_url;
  let n = 1;
  return (
    <main className="st-page setup-page">
      {head}
      <div className="setup-grid">
        <Step n={n++} title="Instructions" state="open">
          <Steps text={flow.steps.split("{board_url}").join(board.url).split("{redirect_url}").join(flow.redirect_url ?? "")} />
          {flow.console_url && (
            <a className="btn" href={flow.console_url} target="_blank" rel="noreferrer">
              Open {flow.title} ↗
            </a>
          )}
        </Step>
        <div className="setup-side">
          {fields.length > 0 && (
            <Step n={n++} title="Paste the details" state={secretsDone ? "done" : "open"}>
              {fields.map((f) => (
                <label key={f.secret} className="setup-field">
                  <span>
                    {f.label}
                    {flow.present[f.secret] && <em className="setup-ok">saved</em>}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={bad.has(f.secret)}
                    placeholder={flow.present[f.secret] ? "Paste to replace" : flow.done ? "Set elsewhere; paste to change" : "Paste here"}
                    value={values[f.secret] ?? ""}
                    onChange={(e) => setValues({ ...values, [f.secret]: e.target.value })}
                  />
                  {bad.has(f.secret) ? <small className="setup-bad">That doesn't look right.{f.help ? ` ${f.help}` : ""}</small> : f.help && <small className="setup-help">{f.help}</small>}
                </label>
              ))}
              <div className="setup-actions">
                <button className={`btn${secretsDone ? "" : " primary"}`} disabled={saving || !filled.length || bad.size > 0} onClick={save}>
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </Step>
          )}
          {connect && (
            <Step n={n++} title="Connect" state={flow.signedIn ? "done" : secretsDone ? "open" : "wait"}>
              {flow.signedIn ? (
                <div className="setup-actions setup-paired">
                  <p className="setup-ok-line">Connected.</p>
                  {flow.signin && <ConnectButton c={{ id: flow.signin, label: flow.title, signIn: { state: "ok", offer: flow.scopes } }} />}
                </div>
              ) : secretsDone ? (
                flow.signin ? (
                  <ConnectButton c={{ id: flow.signin, label: flow.title, signIn: { state: "missing", offer: flow.scopes } }} variant="primary" />
                ) : (
                  <a className="btn primary" href={connect}>Connect {flow.title}</a>
                )
              ) : (
                <p className="setup-hint">Save the details above first; then connect here and allow access.</p>
              )}
            </Step>
          )}
          {flow.pair_url && (
            <Step n={n++} title="Pair" state={flow.paired ? "done" : secretsDone ? "open" : "wait"}>
              {secretsDone ? <Pairing flow={flow} reload={reload} fail={fail} /> : <p className="setup-hint">Save the details above first.</p>}
            </Step>
          )}
          {error && (
            <p className="setup-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <footer className="setup-foot">
        <span className={flow.done ? "setup-ok-line" : "setup-hint"}>{flow.done ? `${flow.title} is set up.` : "You can finish this later from Settings."}</span>
        {flow.done ? (
          <button className="btn primary" onClick={onDone}>
            Done
          </button>
        ) : (
          later
        )}
      </footer>
    </main>
  );
}

/** One numbered stage of the flow: open (its turn), done (a check), or waiting on an earlier one. */
function Step({ n, title, state, children }: { n: number; title: string; state: "open" | "done" | "wait"; children: ReactNode }) {
  return (
    <section className={`setup-card setup-step ${state}`}>
      <h2>
        <span className="setup-num" aria-hidden>
          {state === "done" ? "✓" : n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Copy `text`; on a plain-http address (no clipboard API) select it so the person can copy it themselves. */
function copy(el: HTMLElement, text: string, button: HTMLButtonElement) {
  const done = () => {
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  };
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    if (document.execCommand?.("copy")) done();
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, select);
  else select();
}

/** The flow's steps, with a copy button after each inline code span (an address or value to paste elsewhere). */
function Steps({ text }: { text: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = el.current;
    if (!root) return;
    for (const code of root.querySelectorAll<HTMLElement>(":not(pre) > code")) {
      if (code.nextElementSibling?.classList.contains("setup-copy")) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "setup-copy";
      b.textContent = "Copy";
      b.onclick = () => copy(code, code.textContent ?? "", b);
      code.after(b);
    }
  }, [text]);
  return (
    <div ref={el}>
      <Markdown text={text} prefix="SETUP" className="setup-steps" />
    </div>
  );
}

/** A pairing time (the service's ISO string, or ms) as ms. */
const ms = (t: string | number | undefined) => (typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : t ? Date.parse(t) : NaN);

function Pairing({ flow, reload, fail }: { flow: SetupFlowView; reload: () => Promise<void>; fail: (e: unknown) => void }) {
  // `was`: paired already when minted. Then only a pairing time after the mint shows the re-pair; with no time, keep waiting.
  const [pair, setPair] = useState<{ code: string; link?: string; minted_at: number; was: boolean } | null>(null);
  useEffect(() => {
    if (!pair) return;
    // Paired by this code: a pairing after it was minted, or, from unpaired, any pairing when the service gives no time.
    const t = setInterval(
      () =>
        api.setupPaired(flow.module).then(
          (r) => {
            if (r.paired && (r.paired_at != null ? ms(r.paired_at) >= pair.minted_at : !pair.was)) {
              setPair(null);
              void reload();
            }
          },
          () => {},
        ),
      2000,
    );
    return () => clearInterval(t);
  }, [pair, flow.module, reload]);
  const mint = () => api.setupPair(flow.module).then((r) => setPair({ ...r, was: flow.paired }), fail);
  if (!pair) {
    return (
      <>
        {flow.paired ? (
          <div className="setup-actions setup-paired">
            <p className="setup-ok-line">Paired.</p>
            <button className="btn" onClick={mint}>Pair again</button>
          </div>
        ) : (
          <button className="btn primary" onClick={mint}>Get a pairing code</button>
        )}
      </>
    );
  }
  return (
    <>
      <div className="setup-code">{pair.code}</div>
      {pair.link && <a className="btn primary" href={pair.link} target="_blank" rel="noreferrer">Open</a>}
      <p className="setup-hint">Waiting for you to send the code. It works once, for 15 minutes.</p>
    </>
  );
}
