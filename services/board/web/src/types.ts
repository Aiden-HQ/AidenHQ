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
  engine?: "codex" | "claude" | "openrouter";
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

export interface RosterAgent {
  id: string;
  name: string;
  title: string | null;
  group: "coordinators" | "scouts" | "engineers" | "instance";
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
  state: "missing" | "ok" | "expired" | "unknown";
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
  labelIds: string[];
  replyTarget: string;
  scheduled: { date: string; bucket: Bucket; position: "top" | "bottom" } | null;
  recurring: RecurringView | null;
  comments: CommentView[];
  files: FileView[];
  parent: TaskRef | null;
  /** The agents on this task, with each one's latest word. */
  crew: (CrewMember & { said: { text: string; at: string } | null })[];
  /** After a reply: the agent's part a message that @-mentioned them went to, instead of this chat. */
  movedTo?: string;
  /** After an exact typed reply ("apply WOR-184"): the approval it decided, instead of a posted message. */
  approval?: Approval;
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
  state: "pending" | "approved" | "rejected" | "expired" | "used" | "unknown" | "auto";
  /** 0 ran at once, 1 the AI reviewer decides, 2 the owner decides. */
  tier: 0 | 1 | 2;
  reason: string;
  /** The AI reviewer's note (its verdict's reason, or why it sent the card to the owner). */
  review: string | null;
  /** Stamped by the board from the credential: account:<id> (an admin's tap, or the owner's typed reply on the board), owner:telegram, owner:reply (a typed reply in Telegram), watcher, reviewer:<model>, auto:<rule>. */
  decidedBy: string | null;
  /** The deciding admin's name, when it wasn't the owner. */
  decidedByName?: string;
  outcome: "applied" | "failed" | null;
  outcomeText: string | null;
  createdAt: string;
  expiresAt: string;
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
export interface ModuleRow {
  name: string;
  description: string;
  agents: string[];
  requires: string[];
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

/** One app from apps-mcp's /internal/status. */
export interface AppRow {
  name: string;
  healthy: boolean;
  state: string;
  sha?: string;
  deployed_at?: string;
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
}
export interface ChatAgent {
  key: string;
  name: string;
  /** Aiden: the front door, pinned on top. */
  front?: boolean;
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
  /** Questions an agent this chat handed work to is asking the owner; answered on that agent's task (`identifier`). */
  asks: { id: string; at: string; text: string; questions: Question[]; identifier: string; agent: string }[];
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
