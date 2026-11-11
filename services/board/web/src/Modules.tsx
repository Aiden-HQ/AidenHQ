import { useCallback, useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import type { ModuleRow } from "./types";

const STATE: Record<ModuleRow["state"], { label: string; pill: string }> = {
  core: { label: "Core", pill: "pill-working" },
  on: { label: "On", pill: "pill-working" },
  dependency: { label: "On as a dependency", pill: "" },
  off: { label: "Off", pill: "" },
};

/** The module catalog, read-only. Turning one on is a message to Aiden that you send yourself. */
export function ModulesView({ onSignIn }: { onSignIn: () => void }) {
  const [modules, setModules] = useState<ModuleRow[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setModules((await api.modules()).modules);
      setError("");
    } catch (e) {
      if (e instanceof SignInRequired) onSignIn();
      else setError((e as Error).message);
    }
  }, [onSignIn]);
  useEffect(() => void load(), [load]);

  const on = modules?.filter((m) => m.state !== "off").length ?? 0;
  return (
    <main className="page wide">
      <header className="page-head">
        <div>
          <h1>Modules</h1>
          <p className="page-sub">{modules ? `${on} of ${modules.length} on` : "Loading…"}</p>
        </div>
      </header>
      {error && <div className="offline">Couldn't load modules: {error}</div>}
      {!modules ? (
        !error && <span className="spinner" />
      ) : (
        <div className="app-grid">
          {modules.map((m) => (
            <article key={m.name} className={`app-card module-card${m.state === "off" ? " off" : ""}`}>
              <header className="app-card-head">
                <h3>{m.name}</h3>
                <span className={`pill ${STATE[m.state].pill}`}>{STATE[m.state].label}</span>
              </header>
              {m.description && <p className="module-desc">{m.description}</p>}
              <dl className="panel-facts">
                <dt>Agents</dt>
                <dd>{m.agents.length ? m.agents.join(", ") : <span className="muted">none</span>}</dd>
                <dt>Requires</dt>
                <dd>{m.requires.length ? m.requires.join(", ") : <span className="muted">nothing</span>}</dd>
              </dl>
              {m.state === "off" && (
                <a className="btn" href={`#/c/?text=${encodeURIComponent(`Please turn on the ${m.name} module.`)}`}>
                  Ask Aiden
                </a>
              )}
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
