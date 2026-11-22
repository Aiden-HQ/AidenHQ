import type { AuthorKind, FlowSummary, IdleItem, JourneyInfo, JourneyList, JourneySort, Waterfall } from "../../src/flow";
import type { AgentProfile, TaskRow, FeatureCost, Features, Advisory, Agents, AsideMessage, Lineage, SettledItem, AppRow, Approval, Board, Bucket, Cadence, ChatAgent, ChatDetail, LaneAgent, LaneMessage, ChatRow, CostLedger, CostTop, IssueView, Models, ModuleDetail, ModuleRow, NeedsYou, RecurringView, RosterAgent, RunTrace, Scorecard, SettingChange, FiledChange, SettingsData, Update } from "./types";
import type { ConnectionsData } from "./connections";
import type { TimelineEntry } from "../../src/timeline";
import type { Explanation } from "../../src/explain";
import type { Catalog, CodeReview, Combo, EngineCatalog, FindingRow, Gate, ReposView, Review, ReviewInsights, Run, TreeBatch, TreeRequest } from "../../src/reviews";
import type { BrowseModule, GrantConnection, MarketplaceRow } from "./types";

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
  if (!res.ok) throw new HttpStatusError(res.status, data.error ?? `${res.status}`);
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

/** The Reviews page's first read: whether the module is on, GitHub signed in, and settings.code_review as compiled. */
export interface ReviewsSetup {
  module: boolean;
  github: { configured: boolean; connected: boolean; state: string | null };
  config: CodeReview | null;
  problems: string[];
}

/** Not signed in (or the session ended), or an admin without an authenticator yet. */
export class SignInRequired extends Error {
  constructor() {
    super("sign in");
  }
}

/** A refused request, with its HTTP status: a page can tell a 409 (the service is still restarting) from a failure. */
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A sign-in's Connect dialog (Connect.tsx) as GET /api/sign-ins/<id> returns it: `scopes` only when the vendor offers a choice. */
export interface SignInView {
  id: string;
  label: string;
  connect: string;
  /** Its per-install values are in place (asked afresh: the dialog waits on it after a save). */
  configured: boolean;
  /** It needs the owner's values (its address, or a token that isn't working yet): `fields` are what to ask. */
  asks: boolean;
  /** Why it stopped working, when the service said. */
  detail?: string;
  fields: { secret: string; label: string; pattern: string; help?: string }[];
  scopes: { supported: string[]; recommended: string[]; granted?: string[] } | null;
  state: string;
  /** The loopback address the sign-in ends on, whose full address (with its code) the owner pastes back; null: one click only. */
  redirect: string | null;
  /** The board's https name a one-click sign-in returns to (a company may have to allow it first); null: none. */
  oneClick: string | null;
  /** redirect: the vendor sends the browser back; device: a code typed on the vendor's page (DeviceSignIn in Connect.tsx). */
  mode?: "redirect" | "device";
  /** What stops this sign-in before it starts, in words. */
  preflight?: string | null;
}

/** A device sign-in's code, for the person to type on the vendor's page; the board then follows it. */
export interface DeviceCode { user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval: number }
export interface DeviceProgress { state: "idle" | "pending" | "ok" | "expired" | "denied" | "cancelled" | "failed"; detail?: string }

/** Organisations that run internal apps (GET /api/organisations): the connections each fills, and the one the email suggests. */
export interface Organisations {
  organisations: { id: string; name: string; domains: string[]; connections: string[] }[];
  suggested: string | null;
  chosen: string | null;
}

/** A module's advanced flow: the person's own app, for what the basic sign-in can't do. */
export interface AdvancedFlowView {
  title: string;
  why: string;
  effort: string;
  admin?: string;
  steps: string;
  capabilities: string[];
  secrets?: string[];
  fields?: { secret: string; label: string; pattern: string; help?: string }[];
  console_url?: string;
  pair_url?: string;
  done: boolean;
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
  fields?: { secret: string; label: string; pattern: string; help?: string }[];
  signin?: string;
  connect_url?: string;
  pair_url?: string;
  console_url?: string;
  /** The exact redirect its sign-in sends (the steps' {redirect_url}): what a hand-made client must list. */
  redirect_url?: string;
  present: Record<string, boolean>;
  signedIn: boolean;
  /** Signed in, and its Reconnect may pick what to grant. */
  scopes?: boolean;
  paired: boolean;
  /** A saved secret's services are being recreated: the Pair step waits rather than treating the module's 409 as an error. */
  restarting?: boolean;
  /** How much of that restart is left (ms): the page counts it down on its own clock, which need not match the board's. */
  restarting_for?: number;
  done: boolean;
  dismissed: boolean;
  /** A module with modes (board.setup_flows `choose`): what is live, what the owner picked, and the options. */
  choose?: SetupChoice;
  /** Who else may need to approve. */
  admin?: string;
  /** Its sign-in is a device code (Connect opens the code dialog). */
  signin_mode?: "device";
  advanced?: AdvancedFlowView;
}

