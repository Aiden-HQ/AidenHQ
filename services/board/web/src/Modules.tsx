// The Modules tab (#/modules): what is on and what is available, with a switch for each chosen module.
import { useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import { RowsSkeleton } from "./SettingsConnections";
import { ChangePreview, ChangeProgress, ChangesScope, Group, IN_FLIGHT, Page, Row, StatusPill, Switch, useFiled } from "./settings-ui";
import type { Advisory, ModuleRow } from "./types";
import "./settings.css";

export function ModulesView({ onSignIn }: { onSignIn: () => void }) {
  return (
    <ChangesScope onSignIn={onSignIn}>
      <div className="st-shell">
        <div className="st-pane">
          <div className="page wide">
            <ModulesPage onSignIn={onSignIn} />
          </div>
        </div>
      </div>
    </ChangesScope>
  );
}

function ModulesPage({ onSignIn }: { onSignIn: () => void }) {
  const [mods, setMods] = useState<ModuleRow[] | null>(null);
  const [advisories, setAdvisories] = useState<Advisory[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api.modules().then(
      (r) => (setMods(r.modules), setAdvisories(r.advisories ?? [])),
      (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)),
    );
  }, [onSignIn]);
  if (!mods)
    return (
      <Page title="Modules" sub={error ? `Couldn't load modules: ${error}` : "Loading…"}>
        {!error && <RowsSkeleton />}
      </Page>
    );
  const on = mods.filter((m) => m.state !== "off");
  const off = mods.filter((m) => m.state === "off");
  return (
    <Page title="Modules" sub={`${on.length} on, ${off.length} available. A module brings its agents, connections and apps; turning one on or off is a change you approve.`}>
      {advisories.map((a) => (
        <div key={a.id} className={`st-banner${a.severity === "high" || a.severity === "critical" ? " bad" : ""}`} role="alert">
          <strong>Advisory {a.id}</strong> ({a.severity}) affects the installed {a.module}: {a.summary.replace(/^`|`$/g, "")}
          {a.url && (
            <>
              {" "}
              <a href={a.url} target="_blank" rel="noreferrer noopener">
                Details
              </a>
            </>
          )}
          . The fix is an ordinary update to a newer pin.
        </div>
      ))}
      <Group title="On" count={on.length}>
        {on.map((m) => (
          <ModuleItem key={m.name} m={m} />
        ))}
      </Group>
      {off.length > 0 && (
        <Group title="Available" count={off.length}>
          {off.map((m) => (
            <ModuleItem key={m.name} m={m} />
          ))}
        </Group>
      )}
    </Page>
  );
}

function ModuleItem({ m }: { m: ModuleRow }) {
  const filed = useFiled((c) => c.kind === "module" && c.name === m.name);
  const [want, setWant] = useState<boolean | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const isOn = m.state !== "off";
  const fixed = m.state === "core" || m.state === "dependency";
  return (
    <>
    {confirmOff && (
      <div className="drawer-backdrop center" onPointerDown={(e) => e.target === e.currentTarget && setConfirmOff(false)}>
        <div className="new-task" role="dialog" aria-label={`Turn off ${m.name}?`}>
          <h2>Turn off {m.name}?</h2>
          {m.agents.length > 0 && <p>These agents will stop: {m.agents.join(", ")}.</p>}
          <p>Their tasks and the module's data are kept; turning it back on resumes.</p>
          <div className="ap-bar">
            <span className="spacer" />
            <button className="btn" autoFocus onClick={() => setConfirmOff(false)}>Cancel</button>
            <button className="btn primary" onClick={() => (setConfirmOff(false), setWant(false))}>Turn off</button>
          </div>
        </div>
      </div>
    )}
    <Row
      title={m.name}
      sub={m.description}
      meta={filed && IN_FLIGHT.includes(filed.stage) ? <StatusPill tone="busy">Changing</StatusPill> : m.state === "core" ? <span className="st-chip">always on</span> : m.state === "dependency" ? <span className="st-chip">needed by another</span> : undefined}
      action={!fixed ? <Switch on={want ?? isOn} label={`${m.name}: ${isOn ? "on" : "off"}`} redOff disabled={Boolean(filed && IN_FLIGHT.includes(filed.stage))} onChange={(v) => (v ? setWant(true) : setConfirmOff(true))} /> : undefined}
      open={want !== null || undefined}
      onToggle={(o) => !o && setWant(null)}
      details={
        <>
          {filed && <ChangeProgress f={filed} />}
          {want !== null && want !== isOn ? (
            <ChangePreview items={[{ kind: "module", name: m.name, on: want }]} was={[isOn]} onCancel={() => setWant(null)} onDone={() => setWant(null)} note={want ? "You approve it on the card. A module that needs settings (a URL, a site) asks for them on its page once it is on." : "You approve it on the card. Its agents stop and its connections close."} />
          ) : (
            <dl className="st-facts compact">
              <dt>Agents</dt>
              <dd>{m.agents.length ? m.agents.join(", ") : <span className="muted">none</span>}</dd>
              <dt>Needs</dt>
              <dd>{m.requires.length ? m.requires.join(", ") : <span className="muted">nothing</span>}</dd>
              <dt>From</dt>
              <dd>
                {m.marketplace} <span className="st-chip">{m.tier}</span>
              </dd>
            </dl>
          )}
        </>
      }
    />
    </>
  );
}

