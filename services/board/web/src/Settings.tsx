import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountsView } from "./Accounts";
import { SignInRequired, admin, api, type Session } from "./api";
import { PoweredBy } from "./components";
import { needsAttention, type ConnectionsData } from "./connections";
import { useEvents } from "./events";
import { askForNotifications, notificationsSupported } from "./notify";
import { ConnectionsPage, RowsSkeleton } from "./SettingsConnections";
import { ADVANCED_SETTINGS, CATEGORIES, PAGE_SETTINGS, type Category } from "./settings-layout";
import { SettingsCard, type RowOpts } from "./SettingsForm";
import { Changes, IN_FLIGHT, Page, Toasts } from "./settings-ui";
import type { FiledChange, SettingChange, SettingRow, SettingsData } from "./types";
import "./settings.css";
import { Banner, Button, Disclosure, FieldRow, LinkButton, Select, StatusDot, safeHref } from "./ui";
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
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadChanges();
      void loadConns(busy);
    }, busy ? 5_000 : 30_000);
    return () => clearInterval(t);
  }, [busy, loadChanges, loadConns]);
  // A change just went live (even one that applied before its first in-flight read): the compiled config moved, so read it again.
  const applied = useRef<Set<string> | null>(null);
  useEffect(() => {
    const now = new Set(changes.filter((c) => c.stage === "applied").map((c) => c.identifier));
    if (applied.current && [...now].some((id) => !applied.current!.has(id))) void loadSettings();
    applied.current = now;
  }, [changes, loadSettings]);

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

  const current: Category = cat ?? "profile";
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
  const find = (keys: readonly string[]) => keys.map((k) => data.settings.find((s) => s.key === k)).filter((s): s is SettingRow => Boolean(s));
  const rows = (page: keyof typeof PAGE_SETTINGS) => find(PAGE_SETTINGS[page]);
  const card = (page: keyof typeof PAGE_SETTINGS, opts?: Record<string, RowOpts>) => <SettingsCard rows={rows(page)} all={data.settings} opts={opts} />;
  switch (cat) {
    case "profile":
      return (
        <Page title="Profile" sub={data.owner.name ? `This AidenHQ belongs to ${data.owner.name}. The board's own Today and Tomorrow use ${data.instance.boardTimezone}.` : `Who this AidenHQ belongs to. The board's own Today and Tomorrow use ${data.instance.boardTimezone}.`}>
          {card("profile", {
            owner_name: { sub: "Handbooks say “the owner”; one line names you." },
            owner_email: { sub: "The board account setup created: you sign in with it." },
            timezone: { sub: "Schedules, spend limits and your day reset at midnight here.", control: (v, set) => <TimezoneInput value={String(v ?? "")} set={set} /> },
            time_format: { sub: "How times read on the board and in what the agents say.", labels: { "12h": "8:00 PM", "24h": "20:00" } },
          })}
        </Page>
      );
    case "notifications":
      return <NotificationsPage rows={rows("notifications")} all={data.settings} conns={conns} />;
    case "autonomy":
      return <AutonomyPage data={data} card={card("autonomy", { autonomy: { sub: "How much of Tier 1 the AI reviewer decides.", labels: { off: "Off", tier0: "Tier 0", full: "Full" } } })} />;
    case "spend":
      return (
        <Page title="Spend" sub="The model gateway refuses a call that would take the whole install past either install limit (a day, or a calendar month: midnight in your timezone), and a task that would pass its own limit. All in USD.">
          {card("spend", {
            spend_day_usd: { sub: "Across every agent, per day.", prefix: "$" },
            spend_month_usd: { sub: "Across every agent, per calendar month.", prefix: "$" },
            task_usd: { sub: "One task and everything it delegates.", prefix: "$" },
          })}
        </Page>
      );
    case "updates":
      return <UpdatesPage data={data} />;
    case "access":
      return (
        <Page title="Board access" sub="How this board is reached from outside the server.">
          <SettingsCard
            rows={rows("access")}
            advanced={find(ADVANCED_SETTINGS.access)}
            all={data.settings}
            opts={{
              exposure: { sub: "Public, a tailnet, a Cloudflare tunnel, or this machine only.", labels: { public: "Public", tailscale: "Tailnet", cloudflare: "Cloudflare", local: "Local" } },
              computers_max: { sub: "How many agent jobs run at once, 1 to 64.", min: 1, max: 64 },
            }}
            trail={
              <div className="st-set-full">
                <Disclosure summary="Connect your Claude">
                  <p className="st-hint">Your own Claude can check status, talk to Aiden, change settings and decide approvals as you, and can help finish anything you skipped in setup.</p>
                  <Steps text={mcpSteps(location.origin)} />
                </Disclosure>
              </div>
            }
          />
        </Page>
      );
    case "backups":
      return (
        <Page title="Backups" sub="Every night the server keeps a local backup. An off-host repository keeps a copy that survives losing the machine.">
          {card("backups", { backup_repository: { sub: "A restic repository, for example a storage box. Empty means no off-host backup.", placeholder: "sftp://user@host:23/aidenhq" } })}
        </Page>
      );
  }
}

