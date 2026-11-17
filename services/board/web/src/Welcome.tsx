// The first-run wizard: a model gate, then the recovery key (when one is waiting), each module flow marked `wizard`, and a
// summary that ends in Aiden's welcome chat. It wraps the app (main.tsx), so every board route sits behind the model gate.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SignInRequired, admin, api, type SetupFlowView, type WelcomeState } from "./api";
import { Page } from "./settings-ui";
import { SetupFlow } from "./SetupFlow";
import "./settings.css";
import "./setup-flow.css";
import "./welcome.css";

const go = (hash: string) => {
  if (location.hash !== hash) location.hash = hash;
};

export function WelcomeGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WelcomeState | null>(null);
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    // Signed out, or a kernel that doesn't answer: the app shows its own sign-in or error.
    api
      .session()
      .then((s) => (s.account ? api.welcome() : null))
      .then((w) => {
        setState(w);
        if (w && w.modelReady && !w.finished && location.hash !== "#/welcome") go("#/welcome");
      })
      .catch(() => {});
  }, []);

  if (state && !state.modelReady) return <ModelGate />;
  if (state && !state.finished && hash === "#/welcome") return <Wizard state={state} onFinished={() => setState({ ...state, finished: true })} />;
  return <>{children}</>;
}

function ModelGate() {
  return (
    <div className="setup-overlay">
      <Page title="Connect a model to start" sub="Aiden needs an AI model before anything else works. It takes a minute.">
        <section className="setup-card">
          <a className="btn primary" href={`${admin.url}/setup/model`}>Connect a model</a>
        </section>
      </Page>
    </div>
  );
}

type Screen = { kind: "key" } | { kind: "flow"; module: string } | { kind: "summary" };

function Wizard({ state, onFinished }: { state: WelcomeState; onFinished: () => void }) {
  const screens: Screen[] = [...(state.recoveryKeyWaiting ? [{ kind: "key" as const }] : []), ...state.wizard.map((module) => ({ kind: "flow" as const, module })), { kind: "summary" as const }];
  const [at, setAt] = useState(0);
  const [flows, setFlows] = useState<SetupFlowView[]>([]);
  const [error, setError] = useState("");
  const finishing = useRef(false);
  const refresh = useCallback(() => api.setupFlows().then((r) => setFlows(r.flows.filter((f) => state.wizard.includes(f.module))), () => {}), [state.wizard]);
  useEffect(() => void refresh(), [refresh, at]);

  const screen = screens[Math.min(at, screens.length - 1)]!;
  const next = () => setAt((i) => Math.min(i + 1, screens.length - 1));
  const finish = async () => {
    if (finishing.current) return;
    finishing.current = true;
    setError("");
    try {
      const fresh = await api.setupFlows().then((r) => r.flows.filter((f) => state.wizard.includes(f.module)), () => flows);
      const r = await api.welcomeFinish(fresh.filter((f) => f.done).map((f) => f.module), fresh.filter((f) => !f.done).map((f) => f.module));
      onFinished();
      go(r.identifier ? `#/c/${r.identifier}` : "#/");
    } catch (e) {
      finishing.current = false;
      setError(e instanceof SignInRequired ? "Sign in again to continue." : (e as Error).message);
    }
  };

  return (
    <>
      {screen.kind === "key" && (
        <div className="setup-overlay">
          <Page title="Save your recovery key" sub="It opens your vault if the sealed password is ever lost. It is shown once.">
            <section className="setup-card">
              <a className="btn primary" href={`${admin.url}/recovery-key`}>Show my recovery key</a>
              <button className="btn" onClick={next}>Skip for now</button>
            </section>
          </Page>
        </div>
      )}
      {screen.kind === "flow" && <SetupFlow key={screen.module} module={screen.module} onDone={next} onSignIn={() => location.reload()} />}
      {screen.kind === "summary" && (
        <div className="setup-overlay">
          <Page title="You're set" sub="Aiden will pick up from here.">
            <section className="setup-card">
              {flows.length === 0 ? <p className="setup-hint">Everything else is set up from Settings, any time.</p> : (
                <ul className="welcome-list">
                  {flows.map((f) => (
                    <li key={f.module} className={f.done ? "done" : ""}>
                      <span>{f.title}</span>
                      <em>{f.done ? "Connected" : "Skipped"}</em>
                    </li>
                  ))}
                </ul>
              )}
              <div className="setup-actions">
                <button className="btn primary" onClick={finish}>Meet Aiden</button>
              </div>
            </section>
          </Page>
        </div>
      )}
      <nav className="welcome-bar" aria-label="Setup progress">
        <div className="welcome-dots" role="list">
          {screens.map((_, i) => (
            <span key={i} role="listitem" className={i === at ? "on" : i < at ? "past" : ""} aria-current={i === at ? "step" : undefined} />
          ))}
        </div>
        {error && <span className="welcome-error" role="alert">{error}</span>}
        <span className="spacer" />
        <button className="btn" onClick={finish}>Later</button>
        {screen.kind !== "summary" && <button className="btn primary" onClick={finish}>Meet Aiden now</button>}
      </nav>
    </>
  );
}
