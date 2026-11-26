import type { Lane } from "../../src/aidenhq-sdk/task-state-types";
import type { ShownState } from "../../src/task-state";
import type { FaceKit } from "../../src/face-kit";
import type { IconName } from "./ui/icons";
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
  /** Its face's seed: the definition key (stable across renames), else the Paperclip id ("me" for the owner). */
  seed: string;
  /** A teammate's face; none for "me" and hidden agents. */
  face?: RosterFace;
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
  /** The kernel's state of the task. */
  state?: ShownState | null;
  /** Ids the filters match. */
  labelIds: string[];
  projectId: string | null;
}

/** An Agent work card (services/board/src/board.ts WorkCard): one issue, never folded, in its kernel lane. */
export interface WorkCard extends Card {
  state: ShownState | null;
  /** The delegating task's identifier, for a sub-task. */
  parent: string | null;
  /** The agents working in its sub-tasks (agent ids). */
  crewIds: string[];
  closedAt: string | null;
  /** An older search hit (search.ts): whether My day may show it (assigned to the owner or a crew agent). */
  mine?: boolean;
  /** An older search hit's close is inside the board's window (Agent work may lack the task; My day never does). */
  recent?: boolean;
}

/** A saved board (services/board/src/views.ts): its filters and layout, ids never names; `rev` guards every write. */
export type Layout = "day" | "work";
export interface Filters {
  /** Agent ids, "me" (You) or "none" (Unassigned). */
  agent?: string[];
  state?: Lane[];
  label?: string[];
  priority?: ("critical" | "high" | "medium" | "low")[];
  /** Project ids, or "none". */
  project?: string[];
  updated?: "today" | "7d" | "30d" | null;
  text?: string;
}
export interface ViewSpec {
  layout: Layout;
  groupBy: "none" | "agent";
  filters: Filters;
}
export interface SavedView {
  id: string;
  name: string;
  spec: ViewSpec;
  rev: number;
}

export type CrewState = "needs" | "failed" | "working" | "queued" | "waiting" | "done";

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
  said?: string;
  saidAt?: string;
  plan?: PlanItem[];
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
  roster?: RosterAgent[];
}

/** GET /api/agents/:id/scorecard (fleet-stats.ts). */
export interface Scorecard {
  done: { count: number; prior: number; tasks: { identifier: string; title: string }[] };
  reopen: { graded: number; reopened: number };
  approvals: { filed: number; rejected: number; priorRejected: number };
  runsFailed: number;
  cost: { usd: number; prior: number; perDone: number | null; billed: boolean };
  daily: { day: string; done: number; costUsd: number }[];
}

/** GET /api/agents/by-key/:key (agent-page.ts). */
/** From the kernel's jobs; paused is the owner's setting (activity.ts agentState). */
export type AgentState = "working" | "queued" | "waiting" | "idle" | "failing" | "paused";

/** A teammate's face (activity.ts): its shipped file the board serves, its module's kit spec, or none (drawn from the seed). */
export type RosterFace = { src: string } | { kit: FaceKit } | null;
/** An agent the owner sees by name (its module's `teammate:` block); without one an agent is hidden staff. */
export interface RosterTeammate {
  job: string;
  sample: string;
  staff: string[];
  controls: string[];
  face: RosterFace;
}

export interface AgentProfile {
  id: string;
  key: string;
  name: string;
  teammate?: RosterTeammate;
  title: string | null;
  state: AgentState;
  stateNote?: string;
  model: string | null;
  effort: string | null;
  reportsTo: string | null;
  source: { module: string; marketplace: string | null; tier: string | null; revision: string | null } | null;
  schedules: { title: string; paused: boolean; nextRunAt: string | null }[];
}

/** One task on an agent's page. `state` is a chat state ("working", "waiting for you", "failed", "done"…). */
export interface TaskRow {
  identifier: string;
  title: string;
  state: ShownState | null;
  updatedAt: string;
  from: string | null;
}

export interface RosterAgent {
  id: string;
  name: string;
  title: string | null;
  system: boolean;
  department: { id: string; name: string; description?: string; order: number };
  key?: string;
  teammate?: RosterTeammate;
  model: string | null;
  reportsTo: string | null;
  team?: { name: string; members: { key: string; name: string }[] };
  memberOf?: string;
  maxParallel?: number;
  state: AgentState;
  stateNote?: string;
  waitUntil?: string;
  running: number;
  queued: number;
  workingSince: string | null;
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
}

