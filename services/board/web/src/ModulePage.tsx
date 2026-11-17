// A module's page (#/modules/<name>/<tab>): what it is, its agents and work, what it may do, its contents, settings and changes.
import { useEffect, useState } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { SignInRequired, api } from "./api";
import { STATUS_LABEL, connectionStatus, displayName, type ConnectionRow } from "./connections";
import { useModuleToggle, useSetupNeeded } from "./ModuleParts";
import { SettingItem } from "./Settings";
import { ChangePreview, ChangesScope, Group, StatusPill, useChanges } from "./settings-ui";
import { SetupButton } from "./SetupButton";
import { SkeletonLines } from "./Skeleton";
import type { ModuleDetail, ModuleRow, PinChange, SettingChange, SettingRow, TaskRow } from "./types";
import { ago } from "./util";
import "./settings.css";

export type ModuleTab = "overview" | "contents" | "settings" | "changes";
const TABS: [ModuleTab, string][] = [["overview", "Overview"], ["contents", "Contents"], ["settings", "Settings"], ["changes", "Changes"]];

const tone = (state: string) => (state === "failed" ? "failed" : state === "working" || state === "queued" ? "working" : state.startsWith("waiting") ? "needs" : "");

export function ModulePage(props: { name: string; tab: ModuleTab; go: (hash: string) => void; onSignIn: () => void }) {
  return (
    <ChangesScope onSignIn={props.onSignIn}>
      <ModuleBody {...props} />
    </ChangesScope>
  );
}

function ModuleBody({ name, tab, go, onSignIn }: { name: string; tab: ModuleTab; go: (hash: string) => void; onSignIn: () => void }) {
  const [d, setD] = useState<ModuleDetail | null>(null);
  const [error, setError] = useState("");
  const needsSetup = useSetupNeeded();
  useEffect(() => {
    api.module(name).then(setD, (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)));
  }, [name, onSignIn]);
  if (!d)
    return (
      <main className="page wide">
        {error ? <p className="empty">{/no such module/.test(error) ? <>No module called {name}. <a href="#/modules">Back to Modules</a></> : `Couldn't load: ${error}`}</p> : <SkeletonLines lines={6} />}
      </main>
    );
  return <Loaded d={d} tab={tab} go={go} onSignIn={onSignIn} setup={needsSetup.has(name)} />;
}

function Loaded({ d, tab, go, onSignIn, setup }: { d: ModuleDetail; tab: ModuleTab; go: (hash: string) => void; onSignIn: () => void; setup: boolean }) {
  const m = d.module;
  const t = useModuleToggle(m);
  const line = [m.revision, m.marketplace, m.tier].filter(Boolean).join(" · ");
  return (
    <main className="page wide agent-page">
      <nav className="ap-crumb"><a href="#/modules">Modules</a> / {m.name}</nav>
      <header className="page-head ap-head">
        <div>
          <h1>{m.name} {t.meta}{setup && <StatusPill tone="warn">Needs setup</StatusPill>}</h1>
          <p className="page-sub">{line}</p>
          <p className="page-sub">{m.description}</p>
        </div>
        <span className="spacer" />
        {setup && <SetupButton module={m.name} primary />}
        {!setup && <SetupButton module={m.name} />}
        {t.switchEl && <><span className="muted">{t.isOn ? "On" : "Off"}</span>{t.switchEl}</>}
      </header>
      {t.dialog}
      {t.progress}
      {t.preview}
      <Pin m={m} />
      <div className="st-seg" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => go(`#/modules/${m.name}${k === "overview" ? "" : `/${k}`}`)}>{label}</button>
        ))}
      </div>
      {tab === "overview" && <Overview d={d} />}
      {tab === "contents" && <Contents d={d} onSignIn={onSignIn} />}
      {tab === "settings" && <ModuleSettings m={m} onSignIn={onSignIn} />}
      {tab === "changes" && <ModuleChanges m={m} />}
    </main>
  );
}

/** "Pinned at X": the module is held at its own commit; Follow marketplace removes the pin. */
function Pin({ m }: { m: ModuleRow }) {
  const [open, setOpen] = useState(false);
  if (!m.pinned) return null;
  const change = { kind: "pin", name: m.name, sha: null } satisfies PinChange as unknown as SettingChange;
  return (
    <div className="st-banner">
      Pinned at {m.pinned}: this module stays there when its marketplace moves.{" "}
      {!open && <button className="btn" onClick={() => setOpen(true)}>Follow marketplace</button>}
      {open && <ChangePreview items={[change]} was={[m.pinned]} onCancel={() => setOpen(false)} onDone={() => setOpen(false)} note="Removes the pin: the module follows its marketplace again." />}
    </div>
  );
}

function Tasks({ rows }: { rows: TaskRow[] }) {
  if (!rows.length) return <p className="fleet-empty">Nothing running.</p>;
  return (
    <div className="st-rows">
      {rows.map((r) => (
        <a key={r.identifier} className="ap-row" href={`#/t/${r.identifier}`}>
          <span className={`pill${tone(r.state) ? ` pill-${tone(r.state)}` : ""}`}>{r.state}</span>
          <span className="ap-id">{r.identifier}</span>
          <span className="ap-title">{r.title}</span>
          {r.from && <span className="ap-from">from {r.from}</span>}
          <span className="time">{ago(r.updatedAt)}</span>
        </a>
      ))}
    </div>
  );
}

const modLinks = (names: string[]) => (names.length ? names.map((n, i) => <span key={n}>{i > 0 && ", "}<a href={`#/modules/${n}`}>{n}</a></span>) : <span className="muted">nothing</span>);

