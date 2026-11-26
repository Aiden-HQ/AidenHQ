// The Modules page (#/team/modules): every module as a tile, installed first, then available; one search over both, and
// Marketplaces (where modules come from) one click away.
import { useEffect, useMemo, useRef, useState } from "react";
import { SignInRequired, api } from "./api";
import { Marketplaces } from "./Marketplaces";
import { LockIcon, ModuleFacts, ModuleStatus, TurnOnCard, lockedWhy, moduleState, publisher, useModuleToggle, useSetupNeeded, useSetupPairing } from "./ModuleParts";
import { ConnectButton, useConnectNeeded, type Can, type Connectable } from "./Connect";
import { ChangesScope, IN_FLIGHT } from "./settings-ui";
import { safeHref } from "./ui";
import { SetupButton } from "./SetupButton";
import { SkeletonLines } from "./Skeleton";
import type { Advisory, BrowseModule, MarketplaceRow, ModuleRow } from "./types";
import { EmptyState } from "./ui/EmptyState";
import { PageHeader } from "./ui/PageHeader";
import { Section } from "./ui/Section";
import { Segmented } from "./ui/Segmented";
import { Tile, TileGrid } from "./ui/Tile";
import "./settings.css";
import "./modules.css";

type Show = "installed" | "available" | "all";
const SHOW = [["installed", "Installed"], ["available", "Available"], ["all", "All"]] as const;

export function ModulesView({ onSignIn, can }: { onSignIn: () => void; can: Can }) {
  const [markets, setMarkets] = useState(false);
  return (
    <ChangesScope onSignIn={onSignIn}>
      {/* A page with its own main landmark (off the board, App.tsx's <main> is hidden); .mods keeps its gutters and scroll. */}
      <main className="mods page wide">
        {markets ? (
          <>
            <PageHeader crumb={<><a href="#/team/modules" onClick={(e) => (e.preventDefault(), setMarkets(false))}>Modules</a> / Marketplaces</>} title="Marketplaces" sub="Where modules come from, each held at a commit at least 7 days old. Updating one moves every module it holds." />
            <div className="mods-markets">
              <Marketplaces onSignIn={onSignIn} />
            </div>
          </>
        ) : (
          <ModulesList onSignIn={onSignIn} onMarkets={() => setMarkets(true)} can={can} />
        )}
      </main>
    </ChangesScope>
  );
}

