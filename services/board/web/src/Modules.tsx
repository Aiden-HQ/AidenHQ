// The Modules tab (#/modules): what is on and what is available, with a switch for each chosen module.
import { useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import { RowsSkeleton } from "./SettingsConnections";
import { ChangesScope, Group, Page, Row, StatusPill } from "./settings-ui";
import { useModuleToggle, useSetupNeeded } from "./ModuleParts";
import { SetupButton } from "./SetupButton";
import { Marketplaces } from "./Marketplaces";
import { ModulesBrowse } from "./ModulesBrowse";
import type { Advisory, ModuleRow } from "./types";
import "./settings.css";

export function ModulesView({ onSignIn }: { onSignIn: () => void }) {
  return (
    <ChangesScope onSignIn={onSignIn}>
      <div className="st-shell">
        <div className="st-pane">
          <div className="page wide">
            <ModulesTabs onSignIn={onSignIn} />
          </div>
        </div>
      </div>
    </ChangesScope>
  );
}

type ModulesTab = "installed" | "browse" | "marketplaces";
const MODULE_TABS: [ModulesTab, string][] = [["installed", "Installed"], ["browse", "Browse"], ["marketplaces", "Marketplaces"]];

/** Installed (lane D), Browse and Marketplaces (lane E). */
function ModulesTabs({ onSignIn }: { onSignIn: () => void }) {
  const [tab, setTab] = useState<ModulesTab>("installed");
  return (
    <>
      <div className="st-seg" role="tablist">
        {MODULE_TABS.map(([t, name]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {name}
          </button>
        ))}
      </div>
      {tab === "installed" && <ModulesPage onSignIn={onSignIn} />}
      {tab === "browse" && <ModulesBrowse onSignIn={onSignIn} />}
      {tab === "marketplaces" && <Marketplaces onSignIn={onSignIn} />}
    </>
  );
}

function ModulesPage({ onSignIn }: { onSignIn: () => void }) {
  const [mods, setMods] = useState<ModuleRow[] | null>(null);
  const [advisories, setAdvisories] = useState<Advisory[]>([]);
  const [error, setError] = useState("");
  const needsSetup = useSetupNeeded();
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
  const chosen = mods.filter((m) => m.state === "on");
  const fixed = mods.filter((m) => m.state === "core" || m.state === "dependency");
  const off = mods.filter((m) => m.state === "off");
  return (
    <Page title="Modules" sub={`${chosen.length + fixed.length} on, ${off.length} available. A module brings its agents, connections and apps; turning one on or off is a change you approve.`}>
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
      <Group title="Chosen by you" count={chosen.length}>
        {chosen.map((m) => (
          <ModuleItem key={m.name} m={m} setup={needsSetup.has(m.name)} />
        ))}
      </Group>
      <Group title="Core and dependencies" count={fixed.length}>
        {fixed.map((m) => (
          <ModuleItem key={m.name} m={m} setup={needsSetup.has(m.name)} />
        ))}
      </Group>
      {off.length > 0 && (
        <Group title="Available" count={off.length}>
          {off.map((m) => (
            <ModuleItem key={m.name} m={m} setup={false} />
          ))}
        </Group>
      )}
    </Page>
  );
}

/** Why a module that isn't chosen is on: always (the kernel) or because other modules need it. */
const why = (m: ModuleRow) => (m.state === "core" ? "always on" : m.state === "dependency" ? (m.neededBy.length ? `needed by ${m.neededBy.join(", ")}` : "needed by another") : undefined);

function ModuleItem({ m, setup }: { m: ModuleRow; setup: boolean }) {
  const t = useModuleToggle(m);
  const counts = [m.agents.length && `${m.agents.length} agent${m.agents.length === 1 ? "" : "s"}`, m.connections.length && `${m.connections.length} connection${m.connections.length === 1 ? "" : "s"}`].filter(Boolean).join(", ");
  return (
    <>
      {t.dialog}
      <Row
        title={<a href={`#/modules/${m.name}`}>{m.name}</a>}
        sub={`${m.description}${counts ? ` · ${counts}` : ""} · ${m.marketplace} ${m.tier}${m.pinned ? ` · pinned at ${m.pinned}` : ""}`}
        meta={
          <>
            {t.meta}
            {setup && <StatusPill tone="warn">Needs setup</StatusPill>}
            {why(m) && <span className="st-chip">{why(m)}</span>}
          </>
        }
        action={
          <>
            {setup && <SetupButton module={m.name} primary />}
            {t.switchEl}
          </>
        }
        open={t.want !== null || Boolean(t.filed) || undefined}
        onToggle={(o) => !o && t.setWant(null)}
        details={t.preview || t.progress ? <>{t.progress}{t.preview}</> : undefined}
      />
    </>
  );
}
