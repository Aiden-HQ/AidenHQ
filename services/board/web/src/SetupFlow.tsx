// A module's guided setup at #/setup/<module>, rendered from its board.setup_flows declaration: why and effort, the steps (with
// the board's address and the sign-in's exact redirect, each copyable) and the vendor's console link, one paste field per
// secret, then the sign-in's Connect button or a pairing code, as numbered stages. Nothing here knows which module it is.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { SignInRequired, admin, api, type AdvancedFlowView, type SetupChoice, type SetupFlowView } from "./api";
import { ConnectButton } from "./Connect";
import { useEvents } from "./events";
import { Markdown } from "./markdown";
import { ChangeProgress, Page } from "./settings-ui";
import type { FiledChange } from "./types";
import { PageHeader } from "./ui/PageHeader";
import { Banner } from "./ui";
import "./settings.css";
import "./setup-flow.css";

type Board = { url: string; named: boolean };

export function SetupFlow({ module, change, onDone, onSignIn }: { module: string; change?: boolean; onDone: () => void; onSignIn: () => void }) {
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
  const head = <PageHeader title={flow.title} sub={flow.why} status={viaOrg ? <Effort effort="about a minute" /> : <Effort effort={flow.effort} admin={flow.admin} />} />;

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
      {flow.done && change && <Banner>Changing setup: your current choices are shown. A new pick files a settings change for approval; pasting a secret replaces the saved one (its value is never shown).</Banner>}
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
              <SecretFields module={flow.module} fields={fields} present={flow.present} done={secretsDone} elsewhere={flow.done} reload={reload} fail={fail} />
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
      {flow.advanced && <Advanced flow={flow} advanced={flow.advanced} board={board} reload={reload} fail={fail} />}
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
function Effort({ effort, admin }: { effort: string; admin?: string }) {
  return (
    <span className="setup-labels">
      <span className="setup-effort">{effort}</span>
      {admin && <span className="setup-admin">{admin}</span>}
    </span>
  );
}

/** Paste fields for a flow's secrets (each checked against its pattern here; the kernel checks again on save). */
function SecretFields({ module, fields, present, done, elsewhere, reload, fail }: { module: string; fields: NonNullable<SetupFlowView["fields"]>; present: Record<string, boolean>; done: boolean; elsewhere?: boolean; reload: () => Promise<void>; fail: (e: unknown) => void }) {
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

/**
 * A module's advanced flow (`mode: advanced`): what the person's own app unlocks, then its steps, secrets and pairing, folded
 * until opened. Its parts start once its secrets exist; the basic sign-in above keeps working either way.
 */
function Advanced({ flow, advanced: a, board, reload, fail }: { flow: SetupFlowView; advanced: AdvancedFlowView; board: Board; reload: () => Promise<void>; fail: (e: unknown) => void }) {
  const [open, setOpen] = useState(a.done || (a.secrets ?? []).some((x) => flow.present[x]));
  const fields = a.fields ?? [];
  const saved = fields.every((f) => flow.present[f.secret]);
  let n = 1;
  return (
    <section className={`setup-adv${open ? " open" : ""}`} aria-label={a.title}>
      <header className="setup-adv-head">
        <div className="setup-adv-intro">
          <h2>Unlock more with your own app</h2>
          <p>{a.why}</p>
          <Effort effort={a.effort} admin={a.admin} />
        </div>
        <ul className="setup-caps">
          {a.capabilities.map((c) => (
            <li key={c}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {c}
            </li>
          ))}
        </ul>
        <div className="setup-adv-act">
          {a.done ? <p className="setup-ok-line">Your app is set up.</p> : null}
          <button className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide the steps" : a.done ? "Show the steps" : `Set up ${a.title}`}
          </button>
        </div>
      </header>
      {open && (
        <div className="setup-grid">
          <Step n={n++} title="Instructions" state="open">
            <Steps text={a.steps.split("{board_url}").join(board.url).split("{redirect_url}").join(flow.redirect_url ?? "")} />
            {a.console_url && (
              <a className="btn" href={a.console_url} target="_blank" rel="noreferrer">
                Open {a.title} ↗
              </a>
            )}
            {a.admin_page && (
              <a className="btn primary" href={`${admin.url}${a.admin_page}`}>
                Create the {a.title}
              </a>
            )}
          </Step>
          <div className="setup-side">
            {fields.length > 0 && (
              <Step n={n++} title="Paste the details" state={saved ? "done" : "open"}>
                <SecretFields module={flow.module} fields={fields} present={flow.present} done={saved} reload={reload} fail={fail} />
              </Step>
            )}
            {a.pair_url && (
              <Step n={n++} title="Pair" state={flow.paired ? "done" : saved ? "open" : "wait"}>
                {saved ? <Pairing flow={flow} reload={reload} fail={fail} /> : <p className="setup-hint">Save the details above first.</p>}
              </Step>
            )}
          </div>
        </div>
      )}
    </section>
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
