// A module's page (#/modules/<name>/<tab>): what it is, its agents and work, what it may do, its contents, settings and changes.
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SignInRequired, api } from "./api";
import { ConnectButton, useConnectNeeded, type Can, type Connectable } from "./Connect";
import { useEvents } from "./events";
import { STATUS_LABEL, connectionStatus, displayName, type ConnectionRow } from "./connections";
import { LockIcon, ModuleFacts, ModuleStatus, TurnOnCard, lockedWhy, moduleState, publisher, useModuleToggle, useSetupNeeded, useSetupPairing } from "./ModuleParts";
import { SettingItem } from "./Settings";
import { ChangePreview, ChangeProgress, ChangesScope, Group, useChanges } from "./settings-ui";
import { SetupButton } from "./SetupButton";
import { SkeletonLines } from "./Skeleton";
import type { Advisory, BrowseModule, ModuleDetail, ModuleRow, SettingChange, SettingRow, SharePreview, TaskRow } from "./types";
import { EmptyState } from "./ui/EmptyState";
import { ListRow, ListRows } from "./ui/ListRow";
import { PageHeader } from "./ui/PageHeader";
import { Section } from "./ui/Section";
import { Banner, Face, Field, Input, Tabs, faceProps, safeHref } from "./ui";
import { StatusDot, type StatusTone } from "./ui/StatusDot";
import { TaskState } from "./ui/TaskState";
import { Monogram } from "./ui/Tile";
import { hueClass } from "./ui/hue";
import { ago } from "./util";
import "./settings.css";
import "./modules.css";

export type ModuleTab = "overview" | "contents" | "settings" | "changes";
const TABS = [["overview", "Overview"], ["contents", "Contents"], ["settings", "Settings"], ["changes", "Changes"]] as const;

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ModulePage(props: { name: string; tab: ModuleTab; go: (hash: string) => void; onSignIn: () => void; can: Can }) {
  return (
    <ChangesScope onSignIn={props.onSignIn}>
      <ModuleBody {...props} />
    </ChangesScope>
  );
}

function ModuleBody({ name, tab, go, onSignIn, can }: { name: string; tab: ModuleTab; go: (hash: string) => void; onSignIn: () => void; can: Can }) {
  const [d, setD] = useState<ModuleDetail | null>(null);
  const [advisory, setAdvisory] = useState<Advisory | undefined>();
  const [error, setError] = useState("");
  const needsSetup = useSetupNeeded();
  const needsPairing = useSetupPairing();
  const needsConnect = useConnectNeeded(can);
  useEffect(() => {
    api.module(name).then(setD, (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)));
    api.modules().then((r) => setAdvisory(r.advisories?.find((a) => a.module === name)), () => {});
  }, [name, onSignIn]);
  if (!d)
    return (
      <main className="mods">
        {error ? (
          /no such module/.test(error) ? (
            <EmptyState action={<a className="btn" href="#/modules">Back to Modules</a>}>
              <strong>No module called {name}.</strong> It may have been removed from its marketplace, or the link has a typo.
            </EmptyState>
          ) : (
            <EmptyState action={<button className="btn" onClick={() => location.reload()}>Try again</button>}>
              <strong>Couldn't load this module.</strong> {error}
            </EmptyState>
          )
        ) : (
          <SkeletonLines lines={6} />
        )}
      </main>
    );
  return <Loaded d={d} tab={tab} go={go} onSignIn={onSignIn} setup={needsSetup.has(name)} pairing={needsPairing.has(name)} connect={needsConnect.get(name)} can={can} advisory={advisory} />;
}

