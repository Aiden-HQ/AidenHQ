// Modules > Browse: every module across the instance's marketplaces, with one action button that follows its state.
import { useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import { RowsSkeleton } from "./SettingsConnections";
import { SetupButton } from "./SetupButton";
import { ChangeProgress, Group, IN_FLIGHT, Row, useChanges, useFiled } from "./settings-ui";
import type { BrowseModule, SettingChange } from "./types";
import "./settings.css";

const KINDS: [string, string][] = [["", "All"], ["agents", "Agents"], ["connections", "Connections"], ["channels", "Channels"], ["apps", "Apps"]];

export function ModulesBrowse({ onSignIn }: { onSignIn: () => void }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [rows, setRows] = useState<BrowseModule[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      api.browse(q, kind).then(
        (r) => (setRows(r.modules), setError("")),
        (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)),
      );
    }, 200);
    return () => clearTimeout(t);
  }, [q, kind, onSignIn]);
  return (
    <section className="st-page">
      <div className="br-bar">
        <input className="br-search" type="search" placeholder="Search modules" aria-label="Search modules" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="st-seg" role="group" aria-label="Kind">
          {KINDS.map(([k, name]) => (
            <button key={k} className={kind === k ? "on" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      {error ? <p className="fleet-empty">Couldn't load modules: {error}</p> : !rows ? <RowsSkeleton /> : rows.length === 0 ? <p className="fleet-empty">Nothing matches.</p> : (
        <Group count={rows.length}>
          {rows.map((m) => (
            <BrowseRow key={m.name} m={m} />
          ))}
        </Group>
      )}
    </section>
  );
}

function BrowseRow({ m }: { m: BrowseModule }) {
  const filed = useFiled((c) => c.kind === "module" && c.name === m.name);
  const [asking, setAsking] = useState(false);
  const live = m.installed || filed?.stage === "applied";
  return (
    <>
      {asking && <InstallCard m={m} onClose={() => setAsking(false)} />}
      <Row
        title={m.name}
        sub={m.description}
        meta={
          <span className="st-chip">
            {m.marketplace} · {m.tier}
          </span>
        }
        action={<ModuleAction m={m} stage={live ? "live" : filed?.stage} tier={filed?.tier} onInstall={() => setAsking(true)} />}
        details={
          <>
            {m.adds.length > 0 && (
              <ul className="br-adds">
                {m.adds.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            )}
            {m.setupFlow && !live && <p className="muted">Needs setup after install: {m.setupFlow.title}</p>}
            {filed && IN_FLIGHT.concat(["failed", "rejected"]).includes(filed.stage) && <ChangeProgress f={filed} />}
          </>
        }
      />
    </>
  );
}

function ModuleAction({ m, stage, tier, onInstall }: { m: BrowseModule; stage?: string; tier?: number; onInstall: () => void }) {
  if (stage === "live") return (
    <>
      <span className="st-chip">Installed</span>
      <SetupButton module={m.name} primary />
    </>
  );
  if (stage === "working") return <button className="btn" disabled>In review</button>;
  if (stage === "waiting") return <button className="btn" disabled>{tier === 1 ? "In review" : "Waiting for your tap"}</button>;
  if (stage === "applying") return <button className="btn" disabled>Applying</button>;
  return (
    <button className="btn primary" onClick={onInstall}>
      {stage === "failed" || stage === "rejected" ? "Try again" : "Install"}
    </button>
  );
}

/** What it may read and write, what it needs and who taps, then Request install. */
function InstallCard({ m, onClose }: { m: BrowseModule; onClose: () => void }) {
  const { file, toast } = useChanges();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const taps = m.adds.some((a) => a.startsWith("needs")) || m.tier !== "official";
  const go = async () => {
    setBusy(true);
    try {
      const task = await file([{ kind: "module", name: m.name, on: true } as SettingChange]);
      toast(`Install requested (${task}).`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="drawer-backdrop center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="new-task" role="dialog" aria-label={`Install ${m.name}`}>
        <h2>Install {m.name}</h2>
        <p>{m.description}</p>
        <p>
          From {m.marketplace} ({m.tier}). It would add:
        </p>
        <ul className="br-adds">{m.adds.length ? m.adds.map((a) => <li key={a}>{a}</li>) : <li>nothing beyond its own settings</li>}</ul>
        <p className="muted">
          {taps ? "It adds access or sign-ins, so after the AI review you tap to approve." : "The AI reviewer checks it; you tap only if it turns out to add new authority."}
          {m.setupFlow ? ` Afterwards: ${m.setupFlow.title}.` : ""}
        </p>
        {error && <p className="st-error" role="alert">{error}</p>}
        <div className="ap-bar">
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" autoFocus onClick={() => void go()} disabled={busy}>{busy ? "Requesting…" : "Request install"}</button>
        </div>
      </div>
    </div>
  );
}
