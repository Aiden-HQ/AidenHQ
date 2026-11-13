import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AccountsView } from "./Accounts";
import { SignInRequired, api, type Session } from "./api";
import { STATUS_LABEL, connectionStatus, displayName, needsAttention, sourceStatus, type ConnectionRow, type ConnectionsData, type Status, type Verdict } from "./connections";
import { ModulesView } from "./Modules";
import { askForNotifications, notificationsSupported } from "./notify";
import type { AgentSettings, SettingRow, SettingsData } from "./types";

// Settings: one page, categories on the left like Chat's sidebar (#/settings/<category>). Instance settings live in git
// (instance.yaml): the board shows them and the exact line to change, and the change itself is a message to Aiden, who files
// it as an apply card. What the board owns (accounts, sign-ins, browser notifications) is changed right here.

export const CATEGORIES = [
  { key: "connections", name: "Connections", sub: "Sign-ins and health" },
  { key: "agents", name: "Agents and models", sub: "Models, schedules, heartbeats" },
  { key: "approvals", name: "Approvals and autonomy", sub: "Who decides each write" },
  { key: "spend", name: "Spend caps", sub: "Per run, task and agent-day" },
  { key: "switches", name: "Kill switches", sub: "Features you can turn off" },
  { key: "notifications", name: "Notifications", sub: "How you're reached" },
  { key: "accounts", name: "Accounts and access", sub: "People, authenticators, apps" },
  { key: "modules", name: "Modules", sub: "What this AidenHQ has on" },
  { key: "general", name: "General", sub: "Owner, timezone, names" },
  { key: "instance", name: "Instance", sub: "Versions and every setting" },
] as const;
export type Category = (typeof CATEGORIES)[number]["key"];
export const isCategory = (s: string | null | undefined): s is Category => CATEGORIES.some((c) => c.key === s);

interface Props {
  cat: Category | null;
  mobile: boolean;
  session: Session | null;
  go: (hash: string) => void;
  onSignIn: () => void;
  can: { signIn: boolean; google: boolean };
}

export function SettingsView({ cat, mobile, session, go, onSignIn, can }: Props) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [conns, setConns] = useState<ConnectionsData | null>(null);
  const [error, setError] = useState("");
  const fail = useCallback((e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)), [onSignIn]);
  const loadConns = useCallback((fresh = false) => api.connections(fresh).then(setConns, fail), [fail]);
  useEffect(() => {
    void api.settings().then(setData, fail);
    void loadConns();
    const t = setInterval(() => document.visibilityState === "visible" && void loadConns(), 30_000);
    return () => clearInterval(t);
  }, [fail, loadConns]);

  const current: Category = cat ?? "connections";
  const attention = conns ? needsAttention(conns, can) : false;
  const side = (
    <aside className="ws-side settings-side" aria-label="Settings categories">
      <div className="side-top">
        <h1 className="settings-title">Settings</h1>
      </div>
      <nav className="side-scroll">
        {CATEGORIES.map((c) => (
          <a key={c.key} href={`#/settings/${c.key}`} className={`side-chat settings-cat${!mobile && current === c.key ? " on" : ""}`} aria-current={!mobile && current === c.key ? "page" : undefined}>
            <span className="side-chat-top">
              <span className="side-chat-title">{c.name}</span>
              {c.key === "connections" && attention && <span className="needs-dot" title="A connection needs you" />}
            </span>
            <span className="side-preview">{c.sub}</span>
          </a>
        ))}
      </nav>
    </aside>
  );

  const pane = (
    <div className="ws-main settings-main">
      {mobile && (
        <header className="conv-head">
          <button className="icon-btn" onClick={() => go("#/settings")} aria-label="All settings">
            ‹
          </button>
          <span className="conv-name">{CATEGORIES.find((c) => c.key === current)?.name}</span>
        </header>
      )}
      <div className="settings-scroll">
        {error && <div className="offline">Couldn't load settings: {error}</div>}
        {data && !data.compiled && current !== "accounts" && current !== "modules" && (
          <div className="offline">This board can't read the compiled config yet (config/paperclip.yaml). Run ops/apply-config.sh on the host to mount it.</div>
        )}
        <Pane cat={current} data={data} conns={conns} session={session} onSignIn={onSignIn} can={can} refresh={() => loadConns(true)} />
      </div>
    </div>
  );

  if (mobile) return <div className="ws ws-phone settings">{cat ? pane : side}</div>;
  return (
    <div className="ws settings">
      {side}
      {pane}
    </div>
  );
}