function ModulesList({ onSignIn, onMarkets, can }: { onSignIn: () => void; onMarkets: () => void; can: Can }) {
  const [mods, setMods] = useState<ModuleRow[] | null>(null);
  const [advisories, setAdvisories] = useState<Advisory[]>([]);
  const [info, setInfo] = useState<Map<string, BrowseModule>>(new Map());
  const [newer, setNewer] = useState<MarketplaceRow[]>([]);
  const [error, setError] = useState("");
  const [show, setShow] = useState<Show>("installed");
  const [q, setQ] = useState("");
  const needsSetup = useSetupNeeded();
  const needsPairing = useSetupPairing();
  const needsConnect = useConnectNeeded(can);
  useEffect(() => {
    api.modules().then(
      (r) => (setMods(r.modules), setAdvisories(r.advisories ?? [])),
      (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)),
    );
    // What turning one on adds, and newer marketplace commits: both optional extras.
    api.browse("", "").then((r) => setInfo(new Map(r.modules.map((m) => [m.id, m]))), () => {});
    api.marketplaces().then((r) => setNewer(r.marketplaces.filter((m) => m.newer)), () => {});
  }, [onSignIn]);

  const advisoryOf = useMemo(() => new Map(advisories.map((a) => [a.module, a])), [advisories]);
  const needle = q.trim().toLowerCase();
  const match = (m: ModuleRow) => !needle || `${m.name} ${m.description} ${m.marketplace} ${m.agents.join(" ")} ${m.connections.join(" ")}`.toLowerCase().includes(needle);
  // Installed: what needs you first, then what you chose, then what they need, the core last.
  const rank = (m: ModuleRow) => (advisoryOf.has(m.name) || needsSetup.has(m.name) || needsConnect.has(m.name) ? 0 : m.state === "on" ? 1 : m.state === "dependency" ? 2 : 3);
  const installed = (mods ?? []).filter((m) => m.state !== "off").sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const available = (mods ?? []).filter((m) => m.state === "off").sort((a, b) => a.name.localeCompare(b.name));
  const shownInstalled = show === "available" ? [] : installed.filter(match);
  const shownAvailable = show === "installed" ? [] : available.filter(match);

  const header = (
    <PageHeader
      title="Modules"
      sub="Each module brings agents, connections and apps. Turning one on or off is a change you approve."
      actions={
        <button className="btn" onClick={onMarkets}>
          Marketplaces
        </button>
      }
    />
  );
  if (!mods)
    return (
      <>
        {header}
        {error ? (
          <EmptyState action={<button className="btn" onClick={() => location.reload()}>Try again</button>}>
            <strong>Couldn't load modules.</strong> The board couldn't read the module list: {error}
          </EmptyState>
        ) : (
          <TileGrid>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="ui-tile mods-skeleton">
                <SkeletonLines lines={3} />
              </div>
            ))}
          </TileGrid>
        )}
      </>
    );

  const grid = (list: ModuleRow[]) => (
    <TileGrid>
      {list.map((m) => (
        <ModuleTile key={m.id} m={m} setup={needsSetup.has(m.name)} pairing={needsPairing.has(m.name)} connect={needsConnect.get(m.name)} advisory={advisoryOf.get(m.name)} info={info.get(m.id)} />
      ))}
    </TileGrid>
  );
  const nothing = shownInstalled.length + shownAvailable.length === 0;
  return (
    <>
      {header}
      {advisories.map((a) => (
        <div key={a.id} className={`ui-banner ${a.severity === "high" || a.severity === "critical" ? "ui-banner-danger" : "ui-banner-warn"}`} role="alert">
          <span className="ui-banner-text">
            <strong>Security advisory for {a.module}</strong> ({a.severity}): {a.summary.replace(/^`|`$/g, "")} The fix is an ordinary update to a newer pin.
          </span>
          {a.url && (
            <a className="btn" href={safeHref(a.url)} target="_blank" rel="noreferrer noopener">
              Details
            </a>
          )}
          <a className="btn primary" href={`#/team/modules/${mods?.find((m) => m.name === a.module && !m.browse)?.id ?? a.module}`}>
            Open {a.module}
          </a>
        </div>
      ))}
      {newer.length > 0 && advisories.length === 0 && (
        <div className="ui-banner">
          <span className="ui-banner-text">A newer version of {newer.map((m) => m.name).join(", ")} is available.</span>
          <button className="btn" onClick={onMarkets}>
            Review update
          </button>
        </div>
      )}
      <div className="mods-bar">
        <Segmented<Show> label="Show" value={show} onChange={setShow} options={SHOW} />
        <input className="mods-search" type="search" placeholder="Search modules" aria-label="Search modules" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {nothing ? (
        needle ? (
          <EmptyState action={<button className="btn" onClick={() => (setQ(""), setShow("all"))}>Clear search</button>}>
            <strong>Nothing matches "{q.trim()}".</strong>{" "}
            {show === "all" ? "No installed or available module has that in its name, description, agents or connections." : `Nothing ${show} matches. It may be under ${show === "installed" ? "Available" : "Installed"}.`}
          </EmptyState>
        ) : show === "available" ? (
          <EmptyState action={<button className="btn" onClick={onMarkets}>Add a marketplace</button>}>
            <strong>Every module is on.</strong> Your marketplaces have nothing else to offer. Add a marketplace to find more modules.
          </EmptyState>
        ) : (
          <EmptyState action={available.length > 0 ? <button className="btn primary" onClick={() => setShow("available")}>See available modules</button> : <button className="btn" onClick={onMarkets}>Add a marketplace</button>}>
            <strong>Only the core is installed.</strong> Turn on a module to give your agents something to do: a chief of staff, engineers, connections to your tools.
          </EmptyState>
        )
      ) : show === "all" ? (
        <>
          {shownInstalled.length > 0 && <Section title="Installed" count={shownInstalled.length}>{grid(shownInstalled)}</Section>}
          {shownAvailable.length > 0 && <Section title="Available" count={shownAvailable.length}>{grid(shownAvailable)}</Section>}
        </>
      ) : show === "installed" ? (
        <Section title="Installed" count={shownInstalled.length}>{grid(shownInstalled)}</Section>
      ) : (
        <Section title="Available" count={shownAvailable.length}>{grid(shownAvailable)}</Section>
      )}
    </>
  );
}

