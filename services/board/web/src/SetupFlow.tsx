// A module's guided setup at #/setup/<module>, rendered from its board.setup_flows declaration: why and effort, the steps, one
// paste field per secret, then the sign-in's Connect button or a pairing code. Nothing here knows which module it is.
import { useCallback, useEffect, useState } from "react";
import { SignInRequired, api, type SetupFlowView } from "./api";
import { Markdown } from "./markdown";
import { Page } from "./settings-ui";
import "./settings.css";
import "./setup-flow.css";

const label = (secret: string, module: string) => secret.replace(new RegExp(`^${module.replace(/-/g, "_")}_`), "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function SetupFlow({ module, onDone, onSignIn }: { module: string; onDone: () => void; onSignIn: () => void }) {
  const [flow, setFlow] = useState<SetupFlowView | null | undefined>(undefined);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api.setupFlows().then(
        (r) => setFlow(r.flows.find((f) => f.module === module) ?? null),
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
        <FlowBody flow={flow} reload={load} onDone={onDone} onSignIn={onSignIn} />
      )}
    </div>
  );
}

function FlowBody({ flow, reload, onDone, onSignIn }: { flow: SetupFlowView; reload: () => Promise<void>; onDone: () => void; onSignIn: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const secrets = flow.secrets ?? [];
  const secretsDone = secrets.every((s) => flow.present[s]);
  const fail = (e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      for (const s of secrets) if (values[s]?.trim()) await api.setupSecret(flow.module, s, values[s]!.trim());
      setValues({});
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page title={flow.title} sub={flow.why} tools={<span className="setup-effort">{flow.effort}</span>}>
      <section className="setup-card">
        <Markdown text={flow.steps} prefix="SETUP" className="setup-steps" />
      </section>
      {secrets.length > 0 && (
        <section className="setup-card">
          {secrets.map((s) => (
            <label key={s} className="setup-field">
              <span>
                {label(s, flow.module)}
                {flow.present[s] && <em className="setup-ok">saved</em>}
              </span>
              <input type="password" autoComplete="off" spellCheck={false} placeholder={flow.present[s] ? "Paste to replace" : "Paste here"} value={values[s] ?? ""} onChange={(e) => setValues({ ...values, [s]: e.target.value })} />
            </label>
          ))}
          <div className="setup-actions">
            <button className="btn primary" disabled={saving || !secrets.some((s) => values[s]?.trim())} onClick={save}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </section>
      )}
      {error && <p className="setup-error" role="alert">{error}</p>}
      {secretsDone && flow.signin && (
        <section className="setup-card">
          {flow.signedIn ? <p className="setup-ok-line">Connected.</p> : <a className="btn primary" href={`/${flow.signin}/connect`}>Connect</a>}
        </section>
      )}
      {secretsDone && flow.pair_url && <Pairing flow={flow} reload={reload} fail={fail} />}
      <div className="setup-actions">
        {flow.done ? (
          <button className="btn primary" onClick={onDone}>Done</button>
        ) : (
          <button className="btn" onClick={() => api.setupDismiss(flow.module).then(onDone, fail)}>Later</button>
        )}
      </div>
    </Page>
  );
}

function Pairing({ flow, reload, fail }: { flow: SetupFlowView; reload: () => Promise<void>; fail: (e: unknown) => void }) {
  const [pair, setPair] = useState<{ code: string; link?: string } | null>(null);
  useEffect(() => {
    if (!pair || flow.paired) return;
    const t = setInterval(() => api.setupPaired(flow.module).then((r) => void (r.paired && reload()), () => {}), 2000);
    return () => clearInterval(t);
  }, [pair, flow.paired, flow.module, reload]);
  if (flow.paired) return <section className="setup-card"><p className="setup-ok-line">Paired.</p></section>;
  return (
    <section className="setup-card">
      {pair ? (
        <>
          <div className="setup-code">{pair.code}</div>
          {pair.link && <a className="btn primary" href={pair.link} target="_blank" rel="noreferrer">Open</a>}
          <p className="setup-hint">Waiting for you to send the code. It works once, for 15 minutes.</p>
        </>
      ) : (
        <button className="btn primary" onClick={() => api.setupPair(flow.module).then(setPair, fail)}>Get a pairing code</button>
      )}
    </section>
  );
}
