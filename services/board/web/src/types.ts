export type Bucket = "triage" | "today" | "tomorrow" | "later" | "backlog";
export const BUCKETS: Bucket[] = ["triage", "today", "tomorrow", "later", "backlog"];
export const BUCKET_NAMES: Record<Bucket, string> = { triage: "Triage", today: "Today", tomorrow: "Tomorrow", later: "Later", backlog: "Backlog" };

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Assignee {
  key: string;
  kind: "me" | "assistant" | "engineer" | "agent";
  name: string;
  engine?: "codex" | "codex-openrouter" | "claude" | "openrouter";
  defaultModel?: string;
  efforts?: string[];
  /** The crew member's name, voice and portrait. */
  persona?: Persona;
  /** A portrait without a persona: /crew/<avatar>.svg. */
  avatar?: string;
}

export interface Persona {
  name: string;
  voice: string;
  avatar: string;
}

export interface Card {
  id: string;
  identifier: string;
  /** The admin (not the owner) who created it. */
  by?: string;
  title: string;
  status: string;
  priority: string;
  labels: { name: string; color: string }[];
  assignee: string | null;
  executor?: { model?: string; effort?: string };
  unread: boolean;
  createdAt: string;
  activityAt: string;
  scheduled?: { date: string; bucket: Bucket };
  recurring?: { summary: string; nextRun: string | null; paused: boolean };
  /** In Today: workdays carried over unfinished. */
  carried?: number;
  /** An agent is working on it now, or the runner has it queued. */
  working?: Working;
  /** The agents on the task. */
  crew?: CrewMember[];
}

export type CrewState = "needs" | "failed" | "proposed" | "working" | "queued" | "done";

export interface CrewMember {
  agent: string;
  state: CrewState;
  issues: { id: string; identifier: string; title: string; state: CrewState }[];
  finished?: number;
  since?: string | null;
}

export interface PlanItem {
  text: string;
  state: "todo" | "doing" | "done";
}

export interface Working {
  agent: string;
  since: string | null;
  queued: boolean;
  /** What the agent last said while working, and its own task list (runner jobs). */
  said?: string;
  saidAt?: string;
  plan?: PlanItem[];
  /** What a Codex agent has done so far, oldest first (from its session log). */
  steps?: { at: string; kind: "tool" | "thought" | "message"; text: string }[];
}

export interface TaskRef {
  identifier: string;
  title?: string;
}

export interface Session {
  id: string;
  agent: string;
  agentId: string | null;
  state: "working" | "queued";
  startedAt: string | null;
  doing?: string;
  tool?: string;
  said?: string;
  saidAt?: string;
  plan?: PlanItem[];
  quiet?: boolean;
  run: TaskRef | null;
  tasks: TaskRef[];
}

export interface Finished {
  id: string;
  agent: string;
  agentId: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  detail?: string;
  run: TaskRef | null;
  tasks: TaskRef[];
}

export interface Agents {
  sessions: Session[];
  finished: Finished[];
  runner: { reportedAt: string | null; stale: boolean };
  roster?: RosterAgent[];
}

/** GET /api/agents/:id/scorecard (fleet-stats.ts). */
export interface Scorecard {
  done: { count: number; prior: number; tasks: { identifier: string; title: string }[] };
  reopen: { graded: number; reopened: number; escalated: number };
  approvals: { filed: number; rejected: number; priorRejected: number };
  runsFailed: number;
  cost: { usd: number; prior: number; perDone: number | null; billed: boolean };
  daily: { day: string; done: number; costUsd: number }[];
}