function Loaded({ d, tab, go, onSignIn, setup, pairing, connect, can, advisory }: { d: ModuleDetail; tab: ModuleTab; go: (hash: string) => void; onSignIn: () => void; setup: boolean; pairing: boolean; connect?: { c: Connectable; word: string }; can: Can; advisory?: Advisory }) {
  const m = d.module;
  const t = useModuleToggle(m);
  const [asking, setAsking] = useState(false);
  const [info, setInfo] = useState<BrowseModule | undefined>();
  useEffect(() => {
    if (m.state === "off") api.browse(m.name, "").then((r) => setInfo(r.modules.find((b) => b.name === m.name)), () => {});
  }, [m.name, m.state]);
  const s = moduleState(m, { filed: t.filed, setup, pairing, connect: Boolean(connect), advisory });
  const locked = lockedWhy(m);
  return (
    <main className={`mods ${hueClass(m.name)}`}>
      <PageHeader
        crumb={<><a href="#/modules">Modules</a> / {m.name}</>}
        face={<Monogram name={m.name} size={44} />}
        title={m.name}
        status={
          <>
            <ModuleStatus s={s} />
            <span className="mod-meta">
              <span>{publisher(m)}{m.revision ? `, revision ${m.revision}` : ""}</span>
              <ModuleFacts m={m} />
            </span>
          </>
        }
        sub={m.description}
        actions={
          <>
            <SetupButton module={m.name} primary={setup} word={s.action} />
            {connect && !setup && <ConnectButton c={connect.c} word={connect.word} variant="primary" />}
            {m.state === "off" && !t.busy && <button className="btn primary" onClick={() => setAsking(true)}>Turn on</button>}
            {m.state !== "off" && t.switchEl && (
              <span className="mod-switch">
                {/* Enabled but unpaired is said once, by the status; the switch doesn't call it on. */}
                {s.action ? null : t.isOn ? "On" : "Off"}
                {t.switchEl}
              </span>
            )}
            {locked && (
              <span className="mod-switch" title="Can't be turned off">
                <LockIcon />
                {locked}
              </span>
            )}
          </>
        }
      />
      {t.dialog}
      {asking && <TurnOnCard m={m} info={info} onClose={() => setAsking(false)} />}
      {t.filed && <div className="mod-change"><ChangeProgress f={t.filed} /></div>}
      {advisory && (
        <div className={`ui-banner ${advisory.severity === "high" || advisory.severity === "critical" ? "ui-banner-danger" : "ui-banner-warn"}`} role="alert">
          <span className="ui-banner-text">
            <strong>Security advisory {advisory.id}</strong> ({advisory.severity}): {advisory.summary.replace(/^`|`$/g, "")} The fix is an ordinary update to a newer pin: {m.pinned ? "follow the marketplace (below) or pin a newer commit" : "update its marketplace (Modules, then Marketplaces)"}.
          </span>
          {advisory.url && <a className="btn" href={safeHref(advisory.url)} target="_blank" rel="noreferrer noopener">Details</a>}
        </div>
      )}
      <Pin m={m} />
      <div>
        <Tabs<ModuleTab> label="Section" value={tab} tabs={TABS} href={(k) => `#/modules/${m.name}${k === "overview" ? "" : `/${k}`}`} />
      </div>
      {tab === "overview" && <Overview d={d} />}
      {tab === "contents" && <Contents d={d} onSignIn={onSignIn} can={can} />}
      {tab === "settings" && <ModuleSettings m={m} onSignIn={onSignIn} />}
      {tab === "changes" && <ModuleChanges m={m} />}
    </main>
  );
}

/** "Pinned at X": the module is held at its own commit; Follow marketplace removes the pin. */
function Pin({ m }: { m: ModuleRow }) {
  const [open, setOpen] = useState(false);
  if (!m.pinned) return null;
  const change: SettingChange = { kind: "pin", name: m.name, sha: null };
  return (
    <div className="ui-banner">
      <span className="ui-banner-text">Pinned at {m.pinned}: this module stays there when its marketplace moves.</span>
      {!open && <button className="btn" onClick={() => setOpen(true)}>Follow marketplace</button>}
      {open && <div className="mods-banner-full"><ChangePreview items={[change]} was={[m.pinned]} onCancel={() => setOpen(false)} onDone={() => setOpen(false)} note="Removes the pin: the module follows its marketplace again." /></div>}
    </div>
  );
}

function Tasks({ rows }: { rows: TaskRow[] }) {
  if (!rows.length) return <p className="mod-none">Nothing running right now.</p>;
  return (
    <ListRows>
      {rows.map((r) => (
        <ListRow key={r.identifier} href={`#/t/${r.identifier}`} status={<TaskState state={r.state} />} title={r.title} id={r.identifier} from={r.from ?? null} time={ago(r.updatedAt)} />
      ))}
    </ListRows>
  );
}

const modLinks = (names: string[]) => (names.length ? <span className="mod-tags">{names.map((n) => <a key={n} className="mod-tag" href={`#/modules/${n}`}>{n}</a>)}</span> : <span className="mod-none">nothing</span>);
const tags = (names: string[], none = "none") => (names.length ? <span className="mod-tags">{names.map((n) => <span key={n} className="mod-tag">{n}</span>)}</span> : <span className="mod-none">{none}</span>);

function Agents({ d }: { d: ModuleDetail }) {
  if (!d.agents.length) return <p className="mod-none">This module brings no agents of its own.</p>;
  return (
    <div className="mod-rows">
      {d.agents.map((a) => (
        <ModRow key={a.key} href={`#/agents/${a.key}`} lead={<Face seed={a.key} {...faceProps(a.teammate?.face)} size={24} label={a.name} />} title={a.name} meta={<>{a.title && <span>{a.title}</span>}<span>{sentence(a.state)}</span></>} />
      ))}
    </div>
  );
}

