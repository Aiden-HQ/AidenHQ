import type { ActivityItem, Agents, AppRow, Approval, Board, Bucket, Cadence, ChatAgent, ChatDetail, ChatRow, CostLedger, CostTop, CostWindow, Costs, IssueView, Models, ModuleRow, NeedsYou, RecurringView, RosterAgent, RunTrace, Scorecard, SettingsData, Update } from "./types";
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

export interface Session {
  mode: "local" | "lan";
  account?: { id: string; email: string; name: string; role: "admin" | "user"; owner: boolean } | null;
  /** Signed in as an admin who hasn't set up an authenticator yet. */
  needsTotp?: boolean;
  /** Google's Connect works from this address (the board's https address). */
  googleConnect?: boolean;
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

/** Better Auth's endpoints on the board (/api/auth/*): its errors come as { message }. */
async function auth<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method,
    headers: { accept: "application/json", ...(method === "GET" ? {} : { "content-type": "application/json", "x-aidenhq-board": "1" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message ?? data?.error ?? `${res.status}`);
  return data as T;
}

export interface AppAdmins {
  app: string;
  host: string;
  default: string;
  admins: string[];
}

export const accountsApi = {
  signIn: (email: string, password: string) => auth<{ twoFactorRedirect?: boolean }>("POST", "/sign-in/email", { email, password }),
  verifyTotp: (code: string) => auth("POST", "/two-factor/verify-totp", { code }),
  enableTotp: (password: string) => auth<{ totpURI: string }>("POST", "/two-factor/enable", { password }),
  setPassword: (token: string, newPassword: string) => auth("POST", "/reset-password", { token, newPassword }),
  changePassword: (currentPassword: string, newPassword: string) => auth("POST", "/change-password", { currentPassword, newPassword, revokeOtherSessions: true }),
  signOut: () => auth("POST", "/sign-out", {}),
  /** Also slides the session cookie's expiry forward (Better Auth refreshes it here). */
  refresh: () => auth("GET", "/get-session"),
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

export const api = {
  session: () => call<Session>("GET", "/api/session"),
  board: () => call<Board>("GET", "/api/board"),
  chats: () => call<{ chats: ChatRow[]; agents: ChatAgent[] }>("GET", "/api/chats"),
  chat: (ref: string) => call<ChatDetail>("GET", `/api/chats/${encodeURIComponent(ref)}`),
  newChat: (text: string, agent?: string) => call<{ identifier: string }>("POST", "/api/chats", { text, ...(agent ? { agent } : {}) }),
  stopChat: (ref: string) => call<{ stopped: number }>("POST", `/api/chats/${encodeURIComponent(ref)}/stop`, {}),
  notRight: (ref: string, text: string) => call<IssueView>("POST", `/api/issues/${encodeURIComponent(ref)}/not-right`, { text }),
  activity: (days = 7) => call<{ days: { day: string; items: ActivityItem[] }[] }>("GET", `/api/activity?days=${days}`),
  needsYou: () => call<NeedsYou>("GET", "/api/needs-you"),
  approvals: () => call<{ approvals: Approval[] }>("GET", "/api/approvals"),
  decide: (id: string, decision: "approve" | "reject") => call<Approval>("POST", `/api/approvals/${encodeURIComponent(id)}/${decision}`, {}),
  decideBatch: (items: { id: string; digest: string }[], decision: "approve" | "reject") => call<{ approvals: Approval[] }>("POST", `/api/approvals/batch/${decision}`, { items }),
  agents: () => call<Agents>("GET", "/api/agents"),
  /** The fleet without run history: the Agents page's first paint. */
  roster: () => call<{ roster: RosterAgent[] }>("GET", "/api/agents/roster"),
  scorecard: (id: string) => call<Scorecard>("GET", `/api/agents/${encodeURIComponent(id)}/scorecard`),
  modules: () => call<{ modules: ModuleRow[] }>("GET", "/api/modules"),
  settings: () => call<SettingsData>("GET", "/api/settings"),
  connections: (fresh = false) => call<ConnectionsData>("GET", `/api/settings/connections${fresh ? "?fresh" : ""}`),
  apps: () => call<{ apps: AppRow[]; error?: string }>("GET", "/api/apps"),
  costs: (window: CostWindow) => call<Costs>("GET", `/api/costs?window=${window}`),
  costLedger: (q: URLSearchParams) => call<CostLedger>("GET", `/api/costs/ledger?${q}`),
  costTop: (q: URLSearchParams) => call<CostTop>("GET", `/api/costs/top?${q}`),
  run: (id: string) => call<RunTrace>("GET", `/api/runs/${encodeURIComponent(id)}`),
  issue: (ref: string) => call<IssueView>("GET", `/api/issues/${encodeURIComponent(ref)}`),
  update: (ref: string, u: Update) => call<IssueView>("PATCH", `/api/issues/${encodeURIComponent(ref)}`, u),
  comment: (ref: string, body: string, answer = false) => call<IssueView>("POST", `/api/issues/${encodeURIComponent(ref)}/comments`, { body, ...(answer ? { answer: true } : {}) }),
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
