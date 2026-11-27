import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountsView } from "./Accounts";
import { SignInRequired, admin, api, type Session } from "./api";
import { PoweredBy } from "./components";
import { needsAttention, type ConnectionsData } from "./connections";
import { useEvents } from "./events";
import { askForNotifications, notificationsSupported } from "./notify";
import { ConnectionsPage, RowsSkeleton } from "./SettingsConnections";
import { parseInput, shown } from "./settings-format";
import { ChangePreview, ChangeProgress, Changes, Group, IN_FLIGHT, Page, Row, Toasts, useFiled } from "./settings-ui";
import type { Advisory, FiledChange, ModuleRow, SettingChange, SettingRow, SettingsData, UpdatesData } from "./types";
import { urlSettingProblem } from "../../src/url-setting";
import "./settings.css";
import { Banner, Button, LinkButton, SectionCard, Segmented, StatusDot, Switch, Tag, safeHref } from "./ui";
import { Steps } from "./SetupFlow";
import { clockOpts, clockText } from "./util";

// Claude Desktop and claude.ai call from Anthropic's cloud, so they need a public https address: not a tailnet name (*.ts.net) or loopback.
const cloudReachable = (origin: string) => { const u = new URL(origin); return u.protocol === "https:" && !u.hostname.endsWith(".ts.net"); };
const mcpSteps = (origin: string) => `**Claude Code:** \`claude mcp add --transport http aidenhq ${origin}/mcp\`, then \`/mcp\`, choose aidenhq, Authenticate, sign in and Allow.

**Codex CLI:** \`codex mcp add aidenhq --url ${origin}/mcp\`

${cloudReachable(origin) ? "Claude Desktop and claude.ai connectors work here too." : "claude.ai needs public mode; Claude Code works here over the tunnel/tailnet."}`;

// Settings: categories in a side nav (a selector at phone width), each a page of grouped rows (#/settings/<category>).
// Instance settings live in git (instance.yaml): a change made here is filed as the owner's task the runner writes, and lands
// only through its apply card (docs/design/settings-changes.md). What the board owns (accounts, sign-ins, browser
// notifications) changes right here.