// ------------------------------------------------------------------ pages

/** A timezone: type it or pick one the browser knows. */
function TimezoneInput({ value, set }: { value: string; set: (v: string) => void }) {
  const zones = useMemo(() => { try { return Intl.supportedValuesOf("timeZone"); } catch { return []; } }, []);
  return (
    <>
      <input className="ui-input" list="st-zones" value={value} onChange={(e) => set(e.target.value)} spellCheck={false} aria-label="Timezone" placeholder="Europe/London" />
      <datalist id="st-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
    </>
  );
}

function AutonomyPage({ data, card }: { data: SettingsData; card: React.ReactNode }) {
  return (
    <Page title="Autonomy" sub="Every write (a push, merge, apply, deploy or outbound message) is an approval record. Code sets each one's tier; autonomy says how much of Tier 1 the AI reviewer decides.">
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
      {card}
    </Page>
  );
}

const TRANSPORT_NAMES: Record<string, string> = { slack: "Slack", "channel-telegram": "Telegram" };
// Which key of a channel module's health says a transport has its tokens (channel-telegram: telegram; channel-slack: slack).
const TRANSPORT_HEALTH: Record<string, string> = { slack: "slack", "channel-telegram": "telegram" };
const transportName = (id: string) => TRANSPORT_NAMES[id] ?? id.replace(/^channel-/, "").replace(/^./, (c) => c.toUpperCase());

