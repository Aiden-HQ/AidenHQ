// A module's guided setup at #/setup/<module>, rendered from its board.setup_flows declaration: why and effort, the steps, one
// paste field per secret, then the sign-in's Connect button or a pairing code. Nothing here knows which module it is.
import { useCallback, useEffect, useRef, useState } from "react";
import { SignInRequired, api, type SetupFlowView } from "./api";
import { Markdown } from "./markdown";
import { Page } from "./settings-ui";
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
  const secretsDone = fields.every((f) => flow.present[f.secret]);
  const filled = fields.filter((f) => values[f.secret]?.trim());
  const bad = new Set(filled.filter((f) => !valid(f.pattern, values[f.secret]!.trim())).map((f) => f.secret));
  const fail = (e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message));
  const later = (
    <button className="btn" onClick={() => api.setupDismiss(flow.module).then(onDone, fail)}>
      Later
    </button>
  );

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      for (const f of filled) await api.setupSecret(flow.module, f.secret, values[f.secret]!.trim());
      setValues({});
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  // A setup that needs a named address, on a board reached by its IP: only why, and the way back.
  if (flow.needs_name && !board.named) {
    return (
      <Page title={flow.title} sub={flow.why}>
        <section className="setup-card setup-stop">
          <p>{flow.needs_name}</p>
        </section>
        <div className="setup-actions">{later}</div>
      </Page>
    );
  }

  const connect = flow.signin ? `/${flow.signin}/connect` : flow.connect_url;
  return (
    <Page title={flow.title} sub={flow.why} tools={<span className="setup-effort">{flow.effort}</span>}>
      <section className="setup-card">
        <Steps text={flow.steps.split("{board_url}").join(board.url)} />
      </section>
      {fields.length > 0 && (
        <section className="setup-card">
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
                placeholder={flow.present[f.secret] ? "Paste to replace" : "Paste here"}
                value={values[f.secret] ?? ""}
                onChange={(e) => setValues({ ...values, [f.secret]: e.target.value })}
              />
              {bad.has(f.secret) ? <small className="setup-bad">That doesn't look right.{f.help ? ` ${f.help}` : ""}</small> : f.help && <small className="setup-help">{f.help}</small>}
            </label>
          ))}
          <div className="setup-actions">
            <button className="btn primary" disabled={saving || !filled.length || bad.size > 0} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </section>
      )}
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
      {secretsDone && connect && (
        <section className="setup-card">
          {flow.signedIn ? <p className="setup-ok-line">Connected.</p> : <a className="btn primary" href={connect}>Connect</a>}
        </section>
      )}
      {secretsDone && flow.pair_url && <Pairing flow={flow} reload={reload} fail={fail} />}
      <div className="setup-actions">
        {flow.done ? (
          <button className="btn primary" onClick={onDone}>
            Done
          </button>
        ) : (
          later
        )}
      </div>
    </Page>
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
  const [pair, setPair] = useState<{ code: string; link?: string; minted_at: number } | null>(null);
  useEffect(() => {
    if (!pair) return;
    // Paired by this code: a pairing after it was minted (a re-pair), or any pairing when the service gives no time.
    const t = setInterval(
      () =>
        api.setupPaired(flow.module).then(
          (r) => {
            if (r.paired && (r.paired_at == null || ms(r.paired_at) >= pair.minted_at)) {
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
  const mint = () => api.setupPair(flow.module).then(setPair, fail);
  if (!pair) {
    return (
      <section className="setup-card">
        {flow.paired ? (
          <div className="setup-actions setup-paired">
            <p className="setup-ok-line">Paired.</p>
            <button className="btn" onClick={mint}>Pair again</button>
          </div>
        ) : (
          <button className="btn primary" onClick={mint}>Get a pairing code</button>
        )}
      </section>
    );
  }
  return (
    <section className="setup-card">
      <div className="setup-code">{pair.code}</div>
      {pair.link && <a className="btn primary" href={pair.link} target="_blank" rel="noreferrer">Open</a>}
      <p className="setup-hint">Waiting for you to send the code. It works once, for 15 minutes.</p>
    </section>
  );
}