/** A plain row of a module's list: a link with a lead, a title and quiet details on the right. */
function ModRow({ href, lead, title, meta, hint }: { href: string; lead?: ReactNode; title: string; meta?: ReactNode; hint?: string }) {
  return (
    <a className="mod-row" href={href} title={hint}>
      {lead}
      <span className="mod-row-title">{title}</span>
      {meta && <span className="mod-row-meta">{meta}</span>}
    </a>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section title={title}>
      <div className="mod-card">{children}</div>
    </Section>
  );
}

function Overview({ d }: { d: ModuleDetail }) {
  const m = d.module;
  const { connections, writes, secrets } = d.authority;
  return (
    <div className="mod-body">
      <div className="mod-main">
        <Section title="Agents" count={d.agents.length || undefined}><Agents d={d} /></Section>
        {d.agents.length > 0 && <Section title="Ongoing work" count={d.ongoing.length || undefined}><Tasks rows={d.ongoing} /></Section>}
      </div>
      <div className="mod-side">
        <Card title="What it may do">
          <dl className="mod-facts">
            <dt>Connections</dt>
            <dd>{tags(connections)}</dd>
            <dt>Writes</dt>
            <dd>{tags(writes.map((w) => `${w.kind}${w.tier != null ? `, tier ${w.tier}` : ""}`))}</dd>
            <dt>Secrets</dt>
            <dd>{tags(secrets)}</dd>
          </dl>
        </Card>
        <Card title="Needs and needed by">
          <dl className="mod-facts">
            <dt>Needs</dt>
            <dd>{modLinks(d.requires)}</dd>
            <dt>Needed by</dt>
            <dd>{modLinks(d.neededBy)}</dd>
          </dl>
        </Card>
        <Card title="If you turn it off">
          <p>
            {m.state === "core" ? "It is part of the core and always on." : d.neededBy.length ? `It can't be turned off while ${d.neededBy.join(", ")} need${d.neededBy.length === 1 ? "s" : ""} it.` : `${m.agents.length ? `Its agents stop (${m.agents.join(", ")})` : "No agents stop"}${m.routines.length ? ` and so do its routines (${m.routines.join(", ")})` : ""}. Their tasks and the module's data on disk are kept; turning it back on resumes.`}
          </p>
        </Card>
      </div>
    </div>
  );
}

function Contents({ d, onSignIn, can }: { d: ModuleDetail; onSignIn: () => void; can: Can }) {
  const m = d.module;
  const [conns, setConns] = useState<ConnectionRow[] | null>(null);
  const [connsError, setConnsError] = useState("");
  const loadConns = useCallback((fresh = false) => api.connections(fresh).then((r) => (setConnsError(""), setConns(r.connections.filter((c) => c.module === m.name))), (e) => (e instanceof SignInRequired ? onSignIn() : setConnsError((e as Error).message))), [m.name, onSignIn]);
  useEffect(() => void loadConns(), [loadConns]);
  // A sign-in finished in the tab its Connect opened: ask again, fresh, so the row turns Connected here too.
  useEvents(["connections"], () => loadConns(true));
  return (
    <div className="mod-body">
      <div className="mod-main">
        <Section title="Agents" count={d.agents.length || undefined}><Agents d={d} /></Section>
        <Section title="Connections" count={m.connections.length || undefined}>
          {connsError && <p className="mod-none">Couldn't read the connections' state: {connsError}</p>}
          {!m.connections.length ? <p className="mod-none">No connections.</p> : (
            <div className="mod-rows">
              {m.connections.map((c) => {
                const row = conns?.find((r) => r.name === c);
                const v = row ? connectionStatus(row, can) : null;
                return <ModRow key={c} href="#/settings/connections" title={displayName(c)} meta={v && <span>{STATUS_LABEL[v.status]}</span>} />;
              })}
            </div>
          )}
        </Section>
        <Section title="Routines" count={m.routines.length || undefined}><Routines d={d} /></Section>
        {d.authority.readme && <Section title="README"><div className="mod-card"><pre className="mod-readme">{d.authority.readme}</pre></div></Section>}
        {m.tier === "local" && <Section title="Share"><Share m={m} onSignIn={onSignIn} /></Section>}
      </div>
      <div className="mod-side">
        <Card title="Apps">{tags(m.apps, "No apps.")}</Card>
        <Card title="Handbook sections">{tags(d.authority.prompts.map((p) => p.id), "None.")}</Card>
        {m.source && (
          <Card title="Source">
            <span className="mod-source">{m.source.url}<br />{m.source.path}</span>
          </Card>
        )}
      </div>
    </div>
  );
}