export interface RosterAgent {
  id: string;
  name: string;
  title: string | null;
  system: boolean;
  department: { id: string; name: string; description?: string; order: number };
  key?: string;
  avatar?: string;
  model: string | null;
  status: string;
  trial: boolean;
  schedules: { title: string; paused: boolean; nextRunAt: string | null }[];
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type Cadence =
  | { kind: "weekly"; weekday: Weekday; interval: number }
  | { kind: "monthly_day"; day: number | "last"; interval: number }
  | { kind: "monthly_weekday"; nth: number | "last"; weekday: Weekday; interval: number };

export interface RecurringView {
  summary: string;
  cadence: Cadence;
  time: string;
  repos: string[];
  paused: boolean;
  nextRun: string | null;
  upcoming: string[];
  runNowPending: boolean;
}

export interface Board {
  buckets: Record<Bucket, Card[]>;
  brief: { id: string; identifier: string; title: string; description: string } | null;
  done: Card[];
  recurring: Card[];
  assignees: Assignee[];
  labels: Label[];
  prefix: string;
  timezone: string;
  /** Slack host → the ID its slack:// links need. */
  slackTeams: Record<string, string>;
  /** The next workday, when Tomorrow rolls into Today. */
  rollsOn: string;
  rollsTomorrow: boolean;
  /** Agent sessions running now. */
  agentsActive: number;
  /** Google sign-in per account; null when the board can't ask. */
  google: { accounts: GoogleAccount[]; error?: string } | null;
  /** Glean sign-in; null when the board can't ask. */
  glean: SignInStatus | null;
  /** Grafana sign-in, for the Engineers; null when the board can't ask. */
  grafana: SignInStatus | null;
  /** ClickHouse sign-in, for the Engineers; null when the board can't ask. */
  clickhouse: SignInStatus | null;
  /** Jira sign-in; null when the jira module is off or the board can't ask. */
  jira: SignInStatus | null;
}

/** A sign-in through an MCP proxy (Glean, Grafana, ClickHouse, Jira). */
export interface SignInStatus {
  /** "none": the connection signs in to nothing (e.g. Grafana with grafana_source: local). */
  state: "missing" | "ok" | "expired" | "unknown" | "none";
  /** Whether the service is set up (GLEAN_MCP_URL, GRAFANA_URL, CLICKHOUSE_MCP_URL): without it there's no banner. */
  configured: boolean;
  since: string;
  detail?: string;
}

export interface GoogleAccount {
  email: string;
  primary: boolean;
  state: "unknown" | "ok" | "expired" | "error";
  since: string;
  detail?: string;
}

export interface CommentView {
  id: string;
  body: string;
  author: { kind: "me" | "runner" | "agent" | "user"; name: string };
  /** The admin (not the owner) who wrote it. */
  by?: string;
  createdAt: string;
}

export interface IssueView extends Omit<Card, "scheduled" | "recurring" | "working" | "crew"> {
  working: Working | null;
  description: string;
  bucket: Bucket | null;
  editable: boolean;
  /** Settled out of the active lists (finished work the owner put away). */
  settled?: boolean;
  labelIds: string[];
  replyTarget: string;
  scheduled: { date: string; bucket: Bucket; position: "top" | "bottom" } | null;
  recurring: RecurringView | null;
  comments: CommentView[];
  files: FileView[];
  parent: TaskRef | null;
  /** The newest runs on this task, linked to their run pages. */
  runs: RunLink[];
  /** The agents on this task, with each one's latest word. */
  crew: (CrewMember & { said: { text: string; at: string } | null })[];
  /** After a reply: the agent's part a message that @-mentioned them went to, instead of this chat. */
  movedTo?: string;
}

/** An approval card: the exact request, written by the board; the outcome lands on the same card. */
export interface Approval {
  id: string;
  identifier: string;
  action: string;
  target: string;
  digest: string;
  sentence: string;
  reads: string;
  changes: string;
  cost: string;
  details: string;
  requestedBy: string;
  /** auto: a Tier 0 run, already made; an audit row only. */
  state: "pending" | "approved" | "rejected" | "stale" | "expired" | "used" | "unknown" | "auto";
  /** 0 ran at once, 1 the AI reviewer decides, 2 the owner decides. */
  tier: 0 | 1 | 2;
  reason: string;
  /** The tier on the request's merits, before the autonomy setting (display only; null on older records). */
  baseTier?: 0 | 1 | 2 | null;
  /** The filing agent's Paperclip id (display only). */
  requesterId?: string | null;
  /** The AI reviewer's note (its verdict's reason, or why it sent the card to the owner). */
  review: string | null;
  /** The tier rule's reason code (null on older records). */
  reasonCode?: string | null;
  /** The reviewer's reason code (reviewer_unsure on a rejection: two reviewers couldn't tell, so it went back to the agent). */
  reviewCode?: string | null;
  /** Stamped by the board from the credential: account:<id> (an admin's tap, or the owner's typed reply on the board), owner:telegram, owner:reply (a typed reply in Telegram), watcher, reviewer:<model>, auto:<rule>. */
  decidedBy: string | null;
  /** The deciding admin's name, when it wasn't the owner. */
  decidedByName?: string;
  outcome: "applied" | "failed" | null;
  outcomeText: string | null;
  createdAt: string;
  replaced: boolean;
}

/** A file on a task. */
export interface FileView {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  by: "me" | "agent";
  /** Set on a PDF's text version, which isn't listed separately. */
  textOf: string | null;
}

export interface Models {
  default: string | null;
  models: string[];
  efforts: string[];
}

export interface Update {
  title?: string;
  description?: string;
  status?: "todo" | "in_progress" | "done" | "cancelled";
  priority?: "critical" | "high" | "medium" | "low";
  assignee?: string;
  model?: string;
  effort?: string;
  labelIds?: string[];
}

/** One module from the compiled catalog, with how it is on (src/modules.ts). */
/** A marketplace advisory open against an installed module (the kernel's loader/advisories.ts); `summary` is fenced text. */
export interface Advisory {
  id: string;
  module: string;
  severity: "low" | "medium" | "high" | "critical";
  fixed: string;
  summary: string;
  url: string;
}

export interface ModuleRow {
  name: string;
  description: string;
  agents: string[];
  requires: string[];
  /** Where it comes from and its computed tier: declared, conformant or official (never claimed by the module). */
  marketplace: string;
  tier: string;
  state: "core" | "on" | "dependency" | "off";
}

/** The Costs tab (src/costs.ts). */
export type CostWindow = "today" | "yesterday" | "7d" | "30d";
export interface CostModel {
  model: string;
  input: number;
  cached: number;
  output: number;
  usd: number | null;
  reported: boolean;
}
export interface CostRow {
  name: string;
  kind: "agent" | "system";
  runs: number;
  input: number;
  cached: number;
  output: number;
  usd: number | null;
  partial: boolean;
  reported: boolean;
  models: CostModel[];
}
export interface Costs {
  window: CostWindow;
  from: string;
  to: string;
  pricesAvailable: boolean;
  rows: CostRow[];
  /** usd: billed plus estimated; billed: the part OpenRouter's own cost figures cover. */
  total: { runs: number; input: number; cached: number; output: number; usd: number; billed: number };
  /** Per model, OpenRouter's billed cost over the list price for the same calls (last 7 days): applied to estimated tokens. */
  ratios: Record<string, number>;
  check: { period: string; from: string; itemised: number; real: number | null; error?: string };
}
/** The Costs tab's ledger views (src/cost-ledger.ts): billed spend from the model gateway's ledger, aggregated on the board. */
export interface LedgerMetrics {
  usd: number;
  calls: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
  /** Mean latency of ok calls that timed themselves. */
  ms: number | null;
}
export interface LedgerPeriod {
  usd: number;
  calls: number;
  /** The same span just before; null when the ledger doesn't reach back that far. */
  prev: number | null;
}
export interface CostLedger {
  from: string;
  to: string;
  bucket: "hour" | "day";
  /** Minutes east of UTC the time chart was bucketed by (the viewer's own). */
  offset: number;
  earliest: string | null;
  overview: {
    today: LedgerPeriod;
    week: LedgerPeriod;
    month: LedgerPeriod;
    key: { error: string } | { today: number; month: number; limit: number | null; remaining: number | null; reset: string | null };
    caps: { agentId: string; name: string; usd: number; cap: number }[];
  };
  totals: LedgerMetrics & { prevUsd: number | null };
  modelOrder: string[];
  models: (LedgerMetrics & { model: string })[];
  lanes: (LedgerMetrics & { lane: string })[];
  agents: (LedgerMetrics & { agentId: string; name: string; model: string | null; today: number; dayCap: number })[];
  series: { t: string; model: string; usd: number; calls: number }[];
  insights: LedgerInsights;
}
export interface LedgerInsights {
  forecast: { projected: number | null; perDay: number | null; daysLeft: number; monthToDate: number; partialMonth: boolean };
  coverage: { state: "accurate" | "gap" | "unverified" | "unavailable"; error: string | null; periods: { name: string; from: string; real: number; ledger: number; gap: number; share: number; state: "accurate" | "gap" | "partial" }[] };
  cache: { hit: number | null; cached: number; input: number; savedUsd: number | null };
  departments: (LedgerMetrics & { id: string; name: string; agents: number })[];
  tasks: {
    count: number;
    usd: number;
    perTask: number | null;
    sampled: number;
    done: { count: number; perTask: number | null; median: number | null };
    top: { issueId: string; identifier: string | null; title: string | null; status: string | null; agent: string; usd: number; calls: number }[];
  };
  wasted: {
    failed: { usd: number; calls: number; list: { agent: string; status: string; calls: number; usd: number }[] };
    cancelled: { usd: number; count: number; list: { issueId: string; identifier: string | null; title: string | null; agent: string; usd: number; calls: number }[] };
    looping: { threshold: number; usd: number; count: number; list: { runId: string; agent: string; calls: number; usd: number; first: string }[] };
  };
}
export interface CostTop {
  filter: { agentId?: string; model?: string };
  total: LedgerMetrics;
  split: (LedgerMetrics & { name: string })[];
  runs: (LedgerMetrics & { runId: string; agent: string | null; first: string | null; last: string | null })[];
  tasks: (LedgerMetrics & { issueId: string; identifier: string | null; title: string | null; agent: string | null })[];
  /** Spend on calls that name no task / no Paperclip run. */
  noTask: number;
  noRun: number;
}

/** One app from apps-mcp's /internal/status. */
export interface AppRow {
  name: string;
  healthy: boolean;
  state: string;
  sha?: string;
  deployed_at?: string;
  deployed_by?: string;
  auto_deploy?: boolean;
  /** Newest first: which commits were deployed, by whom, and how each ended. */
  deploys?: { sha: string; at: string; by: string; status: string }[];
  owner?: string;
  url?: string;
  incident?: { opened_at: string; kind: string; detail: string };
  stats?: { cpu_pct: number; mem_bytes: number; mem_limit_bytes: number };
}

/** "idle": open, nothing running and nothing asked of you (no chip). */
export type ChatState = "working" | "queued" | "waiting for you" | "waiting for approval" | "in review" | "done" | "failed" | "idle";
export interface ChatRow {
  identifier: string;
  title: string;
  open: boolean;
  agent: { key: string; name: string };
  state: ChatState;
  reason?: string;
  updatedAt: string;
  /** The last thing said: the agent's reply or your message. */
  preview?: { text: string; at: string; from: "agent" | "you" };
  unread: boolean;
  /** Work handed out from that chat (its identifier). */
  from?: string;
  /** Settled out of the active list (until something happens on it). */
  settled?: boolean;
}

export type LineageStatus = "running" | "done" | "blocked" | "approval" | "needs" | "waiting";
/** A delegated task in the lineage strip; `tokens` and `usd` are null when the ledger has no calls for it. */
export interface LineageRow {
  identifier: string;
  title: string;
  agent: string;
  model: string | null;
  status: LineageStatus;
  latest: { text: string; at: string } | null;
  tokens: number | null;
  usd: number | null;
  startedAt: string;
  endedAt: string | null;
  approvals: Approval[];
  children: LineageRow[];
}
export interface Lineage {
  identifier: string;
  children: LineageRow[];
  total: { tasks: number; running: number; needs: number; blocked: number; tokens: number; usd: number; ms: number };
}
export interface SettledItem {
  issueId: string;
  identifier: string;
  title: string;
  agent: string;
  kind: "chat" | "task";
  at: string;
}
export interface AsideMessage {
  role: "user" | "assistant";
  text: string;
}
export interface ChatAgent {
  key: string;
  name: string;
  /** Aiden: the front door, pinned on top. */
  front?: boolean;
}

/** A fast-lane agent (slack-live-mcp /lane) and a message in its conversation (`at`: ms). */
export interface LaneAgent {
  key: string;
  id: string;
  name: string;
}
export interface LaneMessage {
  id: string;
  role: "owner" | "agent" | "wake";
  text: string;
  at: number;
}

export type ChatMessage =
  | { kind: "owner"; id: string; text: string; at: string; via?: string; correction?: boolean; by?: string }
  | { kind: "reply"; id: string; agent: string; text: string; at: string; actions?: string[]; questions?: Question[] }
  | { kind: "notes"; id: string; agent: string; at: string; notes: { by: string; text: string; at: string }[] }
  | { kind: "notice"; id: string; text: string; at: string };

export interface ChatDetail {
  id: string;
  identifier: string;
  title: string;
  open: boolean;
  agent: { key: string; name: string };
  state: ChatState;
  reason?: string;
  messages: ChatMessage[];
  working: Working | null;
  files: FileView[];
  approvals: Approval[];
  handedOut: { identifier: string; title: string; agent: string; state: ChatState; reason?: string; updatedAt: string; working: Working | null }[];
  parent: TaskRef | null;
  runs: RunLink[];
  /** Questions an agent this chat handed work to is asking the owner; answered on that agent's task (`identifier`). */
  asks: { id: string; at: string; text: string; questions: Question[]; identifier: string; agent: string }[];
}
export interface RunLink {
  id: string;
  agent: string;
  status: string;
  at: string | null;
}
/** One run's trace (services/board/src/runs.ts RunView, with the agent's and task's names). */
export interface RunTrace {
  id: string;
  agent: string;
  status: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  issue: { identifier: string; title: string } | null;
  rev: { rev: string; productSha: string | null; instanceSha: string | null; from: "ledger" | "revs" } | null;
  tokens: { input: number; cached: number; output: number; reasoning: number } | null;
  paperclip: { input: number | null; output: number | null; model: string | null };
  contexts: number[];
  tools: { name: string; calls: number; failures: number; medianMs: number | null }[];
  timeline: { at: string; kind: "tool" | "shell" | "message" | "error"; name: string; text: string; ok: boolean; error?: string; ms?: number }[];
  ledger: { rows: { at: string; kind: string | null; model: string; input: number; cached: number; output: number; costUsd: number | null; ms: number | null; status: string | null; runKey: string | null }[]; usd: number | null; capUsd: number | null };
  notes: string[];
}
export interface ActivityItem {
  when: string;
  agent: string;
  chat: string;
  sentence: string;
  link: string;
  kind: "done" | "failed";
}
export interface NeedsYou {
  count: number;
  /** Open Tier 2 approval cards: the Approvals badge. */
  approvals: number;
  items: { identifier: string; title: string; agent: string; state: ChatState; reason?: string }[];
}

/** A multiple-choice question an agent asks (recommended option first); the owner may answer in his own words. */
export type Question = { question: string; options: string[]; multi?: boolean };

/** A change the Settings pages file (services/board/src/settings-change.ts): it becomes an apply card, never applied here. */
export type SettingChange =
  | { kind: "setting"; key: string; value: unknown }
  | { kind: "agent"; agent: string; field: "model" | "reasoning_effort" | "heartbeat"; value: string | number | boolean }
  | { kind: "caps"; agent: string; value: Partial<Record<"run_usd" | "task_usd" | "day_usd", number>> }
  | { kind: "module"; name: string; on: boolean };
export type ChangeStage = "working" | "waiting" | "applying" | "applied" | "failed" | "rejected" | "closed";
export interface FiledChange {
  identifier: string;
  title: string;
  createdAt: string;
  items: SettingChange[];
  stage: ChangeStage;
  tier?: number;
  approval?: string;
  detail?: string;
}

/** GET /api/settings (services/board/src/settings.ts): the compiled config, read-only. */
export interface SettingRow {
  key: string;
  module: string;
  value: unknown;
  /** instance.yaml sets it (otherwise the module's default applies). */
  set: boolean;
  /** The compiled config has it (false: an older compile, before the board could read settings). */
  known: boolean;
  default?: unknown;
  values?: unknown[];
  required?: boolean;
  doc?: string;
  /** What the running system reads now, where the board can see it (grants table, gateway, its own environment). */
  live?: string;
  switch: boolean;
  /** `url`: a URL input, checked like the compiler does (src/url-setting.ts), against `host` when set. */
  type?: string;
  host?: string;
}
export interface AgentSettings {
  key: string;
  name: string;
  module: string;
  adapter: string;
  runsOn: string;
  model: string;
  models: string[];
  effort: string;
  heartbeatHours: number | null;
  routines: { key: string; title: string; schedules: { cron: string; timezone: string; label: string }[]; model?: string; status?: string; webhook?: boolean }[];
  trial: boolean;
  graded: boolean;
  roles: string[];
  caps: Record<string, number>;
  connections: string[];
  /** A heartbeat may be turned on (not a runner agent, and it has the tools). */
  canHeartbeat: boolean;
  /** The reasoning efforts its engine takes (none: no effort setting). */
  efforts: string[];
  department: { id: string; name: string; description?: string; order: number };
}
export interface SettingsData {
  compiled: boolean;
  owner: { name: string | null };
  instance: { product: string | null; instance: string | null; lastChangeAt: string | null; boardTimezone: string; node: string };
  settings: SettingRow[];
  agents: AgentSettings[];
  choices: { heartbeatHours: number[]; models: string[] };
  approvals: { pending: number };
  spend: { defaults: Record<string, number>; pendingRaises: number };
}