function Pane({ cat, data, conns, session, onSignIn, can, refresh }: { cat: Category; data: SettingsData | null; conns: ConnectionsData | null; session: Session | null; onSignIn: () => void; can: Props["can"]; refresh: () => Promise<void> }) {
  if (cat === "accounts") return session ? <AccountsView session={session} onSignIn={onSignIn} /> : null;
  if (cat === "modules") return <ModulesView onSignIn={onSignIn} />;
  if (cat === "connections") return <Connections conns={conns} can={can} refresh={refresh} />;
  if (!data) return <span className="spinner" />;
  const by = (k: string) => data.settings.find((s) => s.key === k);
  const rows = (keys: string[]) => keys.map(by).filter((s): s is SettingRow => Boolean(s));
  if (cat === "agents") return <Agents agents={data.agents} />;
  if (cat === "approvals")
    return (
      <Page title="Approvals and autonomy" sub="Every write (push, merge, apply, deploy, outbound message) is an approval record, tiered in code.">
        <section className="settings-section">
          <dl className="tier-list">
            <dt>Tier 0</dt>
            <dd>Safe writes run at once and are recorded.</dd>
            <dt>Tier 1</dt>
            <dd>The AI reviewer decides, when autonomy is full; otherwise you do.</dd>
            <dt>Tier 2</dt>
            <dd>Always yours: one tap in Approvals or Telegram, or an exact typed reply.</dd>
          </dl>
          <p className="muted small">
            {data.approvals.pending ? <><a href="#/approvals">{data.approvals.pending} waiting on you</a> in Approvals.</> : "Nothing is waiting on you."}
          </p>
        </section>
        <SettingList rows={rows(["autonomy", "batch_approvals", "dup_guard", "grading"])} />
      </Page>
    );
  if (cat === "spend") return <Spend data={data} />;
  if (cat === "switches") return <Page title="Kill switches" sub="Each feature can be turned off in instance.yaml. Most are read on every use, so no restart is needed after the apply."><SettingList rows={data.settings.filter((s) => s.switch)} /></Page>;
  if (cat === "notifications") return <Notifications rows={rows(["channels", "slack_post_channels", "owner_slack_user_id"])} conns={conns} />;
  if (cat === "general") {
    const elsewhere = new Set(["autonomy", "channels", "slack_post_channels", "owner_slack_user_id"]);
    const general = data.settings.filter((s) => !s.switch && !elsewhere.has(s.key));
    return (
      <Page title="General" sub={data.owner.name ? `This AidenHQ belongs to ${data.owner.name}.` : "Who this AidenHQ belongs to, and how it is named."}>
        <p className="muted small">The board's own day boundaries (Today, Tomorrow) use {data.instance.boardTimezone}, from the host's config/system.yaml.</p>
        <SettingList rows={general} />
      </Page>
    );
  }
  return <Instance data={data} />;
}

function Page({ title, sub, children, tools }: { title: string; sub?: ReactNode; children: ReactNode; tools?: ReactNode }) {
  return (
    <main className="page settings-page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {sub && <p className="page-sub">{sub}</p>}
        </div>
        {tools && <div className="page-tools">{tools}</div>}
      </header>
      {children}
    </main>
  );
}

// ------------------------------------------------------------------ the instance.yaml line

/** A YAML scalar or flow value, quoted where YAML would read it as something else. */
export function yamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(yamlValue).join(", ")}]`;
  if (v && typeof v === "object") return JSON.stringify(v);
  if (typeof v === "string") return /^(on|off|yes|no|true|false|null|~|)$/i.test(v) || /[:#{}[\],&*!|>'"%@`]|^\s|\s$/.test(v) ? JSON.stringify(v) : v;
  return String(v);
}

const askAiden = (text: string) => `#/c/?text=${encodeURIComponent(text)}`;

/** The exact lines to put in instance.yaml, with Copy and a message to Aiden (who files the change as an apply card). */
export function SourceLine({ path, value, ask }: { path: string[]; value: unknown; ask: string }) {
  const [copied, setCopied] = useState(false);
  const lines = path.map((p, i) => `${"  ".repeat(i)}${p}:${i === path.length - 1 ? ` ${yamlValue(value)}` : ""}`).join("\n");
  const copy = () => void navigator.clipboard?.writeText(lines).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
  return (
    <div className="source-line">
      <div className="source-line-head">
        <span>instance.yaml</span>
        <button className="link-btn" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{lines}</pre>
      <div className="source-line-foot">
        <span className="muted small">Instance settings live in git. Aiden files the change as an apply card for you to approve.</span>
        <a className="btn" href={askAiden(ask)}>
          Ask Aiden to change it
        </a>
      </div>
    </div>
  );
}