export const CATEGORIES = [
  { key: "connections", name: "Connections", group: "Connect" },
  { key: "approvals", name: "Approvals and autonomy", group: "Fleet" },
  { key: "spend", name: "Spend limits", group: "Fleet" },
  { key: "switches", name: "Kill switches", group: "Fleet" },
  { key: "notifications", name: "Notifications", group: "You" },
  { key: "accounts", name: "Accounts and access", group: "You" },
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
  can: { signIn: boolean };
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

  // A sign-in finished in the tab its Connect opened: its tile turns Connected now.
  useEvents(["connections"], () => loadConns(true));
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
            <Banner tone="danger" action={<Button size="sm" onClick={() => (setError(""), void loadSettings(), void loadConns(true))}>Try again</Button>}>
              Couldn't load settings: {error}.
            </Banner>
          )}
          {data && !data.compiled && current !== "accounts" && (
            <Banner tone="warn">This board can't read the compiled config yet (config/paperclip.yaml): the next apply on the host mounts it.</Banner>
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
  if (cat === "connections") return <ConnectionsPage conns={conns} can={can} refresh={checking} onRefresh={check} />;
  const title = CATEGORIES.find((c) => c.key === cat)!.name;
  if (!data)
    return (
      <Page title={title} sub="Loading…">
        <RowsSkeleton />
      </Page>
    );
  const rows = (keys: string[]) => keys.map((k) => data.settings.find((s) => s.key === k)).filter((s): s is SettingRow => Boolean(s));
  if (cat === "approvals") return <ApprovalsPage data={data} rows={rows} />;
  if (cat === "spend") return <SpendPage rows={rows(["spend_day_usd", "spend_month_usd", "task_usd"])} />;
  if (cat === "switches") {
    const sw = data.settings.filter((s) => s.switch);
    const off = sw.filter((s) => (s.live ?? s.value ?? s.default) === "off").length;
    return (
      <Page title="Kill switches" sub={`${sw.length - off} of ${sw.length} on. Turning one off files a change for you to approve; most take effect on the next use after it lands.`}>
        <Group>{sw.length ? sw.map((s) => <SettingItem key={s.key} s={s} />) : <p className="st-empty">No switches on this instance.</p>}</Group>
      </Page>
    );
  }
  if (cat === "notifications") return <NotificationsPage rows={rows(["channels", "notify_transports", "notify_fyi", "slack_post_channels"])} conns={conns} />;
  if (cat === "general") {
    const elsewhere = new Set(["autonomy", "spend_day_usd", "spend_month_usd", "task_usd", "channels", "notify_transports", "notify_fyi", "slack_post_channels"]);
    const general = data.settings.filter((s) => !s.switch && !s.page && !elsewhere.has(s.key) && s.type !== "url");
    return (
      <Page title="General" sub={data.owner.name ? `This AidenHQ belongs to ${data.owner.name}. The board's own Today and Tomorrow use ${data.instance.boardTimezone}.` : `Who this AidenHQ belongs to, and how it is named. The board's own Today and Tomorrow use ${data.instance.boardTimezone}.`}>
        <Group>{general.length ? general.map((s) => <SettingItem key={s.key} s={s} />) : <p className="st-empty">Nothing here on this instance.</p>}</Group>
        <SectionCard title="Connect your Claude" meta="Manage AidenHQ from your own Claude">
          <p className="st-hint">Your own Claude can check status, talk to Aiden, change settings and decide approvals as you, and can help finish anything you skipped in setup.</p>
          <Steps text={mcpSteps(location.origin)} />
        </SectionCard>
      </Page>
    );
  }
  return <InstancePage data={data} />;
}

// ------------------------------------------------------------------ one setting, changed in place

const label = (k: string) => k.replace(/_/g, " ").replace(/\burl\b/g, "URL").replace(/\bmcp\b/g, "MCP").replace(/^./, (c) => c.toUpperCase());

export function SettingItem({ s, title }: { s: SettingRow; title?: string }) {
  const filed = useFiled((c) => c.kind === "setting" && c.key === s.key);
  const busy = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  const effective = s.live ?? s.value ?? s.default;
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<unknown>(undefined);
  const drift = s.live !== undefined && s.known && s.value !== null && s.live !== String(s.value);
  const pick = (v: unknown) => (setTo(v), setOpen(true));
  const status = busy ? <StatusDot tone="busy">Changing</StatusDot> : null;
  if (s.switch) {
    const on = (to ?? effective) !== "off";
    return (
      <Row
        title={title ?? label(s.key)}
        sub={s.doc}
        meta={status ?? (!s.known && s.live === undefined ? <StatusDot tone="idle">Unknown</StatusDot> : undefined)}
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
  const shaped = s.pattern && typeof next === "string" && next !== "" && !new RegExp(s.pattern).test(next) ? `a value like ${s.pattern}` : null;
  const problem = s.type === "url" ? urlSettingProblem(next, s.host) : typeof (s.default ?? s.value) === "number" && Number.isNaN(next) ? "a number" : shaped;
  const same = JSON.stringify(next) === JSON.stringify(s.value ?? s.default);
  return (
    <form className="st-editor" onSubmit={(e) => (e.preventDefault(), !problem && !same && setReview(true))}>
      {values.length && !multi ? (
        values.length <= 4 ? (
          <Segmented value={String(v)} label={label(s.key)} options={values.map((x) => [String(x), String(x)] as const)} onChange={(x) => (setV(values.find((y) => String(y) === x)), setReview(false))} />
        ) : (
          <select className="ui-select" value={String(v)} onChange={(e) => (setV(values.find((y) => String(y) === e.target.value)), setReview(false))} aria-label={label(s.key)}>
            {values.map((x) => (
              <option key={String(x)}>{String(x)}</option>
            ))}
          </select>
        )
      ) : values.length ? (
        <div className="ui-checks" role="group" aria-label={label(s.key)}>
          {values.map((x) => {
            const on = (v as unknown[]).includes(x);
            return (
              <label key={String(x)} className={`ui-check${on ? " on" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => (setV(on ? (v as unknown[]).filter((y) => y !== x) : [...(v as unknown[]), x]), setReview(false))} />
                {String(x)}
              </label>
            );
          })}
        </div>
      ) : (
        <input className="ui-input" value={text} onChange={(e) => (setText(e.target.value), setReview(false))} type={s.type === "url" ? "url" : "text"} spellCheck={false} aria-label={label(s.key)} placeholder={multi ? "comma, separated" : ""} />
      )}
      {problem && !same && <span className="ui-field-error">{problem.replace(/^./, (c) => c.toUpperCase())}</span>}
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
      <p className="st-note">{data.approvals.pending ? <><a href="#/">{data.approvals.pending} waiting on you</a> on Home.</> : "Nothing is waiting on you."}</p>
      <Group title="Settings">
        {autonomy && <SettingItem s={autonomy} />}
      </Group>
    </Page>
  );
}

function SpendPage({ rows }: { rows: SettingRow[] }) {
  return (
    <Page title="Spend limits" sub="The model gateway refuses a call that would take the whole install past either install limit (a day or a calendar month: midnight in the owner's timezone), and a task that would pass its own limit; all in USD.">
      <Group>{rows.map((s) => <SettingItem key={s.key} s={s} />)}</Group>
    </Page>
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
          meta={<StatusDot tone={perm === "granted" ? "ok" : perm === "denied" ? "needs" : "idle"}>{perm === "granted" ? "On" : perm === "denied" ? "Blocked" : perm === "unsupported" ? "Not supported" : "Off"}</StatusDot>}
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
          <Row key={k} title={name} sub={what} meta={<>{k !== "voice" && <Tag>{chosen.includes(k) ? "in your channels" : "not in your channels"}</Tag>}<StatusDot tone={state(k) === "set up" ? "ok" : "idle"}>{state(k)}</StatusDot></>} />
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
        <Fig n={i.lastChangeAt ? new Date(i.lastChangeAt).toLocaleString(undefined, { month: "short", day: "numeric", ...clockOpts() }) : "unknown"} l="Last applied change" />
        <Fig n={i.node} l={`Board runtime, ${i.boardTimezone}`} />
      </div>
      {data.updates ? (
        <Updates u={data.updates} setting={data.settings.find((s) => s.key === "auto_update")} />
      ) : (
        <p className="st-note">A newer product is a change to instance.yaml's product: pin; the Engineer files it with its commit log for you to approve.</p>
      )}
      <Group title="Every setting" count={data.settings.length} hint={<input className="ui-input small" type="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter settings" />}>
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

// Release updates (docs/design/release-updates.md): the release this server follows, the one available with what changed, and
// Update now, which is the kernel's own page (an owner tap happens there, never on the board).
function Updates({ u, setting }: { u: UpdatesData; setting?: SettingRow }) {
  const when = (t: string | null) => (t ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", ...clockOpts() }) : "never");
  const a = u.available;
  return (
    <Group title="Updates" hint={<span className="muted">Release {u.current?.name}, checked {when(u.checkedAt)}</span>}>
      {a ? (
        <Banner action={<LinkButton variant="primary" size="sm" href={`${admin.url}/updates`}>Update now</LinkButton>}>
          AidenHQ {a.name} is available.{" "}
          {u.auto ? `It installs tonight between ${clockText(2)} and ${clockText(5)} (${u.timezone ?? "UTC"}).` : "Auto-updates are off: install it when you're ready."}
        </Banner>
      ) : (
        <p className="st-note">{u.error ? `Update check: ${u.error}` : `This server runs ${u.current?.name}, the newest release.`}</p>
      )}
      {a && (
        <div className="st-note">
          {a.notes.length > 0 && (
            <ul>
              {a.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <a href={safeHref(a.compare)} target="_blank" rel="noreferrer">
            Every change since {u.current?.name}
          </a>
        </div>
      )}
      {u.last && (
        <p className="st-note">
          Last update: {u.last.release} {u.last.outcome === "installed" ? "installed" : `failed (${u.last.why ?? "see the apply log"}); this server went back to the release before it`}, {when(u.last.at)}.
        </p>
      )}
      {setting && <SettingItem s={setting} title="Install updates automatically, at night" />}
    </Group>
  );
}

const Fig = ({ n, l }: { n: ReactNode; l: string }) => (
  <div className="st-figure">
    <span className="st-figure-n">{n}</span>
    <span className="st-figure-l">{l}</span>
  </div>
);
