// A module's guided setup at #/setup/<module>, rendered from its board.setup_flows declaration: why and effort, the steps (with
// the board's address and the sign-in's exact redirect, each copyable) and the vendor's console link, one paste field per
// secret, then the sign-in's Connect button or a pairing code, as numbered stages. Nothing here knows which module it is.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { HttpStatusError, SignInRequired, api, type SetupChoice, type SetupFlowView } from "./api";
import { ConnectButton } from "./Connect";
import { forgetFlows } from "./SetupButton";
import { SetupPaths } from "./SetupPaths";
import { useEvents } from "./events";
import { Markdown } from "./markdown";
import { ChangeProgress, Page } from "./settings-ui";
import type { FiledChange } from "./types";
import { PageHeader } from "./ui/PageHeader";
import { Banner } from "./ui";
import "./settings.css";
import "./setup-flow.css";

type Board = { url: string };

export function SetupFlow({ module, change, onDone, onSignIn }: { module: string; change?: boolean; onDone: () => void; onSignIn: () => void }) {
  const [flow, setFlow] = useState<SetupFlowView | null | undefined>(undefined);
  const [board, setBoard] = useState<Board>({ url: location.origin });
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api.setupFlows().then(
        (r) => {
          setBoard({ url: r.board_url });
          setFlow(r.flows.find((f) => f.module === module) ?? null);
        },
        (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)),
      ),
    [module, onSignIn],
  );
  useEffect(() => void load(), [load]);
  // Its sign-in finished in the tab Connect opened, or its pairing did in another: re-read either way.
  useEvents(["connections", "setup"], load);
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
        <FlowBody flow={flow} change={change} board={board} reload={load} onDone={onDone} onSignIn={onSignIn} />
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