/** The install's spend against its two limits (a UTC day and a UTC month). */
export type SpendNow = { day: { spent: number; cap: number }; month: { spent: number; cap: number } };
export interface Board {
  buckets: Record<Bucket, Card[]>;
  /** Agent work: every open issue and those the kernel saw close in the last 48 hours, each its own card. */
  work: WorkCard[];
  /** The kernel snapshot's time: every lane is as of then. */
  asOf: string;
  /** A Paperclip list hit its bound: the board shows only the newest tasks. */
  incomplete: boolean;
  /** The company's projects; null when the catalog couldn't be read (the Project filter is unavailable). */
  projects: { id: string; name: string }[] | null;
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
  /** The install's model spend against its two limits (settings.spend_day_usd, spend_month_usd: a UTC day and month); null without the kernel. */
  spend?: SpendNow | null;
  /** Google sign-in per account; null when the board can't ask. */
  google: { accounts: GoogleAccount[]; error?: string; client?: boolean } | null;
  /** The modules' sign-ins (board.signins): each one's banner text and state (null when the board can't ask). */
  signIns: { id: string; label: string; missing: string; stopped: string; status: SignInStatus | null; offer?: boolean; mode?: "device" }[];
}

/** A sign-in through an MCP proxy (Glean, Grafana, ClickHouse, Jira). */
export interface SignInStatus {
  login?: string;
  /** `time`: an ISO instant shown after `value` in the viewer's local time. An action's `href` is the vendor's https page or a
   * board path (`#/...`); anything else isn't rendered. */
  lines?: { label: string; value: string; time?: string; state: "ok" | "warn" | "error"; action?: { label: string; href?: string; reconnect?: true } }[];
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
  author: { kind: "me" | "board" | "agent" | "user"; name: string };
  /** The admin (not the owner) who wrote it. */
  by?: string;
  createdAt: string;
}

export interface GradeShown {
  state: "none" | "unavailable" | "ungraded_close" | "open" | "pending" | "awaiting_evidence" | "satisfied" | "needs_revision" | "grading_failed" | "not_graded";
  rubric: { text: string; met: "yes" | "no" | "unknown"; evidence?: string }[];
  judgedAt?: string;
  version?: string;
  deliverable?: { kind: "pr" | "app" | "apply" | "file" | "report" | "issue"; ref: string; href?: string };
}
export interface Milestone {
  at: string;
  kind: "created" | "run_started" | "run_ended" | "asked_you" | "approved" | "applied" | "deployed" | "graded";
  text: string;
  href?: string;
  runId?: string;
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
  /** The agents on this task, with each one's latest word. */
  crew: (CrewMember & { said: { text: string; at: string } | null })[];
  /** What done means and whether it is met (src/task-truth.ts); `none` when the task has no grade row. */
  grade: GradeShown;
  /** The task's own recorded milestones, oldest first. */
  milestones: Milestone[];
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
  /** auto: a Tier 0 run, already made; an audit row only; running: claimed and in flight, with its wait reason in `wait`. */
  state: "pending" | "approved" | "rejected" | "stale" | "expired" | "running" | "used" | "unknown" | "auto";
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
  /** Why the record is still running, while it is `running` (the executor's words, shown as data); null once it ends. */
  wait: string | null;
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
/** A marketplace advisory open against an installed module (the kernel's advisories.ts); `summary` is fenced text. */
export interface Advisory {
  id: string;
  module: string;
  severity: "low" | "medium" | "high" | "critical";
  fixed: string;
  summary: string;
  url: string;
}

/** A module's Fleet page (board.pages): its view is the module's, shown in a sandboxed frame (ModuleView.tsx). */
export interface PageRow {
  id: string;
  title: string;
  icon: IconName;
  order: number;
  module: string;
}

export interface ModuleRow {
  name: string;
  description: string;
  agents: string[];
  requires: string[];
  /** Where it comes from and its computed tier: declared or official (never claimed by the module). */
  marketplace: string;
  tier: string;
  state: "core" | "on" | "dependency" | "off";
  /** Enabled modules that require this one (why a dependency is on). */
  neededBy: string[];
  connections: string[];
  routines: string[];
  apps: string[];
  settings: Record<string, unknown>;
  revision: string | null;
  /** The short sha instance.yaml pins this module at; null: it follows its marketplace. */
  pinned: string | null;
  source: { url: string; path: string } | null;
  setup: string | null;
}

/** GET /api/modules/:name (services/board/src/app.ts). */
export interface ModuleDetail {
  module: ModuleRow;
  agents: AgentProfile[];
  ongoing: TaskRow[];
  /** Its routines as compiled: on or off, and the agent whose Settings tab changes them. */
  routines?: { key: string; id?: string; title: string; agent: string; on: boolean; scheduled: boolean }[];
  authority: { connections: string[]; writes: { kind: string; tier?: number }[]; secrets: string[]; prompts: { id: string; file: string }[]; readme: string | null };
  neededBy: string[];
  requires: string[];
}

/** The Costs tab's ledger views (src/cost-ledger.ts): billed spend from the model gateway's ledger, aggregated on the board. */
export interface LedgerMetrics {
  usd: number;
  calls: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
  /** Calls cut off before their final usage: a kernel restart, a cut or usage-less stream (spend: what OpenRouter billed for them). */
  interrupted: number;
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
    limits: { day: { spent: number; cap: number }; month: { spent: number; cap: number } } | null;
    todayByAgent: { agentId: string; name: string; usd: number }[];
  };
  totals: LedgerMetrics & { prevUsd: number | null };
  modelOrder: string[];
  models: (LedgerMetrics & { model: string })[];
  lanes: (LedgerMetrics & { lane: string })[];
  agents: (LedgerMetrics & { agentId: string; name: string; model: string | null; today: number })[];
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
  /** Epoch ms (apps-mcp's deploy store). */
  deployed_at?: number;
  deployed_by?: string;
  auto_deploy?: boolean;
  /** Its source repo. */
  repo?: string;
  /** Newest first: which commits were deployed (at: epoch ms), by whom, and how each ended (healthy, failed, build_failed, rolled_back). */
  deploys?: { sha: string; at: number; by: string; status: string }[];
  owner?: string;
  url?: string;
  /** Serves a port but its browser door doesn't open (yet): why, in words for the owner (older apps-mcp: true). */
  unpublished?: string | boolean;
  /** Pinned into the nav under this label (apps.yaml `panel`). */
  panel?: string;
  incident?: { opened_at: string; kind: string; detail: string };
  stats?: { cpu_pct: number; mem_bytes: number; mem_limit_bytes: number };
}

