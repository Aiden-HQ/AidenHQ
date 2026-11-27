// Settings > Connections: what the board's /api/settings/connections rows mean for the owner (status, why, what to do).
// Pure, so it is tested without a browser (test/connections-status.test.ts).
import { clockOpts } from "./util";

export interface Probe {
  ok: boolean;
  status?: number;
  state?: string;
  detail?: string;
  channels?: Record<string, boolean>;
  checkedAt: string;
  lastOkAt?: string;
}
/** One row a module's sign-in reports about itself (GitHub: what works, what an org blocks, the rate limit); rendered as given. */
export interface SignInLine {
  label: string;
  value: string;
  /** An ISO instant shown after `value` in the viewer's local time (GitHub: when the rate limit resets). */
  time?: string;
  state: "ok" | "warn" | "error";
  /** A suggestion's words, shown under the row; with its action, gone once dismissed (`dismiss`, the key the board keeps). */
  hint?: string;
  dismiss?: string;
  /**
   * The one fix: a link (the vendor's https page, or a board path `#/...`), a page on the kernel's admin listener (`admin`,
   * a path), or Reconnect (the sign-in's Connect).
   */
  action?: { label: string; href?: string; admin?: string; reconnect?: true };
}
export interface SignIn {
  state: string;
  /** The signed-in account, when the sign-in knows it. */
  login?: string;
  lines?: SignInLine[];
  configured: boolean;
  since: string;
  detail?: string;
  /** Connect offers a choice of scopes: the picker comes first, and a Reconnect reads "Change access". */
  offer?: boolean;
  /** A device sign-in (a code typed on the vendor's page): Connect opens its dialog, never a tab. */
  mode?: "device";
  /** Not set up yet: the per-install values Connect asks for first. */
  fields?: { secret: string; label: string; pattern: string; help?: string }[];
}
export interface GoogleState {
  accounts: { email: string; primary: boolean; state: string; since: string; detail?: string; missing?: string[] }[];
  error?: string;
  /** Whether a Google app (OAuth client) is set up; false sends the owner to its setup. */
  client?: boolean;
}
export interface ConnectionRow {
  name: string;
  module: string;
  kind: "connection" | "service";
  transport: string;
  tools: { read: number; write: number };
  grants: { agent: string; name: string; access: "read" | "write"; tools: number }[];
  setup: string | null;
  probe: Probe | null;
  signIn: SignIn | null;
  google?: GoogleState | null;
}
export interface SourceRow {
  name: string;
  lastOk: string | null;
  failing: boolean;
  stale: boolean;
}
export interface ConnectionsData {
  compiled: boolean;
  connections: ConnectionRow[];
  sources: SourceRow[];
  sourcesError: boolean;
}

export type Status = "connected" | "not_connected" | "not_configured" | "signed_out" | "error" | "unknown" | "builtin";
export const STATUS_LABEL: Record<Status, string> = { connected: "Connected", not_connected: "Not connected yet", not_configured: "Not connected", signed_out: "Signed out", error: "Error", unknown: "Unknown", builtin: "Built in" };

export interface Verdict {
  status: Status;
  reason: string;
  /** A button the board can act on: Connect / Reconnect (a sign-in the board starts). */
  action?: { label: string; href: string };
  /** Why the button isn't offered here (sign-ins return to the host's loopback address). */
  hint?: string;
}

/** What a built-in connection is for, in the owner's words (it runs inside each agent run: nothing to check). */
const BUILT_IN: Record<string, string> = { paperclip_tasks: "How agents read and update their tasks, delegate, and ask for approvals." };

const NAMES: Record<string, string> = { google_workspace: "Google", ops_mcp: "Meetings and notes", telegram: "Telegram", slack_live: "Slack: Aiden's bot", chat_lane: "Fast chat lane", paperclip_tasks: "Tasks bridge", apps: "Apps and warehouse", glean: "Glean", jira: "Jira", primer: "Primer", slack: "Slack: read as you", github: "GitHub", grafana: "Grafana", clickhouse: "ClickHouse" };
export const displayName = (name: string) => NAMES[name] ?? name.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

// `slack` is the owner's own user sign-in (the setup flow's "Read Slack as you"), not Aiden's bot channel (`slack_live`).
// A bare "Not connected yet" made a working bot's DMs read as Slack itself being broken. The tile clamps its reason to two
// lines (ui.css .ui-tile-desc), so the bot distinction comes first and the generic lead is left to the status label.
const NOT_CONNECTED: Record<string, string> = {
  slack: "Aiden's bot is a separate connection, so its DMs to you don't depend on this sign-in; this one lets agents read Slack as you.",
};
const notConnectedReason = (name: string, reason: string) =>
  NOT_CONNECTED[name] ? [NOT_CONNECTED[name], reason === "Not connected yet." ? null : reason].filter(Boolean).join(" ") : reason;