function FlowBody({ flow, change, board, reload, onDone, onSignIn }: { flow: SetupFlowView; change?: boolean; board: Board; reload: () => Promise<void>; onDone: () => void; onSignIn: () => void }) {
  const [error, setError] = useState("");
  // A save that restarted the service, and the reloaded flow's own window: the longer of them is the wait.
  const [savedRestart, setSavedRestart] = useState(0);
  const restartFor = Math.max(savedRestart, flow.restarting_for ?? 0) || undefined;
  const fields = flow.fields ?? [];
  // A module with modes: its Connect waits for the pick to be live (the setting holds it).
  const picked = !flow.choose || flow.done || (flow.choose.chosen != null && flow.choose.chosen === flow.choose.value);
  const secretsDone = (flow.done || fields.every((f) => flow.present[f.secret])) && picked;
  const fail = (e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message));
  // The organisation the owner chose fills this module's client: its app-making steps are done, unless the owner wants their own.
  const [org, setOrg] = useState<string | null>(null);
  const [ownApp, setOwnApp] = useState(false);
  useEffect(() => {
    api.organisations().then((o) => {
      const c = o.organisations.find((x) => x.id === o.chosen);
      setOrg(c?.connections.includes(flow.module) ? c.name : null);
    }, () => setOrg(null));
  }, [flow.module]);
  const viaOrg = org !== null && !ownApp && fields.length > 0 && secretsDone;
  const later = (
    <button className="btn" onClick={() => api.setupDismiss(flow.module).then(onDone, fail)}>
      Skip this step
    </button>
  );
  // Two options: each card says its own effort; the header says there is a choice.
  const head = flow.advanced ? (
    <PageHeader title={flow.title} sub="Two ways to set it up. Start with either; the first can take the second's extras later." />
  ) : (
    <PageHeader title={flow.title} sub={flow.why} status={viaOrg ? <Effort effort="about a minute" /> : <Effort effort={flow.effort} admin={flow.admin} />} />
  );

  const connect = flow.signin ? `/${flow.signin}/connect` : flow.connect_url;
  let n = 1;
  return (
    <main className="st-page setup-page">
      {head}
      {flow.done && change && <Banner>Changing setup: your current choices are shown. A new pick files a settings change for approval; pasting a secret replaces the saved one (its value is never shown).</Banner>}
      {flow.advanced ? (
        <>
          <SetupPaths flow={flow} board={board} org={org} reload={reload} fail={fail} restartFor={restartFor} onSaved={setSavedRestart} />
          {error && (
            <p className="setup-error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
      <div className="setup-grid">
        {viaOrg ? (
          <Step n={n++} title={`Using ${org}'s app`} state="done">
            <p className="setup-hint">{org} runs this app for you, so there is nothing to make. Connect with your {org} account.</p>
            <button className="link-btn setup-own-app" onClick={() => setOwnApp(true)}>
              Use my own app instead
            </button>
          </Step>
        ) : (
          <Step n={n++} title="Instructions" state="open">
            <Steps text={flow.steps.split("{board_url}").join(board.url).split("{redirect_url}").join(flow.redirect_url ?? "")} />
            {flow.console_url && (
              <a className="btn" href={flow.console_url} target="_blank" rel="noreferrer">
                Open {flow.title} ↗
              </a>
            )}
          </Step>
        )}
        <div className="setup-side">
          {flow.choose && (
            <Step n={n++} title="Choose" state={picked ? "done" : "open"}>
              <Choose flow={flow} choose={flow.choose} picked={picked} reload={reload} fail={fail} />
            </Step>
          )}
          {fields.length > 0 && !viaOrg && (
            <Step n={n++} title="Paste the details" state={secretsDone ? "done" : "open"}>
              <SecretFields module={flow.module} fields={fields} present={flow.present} done={secretsDone} elsewhere={flow.done} reload={reload} fail={fail} onSaved={setSavedRestart} />
            </Step>
          )}
          {connect && (
            <Step n={n++} title="Connect" state={flow.signedIn ? "done" : secretsDone ? "open" : "wait"}>
              {flow.signedIn ? (
                <div className="setup-actions setup-paired">
                  <p className="setup-ok-line">Connected.</p>
                  {flow.signin && <ConnectButton c={{ id: flow.signin, label: flow.title, signIn: { state: "ok", offer: flow.scopes, mode: flow.signin_mode } }} />}
                </div>
              ) : secretsDone ? (
                flow.signin ? (
                  <ConnectButton c={{ id: flow.signin, label: flow.title, signIn: { state: "missing", offer: flow.scopes, mode: flow.signin_mode } }} variant="primary" />
                ) : (
                  <a className="btn primary" href={connect}>Connect {flow.title}</a>
                )
              ) : (
                <p className="setup-hint">{picked ? "Save the details above first; then connect here and allow access." : "Choose above first; then connect here and allow access."}</p>
              )}
            </Step>
          )}
          {flow.pair_url && (
            <Step n={n++} title="Pair" state={flow.paired ? "done" : secretsDone ? "open" : "wait"}>
              {secretsDone ? <Pairing flow={flow} reload={reload} fail={fail} restartFor={restartFor} /> : <p className="setup-hint">Save the details above first.</p>}
            </Step>
          )}
          {error && (
            <p className="setup-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      )}
      <footer className="setup-foot">
        <span className={flow.done ? "setup-ok-line" : "setup-hint"}>{flow.done ? `${flow.title} is set up.` : <>You can finish this later from <a href="#/settings">Settings</a>.</>}</span>
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

/**
 * A module's mode choice (board.setup_flows `choose`): the options, with the inputs the picked one needs. Picking files a
 * settings change when it differs from what is live; this follows it (waiting for the owner's apply card, then the apply)
 * and goes quiet once the setting holds the pick, when Connect opens.
 */
function Choose({ flow, choose, picked, reload, fail }: { flow: SetupFlowView; choose: SetupChoice; picked: boolean; reload: () => Promise<void>; fail: (e: unknown) => void }) {
  const [value, setValue] = useState(choose.chosen ?? choose.value ?? choose.options[0]!.value);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState<FiledChange | undefined>();
  const waiting = choose.chosen != null && choose.chosen !== choose.value;
  const option = choose.options.find((o) => o.value === value) ?? choose.options[0]!;
  // While the picked mode is not live, follow its change (the newest one that touches the setting) and the live config.
  useEffect(() => {
    if (!waiting) return;
    const look = () => {
      void api.settingsChanges().then((r) => setFiled(r.changes.find((c) => c.items.some((i) => i.kind === "setting" && i.key === choose.setting))), () => {});
      void reload();
    };
    look();
    const t = setInterval(() => document.visibilityState === "visible" && look(), 4000);
    return () => clearInterval(t);
  }, [waiting, choose.setting, reload]);
  const ready = (option.inputs ?? []).every((i) => !i.pattern || valid(i.pattern, (inputs[i.setting] ?? i.value).trim()));
  const go = async () => {
    setBusy(true);
    try {
      await api.setupChoose(flow.module, value, Object.fromEntries((option.inputs ?? []).map((i) => [i.setting, (inputs[i.setting] ?? i.value).trim()])));
      setEditing(false);
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  if (picked && !editing) {
    const was = choose.options.find((o) => o.value === choose.value);
    return (
      <div className="setup-actions setup-paired">
        <p className="setup-ok-line">{was?.label ?? choose.value}</p>
        <button className="btn" onClick={() => setEditing(true)}>Change</button>
      </div>
    );
  }
  if (waiting && !editing) {
    const stopped = filed && (filed.stage === "failed" || filed.stage === "rejected" || filed.stage === "closed");
    return (
      <>
        <p className="setup-hint">{choose.options.find((o) => o.value === choose.chosen)?.label}: this takes one apply. Approve it in Approvals, the host then starts what it needs, and this page continues when it is up.</p>
        {filed && <ChangeProgress f={filed} />}
        {stopped && <button className="btn" onClick={() => setEditing(true)}>Choose again</button>}
      </>
    );
  }
  return (
    <>
      <div className="setup-options" role="radiogroup">
        {choose.options.map((o) => (
          <label key={o.value} className={`setup-option${o.value === value ? " on" : ""}${o.unavailable ? " off" : ""}`}>
            <input type="radio" name={`${flow.module}-choice`} checked={o.value === value} disabled={Boolean(o.unavailable)} onChange={() => setValue(o.value)} />
            <span>
              <strong>{o.label}</strong>
              <small>{o.unavailable ?? o.detail}</small>
            </span>
          </label>
        ))}
      </div>
      {(option.inputs ?? []).map((i) => (
        <label key={i.setting} className="setup-field">
          <span>{i.label}</span>
          <input type="text" autoComplete="off" spellCheck={false} aria-invalid={!valid(i.pattern, (inputs[i.setting] ?? i.value).trim())} value={inputs[i.setting] ?? i.value} onChange={(e) => setInputs({ ...inputs, [i.setting]: e.target.value })} />
          {i.help && <small className="setup-help">{i.help}</small>}
        </label>
      ))}
      <div className="setup-actions">
        <button className="btn primary" disabled={busy || !ready || Boolean(option.unavailable)} onClick={() => void go()}>
          {busy ? "Saving…" : "Continue"}
        </button>
        {editing && (
          <button className="btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>
    </>
  );
}

/** One numbered stage of the flow: open (its turn), done (a check), or waiting on an earlier one. */
export function Step({ n, title, state, children }: { n: number; title: string; state: "open" | "done" | "wait"; children: ReactNode }) {
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
export function Steps({ text }: { text: string }) {
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

/** The code's life when the response omits it: what every pairing module keeps (the board sends the channel's own value). */
const PAIR_TTL_S = 15 * 60;

export function Pairing({ flow, reload, fail, restartFor }: { flow: SetupFlowView; reload: () => Promise<void>; fail: (e: unknown) => void; restartFor?: number }) {
  // The board says how long a reported restart has left; this page counts it down on its own clock, so a board whose clock
  // runs ahead doesn't end the wait early and one behind doesn't stretch it.
  const [restartUntil, setRestartUntil] = useState(() => (restartFor ? Date.now() + restartFor : undefined));
  useEffect(() => {
    if (!restartFor) return;
    setRestartUntil(Date.now() + restartFor);
  }, [restartFor]);
  /** End the wait: the module answered, so its old token-less process is gone and a later 409 is a real conflict. */
  const restartOver = () => {
    setRestartUntil(undefined);
    setRestarting(false);
  };
  // `was`: paired already when minted. Then only a pairing time after the mint shows the re-pair; with no time, keep waiting.
  // `ends`: when this code dies by this browser's clock, from the lifetime the channel gave; `minted_at` stays the board's
  // clock, to compare with the service's `paired_at`.
  const [pair, setPair] = useState<{ code: string; link?: string; minted_at: number; ends: number; was: boolean } | null>(null);
  const [expired, setExpired] = useState(false);
  // Bumped on each mint: a check that answers after a newer code was minted is about the old one, so it changes nothing.
  const minted = useRef(0);
  // `restartUntil` is the board's report that a saved secret's service is being recreated, on this page's clock: only then is
  // the module's 409 a wait, not an error. A genuine conflict, with no restart reported, shows at once.
  const [restarting, setRestarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const minting = useRef(false);
  const mounted = useRef(true);
  // The pending retry's delay, so unmounting (leaving setup, folding the advanced steps) stops it instead of minting unseen.
  const waiting = useRef<(() => void) | null>(null);
  const live = pair !== null && !expired;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      waiting.current?.();
    };
  }, []);
  useEffect(() => {
    if (!live) return;
    // A pairing the service now reports is this code's if it happened after the mint, or, from unpaired, when it gives no time.
    const no = minted.current;
    const check = (): Promise<boolean> =>
      api.setupPaired(flow.module).then(
        (r) => {
          if (minted.current !== no) return false; // a newer code replaced this one while the check was out
          if (!(r.paired && (r.paired_at != null ? ms(r.paired_at) >= pair.minted_at : !pair.was))) return false;
          setPair(null);
          setExpired(false);
          // The modules and setup buttons read their flows once per page: a pairing changes "needs setup", so drop it now.
          forgetFlows();
          void reload();
          return true;
        },
        () => false,
      );
    // The code is dead at its end whether or not the service answers: stop showing it, and let a last check that does answer
    // show a pairing made at the end of its life as paired.
    const last = setTimeout(() => {
      setExpired(true);
      void check();
    }, Math.max(0, pair.ends - Date.now()));
    const t = setInterval(() => void check(), 2000);
    return () => (clearInterval(t), clearTimeout(last));
  }, [live, pair, flow.module, reload]);
  /** Wait a retry's backoff; unmounting resolves it now, so the loop ends without another request. */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        waiting.current = null;
        resolve();
      };
      const t = setTimeout(done, ms);
      waiting.current = done;
    });
  const mint = async () => {
    if (minting.current) return;
    minting.current = true;
    setBusy(true);
    try {
      for (;;) {
        try {
          if (!mounted.current) return;
          const r = await api.setupPair(flow.module);
          if (!mounted.current) return;
          restartOver();
          setExpired(false);
          minted.current++;
          setPair({ ...r, ends: Date.now() + (r.expires_in ?? PAIR_TTL_S) * 1000, was: flow.paired });
          return;
        } catch (e) {
          // The module answered 409 while a reported restart has time left: its old process still lacks the token. Anything
          // else (a refusal, a timeout that may have minted, no answer at all) is the error it is, shown at once.
          if (!(e instanceof HttpStatusError && e.status === 409 && restartUntil !== undefined && Date.now() < restartUntil)) throw e;
          setRestarting(true);
          await pause(2500);
        }
      }
    } catch (e) {
      if (mounted.current) (setRestarting(false), fail(e));
    } finally {
      minting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (restarting) {
    return (
      <>
        <button className="btn primary" disabled={busy}>
          Restarting the bot…
        </button>
        <p className="setup-hint">The bot is restarting with the token you saved. This can take a minute.</p>
      </>
    );
  }
  if (pair && expired) {
    return (
      <div className="setup-actions">
        <p className="setup-hint">That code expired. Get a new one.</p>
        <button className="btn primary" disabled={busy} onClick={() => void mint()}>Get a new pairing code</button>
      </div>
    );
  }
  if (!pair) {
    return (
      <>
        {flow.paired ? (
          <div className="setup-actions setup-paired">
            <p className="setup-ok-line">Paired.</p>
            <button className="btn" disabled={busy} onClick={() => void mint()}>Pair again</button>
          </div>
        ) : (
          <button className="btn primary" disabled={busy} onClick={() => void mint()}>Get a pairing code</button>
        )}
      </>
    );
  }
  return (
    <>
      <div className="setup-code">{pair.code}</div>
      {pair.link && (
        <div className="setup-pair-link">
          <QrCode text={pair.link} label="Scan to open the pairing link on your phone" />
          <div>
            <p className="setup-hint">Scan it with your phone's camera, or open it here.</p>
            <a className="btn primary" href={pair.link} target="_blank" rel="noreferrer">Open</a>
          </div>
        </div>
      )}
      <p className="setup-hint">Waiting for you to send the code. It works once, for 15 minutes.</p>
    </>
  );
}

/** The flow's honest labels: how long it takes, and who else may need to approve. */
export function Effort({ effort, admin }: { effort: string; admin?: string }) {
  return (
    <span className="setup-labels">
      <span className="setup-effort">{effort}</span>
      {admin && <span className="setup-admin">{admin}</span>}
    </span>
  );
}

/** Paste fields for a flow's secrets (each checked against its pattern here; the kernel checks again on save). */
export function SecretFields({ module, fields, present, done, elsewhere, reload, fail, onSaved }: { module: string; fields: NonNullable<SetupFlowView["fields"]>; present: Record<string, boolean>; done: boolean; elsewhere?: boolean; reload: () => Promise<void>; fail: (e: unknown) => void; onSaved?: (restartFor: number) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const filled = fields.filter((f) => values[f.secret]?.trim());
  const bad = new Set(filled.filter((f) => !valid(f.pattern, values[f.secret]!.trim())).map((f) => f.secret));
  const save = async () => {
    setSaving(true);
    try {
      // All at once, so one slow or failed save never keeps the others from being sent.
      const results = await Promise.allSettled(filled.map((f) => api.setupSecret(module, f.secret, values[f.secret]!.trim())));
      const failed = results.find((r) => r.status === "rejected");
      // Saves go out together: a later save that restarted nothing must not hide one that did, so only a reported restart
      // (with its window) is passed up, at the latest deadline.
      const left = Math.max(0, ...results.map((r) => (r.status === "fulfilled" && r.value.restarted?.length ? (r.value.restarting_for ?? 0) : 0)));
      if (left) onSaved?.(left);
      setValues(Object.fromEntries(filled.filter((_, i) => results[i]!.status === "rejected").map((f) => [f.secret, values[f.secret]!])));
      await reload();
      if (failed) fail((failed as PromiseRejectedResult).reason);
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      {fields.map((f) => (
        <label key={f.secret} className="setup-field">
          <span>
            {f.label}
            {present[f.secret] && <em className="setup-ok">saved</em>}
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={bad.has(f.secret)}
            placeholder={present[f.secret] ? "Paste to replace" : elsewhere ? "Set elsewhere; paste to change" : "Paste here"}
            value={values[f.secret] ?? ""}
            onChange={(e) => setValues({ ...values, [f.secret]: e.target.value })}
          />
          {bad.has(f.secret) ? <small className="setup-bad">That doesn't look right.{f.help ? ` ${f.help}` : ""}</small> : f.help && <small className="setup-help">{f.help}</small>}
        </label>
      ))}
      <div className="setup-actions">
        <button className={`btn${done ? "" : " primary"}`} disabled={saving || !filled.length || bad.size > 0} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}

/** A link as a QR code (a phone's camera opens it), drawn as one SVG path from the encoder's modules. */
function QrCode({ text, label }: { text: string; label: string }) {
  const { size, d } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let path = "";
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { size: count + 8, d: path };
  }, [text]);
  return (
    <svg className="setup-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