function Agents({ d }: { d: ModuleDetail }) {
  if (!d.agents.length) return <p className="fleet-empty">No agents.</p>;
  return (
    <div className="st-rows">
      {d.agents.map((a) => (
        <a key={a.key} className="ap-row" href={`#/agents/${a.key}`}>
          <AgentAvatar name={a.name} portrait={a.avatar} size={24} />
          <span className="ap-title">{a.name}</span>
          <span className="ap-from">{[a.title, a.status].filter(Boolean).join(" · ")}</span>
        </a>
      ))}
    </div>
  );
}

function Overview({ d }: { d: ModuleDetail }) {
  const m = d.module;
  const { connections, writes, secrets } = d.authority;
  return (
    <>
      <section><h4>Agents</h4><Agents d={d} /></section>
      {d.agents.length > 0 && <section><h4>Ongoing work</h4><Tasks rows={d.ongoing} /></section>}
      <section>
        <h4>What it may do</h4>
        <dl className="st-facts compact">
          <dt>Connections</dt>
          <dd>{connections.length ? connections.join(", ") : <span className="muted">none</span>}</dd>
          <dt>Writes</dt>
          <dd>{writes.length ? writes.map((w) => `${w.kind}${w.tier != null ? ` (tier ${w.tier})` : ""}`).join(", ") : <span className="muted">none declared</span>}</dd>
          <dt>Secrets</dt>
          <dd>{secrets.length ? secrets.join(", ") : <span className="muted">none declared</span>}</dd>
        </dl>
      </section>
      <section>
        <h4>Needs and needed by</h4>
        <dl className="st-facts compact">
          <dt>Needs</dt>
          <dd>{modLinks(d.requires)}</dd>
          <dt>Needed by</dt>
          <dd>{modLinks(d.neededBy)}</dd>
        </dl>
      </section>
      <section>
        <h4>If you turn it off</h4>
        <p>
          {m.state === "core" ? "It is always on." : d.neededBy.length ? `It can't be turned off while ${d.neededBy.join(", ")} need${d.neededBy.length === 1 ? "s" : ""} it.` : `${m.agents.length ? `Its agents stop (${m.agents.join(", ")})` : "No agents stop"}${m.routines.length ? ` and its routines (${m.routines.join(", ")})` : ""}. Their tasks and the module's data on disk are kept; turning it back on resumes.`}
        </p>
      </section>
    </>
  );
}

function Contents({ d, onSignIn }: { d: ModuleDetail; onSignIn: () => void }) {
  const m = d.module;
  const [conns, setConns] = useState<ConnectionRow[] | null>(null);
  useEffect(() => {
    api.connections().then((r) => setConns(r.connections.filter((c) => c.module === m.name)), (e) => e instanceof SignInRequired && onSignIn());
  }, [m.name, onSignIn]);
  return (
    <>
      <section><h4>Agents</h4><Agents d={d} /></section>
      <section>
        <h4>Connections</h4>
        {!m.connections.length ? <p className="fleet-empty">None.</p> : (
          <div className="st-rows">
            {m.connections.map((c) => {
              const row = conns?.find((r) => r.name === c);
              const v = row ? connectionStatus(row, { signIn: false, google: false }) : null;
              return (
                <a key={c} className="ap-row" href="#/settings/connections">
                  <span className="ap-title">{displayName(c)}</span>
                  {v && <span className="ap-from">{STATUS_LABEL[v.status]}</span>}
                </a>
              );
            })}
          </div>
        )}
      </section>
      <section><h4>Routines</h4>{m.routines.length ? <p>{m.routines.join(", ")}</p> : <p className="fleet-empty">None.</p>}</section>
      <section><h4>Apps</h4>{m.apps.length ? <p>{m.apps.join(", ")}</p> : <p className="fleet-empty">None.</p>}</section>
      {m.source && <p className="muted">Source: {m.source.url} · {m.source.path}</p>}
    </>
  );
}

function ModuleSettings({ m, onSignIn }: { m: ModuleRow; onSignIn: () => void }) {
  const [rows, setRows] = useState<SettingRow[] | null>(null);
  useEffect(() => {
    api.settings().then((r) => setRows(r.settings.filter((s) => s.module === m.name)), (e) => e instanceof SignInRequired && onSignIn());
  }, [m.name, onSignIn]);
  if (!rows) return <SkeletonLines lines={3} />;
  if (!rows.length) return <p className="fleet-empty">{m.name} has no settings.</p>;
  return <Group title="Settings" count={rows.length}>{rows.map((s) => <SettingItem key={s.key} s={s} />)}</Group>;
}

function ModuleChanges({ m }: { m: ModuleRow }) {
  const { changes } = useChanges();
  const keys = Object.keys(m.settings);
  const mine = changes.filter((f) => f.items.some((c) => ((c.kind === "module" || (c.kind as string) === "pin") && (c as { name: string }).name === m.name) || (c.kind === "setting" && keys.includes(c.key))));
  if (!mine.length) return <p className="fleet-empty">No changes to {m.name} yet.</p>;
  return (
    <div className="st-rows">
      {mine.map((f) => (
        <a key={f.identifier} className="ap-row" href={`#/c/${f.identifier}`}>
          <span className={`pill${f.stage === "failed" || f.stage === "rejected" ? " pill-failed" : f.stage === "applied" ? "" : " pill-working"}`}>{f.stage}</span>
          <span className="ap-id">{f.identifier}</span>
          <span className="ap-title">{f.title}</span>
          <span className="time">{ago(f.createdAt)}</span>
        </a>
      ))}
    </div>
  );
}