/** The kernel's state of a task as the board shows it (services/board/src/task-state.ts): null when it has no facts for the task. */
export type { Lane, ShownState };
export interface ChatRow {
  identifier: string;
  title: string;
  open: boolean;
  agent: { key: string; name: string };
  state: ShownState | null;
  updatedAt: string;
  /** The last thing said: the agent's reply or your message. */
  preview?: { text: string; at: string; from: "agent" | "you" };
  unread: boolean;
  /** Work handed out from that chat (its identifier). */
  from?: string;
  /** Settled out of the active list (until something happens on it). */
  settled?: boolean;
}

/** A delegated task in the lineage strip; `tokens` and `usd` are null when the ledger has no calls for it. */
export interface LineageRow {
  identifier: string;
  title: string;
  agent: string;
  model: string | null;
  state: ShownState | null;
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
  total: { tasks: number; running: number; needs: number; failed: number; tokens: number; usd: number; ms: number };
}
/** What a feature (a task and everything delegated under it) cost and how long it took. */
export interface FeatureCost {
  identifier: string;
  title: string;
  createdAt: string;
  tasks: number;
  usd: number;
  calls: number;
  jobs: number;
  jobMs: number;
  elapsedMs: number;
  running: boolean;
  prs: number;
  truncated: boolean;
}
export interface Features {
  features: FeatureCost[];
  unattributed: { usd: number; calls: number };
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
  role: "owner" | "agent";
  text: string;
  at: number;
}

export type ChatMessage =
  | { kind: "owner"; id: string; text: string; at: string; via?: string; correction?: boolean; by?: string }
  | { kind: "reply"; id: string; agent: string; text: string; at: string; actions?: string[]; questions?: Question[]; /** The run behind this reply: how long it ran, what woke it. */ run?: { id: string; seconds: number; trigger?: string } }
  | { kind: "notes"; id: string; agent: string; at: string; notes: { by: string; text: string; at: string }[] }
  | { kind: "notice"; id: string; text: string; at: string };