export interface SetupChoice {
  setting: string;
  value: string | null;
  chosen: string | null;
  options: { value: string; label: string; detail: string; unavailable?: string; inputs?: { setting: string; label: string; help?: string; pattern: string; value: string }[] }[];
}

export interface Session {
  mode: "lan";
  account?: { id: string; email: string; name: string; role: "admin" | "user"; owner: boolean } | null;
  /** Google's Connect works from this address (the board's https address). */
  googleConnect?: boolean;
  /** The modules' sign-ins (board.signins) work from this address: the board's https address, or loopback. */
  signInConnect?: boolean;
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

export interface McpClient {
  id: string;
  client: string;
  lastUsed: string | null;
}

export const accountsApi = {
  /** The Claude apps (MCP clients) this admin has signed in, and ending one. */
  mcpClients: () => call<{ grants: McpClient[] }>("GET", "/api/accounts/mcp-clients"),
  revokeMcpClient: (id: string) => call("POST", `/api/accounts/mcp-clients/${id}/revoke`, {}),
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
  notRight: (ref: string, text: string) => call<IssueView>("POST", `/api/issues/${encodeURIComponent(ref)}/not-right`, { text }),
  needsYou: () => call<NeedsYou>("GET", "/api/needs-you"),
  approvals: () => call<{ approvals: Approval[] }>("GET", "/api/approvals"),
  agents: () => call<Agents>("GET", "/api/agents"),
  /** The fleet without run history: the Agents page's first paint. */
  roster: () => call<{ roster: RosterAgent[] }>("GET", "/api/agents/roster"),
  agentProfile: (key: string) => call<{ profile: AgentProfile }>("GET", `/api/agents/by-key/${encodeURIComponent(key)}`),
  /** Lane B: pause or resume an agent now; `stop` also cancels its live runs. */
  pauseAgent: (key: string, body: { paused: boolean; stop?: boolean }) => call<{ status: string }>("POST", `/api/agents/by-key/${encodeURIComponent(key)}/pause`, body),
  agentOpenTasks: (key: string) => call<{ needs: TaskRow[]; ongoing: TaskRow[] }>("GET", `/api/agents/by-key/${encodeURIComponent(key)}/tasks?view=open`),
  agentHistory: (key: string, opts: { q?: string; status?: "done" | "cancelled"; offset?: number } = {}) => {
    const p = new URLSearchParams({ view: "history", ...(opts.q ? { q: opts.q } : {}), ...(opts.status ? { status: opts.status } : {}), ...(opts.offset ? { offset: String(opts.offset) } : {}) });
    return call<{ rows: TaskRow[]; next: number | null }>("GET", `/api/agents/by-key/${encodeURIComponent(key)}/tasks?${p}`);
  },
  agentTimeline: (key: string) => call<{ entries: TimelineEntry[] }>("GET", `/api/agents/by-key/${encodeURIComponent(key)}/timeline`),
  explain: (id: string) => call<{ explanation: Explanation }>("GET", `/api/approvals/${encodeURIComponent(id)}/explain`),
  scorecard: (id: string) => call<Scorecard>("GET", `/api/agents/${encodeURIComponent(id)}/scorecard`),
  signIn: (id: string) => call<SignInView>("GET", `/api/sign-ins/${encodeURIComponent(id)}`),
  signInDismiss: (id: string, key: string) => call<{ ok: boolean }>("POST", `/api/sign-ins/${encodeURIComponent(id)}/dismiss`, { key }),
  signInFinish: (id: string, url: string) => call<{ ok: boolean }>("POST", `/api/sign-ins/${encodeURIComponent(id)}/finish`, { url }),
  deviceStart: (id: string) => call<DeviceCode>("POST", `/api/sign-ins/${encodeURIComponent(id)}/device`, {}),
  deviceProgress: (id: string) => call<DeviceProgress>("GET", `/api/sign-ins/${encodeURIComponent(id)}/device`),
  deviceCancel: (id: string) => call<{ ok: boolean }>("POST", `/api/sign-ins/${encodeURIComponent(id)}/device/cancel`, {}),
  googleFinish: (url: string) => call<{ ok: boolean }>("POST", "/api/google/finish", { url }),
  organisations: () => call<Organisations>("GET", "/api/organisations"),
  organisationApply: (id: string) => call<{ ok: boolean; results: { module: string; secret: string; ok: boolean; error?: string }[] }>("POST", `/api/organisations/${encodeURIComponent(id)}/apply`, {}),
  signInSecret: (id: string, secret: string, value: string) => call<{ ok: boolean }>("POST", `/api/sign-ins/${encodeURIComponent(id)}/secret`, { secret, value }),
  setupFlows: () => call<{ flows: SetupFlowView[]; board_url: string }>("GET", "/api/setup-flows"),
  setupSecret: (module: string, secret: string, value: string) => call<{ ok: boolean; restarted?: string[]; restarting_for?: number }>("POST", `/api/setup-flows/${encodeURIComponent(module)}/secret`, { secret, value }),
  setupChoose: (module: string, value: string, inputs: Record<string, string>) => call<{ ok: boolean; identifier?: string }>("POST", `/api/setup-flows/${encodeURIComponent(module)}/choose`, { value, inputs }),
  setupDismiss: (module: string) => call<{ ok: boolean }>("POST", `/api/setup-flows/${encodeURIComponent(module)}/dismiss`, {}),
  setupPair: (module: string) => call<{ code: string; link?: string; minted_at: number; expires_in?: number }>("POST", `/api/setup-flows/${encodeURIComponent(module)}/pair`, {}),
  setupPaired: (module: string) => call<{ paired: boolean; paired_at?: string | number }>("GET", `/api/setup-flows/${encodeURIComponent(module)}/pair`),
  welcome: () => call<WelcomeState>("GET", "/api/welcome"),
  welcomeFinish: (done: string[], skipped: string[]) => call<{ ok: boolean; identifier?: string }>("POST", "/api/welcome/finish", { done, skipped }),
  modules: () => call<{ modules: ModuleRow[]; advisories: Advisory[] }>("GET", "/api/modules"),
  module: (name: string) => call<ModuleDetail>("GET", `/api/modules/${encodeURIComponent(name)}`),
  /** Installed modules whose setup flow isn't done (docs/design/guided-setup.md); a 404 means no flows. */
  settings: () => call<SettingsData>("GET", "/api/settings"),
  /** The Reviews page (Reviews.tsx): the code-review module's setup, runs, repos and the owner's settings change. */
  reviewsSetup: () => call<ReviewsSetup>("GET", "/api/reviews/setup"),
  reviews: (q: { repo?: string; status?: string; limit?: number } = {}) => call<{ runs: Run[]; batches?: TreeBatch[] }>("GET", `/api/reviews?${new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]])))}`),
  review: (id: string) => call<{ run: Run; review: Review | null; findings: FindingRow[]; gate: Gate | null }>("GET", `/api/reviews/run/${encodeURIComponent(id)}`),
  dismissFinding: (b: { repo: string; number: number; id: string; reason: string }) => call<{ dismissed: string }>("POST", "/api/reviews/dismiss", b),
  reviewRepos: () => call<ReposView>("GET", "/api/reviews/repos"),
  reviewEngines: () => call<{ engines: EngineCatalog }>("GET", "/api/reviews/engines"),
  reviewAvailable: (q: string) => call<{ repos: { repo: string; private: boolean; pushed_at?: string }[] }>("GET", `/api/reviews/available?q=${encodeURIComponent(q)}`),
  reviewInsights: (days: number) => call<ReviewInsights>("GET", `/api/reviews/insights?days=${days}`),
  reviewRun: (body: { pr_url: string; combos?: Combo[]; focus?: string; full?: boolean }) => call<{ runs: Run[] }>("POST", "/api/reviews", body),
  reviewCatalog: (repo: string, commit?: string) => call<Catalog>("GET", `/api/reviews/catalog?${new URLSearchParams({ repo, ...(commit ? { commit } : {}) })}`),
  reviewTreeRun: (body: TreeRequest) => call<{ batch: string }>("POST", "/api/reviews", body),
  reviewReport: (batch: string) => call<{ markdown: string }>("GET", `/api/reviews/report/${encodeURIComponent(batch)}`),
  /** settings.code_review, and/or a GitHub org reviews may post in as the owner, as one settings change. */
  reviewConfig: (body: { value: CodeReview }) => call<{ identifier: string }>("POST", "/api/reviews/config", body),
  connections: (fresh = false) => call<ConnectionsData>("GET", `/api/settings/connections${fresh ? "?fresh" : ""}`),
  /** Files a settings change as the Engineer's task; its commit becomes an apply card. */
  testGoogle: () => call<{ ok: true } | { ok: false; message: string; fix?: string }>("POST", "/api/google/check"),
  testSignIn: (id: string) => call<{ ok: true } | { ok: false; message: string; fix?: string }>("POST", `/api/sign-ins/${encodeURIComponent(id)}/check`),
  changeSettings: (changes: SettingChange[]) => call<{ identifier: string }>("POST", "/api/settings/change", { changes }),
  settingsChanges: () => call<{ changes: FiledChange[] }>("GET", "/api/settings/changes"),
  apps: () => call<{ apps: AppRow[]; error?: string; node?: { up: boolean; login_url?: string } }>("GET", "/api/apps"),
  costLedger: (q: URLSearchParams) => call<CostLedger>("GET", `/api/costs/ledger?${q}`),
  featureCost: (ref: string) => call<{ cost: FeatureCost | null }>("GET", `/api/issues/${encodeURIComponent(ref)}/feature-cost`),
  features: () => call<Features>("GET", "/api/costs/features"),
  flow: (days: number, scope: string, journey: string) => call<{ summary: FlowSummary | null; idle: IdleItem[] }>("GET", `/api/flow?days=${days}&scope=${encodeURIComponent(scope)}${journey ? `&journey=${encodeURIComponent(journey)}` : ""}`),
  flowItem: (id: string) => call<Waterfall>("GET", `/api/flow/item?id=${encodeURIComponent(id)}`),
  flowJourneys: () => call<{ journeys: JourneyInfo[] }>("GET", "/api/flow/journeys"),
  flowJourney: (name: string, days: number, author: AuthorKind[], sort: JourneySort) =>
    call<JourneyList | null>("GET", `/api/flow/journey?name=${encodeURIComponent(name)}&days=${days}&author=${author.join(",")}&sort=${sort}`),
  costTop: (q: URLSearchParams) => call<CostTop>("GET", `/api/costs/top?${q}`),
  run: (id: string) => call<RunTrace>("GET", `/api/runs/${encodeURIComponent(id)}`),
  issue: (ref: string) => call<IssueView>("GET", `/api/issues/${encodeURIComponent(ref)}`),
  lineage: (ref: string) => call<Lineage>("GET", `/api/issues/${encodeURIComponent(ref)}/lineage`),
  /** The owner's Stop: the kernel ends the task's running job; the task stays open. */
  stop: (ref: string) => call<{ stopped: number }>("POST", `/api/issues/${encodeURIComponent(ref)}/stop`, {}),
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
  models: (assignee: string) => call<Models>("GET", `/api/models/${encodeURIComponent(assignee)}`),
  // Lane C: the agent page's Handbook tab.
  handbook: (key: string) => call<import("./AgentHandbook").HandbookData>("GET", `/api/agents/by-key/${encodeURIComponent(key)}/handbook`),
  memory: (key: string) => call<import("./AgentHandbook").MemoryData>("GET", `/api/agents/by-key/${encodeURIComponent(key)}/memory`),
  handbookHistory: (key: string) => call<import("./AgentHandbook").HandbookHistory>("GET", `/api/agents/by-key/${encodeURIComponent(key)}/handbook/history`),
  // Lane E: Browse, marketplaces, an agent's grants, and the setup flows other work adds (a 404 means none).
  browse: (q: string, kind: string) => call<{ modules: BrowseModule[] }>("GET", `/api/modules/browse?${new URLSearchParams({ q, kind })}`),
  resolveMarketplace: (repo: string) => call<{ sha: string; date: string }>("POST", "/api/marketplaces/resolve", { repo }),
  marketplaces: () => call<{ marketplaces: MarketplaceRow[] }>("GET", "/api/marketplaces"),
  agentGrants: (key: string) => call<{ connections: GrantConnection[] }>("GET", `/api/agents/by-key/${encodeURIComponent(key)}/grants`),
};