const shown = (v: unknown) => (v === null || v === undefined ? "not set" : Array.isArray(v) ? (v.length ? v.join(", ") : "none") : typeof v === "object" ? JSON.stringify(v) : String(v));

function SettingList({ rows }: { rows: SettingRow[] }) {
  if (!rows.length) return <p className="empty">Nothing here on this instance.</p>;
  return (
    <ul className="setting-list">
      {rows.map((s) => (
        <SettingItem key={s.key} s={s} />
      ))}
    </ul>
  );
}

function SettingItem({ s }: { s: SettingRow }) {
  const [open, setOpen] = useState(false);
  const options = (s.values ?? []).filter((v) => !Array.isArray(s.value) && v !== s.value);
  const [to, setTo] = useState<unknown>(options[0] ?? s.value ?? s.default ?? "");
  const drift = s.live !== undefined && s.known && s.live !== String(s.value);
  return (
    <li className="setting">
      <div className="setting-head">
        <code className="setting-key">{s.key}</code>
        {s.switch && !s.known && s.live === undefined ? (
          <span className="pill">Unknown</span>
        ) : s.switch ? (
          <span className={`pill ${(s.live ?? s.value ?? s.default) === "off" ? "pill-needs" : "pill-working"}`}>{(s.live ?? s.value ?? s.default) === "off" ? "Off" : "On"}</span>
        ) : (
          <span className="setting-value">{s.known ? shown(s.value) : "unknown"}</span>
        )}
        <span className="setting-source muted small">{!s.known ? "the board can't read it yet" : s.set ? "set in instance.yaml" : s.default !== undefined ? "default" : "not set"}</span>
        <button className="link-btn setting-change" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Close" : s.switch ? ((s.live ?? s.value) === "off" ? "Turn on" : "Turn off") : "Change"}
        </button>
      </div>
      {s.doc && <p className="setting-doc">{s.doc}</p>}
      {drift && (
        <p className="setting-drift small">
          Running as {s.live}, while the compiled config says {shown(s.value)}: the last apply may not have finished.
        </p>
      )}
      {open && (
        <>
          {options.length > 1 && (
            <label className="setting-pick small">
              New value{" "}
              <select value={String(to)} onChange={(e) => setTo(e.target.value)}>
                {options.map((o) => (
                  <option key={String(o)}>{String(o)}</option>
                ))}
              </select>
            </label>
          )}
          <SourceLine path={["settings", s.key]} value={options.length ? to : (s.value ?? s.default ?? "")} ask={`Please change settings.${s.key} in instance.yaml to ${yamlValue(options.length ? to : "<new value>")} and file the apply for me.`} />
        </>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ connections

const ORDER: Status[] = ["signed_out", "error", "not_configured", "unknown", "connected"];
const PILL: Record<Status, string> = { connected: "pill-working", signed_out: "pill-needs", error: "pill-failed", not_configured: "", unknown: "" };
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "never");

function Connections({ conns, can, refresh }: { conns: ConnectionsData | null; can: Props["can"]; refresh: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  if (!conns) return <span className="spinner" />;
  const rows = conns.connections.map((r) => ({ r, v: connectionStatus(r, can) })).sort((a, b) => ORDER.indexOf(a.v.status) - ORDER.indexOf(b.v.status) || displayName(a.r.name).localeCompare(displayName(b.r.name)));
  const need = rows.filter((x) => x.v.status === "signed_out" || x.v.status === "error").length;
  const ok = rows.filter((x) => x.v.status === "connected").length;
  const check = () => (setChecking(true), void refresh().finally(() => setChecking(false)));
  return (
    <Page
      title="Connections"
      sub={`${ok} of ${rows.length} connected${need ? `, ${need} need${need === 1 ? "s" : ""} you` : ""}. Each system is connected once; agents get tool-level grants.`}
      tools={
        <button className="btn" onClick={check} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </button>
      }
    >
      <ul className="conn-list">
        {rows.map(({ r, v }) => (
          <ConnectionItem key={r.name} r={r} v={v} can={can} />
        ))}
      </ul>
      <section className="settings-section">
        <div className="section-head">
          <h2>Warehouse sources</h2>
          <span className="hint">What each source writer last brought into the shared warehouse.</span>
        </div>
        {conns.sourcesError ? (
          <p className="empty">The apps platform didn't answer, so source state is unknown.</p>
        ) : !conns.sources.length ? (
          <p className="empty">No warehouse sources yet.</p>
        ) : (
          <ul className="conn-list compact">
            {conns.sources.map((s) => {
              const sv = sourceStatus(s);
              return (
                <li key={s.name} className={`conn conn-${sv.status}`}>
                  <div className="conn-head">
                    <code className="conn-name">{s.name}</code>
                    <span className={`pill ${PILL[sv.status]}`}>{STATUS_LABEL[sv.status]}</span>
                  </div>
                  <p className="conn-reason">{sv.reason}</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Page>
  );
}

function ConnectionItem({ r, v, can }: { r: ConnectionRow; v: Verdict; can: Props["can"] }) {
  const writers = r.grants.filter((g) => g.access === "write");
  const readers = r.grants.filter((g) => g.access === "read");
  return (
    <li className={`conn conn-${v.status}`}>
      <div className="conn-head">
        <span className="conn-name">{displayName(r.name)}</span>
        <code className="muted small">{r.name}</code>
        <span className={`pill ${PILL[v.status]}`}>{STATUS_LABEL[v.status]}</span>
        <span className="conn-act">
          {v.action ? (
            <a className="btn primary" href={v.action.href}>
              {v.action.label}
            </a>
          ) : (
            v.hint && <span className="muted small">{v.hint}</span>
          )}
        </span>
      </div>
      <p className="conn-reason">{v.reason}</p>
      <dl className="panel-facts conn-facts">
        {r.kind === "service" ? (
          <>
            <dt>Used by</dt>
            <dd>The runner's Engineer jobs</dd>
          </>
        ) : (
          <>
            <dt>Granted to</dt>
            <dd>
              {r.grants.length ? (
                <>
                  {writers.length > 0 && <span>Read and write: {writers.map((g) => g.name).join(", ")}</span>}
                  {writers.length > 0 && readers.length > 0 && <br />}
                  {readers.length > 0 && <span>Read only: {readers.map((g) => g.name).join(", ")}</span>}
                </>
              ) : (
                <span className="muted">no agent yet</span>
              )}
            </dd>
            <dt>Tools</dt>
            <dd>
              {r.tools.read} read, {r.tools.write} write, {r.transport === "built in" ? "built in" : `over ${r.transport}`}
            </dd>
          </>
        )}
        {r.probe && (
          <>
            <dt>Health</dt>
            <dd>
              Checked {when(r.probe.checkedAt)}; last answered ok {when(r.probe.lastOkAt)}
            </dd>
          </>
        )}
        {r.module && (
          <>
            <dt>Module</dt>
            <dd>{r.module}</dd>
          </>
        )}
      </dl>
      {r.google && r.google.accounts.length > 0 && (
        <ul className="conn-accounts">
          {r.google.accounts.map((a) => (
            <li key={a.email}>
              <span>
                <b>{a.email}</b>
                {a.primary ? " (calendar and meeting notes)" : ""}: {a.state === "ok" ? "working" : a.state === "expired" ? "stopped working" : a.state === "unknown" ? "checking" : "error"}
              </span>
              {can.google && (
                <a className="link-btn" href={`/google/connect?account=${encodeURIComponent(a.email)}`}>
                  Reconnect
                </a>
              )}
            </li>
          ))}
          {can.google && (
            <li>
              <a className="link-btn" href="/google/connect">
                Add a Google account
              </a>
            </li>
          )}
        </ul>
      )}
      {r.setup && (
        <details className="conn-setup" open={v.status === "not_configured" || v.status === "error"}>
          <summary>How to set it up</summary>
          <p>{r.setup}</p>
        </details>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ agents, spend, notifications, instance

function Agents({ agents }: { agents: AgentSettings[] }) {
  return (
    <Page title="Agents and models" sub="What each agent runs on and when it wakes. Change one with an override in instance.yaml.">
      <ul className="agent-settings">
        {agents.map((a) => (
          <AgentItem key={a.key} a={a} />
        ))}
      </ul>
    </Page>
  );
}

function AgentItem({ a }: { a: AgentSettings }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="agent-setting">
      <div className="setting-head">
        <span className="conn-name">{a.name}</span>
        <code className="muted small">{a.key}</code>
        {a.trial && <span className="pill pill-needs">In trial</span>}
        {a.graded && <span className="pill">Graded</span>}
        <button className="link-btn setting-change" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Close" : "Change"}
        </button>
      </div>
      <dl className="panel-facts">
        <dt>Model</dt>
        <dd>
          <code>{a.model || "the runner's"}</code>
          {a.effort ? `, ${a.effort} effort` : ""}
          {a.models.length > 0 && <span className="muted"> (may also call {a.models.join(", ")})</span>}
        </dd>
        <dt>Runs on</dt>
        <dd>
          {a.runsOn}, {a.adapter}, module {a.module || "instance"}
        </dd>
        <dt>Heartbeat</dt>
        <dd>{a.heartbeatHours ? `every ${a.heartbeatHours} hour${a.heartbeatHours === 1 ? "" : "s"}` : <span className="muted">none</span>}</dd>
        <dt>Routines</dt>
        <dd>
          {a.routines.filter((r) => !r.key.startsWith("heartbeat-")).length ? (
            <ul className="routine-list">
              {a.routines
                .filter((r) => !r.key.startsWith("heartbeat-"))
                .map((r) => (
                  <li key={r.key}>
                    {r.title}
                    {r.status === "paused" && <span className="muted"> (paused)</span>}:{" "}
                    <span className="muted">{r.schedules.length ? r.schedules.map((x) => `${x.label || x.cron} (${x.cron}${x.timezone ? `, ${x.timezone}` : ""})`).join("; ") : r.webhook ? "on an event" : "started on demand"}</span>
                    {r.model && <span className="muted"> on {r.model}</span>}
                  </li>
                ))}
            </ul>
          ) : (
            <span className="muted">none</span>
          )}
        </dd>
        <dt>Connections</dt>
        <dd>{a.connections.length ? a.connections.join(", ") : <span className="muted">none</span>}</dd>
        {a.roles.length > 0 && (
          <>
            <dt>Roles</dt>
            <dd>{a.roles.join(", ")}</dd>
          </>
        )}
      </dl>
      {open && <SourceLine path={["overrides", "agents", a.key, "model"]} value={a.model} ask={`Please change ${a.name}'s (${a.key}) model in instance.yaml overrides to <model> and file the apply for me.`} />}
    </li>
  );
}

const usd = (n: number) => `$${n.toFixed(n % 1 ? 2 : 0)}`;

function Spend({ data }: { data: SettingsData }) {
  const caps = data.settings.find((s) => s.key === "spend_caps");
  const d = data.spend.defaults;
  const own = data.agents.filter((a) => Object.entries(a.caps).some(([k, v]) => d[k] !== v));
  return (
    <Page title="Spend caps" sub={`Fleet defaults: ${usd(d.run_usd ?? 0)} a run, ${usd(d.task_usd ?? 0)} a task, ${usd(d.day_usd ?? 0)} an agent-day (UTC).`}>
      <section className="settings-section">
        <p>
          {data.spend.enforcing === null
            ? "The model gateway didn't answer, so whether caps are enforced right now is unknown."
            : data.spend.enforcing
              ? "The model gateway is enforcing caps: a call past one is refused and you get a Raise card."
              : "Caps are off: every call is still billed and logged, none is refused."}
        </p>
        <p className="muted small">
          To raise a cap once, approve the Raise card the gateway files (it doubles the cap for that run, task or day).{" "}
          {data.spend.pendingRaises ? <a href="#/approvals">{data.spend.pendingRaises} waiting in Approvals.</a> : "None is waiting."} To change an agent's caps for good, set them in instance.yaml.
        </p>
      </section>
      <section className="settings-section">
        <div className="section-head">
          <h2>Agents with their own caps</h2>
        </div>
        {own.length ? (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Run</th>
                <th>Task</th>
                <th>Day</th>
              </tr>
            </thead>
            <tbody>
              {own.map((a) => (
                <tr key={a.key}>
                  <td>{a.name}</td>
                  <td>{usd(a.caps.run_usd ?? 0)}</td>
                  <td>{usd(a.caps.task_usd ?? 0)}</td>
                  <td>{usd(a.caps.day_usd ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">Every agent uses the fleet defaults.</p>
        )}
        <SourceLine path={["overrides", "agents", "<agent key>", "caps"]} value={{ day_usd: (d.day_usd ?? 30) * 2 }} ask="Please raise <agent>'s spend caps in instance.yaml overrides to <caps> and file the apply for me." />
      </section>
      {caps && <SettingList rows={[caps]} />}
    </Page>
  );
}

function Notifications({ rows, conns }: { rows: SettingRow[]; conns: ConnectionsData | null }) {
  const live = conns?.connections.find((c) => c.name === "slack_live")?.probe;
  const chosen = (rows.find((r) => r.key === "channels")?.value as string[] | undefined) ?? [];
  const [perm, setPerm] = useState(() => (notificationsSupported() ? Notification.permission : "unsupported"));
  const state = (k: string) => (!live?.channels ? "unknown" : live.channels[k] ? "set up" : "not set up");
  return (
    <Page title="Notifications" sub="Where Aiden and the agents reach you, and where you can tap approvals.">
      <ul className="conn-list">
        <li className="conn">
          <div className="conn-head">
            <span className="conn-name">This browser</span>
            <span className={`pill ${perm === "granted" ? "pill-working" : ""}`}>{perm === "granted" ? "On" : perm === "denied" ? "Blocked" : perm === "unsupported" ? "Not supported" : "Off"}</span>
            {perm === "default" && (
              <span className="conn-act">
                <button className="btn" onClick={() => void askForNotifications().then(setPerm)}>
                  Notify me here
                </button>
              </span>
            )}
          </div>
          <p className="conn-reason">A browser notification when something needs you, while the board is open.{perm === "denied" ? " Allow notifications for this site in the browser's settings." : ""}</p>
        </li>
        {[
          ["telegram", "Telegram", "The work bot: messages, approvals with one tap, voice notes."],
          ["slack", "Slack", "A DM from the labelled bot, and Socket Mode for urgent pages."],
          ["voice", "Voice notes", "Telegram voice notes transcribed on the host (whisper)."],
        ].map(([k, name, what]) => (
          <li key={k} className="conn">
            <div className="conn-head">
              <span className="conn-name">{name}</span>
              <span className={`pill ${state(k!) === "set up" ? "pill-working" : ""}`}>{state(k!)}</span>
              {k !== "voice" && <span className="muted small">{chosen.includes(k!) ? "in your channels" : "not in your channels"}</span>}
            </div>
            <p className="conn-reason">{what}</p>
          </li>
        ))}
      </ul>
      {!live?.channels && <p className="muted small">The owner channel didn't say which channels have tokens (an older slack-live-mcp, or it is down).</p>}
      <SettingList rows={rows} />
    </Page>
  );
}

function Instance({ data }: { data: SettingsData }) {
  const i = data.instance;
  const sha = (s: string | null) => (s ? <code title={s}>{s.slice(0, 12)}</code> : <span className="muted">unknown</span>);
  return (
    <Page title="Instance" sub="What this AidenHQ runs, and every setting it was compiled with.">
      <dl className="panel-facts settings-section">
        <dt>Product</dt>
        <dd>{sha(i.product)} (instance.yaml product:)</dd>
        <dt>Instance repo</dt>
        <dd>{sha(i.instance)} at the last applied agent change</dd>
        <dt>Last applied change</dt>
        <dd>{i.lastChangeAt ? when(i.lastChangeAt) : <span className="muted">unknown</span>}</dd>
        <dt>Board</dt>
        <dd>
          Node {i.node}, timezone {i.boardTimezone}
        </dd>
      </dl>
      <p className="muted small">To move to a newer product, set product: to a commit on main in instance.yaml, commit and push, then run ops/apply-config.sh on the host.</p>
      <section className="settings-section">
        <div className="section-head">
          <h2>Every setting</h2>
          <span className="count">{data.settings.length}</span>
        </div>
        <table className="settings-table">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Value</th>
              <th>From</th>
              <th>Module</th>
            </tr>
          </thead>
          <tbody>
            {data.settings.map((s) => (
              <tr key={s.key}>
                <td>
                  <code>{s.key}</code>
                </td>
                <td>{s.known ? shown(s.value) : "unknown"}</td>
                <td className="muted">{s.set ? "instance.yaml" : "default"}</td>
                <td className="muted">{s.module}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Page>
  );
}