export interface ChatDetail {
  id: string;
  identifier: string;
  title: string;
  open: boolean;
  agent: { key: string; name: string };
  /** Settled out of the active list (as the chat lists say). */
  settled?: boolean;
  state: ShownState | null;
  messages: ChatMessage[];
  working: Working | null;
  files: FileView[];
  approvals: Approval[];
  handedOut: { identifier: string; title: string; agent: string; state: ShownState | null; updatedAt: string; working: Working | null }[];
  parent: TaskRef | null;
  runs: RunLink[];
  /** Questions an agent this chat handed work to is asking the owner; answered on that agent's task (`identifier`). */
  asks: { id: string; at: string; text: string; questions: Question[]; waitSince: string; identifier: string; agent: string }[];
}
export interface RunLink {
  id: string;
  agent: string;
  status: string;
  at: string | null;
}
/** One run's trace (services/board/src/runs.ts RunView, with the agent's and task's names). */
/** One run (a kernel job) as a trace (src/runs.ts). */
export interface RunTrace {
  id: string;
  agent: string;
  engine: string;
  status: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  issue: { identifier: string; title: string } | null;
  rev: { rev: string; productSha: string | null; instanceSha: string | null; from: "ledger" | "revs" } | null;
  tokens: { input: number; cached: number; output: number } | null;
  plan: PlanItem[];
  timeline: { at: string; kind: "step" | "message" | "error"; text: string; ok: boolean }[];
  ledger: { rows: { at: string; kind: string | null; model: string; input: number; cached: number; output: number; costUsd: number | null; ms: number | null; status: string | null; runKey: string | null }[]; usd: number | null };
}
export interface NeedsYou {
  /** The fleet's counts of tasks needing the owner, failed, and idle with nothing to wake them. */
  counts: { needs_you: number; failed: number; unexplained_idle: number };
  /** Open Tier 2 approval cards: the Approvals badge. */
  approvals: number;
  /** Every open task with someone to act on it, oldest first. */
  items: { identifier: string; title: string; agent: string; state: ShownState; /** The open owner question, answered in place: its options and the wait it belongs to. */ ask?: { question: string; /** What the question is about (e.g. the draft to send), shown beside it. */ detail?: string; questions: Question[]; waitSince: string } }[];
}

/** A multiple-choice question an agent asks (recommended option first); the owner may answer in his own words. */
export type Question = { question: string; options: string[]; multi?: boolean };

/** A change the Settings pages file (services/board/src/settings-change.ts): it becomes an apply card, never applied here. */
export type SettingChange =
  | { kind: "setting"; key: string; value: unknown }
  | { kind: "agent"; agent: string; field: "model" | "reasoning_effort" | "heartbeat" | "max_parallel" | "name"; value: string | number | boolean }
  | { kind: "module"; name: string; on: boolean }
  | { kind: "routine"; routine: string; field: "schedules"; value: { cron: string; timezone?: string; label?: string }[] }
  | { kind: "routine"; routine: string; field: "model"; value: string | null }
  | { kind: "rules"; agent: string; text: string }
  | { kind: "handbook"; agent: string; text: string }
  | { kind: "unfork"; agent: string }
  | { kind: "pin"; name: string; sha: string | null }
  | { kind: "marketplace"; op: "add" | "update" | "remove"; name: string; source?: { source: "github"; repo: string }; sha?: string }
  | { kind: "grants"; agent: string; connection: string; tools: string[] | null }
  | { kind: "share"; module: string; repo: string; ref: string; source: string; base: string; digest: string };