/**
 * A local module shared to a public GitHub repo (docs/design/sharing.md): the preview shows exactly what leaves this instance
 * (its files whole, what isn't shared and why, its grants and code), and Save files that exact preview. Memory, the owner
 * profile, secrets and setting values never leave.
 */
function Share({ m, onSignIn }: { m: ModuleRow; onSignIn: () => void }) {
  const [github, setGithub] = useState<boolean | null>(null);
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("main");
  const [p, setP] = useState<SharePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filed, setFiled] = useState("");
  // A preview is for one destination: editing it drops the preview (onChange below), and an answer for an older one is ignored.
  const asked = useRef("");
  useEffect(() => {
    api.modules().then((r) => setGithub(r.modules.some((x) => x.name === "github" && x.state !== "off")), () => setGithub(true));
  }, []);
  if (github === false) return <p className="mod-none">Sharing needs GitHub connected.</p>;
  const fail = (e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message));
  const dest = `${repo.trim()} ${ref.trim()}`;
  const preview = () => {
    setBusy(true), setError(""), setFiled(""), setP(null);
    const want = dest;
    asked.current = want;
    api.sharePreview({ module: m.name, repo: repo.trim(), ref: ref.trim() }).then((x) => { if (asked.current === want) setP(x); }, fail).finally(() => setBusy(false));
  };
  const save = () => {
    if (!p) return;
    setBusy(true), setError("");
    api.changeSettings([{ kind: "share", module: p.module, repo: p.repo, ref: p.ref, source: p.source, base: p.base, digest: p.digest }]).then((r) => (setFiled(r.identifier), setP(null)), fail).finally(() => setBusy(false));
  };
  const blocked = Boolean(p && (p.findings.length || p.private || p.conflict));
  return (
    <div className="mod-card mod-share">
      <p>Publish {m.name} to a public GitHub repo with a marketplace.json, for other instances to install. Its agents, skills and routines go; memory, your profile, secrets and setting values never do.</p>
      <div className="mod-share-form">
        <Field label="Public repository">{(id, d) => <Input id={id} aria-describedby={d} value={repo} placeholder="owner/name" onChange={(e) => (setRepo(e.target.value), setP(null), (asked.current = ""))} />}</Field>
        <Field label="Branch">{(id, d) => <Input id={id} aria-describedby={d} value={ref} onChange={(e) => (setRef(e.target.value), setP(null), (asked.current = ""))} />}</Field>
        <button className="btn" type="button" disabled={busy || !/^[\w.-]+\/[\w.-]+$/.test(repo.trim()) || !ref.trim()} onClick={preview}>Preview</button>
      </div>
      {error && <span className="st-error" role="alert">{error}</span>}
      {filed && <Banner action={<a className="btn" href={`#/c/${filed}`}>Open</a>}>Filed as {filed}: not published yet. Open it for whether it published.</Banner>}
      {p && (
        <>
          {p.private && <Banner tone="danger">{p.repo} is private: a module is shared to a public repo.</Banner>}
          {p.conflict && <Banner tone="danger">{p.conflict}</Banner>}
          {p.findings.length > 0 && (
            <Banner tone="danger">
              Not shareable until these are out of the module: {p.findings.map((f) => `${f.file || m.name}: ${f.detail}`).join("; ")}.
            </Banner>
          )}
          <dl className="mod-facts">
            <dt>Goes to</dt>
            <dd>{p.repo}, {p.ref} at {p.base.slice(0, 12)}, as {p.module}/</dd>
            <dt>Runs as</dt>
            <dd>{p.isolation === "trusted" ? "trusted (its agents write)" : "untrusted"}{p.scripts.length ? `; contains code: ${p.scripts.join(", ")}` : ""}</dd>
            {Object.entries(p.grants).map(([agent, tools]) => (
              <Fragment key={agent}>
                <dt>{agent} may use</dt>
                <dd>{tags(tools)}</dd>
              </Fragment>
            ))}
            {p.removes.length > 0 && (
              <>
                <dt>Removes from {p.repo}</dt>
                <dd><ul className="mod-share-list">{p.removes.map((r) => <li key={r}><code>{p.module}/{r}</code></li>)}</ul></dd>
              </>
            )}
            <dt>Not shared</dt>
            <dd>{p.notShared.length ? <ul className="mod-share-list">{p.notShared.map((n) => <li key={n.path}><code>{n.path}</code>: {n.why}</li>)}</ul> : <span className="mod-none">nothing left out</span>}</dd>
          </dl>
          {p.files.map((f) => (
            <details key={f.path} className="mod-share-file" open={f.path === "module.yaml"}>
              <summary><code>{p.module}/{f.path}</code> <span className="mod-none">{f.bytes} bytes</span></summary>
              {f.text !== undefined && <pre className="mod-readme">{f.text}</pre>}
            </details>
          ))}
          <div className="mod-share-actions">
            <button className="btn primary" type="button" disabled={busy || blocked} onClick={save}>Publish exactly this</button>
            <button className="btn" type="button" disabled={busy} onClick={() => setP(null)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Each routine on or off, with its live Pause or Resume; its agent's Settings tab changes its schedule and model. */
function Routines({ d }: { d: ModuleDetail }) {
  const rows = d.routines ?? [];
  if (!rows.length) return d.module.routines.length ? tags(d.module.routines) : <p className="mod-none">No routines.</p>;
  return (
    <div className="mod-rows">
      {rows.map((r) => <RoutineRow key={r.key} r={r} />)}
    </div>
  );
}

function RoutineRow({ r }: { r: NonNullable<ModuleDetail["routines"]>[number] }) {
  const [on, setOn] = useState(r.on);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = () => {
    setBusy(true);
    // The module's snapshot keeps the new state too, so another tab and back shows it.
    api.pauseRoutine(r.id!, on).then((x) => (setOn((r.on = x.status !== "paused")), setError("")), (e) => setError((e as Error).message)).finally(() => setBusy(false));
  };
  return (
    <div className="mod-row-with-action">
      <ModRow href={`#/agents/${r.agent}/settings`} hint="Change its schedule or model on its agent's Settings" title={r.title} meta={<StatusDot tone={on ? "working" : "done"}>{on ? (r.scheduled ? "On" : "On, when something starts it") : "Off"}</StatusDot>} />
      {r.id && <button className="btn" type="button" disabled={busy} onClick={toggle}>{on ? "Pause" : "Resume"}</button>}
      {error && <span className="st-error" role="alert">{error}</span>}
    </div>
  );
}

function ModuleSettings({ m, onSignIn }: { m: ModuleRow; onSignIn: () => void }) {
  const [rows, setRows] = useState<SettingRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.settings().then((r) => setRows(r.settings.filter((s) => s.module === m.name && Object.entries(s.when ?? {}).every(([k, v]) => String(r.settings.find((x) => x.key === k)?.value ?? r.settings.find((x) => x.key === k)?.default) === String(v)))), (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)));
  }, [m.name, onSignIn]);
  if (error) return <EmptyState><strong>Couldn't load the settings.</strong> {error}</EmptyState>;
  if (!rows) return <SkeletonLines lines={3} />;
  if (!rows.length) return <EmptyState><strong>Nothing to set.</strong> {m.name} works as it is; it has no settings of its own.</EmptyState>;
  return <Group title="Settings" count={rows.length}>{rows.map((s) => <SettingItem key={s.key} s={s} />)}</Group>;
}

/** A change's stage (the board's settings changes, not a task) as a dot and a word. */
const CHANGE_STATUS: Record<string, { tone: StatusTone; word: string }> = { working: { tone: "idle", word: "In review" }, waiting: { tone: "needs", word: "Approval" }, applying: { tone: "working", word: "Working" }, applied: { tone: "done", word: "Done" } };
const changeStatus = (stage: string) => { const s = CHANGE_STATUS[stage] ?? { tone: "idle" as const, word: stage }; return <StatusDot tone={s.tone}>{s.word}</StatusDot>; };

function ModuleChanges({ m }: { m: ModuleRow }) {
  const { changes } = useChanges();
  const keys = Object.keys(m.settings);
  const mine = changes.filter((f) => f.items.some((c) => ((c.kind === "module" || (c.kind as string) === "pin") && (c as { name: string }).name === m.name) || (c.kind === "setting" && keys.includes(c.key)) || (c.kind === "share" && c.module === m.name)));
  if (!mine.length) return <EmptyState><strong>No changes yet.</strong> Turning {m.name} on or off, or changing one of its settings, shows up here with where it stands.</EmptyState>;
  return (
    <ListRows>
      {mine.map((f) => (
        <ListRow key={f.identifier} href={`#/c/${f.identifier}`} status={changeStatus(f.stage)} title={f.title} id={f.identifier} time={ago(f.createdAt)} />
      ))}
    </ListRows>
  );
}