const day = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", ...clockOpts() });

/**
 * One row's status. `canConnect`: this browser can start that sign-in (at the board's https address, or on the host's
 * loopback address; the board says which, per sign-in kind).
 */
export function connectionStatus(row: ConnectionRow, canConnect: { signIn: boolean }): Verdict {
  const connect = (label: string, href: string, can = true): Pick<Verdict, "action"> => (can ? { action: { label, href } } : {});

  // Google: each account's own sign-in comes first; the service's health after.
  if (row.google) {
    const g = row.google;
    // No Google app yet (one per Workspace): setting one up comes first; Connect would fail without a client.
    if (!g.accounts.length && g.client === false) return { status: "not_configured", reason: "Google needs an app first: one per Workspace." };
    if (!g.accounts.length) return { status: "signed_out", reason: g.error ? `No Google account connected (${g.error}).` : "No Google account connected.", ...connect("Connect Google", "/google/connect") };
    const expired = g.accounts.filter((a) => a.state === "expired" || a.state === "error");
    if (expired.length) return { status: "signed_out", reason: `${expired.map((a) => a.email).join(", ")} stopped working (since ${day(expired[0]!.since)}).`, ...connect("Reconnect", `/google/connect?account=${encodeURIComponent(expired[0]!.email)}`) };
    // Connected before Google writes: reads work; one reconnect grants calendar changes and Gmail drafts, sends and labels.
    const short = g.accounts.filter((a) => a.missing?.length);
    if (short.length) return { status: "signed_out", reason: `${short.map((a) => a.email).join(", ")} needs new access: reconnect once so agents can change your calendar and send email (each change reviewed first).`, ...connect("Reconnect", `/google/connect?account=${encodeURIComponent(short[0]!.email)}`) };
  }

  // A sign-in through an MCP proxy (Glean, Jira, Grafana, ClickHouse): its Connect asks for any per-install value first (its
  // `fields`); one without fields that isn't set up has a setup flow to make its client first. State "none": this connection
  // signs in to nothing (Grafana with grafana_source: local), so only its health counts.
  const s = row.signIn;
  if (s && !s.configured) return s.fields?.length ? { status: "not_connected", reason: notConnectedReason(row.name, "Not connected yet."), ...connect("Connect", `/${row.name}/connect`, canConnect.signIn) } : { status: "not_configured", reason: notConnectedReason(row.name, s.detail ?? "Not set up yet.") };
  if (s?.state === "missing") return { status: "not_connected", reason: notConnectedReason(row.name, "Not connected yet."), ...connect("Connect", `/${row.name}/connect`, canConnect.signIn) };
  if (s?.state === "expired") return { status: "signed_out", reason: `Sign-in stopped working (since ${day(s.since)})${s.detail ? `: ${s.detail}` : "."}`, ...connect("Reconnect", `/${row.name}/connect`, canConnect.signIn) };

  const p = row.probe;
  if (!p) {
    if (row.kind === "service") return s?.state === "ok" || s?.state === "none" ? { status: "connected", reason: s.state === "ok" ? "Signed in." : "Needs no sign-in." } : { status: "unknown", reason: s ? "Its sign-in hasn't been checked yet." : "The board can't ask this service." };
    return row.transport === "built in" ? { status: "builtin", reason: BUILT_IN[row.name] ?? "Part of every agent run." } : { status: "unknown", reason: "Not checked yet." };
  }
  if (p.ok) return { status: "connected", reason: p.detail ? `Answering; it notes: ${p.detail}` : "Answering its health check." };
  const detail = p.detail ?? (p.status ? `health check answered HTTP ${p.status}` : "health check failed");
  if (/not set|not configured|no token|missing/i.test(detail) && !/sign/i.test(detail)) return { status: "not_configured", reason: detail };
  if (p.state === "missing" || p.state === "expired" || /sign.?in|unauthori[sz]ed|expired|401/i.test(detail)) return { status: "signed_out", reason: detail };
  return { status: "error", reason: detail.replace(/^unreachable: /, "Unreachable: ") };
}

export function sourceStatus(s: SourceRow): Verdict {
  const last = s.lastOk ? `last good pass ${day(s.lastOk)}` : "no good pass yet";
  if (s.stale) return { status: "error", reason: `${s.failing ? "Its latest pass failed; " : "Behind: "}${last}.` };
  if (s.failing) return { status: "connected", reason: `Its latest pass failed, but it is recent: ${last}.` };
  return { status: "connected", reason: `Up to date: ${last}.` };
}

/** Whether anything on the Connections page needs the owner (the gear's dot). */
export const needsAttention = (d: ConnectionsData, can: { signIn: boolean }) =>
  d.connections.some((r) => ["signed_out", "error"].includes(connectionStatus(r, can).status)) || d.sources.some((s) => sourceStatus(s).status === "error");