function ModuleTile({ m, setup, pairing, connect, advisory, info }: { m: ModuleRow; setup: boolean; pairing: boolean; connect?: { c: Connectable; word: string }; advisory?: Advisory; info?: BrowseModule }) {
  const t = useModuleToggle(m);
  const [asking, setAsking] = useState(false);
  const s = moduleState(m, { filed: t.filed, setup, pairing, connect: Boolean(connect), advisory });
  const href = `#/team/modules/${m.id}`;
  // A module turned on while the owner is still here opens its setup flow (the design's "Setup flows").
  const was = useRef(t.filed?.stage);
  useEffect(() => {
    const turnedOn = t.filed?.items.some((c) => c.kind === "module" && c.name === m.id && c.on);
    if (info?.setupFlow && turnedOn && t.filed?.stage === "applied" && was.current && IN_FLIGHT.includes(was.current)) location.hash = `#/setup/${m.name}`;
    was.current = t.filed?.stage;
  }, [t.filed, m.name, info?.setupFlow]);
  const locked = lockedWhy(m);
  const stopped = t.filed && (t.filed.stage === "failed" || t.filed.stage === "rejected");
  const action = t.busy ? null : setup ? (
    // A module switched on that only lacks its phone pairing says so here; Set up or Change setup opens the flow either way.
    <SetupButton module={m.name} primary word={s.action} />
  ) : connect ? (
    <ConnectButton c={connect.c} word={connect.word} variant="primary" />
  ) : advisory ? (
    <a className="btn primary" href={href}>Review fix</a>
  ) : m.state === "off" ? (
    <button className="btn" onClick={() => setAsking(true)}>{stopped ? "Try again" : "Turn on"}</button>
  ) : (
    t.switchEl
  );
  return (
    <>
      {t.dialog}
      {asking && <TurnOnCard m={m} info={info} onClose={() => setAsking(false)} />}
      <Tile
        href={href}
        name={m.name}
        title={m.name}
        status={<ModuleStatus s={s} />}
        tone={s.tone === "failed" ? "failed" : s.tone === "needs" ? "needs" : undefined}
        facts={<ModuleFacts m={m} />}
        foot={
          t.busy ? (
            <a className="mods-foot-link busy" href={`#/t/${t.filed!.identifier}`}>Follow it ({t.filed!.identifier})</a>
          ) : stopped ? (
            <a className="mods-foot-link" href={`#/t/${t.filed!.identifier}`}>See why ({t.filed!.identifier})</a>
          ) : locked ? (
            <span className="mods-locked" title="Can't be turned off">
              <LockIcon />
              {locked}
            </span>
          ) : m.state === "off" && info?.setupFlow ? (
            `Then: ${info.setupFlow.title.charAt(0).toLowerCase()}${info.setupFlow.title.slice(1)}`
          ) : m.tier !== "official" ? (
            publisher(m)
          ) : undefined
        }
        action={action}
      >
        {m.description}
      </Tile>
    </>
  );
}