/** The channels a message tries, in order: move one up or down, take one out, add one back. */
function OrderControl({ value, set, candidates, ready }: { value: string[]; set: (v: string[]) => void; candidates: string[]; ready: (id: string) => boolean | undefined }) {
  const move = (i: number, d: number) => { const n = [...value]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; set(n); };
  const rest = candidates.filter((c) => !value.includes(c));
  return (
    <div className="st-order">
      <ol>
        {value.map((id, i) => (
          <li key={id}>
            <span className="st-order-n">{i + 1}</span>
            <span className="st-order-name">{transportName(id)}</span>
            <StatusDot tone={ready(id) === undefined ? "idle" : ready(id) ? "ok" : "needs"}>{ready(id) === undefined ? "" : ready(id) ? "set up" : "not set up"}</StatusDot>
            <button type="button" className="st-order-btn" aria-label={`Move ${transportName(id)} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="st-order-btn" aria-label={`Move ${transportName(id)} down`} disabled={i === value.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="st-order-btn" aria-label={`Remove ${transportName(id)}`} onClick={() => set(value.filter((x) => x !== id))}>×</button>
          </li>
        ))}
      </ol>
      {rest.length > 0 && (
        <Select value="" aria-label="Add a channel" options={[["", "Add a channel…"], ...rest.map((c) => [c, transportName(c)] as const)]} onChange={(c) => c && set([...value, c])} />
      )}
    </div>
  );
}

function NotificationsPage({ rows, all, conns }: { rows: SettingRow[]; all: SettingRow[]; conns: ConnectionsData | null }) {
  // Each channel module's health says which of its channels have tokens (channel-telegram: telegram, voice; channel-slack: slack).
  const probes = (conns?.connections ?? []).filter((c) => c.name === "telegram" || c.name === "slack_live").map((c) => c.probe?.channels).filter(Boolean);
  const channels = probes.length ? (Object.assign({}, ...probes) as Record<string, boolean>) : undefined;
  const ready = (id: string) => (channels ? Boolean(channels[TRANSPORT_HEALTH[id] ?? id]) : undefined);
  const [perm, setPerm] = useState(() => (notificationsSupported() ? Notification.permission : "unsupported"));
  const transports = rows.find((r) => r.key === "notify_transports");
  const candidates = [...new Set([...[transports?.default].flat(), ...[transports?.value].flat()].filter((x): x is string => typeof x === "string"))];
  const opts: Record<string, RowOpts> = {
    notify_transports: { sub: "Tried in this order: the first one set up that delivers a message gets it.", control: (v, set) => <OrderControl value={(v as string[]) ?? []} set={set} candidates={candidates} ready={ready} /> },
    notify_fyi: { sub: "News to read later. Decisions, results and alerts always reach you.", labels: { send: "Send", mute: "Mute" } },
    summon: { sub: "Let your own chats summon an agent." },
    summon_signature: { sub: "The line every summoned agent's reply ends with; {agent} is its name.", required: true },
  };
  return (
    <Page title="Notifications" sub="Where Aiden and the agents reach you, and where you can tap approvals.">
      <SettingsCard
        rows={rows}
        all={all}
        opts={opts}
        lead={
          <FieldRow
            title="Browser alerts"
            help={perm === "denied" ? "Blocked: allow notifications for this site in the browser's settings." : "A notification when something needs you, while the board is open."}
          >
            {perm === "default" ? (
              <Button onClick={() => void askForNotifications().then(setPerm)}>Turn on</Button>
            ) : (
              <StatusDot tone={perm === "granted" ? "ok" : perm === "denied" ? "needs" : "idle"}>{perm === "granted" ? "On" : perm === "denied" ? "Blocked" : perm === "unsupported" ? "Not supported" : "Off"}</StatusDot>
            )}
          </FieldRow>
        }
      />
    </Page>
  );
}

// Release updates (docs/design/release-updates.md): the release this server follows, the one available with what changed, and
// Update now, which is the kernel's own page (an owner tap happens there, never on the board).
function UpdatesPage({ data }: { data: SettingsData }) {
  const u = data.updates;
  const when = (t: string | null) => (t ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", ...clockOpts() }) : "never");
  const a = u?.available;
  const i = data.instance;
  const auto = data.settings.find((s) => s.key === "auto_update");
  return (
    <Page title="Updates" sub={u ? `Release ${u.current?.name}, checked ${when(u.checkedAt)}.` : "This server's product is pinned by hand: a newer one is a change to instance.yaml's product: pin."}>
      {u && a && (
        <Banner action={<LinkButton variant="primary" size="sm" href={`${admin.url}/updates`}>Update now</LinkButton>}>
          AidenHQ {a.name} is available.{" "}
          {u.auto ? `It installs tonight between ${clockText(2)} and ${clockText(5)} (${u.timezone ?? "UTC"}).` : "Auto-updates are off: install it when you're ready."}
        </Banner>
      )}
      {u && a && a.notes.length > 0 && (
        <div className="st-note">
          <ul>
            {a.notes.map((n, k) => (
              <li key={k}>{n}</li>
            ))}
          </ul>
          <a href={safeHref(a.compare)} target="_blank" rel="noreferrer">
            Every change since {u.current?.name}
          </a>
        </div>
      )}
      {u?.last && (
        <p className="st-note">
          Last update: {u.last.release} {u.last.outcome === "installed" ? "installed" : `failed (${u.last.why ?? "see the apply log"}); this server went back to the release before it`}, {when(u.last.at)}.
        </p>
      )}
      <SettingsCard
        rows={auto ? [auto] : []}
        all={data.settings}
        opts={{ auto_update: { sub: "New releases install by themselves overnight; turn it off to install when you choose.", labels: { on: "On", off: "Off" } } }}
        lead={
          <FieldRow title="Version" help={u ? (u.error ? `Update check: ${u.error}` : a ? `${u.current?.name} is running; ${a.name} is available.` : `${u.current?.name} is running, the newest release.`) : "Pinned by hand."}>
            <span className="st-versions">
              {i.product ? <code title={i.product}>{i.product.slice(0, 12)}</code> : <span className="muted">unknown</span>}
              <span className="muted">last change {when(i.lastChangeAt)}</span>
            </span>
          </FieldRow>
        }
        trail={
          u ? (
            <FieldRow title="Update now" help="Install the newest release now, on the kernel's own page.">
              <LinkButton href={`${admin.url}/updates`}>Update now</LinkButton>
            </FieldRow>
          ) : undefined
        }
      />
    </Page>
  );
}
