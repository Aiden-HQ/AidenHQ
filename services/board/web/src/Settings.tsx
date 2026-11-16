import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountsView } from "./Accounts";
import { SignInRequired, api, type Session } from "./api";
import { PoweredBy } from "./components";
import { needsAttention, type ConnectionsData } from "./connections";
import { askForNotifications, notificationsSupported } from "./notify";
import { ConnectionsPage, RowsSkeleton } from "./SettingsConnections";
import { AgentsPage } from "./SettingsAgents";
import { parseInput, shown } from "./settings-format";
import { ChangePreview, ChangeProgress, Changes, Group, IN_FLIGHT, Page, Row, Segmented, StatusPill, Switch, Toasts, useFiled } from "./settings-ui";
import type { Advisory, FiledChange, ModuleRow, SettingChange, SettingRow, SettingsData } from "./types";
import { urlSettingProblem } from "../../src/url-setting";
import "./settings.css";

// Settings: categories in a side nav (a selector at phone width), each a page of grouped rows (#/settings/<category>).
// Instance settings live in git (instance.yaml): a change made here is filed as the Platform Engineer's task, and lands
// only through its apply card (docs/design/settings-changes.md). What the board owns (accounts, sign-ins, browser
// notifications) changes right here.

export const CATEGORIES = [
  { key: "connections", name: "Connections", group: "Connect" },
  { key: "agents", name: "Agents and models", group: "Fleet" },
  { key: "approvals", name: "Approvals and autonomy", group: "Fleet" },
  { key: "spend", name: "Spend caps", group: "Fleet" },
  { key: "switches", name: "Kill switches", group: "Fleet" },
  { key: "notifications", name: "Notifications", group: "You" },
  { key: "accounts", name: "Accounts and access", group: "You" },
  { key: "modules", name: "Modules", group: "System" },
  { key: "general", name: "General", group: "System" },
  { key: "instance", name: "Instance", group: "System" },
] as const;
export type Category = (typeof CATEGORIES)[number]["key"];
export const isCategory = (s: string | null | undefined): s is Category => CATEGORIES.some((c) => c.key === s);
const GROUPS = [...new Set(CATEGORIES.map((c) => c.group))];

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
  const [changes, setChanges] = useState<FiledChange[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [toasts, setToasts] = useState<{ id: number; text: string; tone?: "ok" | "bad" }[]>([]);
  const fail = useCallback((e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)), [onSignIn]);
  const loadConns = useCallback((fresh = false) => api.connections(fresh).then(setConns, fail), [fail]);
  const loadSettings = useCallback(() => api.settings().then(setData, fail), [fail]);
  const loadChanges = useCallback(() => api.settingsChanges().then((r) => setChanges(r.changes), () => {}), []);
  useEffect(() => {
    void loadSettings();
    void loadConns();
    void loadChanges();
  }, [loadSettings, loadConns, loadChanges]);

  // While a change is under way, follow it closely (and the connections, which come up after it); otherwise every 30 s.
  const busy = changes.some((c) => IN_FLIGHT.includes(c.stage));
  const wasBusy = useRef(busy);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadChanges();
      void loadConns(busy);
    }, busy ? 5_000 : 30_000);
    return () => clearInterval(t);
  }, [busy, loadChanges, loadConns]);
  // A change just went live: the compiled config moved, so read it again.
  useEffect(() => {
    if (wasBusy.current && !busy) void loadSettings();
    wasBusy.current = busy;
  }, [busy, loadSettings]);

  const toast = useCallback((text: string, tone?: "ok" | "bad") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4_500);
  }, []);
  const file = useCallback(
    async (items: SettingChange[]) => {
      try {
        const { identifier } = await api.changeSettings(items);
        void loadChanges();
        return identifier;
      } catch (e) {
        if (e instanceof SignInRequired) onSignIn();
        throw e;
      }
    },
    [loadChanges, onSignIn],
  );
  const ctx = useMemo(() => ({ changes, file, toast }), [changes, file, toast]);

  const current: Category = cat ?? "connections";
  const attention = conns ? needsAttention(conns, can) : false;
  const check = () => (setChecking(true), void loadConns(true).finally(() => setChecking(false)));

  return (
    <Changes.Provider value={ctx}>
      <div className={`st-shell${mobile ? " phone" : ""}`}>
        {mobile ? (
          <header className="st-phone-bar">
            {cat && (
              <button className="icon-btn" onClick={() => go("#/")} aria-label="Leave settings">
                ‹
              </button>
            )}
            <label className="st-phone-select">
              <span className="sr-only">Settings page</span>
              <select value={current} onChange={(e) => go(`#/settings/${e.target.value}`)}>
                {GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {CATEGORIES.filter((c) => c.group === g).map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.name}
                        {c.key === "connections" && attention ? " (needs you)" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </header>
        ) : (
          <nav className="st-nav" aria-label="Settings">
            <div className="st-nav-title">Settings</div>
            {GROUPS.map((g) => (
              <div key={g} className="st-nav-group">
                <div className="st-nav-group-name">{g}</div>
                {CATEGORIES.filter((c) => c.group === g).map((c) => (
                  <a key={c.key} href={`#/settings/${c.key}`} className={`st-nav-item${current === c.key ? " on" : ""}`} aria-current={current === c.key ? "page" : undefined}>
                    {c.name}
                    {c.key === "connections" && attention && <span className="needs-dot" title="A connection needs you" />}
                  </a>
                ))}
              </div>
            ))}
          </nav>
        )}
        <div className="st-pane">
          {error && (
            <div className="st-banner bad" role="alert">
              Couldn't load settings: {error}.{" "}
              <button className="link-btn" onClick={() => (setError(""), void loadSettings(), void loadConns(true))}>
                Try again
              </button>
            </div>
          )}
          {data && !data.compiled && current !== "accounts" && current !== "modules" && (
            <div className="st-banner">This board can't read the compiled config yet (config/paperclip.yaml): the next apply on the host mounts it.</div>
          )}
          <div className="st-page-in" key={current}>
            <Pane cat={current} data={data} conns={conns} session={session} onSignIn={onSignIn} can={can} checking={checking} check={check} />
          </div>
          <PoweredBy />
        </div>
        <Toasts items={toasts} />
      </div>
    </Changes.Provider>
  );
}

function Pane({ cat, data, conns, session, onSignIn, can, checking, check }: { cat: Category; data: SettingsData | null; conns: ConnectionsData | null; session: Session | null; onSignIn: () => void; can: Props["can"]; checking: boolean; check: () => void }) {
  if (cat === "accounts") return session ? <div className="st-embedded"><AccountsView session={session} onSignIn={onSignIn} /></div> : null;
  if (cat === "modules") return <ModulesPage onSignIn={onSignIn} />;
  if (cat === "connections") return <ConnectionsPage conns={conns} can={can} refresh={checking} onRefresh={check} />;
  const title = CATEGORIES.find((c) => c.key === cat)!.name;
  if (!data)
    return (
      <Page title={title} sub="Loading…">
        <RowsSkeleton />
      </Page>
    );
  const rows = (keys: string[]) => keys.map((k) => data.settings.find((s) => s.key === k)).filter((s): s is SettingRow => Boolean(s));
  if (cat === "agents") return <AgentsPage data={data} />;
  if (cat === "approvals") return <ApprovalsPage data={data} rows={rows} />;
  if (cat === "spend") return <SpendPage data={data} />;
  if (cat === "switches") {
    const sw = data.settings.filter((s) => s.switch);
    const off = sw.filter((s) => (s.live ?? s.value ?? s.default) === "off").length;
    return (
      <Page title="Kill switches" sub={`${sw.length - off} of ${sw.length} on. Turning one off files a change for you to approve; most take effect on the next use after it lands.`}>
        <Group>{sw.length ? sw.map((s) => <SettingItem key={s.key} s={s} />) : <p className="st-empty">No switches on this instance.</p>}</Group>
      </Page>
    );
  }
  if (cat === "notifications") return <NotificationsPage rows={rows(["channels", "telegram_fyi", "slack_post_channels", "owner_slack_user_id"])} conns={conns} />;
  if (cat === "general") {
    const elsewhere = new Set(["autonomy", "batch_approvals", "dup_guard", "grading", "channels", "telegram_fyi", "slack_post_channels", "owner_slack_user_id"]);
    const general = data.settings.filter((s) => !s.switch && !elsewhere.has(s.key) && s.type !== "url");
    return (
      <Page title="General" sub={data.owner.name ? `This AidenHQ belongs to ${data.owner.name}. The board's own Today and Tomorrow use ${data.instance.boardTimezone}.` : `Who this AidenHQ belongs to, and how it is named. The board's own Today and Tomorrow use ${data.instance.boardTimezone}.`}>
        <Group>{general.length ? general.map((s) => <SettingItem key={s.key} s={s} />) : <p className="st-empty">Nothing here on this instance.</p>}</Group>
      </Page>
    );
  }
  return <InstancePage data={data} />;
}

// ------------------------------------------------------------------ one setting, changed in place

const label = (k: string) => k.replace(/_/g, " ").replace(/\burl\b/g, "URL").replace(/\bmcp\b/g, "MCP").replace(/^./, (c) => c.toUpperCase());

function SettingItem({ s, title }: { s: SettingRow; title?: string }) {
  const filed = useFiled((c) => c.kind === "setting" && c.key === s.key);
  const busy = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  const effective = s.live ?? s.value ?? s.default;
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<unknown>(undefined);
  const drift = s.live !== undefined && s.known && s.value !== null && s.live !== String(s.value);
  const pick = (v: unknown) => (setTo(v), setOpen(true));
  const status = busy ? <StatusPill tone="busy">Changing</StatusPill> : null;
  if (s.switch) {
    const on = (to ?? effective) !== "off";
    return (
      <Row
        title={title ?? label(s.key)}
        sub={s.doc}
        meta={status ?? (!s.known && s.live === undefined ? <StatusPill tone="off">Unknown</StatusPill> : undefined)}
        action={<Switch on={on} label={`${label(s.key)}: ${on ? "on" : "off"}`} disabled={busy} onChange={(v) => pick(v ? "on" : "off")} />}
        open={open || Boolean(filed)}
        onToggle={(o) => (setOpen(o), !o && setTo(undefined))}
        details={
          filed && !open ? (
            <ChangeProgress f={filed} />
          ) : to !== undefined ? (
            <ChangePreview items={[{ kind: "setting", key: s.key, value: to }]} was={[s.value ?? s.default]} onCancel={() => (setOpen(false), setTo(undefined))} onDone={() => (setOpen(false), setTo(undefined))} />
          ) : (
            <SettingFacts s={s} drift={drift} />
          )
        }
      />
    );
  }
  return (
    <Row
      title={title ?? label(s.key)}
      sub={s.doc}
      meta={status ?? <span className="st-value" title={shown(s.value)}>{s.known ? shown(s.value) : "unknown"}</span>}
      open={open}
      onToggle={setOpen}
      details={
        <>
          {filed && <ChangeProgress f={filed} />}
          {!busy && <SettingEditor s={s} onDone={() => setOpen(false)} />}
          <SettingFacts s={s} drift={drift} />
        </>
      }
    />
  );
}

function SettingFacts({ s, drift }: { s: SettingRow; drift: boolean }) {
  return (
    <>
      {drift && <p className="st-hint warn">Running as {s.live}, while the compiled config says {shown(s.value)}: the last apply may not have finished.</p>}
      <dl className="st-facts compact">
        <dt>Key</dt>
        <dd>
          <code>settings.{s.key}</code>
        </dd>
        <dt>From</dt>
        <dd>{!s.known ? "the board can't read it yet" : s.set ? "instance.yaml" : s.default !== undefined ? `the default (${shown(s.default)})` : "not set"}</dd>
        <dt>Module</dt>
        <dd>{s.module}</dd>
      </dl>
    </>
  );
}

/** The control a setting's type calls for: a choice, several choices, a URL, a number or text; then its preview. */
function SettingEditor({ s, onDone }: { s: SettingRow; onDone: () => void }) {
  const values = s.values ?? [];
  const multi = Array.isArray(s.value ?? s.default);
  const [v, setV] = useState<unknown>(s.value ?? s.default ?? (multi ? [] : ""));
  const [text, setText] = useState(Array.isArray(v) ? (v as unknown[]).join(", ") : v === null || v === undefined ? "" : String(v));
  const [review, setReview] = useState(false);
  const next = values.length ? v : parseInput(s, text);
  const problem = s.type === "url" ? urlSettingProblem(next, s.host) : typeof (s.default ?? s.value) === "number" && Number.isNaN(next) ? "a number" : null;
  const same = JSON.stringify(next) === JSON.stringify(s.value ?? s.default);
  return (
    <form className="st-editor" onSubmit={(e) => (e.preventDefault(), !problem && !same && setReview(true))}>
      {values.length && !multi ? (
        values.length <= 4 ? (
          <Segmented value={String(v)} label={label(s.key)} options={values.map((x) => ({ value: String(x), label: String(x) }))} onChange={(x) => (setV(values.find((y) => String(y) === x)), setReview(false))} />
        ) : (
          <select className="st-select" value={String(v)} onChange={(e) => (setV(values.find((y) => String(y) === e.target.value)), setReview(false))} aria-label={label(s.key)}>
            {values.map((x) => (
              <option key={String(x)}>{String(x)}</option>
            ))}
          </select>
        )
      ) : values.length ? (
        <div className="st-checks" role="group" aria-label={label(s.key)}>
          {values.map((x) => {
            const on = (v as unknown[]).includes(x);
            return (
              <label key={String(x)} className={`st-check${on ? " on" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => (setV(on ? (v as unknown[]).filter((y) => y !== x) : [...(v as unknown[]), x]), setReview(false))} />
                {String(x)}
              </label>
            );
          })}
        </div>
      ) : (
        <input className="st-input" value={text} onChange={(e) => (setText(e.target.value), setReview(false))} type={s.type === "url" ? "url" : "text"} spellCheck={false} aria-label={label(s.key)} placeholder={multi ? "comma, separated" : ""} />
      )}
      {problem && !same && <span className="st-field-help bad">{problem.replace(/^./, (c) => c.toUpperCase())}</span>}
      {review ? (
        <ChangePreview items={[{ kind: "setting", key: s.key, value: next }]} was={[s.value ?? s.default]} onCancel={() => setReview(false)} onDone={onDone} />
      ) : (
        <div className="st-change-actions">
          <button className="btn primary" disabled={same || Boolean(problem)}>
            Review change
          </button>
        </div>
      )}
    </form>
  );
}

// ------------------------------------------------------------------ approvals, spend, notifications, modules, instance

function ApprovalsPage({ data, rows }: { data: SettingsData; rows: (keys: string[]) => SettingRow[] }) {
  const [autonomy] = rows(["autonomy"]);
  return (
    <Page title="Approvals and autonomy" sub="Every write (a push, merge, apply, deploy or outbound message) is an approval record. Code sets each one's tier; autonomy says how much of Tier 1 the AI reviewer decides.">
      <div className="st-tiers">
        <div className="st-tier">
          <span className="st-tier-n">Tier 0</span>
          <p>Safe writes run at once and are recorded.</p>
        </div>
        <div className="st-tier">
          <span className="st-tier-n">Tier 1</span>
          <p>The AI reviewer decides when autonomy is full; otherwise you do.</p>
        </div>
        <div className="st-tier">
          <span className="st-tier-n">Tier 2</span>
          <p>Always yours: one tap in Approvals or Telegram, or an exact typed reply.</p>
        </div>
      </div>
      <p className="st-note">{data.approvals.pending ? <><a href="#/approvals">{data.approvals.pending} waiting on you</a> in Approvals.</> : "Nothing is waiting on you."}</p>
      <Group title="Settings">
        {autonomy && <SettingItem s={autonomy} />}
        {rows(["batch_approvals", "dup_guard", "grading"]).map((s) => (
          <SettingItem key={s.key} s={s} />
        ))}
      </Group>
    </Page>
  );
}

const usd = (n: number) => `$${n.toFixed(n % 1 ? 2 : 0)}`;
const CAP_KEYS = ["run_usd", "task_usd", "day_usd"] as const;
const CAP_NAMES = { run_usd: "a run", task_usd: "a task", day_usd: "an agent-day" };

function SpendPage({ data }: { data: SettingsData }) {
  const d = data.spend.defaults;
  return (
    <Page
      title="Spend caps"
      sub="The model gateway refuses a call that would pass a cap and files a Raise card; approving it doubles that cap once."
    >
      <div className="st-figures">
        {CAP_KEYS.map((k) => (
          <div key={k} className="st-figure">
            <span className="st-figure-n">{usd(d[k] ?? 0)}</span>
            <span className="st-figure-l">{CAP_NAMES[k]}</span>
          </div>
        ))}
      </div>
      <p className="st-note">
        Fleet defaults, in USD (agent-days in UTC). {data.spend.pendingRaises ? <a href="#/approvals">{data.spend.pendingRaises} Raise card{data.spend.pendingRaises === 1 ? "" : "s"} waiting.</a> : "No Raise card is waiting."}
      </p>
      <Group title="Each agent's caps" hint="Open an agent to set its own caps for good.">
        {data.agents.map((a) => (
          <CapsRow key={a.key} name={a.name} agent={a.key} caps={a.caps} defaults={d} />
        ))}
      </Group>
    </Page>
  );
}

function CapsRow({ name, agent, caps, defaults }: { name: string; agent: string; caps: Record<string, number>; defaults: Record<string, number> }) {
  const filed = useFiled((c) => c.kind === "caps" && c.agent === agent);
  const own = CAP_KEYS.some((k) => caps[k] !== defaults[k]);
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(CAP_KEYS.map((k) => [k, String(caps[k] ?? defaults[k] ?? "")])));
  const [review, setReview] = useState(false);
  const changed = Object.fromEntries(CAP_KEYS.filter((k) => Number(v[k]) !== caps[k]).map((k) => [k, Number(v[k])]));
  const bad = Object.values(changed).some((n) => !(n > 0) || n > 1000);
  return (
    <Row
      title={name}
      meta={
        <>
          {filed && IN_FLIGHT.includes(filed.stage) && <StatusPill tone="busy">Changing</StatusPill>}
          <span className={`st-caps${own ? " own" : ""}`}>{CAP_KEYS.map((k) => usd(caps[k] ?? 0)).join(" / ")}</span>
        </>
      }
      details={
        <>
          {filed && <ChangeProgress f={filed} />}
          <form className="st-caps-form" onSubmit={(e) => (e.preventDefault(), Object.keys(changed).length && !bad && setReview(true))}>
            {CAP_KEYS.map((k) => (
              <label key={k} className="st-field">
                <span className="st-field-label">Per {CAP_NAMES[k].replace(/^an? /, "")}</span>
                <span className="st-money">
                  $<input inputMode="decimal" value={v[k]} onChange={(e) => (setV({ ...v, [k]: e.target.value }), setReview(false))} aria-label={`${name}: cap per ${CAP_NAMES[k]}`} />
                </span>
              </label>
            ))}
            {!review && (
              <button className="btn primary" disabled={!Object.keys(changed).length || bad}>
                Review change
              </button>
            )}
          </form>
          {bad && <span className="st-field-help bad">Each cap is above $0 and at most $1000.</span>}
          {review && <ChangePreview items={[{ kind: "caps", agent, value: changed }]} was={[Object.fromEntries(Object.keys(changed).map((k) => [k, caps[k]]))]} onCancel={() => setReview(false)} onDone={() => setReview(false)} />}
        </>
      }
    />
  );
}

function NotificationsPage({ rows, conns }: { rows: SettingRow[]; conns: ConnectionsData | null }) {
  // Each channel module's health says which of its channels have tokens (channel-telegram: telegram, voice; channel-slack: slack).
  const probes = (conns?.connections ?? []).filter((c) => c.name === "telegram" || c.name === "slack_live").map((c) => c.probe?.channels).filter(Boolean);
  const live = probes.length ? { channels: Object.assign({}, ...probes) as Record<string, boolean> } : undefined;
  const chosen = (rows.find((r) => r.key === "channels")?.value as string[] | undefined) ?? [];
  const [perm, setPerm] = useState(() => (notificationsSupported() ? Notification.permission : "unsupported"));
  const state = (k: string) => (!live?.channels ? "unknown" : live.channels[k] ? "set up" : "not set up");
  const channels: [string, string, string][] = [
    ["telegram", "Telegram", "The work bot: messages, approvals with one tap, voice notes."],
    ["slack", "Slack", "A DM from the labelled bot, and Socket Mode for urgent pages."],
    ["voice", "Voice notes", "Telegram voice notes transcribed on the host."],
  ];
  return (
    <Page title="Notifications" sub="Where Aiden and the agents reach you, and where you can tap approvals.">
      <Group title="This browser">
        <Row
          title="Browser notifications"
          sub={perm === "denied" ? "Blocked: allow notifications for this site in the browser's settings." : "A notification when something needs you, while the board is open."}
          meta={<StatusPill tone={perm === "granted" ? "ok" : perm === "denied" ? "warn" : "off"}>{perm === "granted" ? "On" : perm === "denied" ? "Blocked" : perm === "unsupported" ? "Not supported" : "Off"}</StatusPill>}
          action={
            perm === "default" ? (
              <button className="btn" onClick={() => void askForNotifications().then(setPerm)}>
                Turn on
              </button>
            ) : undefined
          }
        />
      </Group>
      <Group title="Channels" hint={!live?.channels ? "The channel modules didn't say which channels have tokens." : undefined}>
        {channels.map(([k, name, what]) => (
          <Row key={k} title={name} sub={what} meta={<>{k !== "voice" && <span className="st-chip">{chosen.includes(k) ? "in your channels" : "not in your channels"}</span>}<StatusPill tone={state(k) === "set up" ? "ok" : "off"}>{state(k)}</StatusPill></>} />
        ))}
      </Group>
      {rows.length > 0 && (
        <Group title="Settings">
          {rows.map((s) => (
            <SettingItem key={s.key} s={s} />
          ))}
        </Group>
      )}
    </Page>
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
          . The fix is an ordinary update to a newer product pin.
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
  const isOn = m.state !== "off";
  const fixed = m.state === "core" || m.state === "dependency";
  return (
    <Row
      title={m.name}
      sub={m.description}
      meta={filed && IN_FLIGHT.includes(filed.stage) ? <StatusPill tone="busy">Changing</StatusPill> : m.state === "core" ? <span className="st-chip">always on</span> : m.state === "dependency" ? <span className="st-chip">needed by another</span> : undefined}
      action={!fixed ? <Switch on={want ?? isOn} label={`${m.name}: ${isOn ? "on" : "off"}`} disabled={Boolean(filed && IN_FLIGHT.includes(filed.stage))} onChange={(v) => setWant(v)} /> : undefined}
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
            </dl>
          )}
        </>
      }
    />
  );
}

function InstancePage({ data }: { data: SettingsData }) {
  const i = data.instance;
  const [q, setQ] = useState("");
  const sha = (s: string | null) => (s ? <code title={s}>{s.slice(0, 12)}</code> : <span className="muted">unknown</span>);
  const list = data.settings.filter((s) => !q || `${s.key} ${s.module} ${shown(s.value)}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Page title="Instance" sub="What this AidenHQ runs, and every setting it was compiled with.">
      <div className="st-figures">
        <Fig n={sha(i.product)} l="Product" />
        <Fig n={sha(i.instance)} l="Instance repo, at the last applied change" />
        <Fig n={i.lastChangeAt ? new Date(i.lastChangeAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "unknown"} l="Last applied change" />
        <Fig n={i.node} l={`Board runtime, ${i.boardTimezone}`} />
      </div>
      <p className="st-note">A newer product is a change to instance.yaml's product: pin; the Platform Engineer files it with its commit log for you to approve.</p>
      <Group title="Every setting" count={data.settings.length} hint={<input className="st-search small" type="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter settings" />}>
        <div className="st-table" role="table">
          <div className="st-tr st-th" role="row">
            <span role="columnheader">Setting</span>
            <span role="columnheader">Value</span>
            <span role="columnheader">From</span>
            <span role="columnheader">Module</span>
          </div>
          {list.map((s) => (
            <div key={s.key} className="st-tr" role="row">
              <code role="cell">{s.key}</code>
              <span role="cell" className="st-td-value">{s.known ? shown(s.value) : "unknown"}</span>
              <span role="cell" className="muted">{s.set ? "instance.yaml" : "default"}</span>
              <span role="cell" className="muted">{s.module}</span>
            </div>
          ))}
          {!list.length && <p className="st-empty">No setting matches “{q}”.</p>}
        </div>
      </Group>
    </Page>
  );
}

const Fig = ({ n, l }: { n: ReactNode; l: string }) => (
  <div className="st-figure">
    <span className="st-figure-n">{n}</span>
    <span className="st-figure-l">{l}</span>
  </div>
);