/** POST /api/modules/share/preview (kernel/src/module-share.ts): exactly what a share would send, where, and what blocks it. */
export interface SharePreview {
  module: string; repo: string; ref: string; source: string; base: string; digest: string; private: boolean; conflict?: string;
  /** Each file whole (`text`) only when nothing blocks the share. */
  files: { path: string; bytes: number; text?: string }[];
  /** Files in the destination's folder now that the publish deletes (the folder becomes exactly `files`). */
  removes: string[];
  notShared: { path: string; why: string }[];
  findings: { file: string; rule: string; detail: string }[];
  isolation: "trusted" | "untrusted"; scripts: string[]; grants: Record<string, string[]>;
}
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
  /** An anchored regex a text value must match. */
  pattern?: string;
  /** Shown only while these settings hold (`{ <setting>: <value> }`). */
  when?: Record<string, unknown>;
}
export interface AgentSettings {
  key: string;
  name: string;
  module: string;
  model: string;
  models: string[];
  effort: string;
  heartbeatHours: number | null;
  /** An Engineer's parallel jobs. */
  maxParallel?: number;
  /** A team record: its team's name. */
  team?: string;
  /** A team member: its team record's key. */
  memberOf?: string;
  routines: { key: string; title: string; schedules: { cron: string; timezone: string; label: string }[]; model?: string; webhook?: boolean; /** The module's own value where the instance overrides it. */ defaults?: Record<string, unknown>; /** Its live Paperclip row and whether it is paused (absent before setup made it). */ id?: string; paused?: boolean; /** An active schedule's next run (ISO). */ next?: string; /** An event routine: what wakes it (its applied subscription), or not_applied before setup has it. */ wakes?: { connection: string; resource?: string; filter?: Record<string, unknown> } | "not_applied" }[];
  /** Its recurring tasks' schedules (Repeats: routines the board made). */
  recurring: { title: string; task: string; summary: string; paused: boolean; zone?: string; next?: string }[];
  graded: boolean;
  roles: string[];
  /** The module's own model, reasoning_effort and heartbeat where the instance overrides them. */
  defaults?: Record<string, unknown>;
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
  /** Release updates (services/board/src/settings.ts UpdatesView); null when the instance pins its product by hand. */
  updates: UpdatesData | null;
}
export interface UpdatesData {
  current: { name: string; product: string } | null;
  auto: boolean | null;
  timezone: string | null;
  checkedAt: string | null;
  available: { name: string; notes: string[]; compare: string } | null;
  error: string | null;
  last: { release: string; outcome: "installed" | "failed"; why?: string; at: string; by: string } | null;
}

// Lane D: the pin change (lane A's schema, settings-change.ts).
// Lane E: GET /api/modules/browse, /api/marketplaces and /api/agents/by-key/:key/grants (services/board/src/marketplace.ts).
export interface BrowseModule {
  name: string;
  description: string;
  marketplace: string;
  tier: string;
  adds: string[];
  installed: boolean;
  setupFlow?: { title: string };
}
export interface MarketplaceRow {
  name: string;
  source: string;
  sha: string;
  modules: number;
  newer: boolean;
  /** The newest commit at least 7 days old: what Add and Update pin. */
  latest?: { sha: string; date: string };
}
export interface GrantConnection {
  id: string;
  module: string;
  tools: { name: string; class: "read" | "write" | "destructive"; granted: boolean; default: boolean }[];
}

/** A session (src/sessions.ts SessionRow): a long-lived harness on the always-on computer, held by one task. */
export type SessionState = "starting" | "running" | "waiting" | "stopped" | "error";
export interface SessionRow {
  task: string;
  identifier: string;
  title: string;
  state: SessionState;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  last_activity: { at: string; text: string } | null;
  cost_usd: number;
  creator: { name: string; kind: "person" | "agent" };
  /** Whether this account may open its terminal and phone UI (only its creator). */
  mine: boolean;
}

// Home (GET /api/home): the server's shapes, services/board/src/home.ts.
/** A teammate as Home shows it; `face` is the roster's own value. */
export type FaceRef = { key: string; name: string; job: string; face: RosterFace; state: "idle" | "working" | "needs" };
export type NeedRow =
  | { id: string; kind: "answer"; teammate: FaceRef; since: string; task: { identifier: string; title: string }; question: string; detail?: string; options: string[]; questions: Question[]; waitSince: string }
  | { id: string; kind: "approval"; teammate: FaceRef; since: string; task: { identifier: string; title: string } | null; question: string; card: Approval }
  | { id: string; kind: "open"; teammate: FaceRef; since: string; task: { identifier: string; title: string }; question: string };
export type SinceItem = { teammate: FaceRef; text: string; at: string; task: string | null; kind: "done" | "fyi" | "digest" | "closed" };
export type WorldBlock = {
  waiting_on: { identifier: string; title: string; age_days: number; quiet_days: number }[] | null;
  today: { timezone: string; events: { id: string; start: string; title: string; all_day: boolean; prep?: string }[] } | null;
};
export type TeamNews = { teammate: FaceRef; line: string };
export type IdeaRow = { identifier: string; teammate: FaceRef; question: string; options: string[]; waitSince: string };
export type Home = {
  as_of: string;
  since_from: string;
  /** Every read behind Since answered: only then may the seen cursor move past this snapshot. */
  since_complete: boolean;
  greeting: { needs: number };
  needs: NeedRow[];
  since: { groups: { teammate: FaceRef; latest: SinceItem; count: number }[]; items: SinceItem[]; total: number } | null;
  world: WorldBlock;
  team: TeamNews[];
  idea: IdeaRow | null;
};
