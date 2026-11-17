import type { AgentProfile, TaskRow, FeatureCost, Features, Advisory, ActivityItem, Agents, AsideMessage, Lineage, SettledItem, AppRow, Approval, Board, Bucket, Cadence, ChatAgent, ChatDetail, LaneAgent, LaneMessage, ChatRow, CostLedger, CostTop, CostWindow, Costs, IssueView, Models, ModuleRow, NeedsYou, RecurringView, RosterAgent, RunTrace, Scorecard, SettingChange, FiledChange, SettingsData, Update } from "./types";
import type { ConnectionsData } from "./connections";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { accept: "application/json", ...(method === "GET" ? {} : { "content-type": "application/json", "x-aidenhq-board": "1" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  // Not signed in, or no authenticator yet: the app shows the right screen.
  if ((res.status === 401 && data.error === "sign in") || (res.status === 403 && data.error === "totp")) throw new SignInRequired();
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data as T;
}

/** A file's bytes as base64 (uploads are JSON, like every other write: checkRequest). */
function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error(`couldn't read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Not signed in (or the session ended), or an admin without an authenticator yet. */
export class SignInRequired extends Error {
  constructor() {
    super("sign in");
  }
}

/** One module's setup flow as GET /api/setup-flows returns it (services/board/src/setup-flows.ts). */
/** The first-run wizard (Welcome.tsx): what to show a new owner, from the board. */
export interface WelcomeState {
  finished: boolean;
  modelReady: boolean;
  recoveryKeyWaiting: boolean;
  wizard: string[];
}

export interface SetupFlowView {
  module: string;
  order: number;
  title: string;
  why: string;
  effort: string;
  wizard?: boolean;
  steps: string;
  secrets?: string[];
  signin?: string;
  pair_url?: string;
  present: Record<string, boolean>;
  signedIn: boolean;
  paired: boolean;
  done: boolean;
  dismissed: boolean;
}

export interface Session {
  mode: "lan";
  account?: { id: string; email: string; name: string; role: "admin" | "user"; owner: boolean } | null;
  /** Google's Connect works from this address (the board's https address). */
  googleConnect?: boolean;
  /** The kernel's admin listener: sign-in, your password, and the approval page every card is decided on. */
  adminUrl?: string | null;
}

export interface Account {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  owner: boolean;
  twoFactorEnabled: boolean;
  disabled: boolean;
  lockedUntil: string | null;
  createdAt: string;
}

export interface AuthSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  updatedAt: string;
  current: boolean;
}

export interface AppAdmins {
  app: string;
  host: string;
  default: string;
  admins: string[];
}

export const accountsApi = {
  sessions: () => call<{ sessions: AuthSession[] }>("GET", "/api/accounts/sessions"),
  revokeSession: (id: string) => call("POST", `/api/accounts/sessions/${id}/revoke`, {}),
  list: () => call<{ accounts: Account[]; me: string }>("GET", "/api/accounts"),
  /** Each shared app, its admins (AidenHQ admins are admins of every app) and default; name or remove an app admin. */
  appAdmins: () => call<{ apps: AppAdmins[] }>("GET", "/api/app-admins"),
  setAppAdmin: (app: string, email: string, admin: boolean) => call("POST", `/api/app-admins/${encodeURIComponent(app)}`, { email, admin }),
  invite: (email: string, name: string, role: "admin" | "user") => call<{ account: Account; url: string | null }>("POST", "/api/accounts", { email, name, role }),
  setRole: (id: string, role: "admin" | "user") => call<Account>("POST", `/api/accounts/${id}/role`, { role }),
  setDisabled: (id: string, disabled: boolean) => call<Account>("POST", `/api/accounts/${id}/${disabled ? "disable" : "enable"}`, {}),
  newLink: (id: string) => call<{ url: string | null }>("POST", `/api/accounts/${id}/link`, {}),
};

/** The kernel's admin listener (from /api/session): sign-in, and the approval page where every card is decided. */
export const admin = { url: "" };

export const api = {
  session: () => call<Session>("GET", "/api/session").then((s) => ((admin.url = s.adminUrl ?? ""), s)),
  /** The board's own session ends (the kernel's sign-in stays; sign out there too from Password). */
  signOut: () => call<{ ok: boolean }>("POST", "/api/sign-out", {}),
  board: () => call<Board>("GET", "/api/board"),
  chats: () => call<{ chats: ChatRow[]; agents: ChatAgent[] }>("GET", "/api/chats"),
  /** `peek`: a prefetch, which leaves the chat unread. */
  chat: (ref: string, peek = false) => call<ChatDetail>("GET", `/api/chats/${encodeURIComponent(ref)}${peek ? "?peek" : ""}`),
  newChat: (text: string, agent?: string) => call<{ identifier: string }>("POST", "/api/chats", { text, ...(agent ? { agent } : {}) }),
  /** The fast chat lane (LaneChat.tsx): its agents (empty without a lane), and one agent's conversation after message `after`. */
  lane: () => call<{ agents: LaneAgent[] }>("GET", "/api/lane"),
  laneMessages: (key: string, after: string) => call<{ messages: LaneMessage[]; busy: boolean }>("GET", `/api/lane/${encodeURIComponent(key)}/messages${after ? `?after=${encodeURIComponent(after)}` : ""}`),
  laneSend: (key: string, text: string) => call<{ ok: boolean }>("POST", `/api/lane/${encodeURIComponent(key)}/messages`, { text }),
  stopChat: (ref: string) => call<{ stopped: number }>("POST", `/api/chats/${encodeURIComponent(ref)}/stop`, {}),
  notRight: (ref: string, text: string) => call<IssueView>("POST", `/api/issues/${encodeURIComponent(ref)}/not-right`, { text }),
  activity: (days = 7) => call<{ days: { day: string; items: ActivityItem[] }[] }>("GET", `/api/activity?days=${days}`),
  needsYou: () => call<NeedsYou>("GET", "/api/needs-you"),
  approvals: () => call<{ approvals: Approval[] }>("GET", "/api/approvals"),
  agents: () => call<Agents>("GET", "/api/agents"),
  /** The fleet without run history: the Agents page's first paint. */
  roster: () => call<{ roster: RosterAgent[] }>("GET", "/api/agents/roster"),
  agentProfile: (key: string) => call<{ profile: AgentProfile }>("GET", `/api/agents/by-key/${encodeURIComponent(key)}`),
  agentOpenTasks: (key: string) => call<{ needs: TaskRow[]; ongoing: TaskRow[] }>("GET", `/api/agents/by-key/${encodeURIComponent(key)}/tasks?view=open`),
  agentHistory: (key: string, opts: { q?: string; status?: "done" | "cancelled"; offset?: number } = {}) => {
    const p = new URLSearchParams({ view: "history", ...(opts.q ? { q: opts.q } : {}), ...(opts.status ? { status: opts.status } : {}), ...(opts.offset ? { offset: String(opts.offset) } : {}) });
    return call<{ rows: TaskRow[]; next: number | null }>("GET", `/api/agents/by-key/${encodeURIComponent(key)}/tasks?${p}`);
  },
  scorecard: (id: string) => call<Scorecard>("GET", `/api/agents/${encodeURIComponent(id)}/scorecard`),
  setupFlows: () => call<{ flows: SetupFlowView[] }>("GET", "/api/setup-flows"),
  setupSecret: (module: string, secret: string, value: string) => call<{ ok: boolean }>("POST", `/api/setup-flows/${module}/secret`, { secret, value }),
  setupDismiss: (module: string) => call<{ ok: boolean }>("POST", `/api/setup-flows/${module}/dismiss`, {}),
  setupPair: (module: string) => call<{ code: string; link?: string }>("POST", `/api/setup-flows/${module}/pair`, {}),
  setupPaired: (module: string) => call<{ paired: boolean }>("GET", `/api/setup-flows/${module}/pair`),
  welcome: () => call<WelcomeState>("GET", "/api/welcome"),
  welcomeFinish: (done: string[], skipped: string[]) => call<{ ok: boolean; identifier?: string }>("POST", "/api/welcome/finish", { done, skipped }),
  modules: () => call<{ modules: ModuleRow[]; advisories: Advisory[] }>("GET", "/api/modules"),
  settings: () => call<SettingsData>("GET", "/api/settings"),
  connections: (fresh = false) => call<ConnectionsData>("GET", `/api/settings/connections${fresh ? "?fresh" : ""}`),
  /** Files a settings change as the Platform Engineer's task; its commit becomes an apply card. */
  changeSettings: (changes: SettingChange[]) => call<{ identifier: string }>("POST", "/api/settings/change", { changes }),
  settingsChanges: () => call<{ changes: FiledChange[] }>("GET", "/api/settings/changes"),
  apps: () => call<{ apps: AppRow[]; error?: string }>("GET", "/api/apps"),
  costs: (window: CostWindow) => call<Costs>("GET", `/api/costs?window=${window}`),
  costLedger: (q: URLSearchParams) => call<CostLedger>("GET", `/api/costs/ledger?${q}`),
  featureCost: (ref: string) => call<{ cost: FeatureCost | null }>("GET", `/api/issues/${encodeURIComponent(ref)}/feature-cost`),
  features: () => call<Features>("GET", "/api/costs/features"),
  costTop: (q: URLSearchParams) => call<CostTop>("GET", `/api/costs/top?${q}`),
  run: (id: string) => call<RunTrace>("GET", `/api/runs/${encodeURIComponent(id)}`),
  issue: (ref: string) => call<IssueView>("GET", `/api/issues/${encodeURIComponent(ref)}`),
  lineage: (ref: string) => call<Lineage>("GET", `/api/issues/${encodeURIComponent(ref)}/lineage`),
  settle: (ref: string, settled: boolean) => call<{ settled: boolean }>("POST", `/api/issues/${encodeURIComponent(ref)}/settle`, { settled }),
  settledList: (q: string) => call<{ settled: SettledItem[] }>("GET", `/api/settled?q=${encodeURIComponent(q)}`),
  /** The side chat: answered by a model, never posted on the task, never waking its agent. */
  aside: (ref: string, messages: AsideMessage[]) => call<{ answer: string }>("POST", `/api/issues/${encodeURIComponent(ref)}/aside`, { messages }),
  update: (ref: string, u: Update) => call<IssueView>("PATCH", `/api/issues/${encodeURIComponent(ref)}`, u),
  /** `brief`: the chat's send, which refetches the chat itself; the board then skips building the whole task view. */
  comment: (ref: string, body: string, answer = false, brief = false) =>
    call<IssueView>("POST", `/api/issues/${encodeURIComponent(ref)}/comments`, { body, ...(answer ? { answer: true } : {}), ...(brief ? { brief: true } : {}) }),
  attach: async (ref: string, file: File) =>
    call<IssueView>("POST", `/api/issues/${encodeURIComponent(ref)}/files`, { name: file.name, type: file.type, data: await base64(file) }),
  move: (ref: string, bucket: Bucket, position: "top" | "bottom" = "top") => call("POST", `/api/issues/${encodeURIComponent(ref)}/move`, { bucket, position }),
  order: (bucket: Bucket, ids: string[]) => call("PUT", `/api/buckets/${bucket}`, { ids }),
  carried: (action: "keep" | "tomorrow" | "later") => call<{ ok: true; count: number }>("POST", "/api/buckets/today/carried", { action }),
  create: (title: string, bucket: Bucket, description = "") => call<{ id: string; identifier: string }>("POST", "/api/issues", { title, bucket, description }),
  schedule: (ref: string, body: { date: string; bucket?: Bucket; park?: Bucket } | { clear: true }) =>
    call<{ scheduled: IssueView["scheduled"]; movedNow: boolean }>("POST", `/api/issues/${encodeURIComponent(ref)}/schedule`, body),
  recurring: (ref: string, body: { action: "set"; cadence: Cadence; time: string; repos: string[] } | { action: "pause" | "resume" | "stop" | "run_now" }) =>
    call<{ recurring: RecurringView | null }>("POST", `/api/issues/${encodeURIComponent(ref)}/recurring`, body),
  addAgent: (ref: string, agent: string, instructions: string) => call<IssueView>("POST", `/api/issues/${encodeURIComponent(ref)}/agents`, { agent, instructions }),
  merge: (ref: string, into: string) => call<{ merged: string; into: string; files: number }>("POST", `/api/issues/${encodeURIComponent(ref)}/merge`, { into }),
  handOver: (ref: string, from: string, to: string) => call<IssueView>("POST", `/api/issues/${encodeURIComponent(ref)}/handover`, { from, to }),
  models: (assignee: string) => call<Models>("GET", `/api/models/${assignee}`),
};
