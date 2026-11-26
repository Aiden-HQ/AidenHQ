// Board logic: which tasks show where, who they're assigned to, and how edits map onto Paperclip.
// Pure functions (unit-tested); I/O is in app.ts.
import { z } from "zod";
import { closedIssue, crewOf, foldedChildren, type CrewInput, type CrewMember } from "./crew.js";
import { forOthers } from "./aidenhq-sdk/for-others.js";
import { keyOf, teammateOf, type RosterFace } from "./activity.js";
import { type Agent, type Comment, type Issue, type Label } from "./paperclip.js";
import { BUCKETS, type Bucket, type Placement } from "./store.js";
import type { ShownState } from "./task-state.js";

/** A board-written comment (a merge, an unreadable file): the board speaks, never the owner. */
export const NOTICE_MARKER = "<!-- aidenhq-notice -->";

/** Whether a comment carries one of our markers. */
export const hasMarker = (body: string, marker: string) => body.includes(marker);
/** A kernel wake notice (wakes.ts wakeNotice, a session's wait or timer): posted with the owner's key, never the owner's words. */
export const WAKE_MARKER = "<!-- aidenhq-wake";
/** A comment the board or the kernel wrote on the system's behalf: shown as a system note, never as the owner's words. */
export const isSystemNote = (body: string) => hasMarker(body, NOTICE_MARKER) || hasMarker(body, WAKE_MARKER);
export const BRIEF_LABEL = "daily-brief";
/** The label on the owner's settings-change tasks (settings-change.ts): the Settings pages show them, the board's columns don't. */
export const SETTINGS_LABEL = "settings-change";

export type Engine = "codex" | "codex-openrouter" | "claude" | "openrouter";
const ENGINES: Engine[] = ["codex", "codex-openrouter", "claude", "openrouter"];
/** A runner Engineer's engine: the one setup recorded (module.yaml `engine:`). */
export const engineOf = (a: { metadata?: { engine?: unknown } | null }): Engine | undefined =>
  ENGINES.includes(a.metadata?.engine as Engine) ? (a.metadata!.engine as Engine) : undefined;
/** The same for an agent in the compiled config (module.yaml fields). */
export const compiledEngine = (a: { engine?: string }): Engine | undefined => engineOf({ metadata: { engine: a.engine } });
export const openrouterEngine = (e: Engine | undefined) => e === "openrouter" || e === "codex-openrouter";
// Where the task's effort override is read (each engine module's effort_key).
const EFFORT_KEY: Record<Engine, string> = { codex: "modelReasoningEffort", "codex-openrouter": "modelReasoningEffort", openrouter: "modelReasoningEffort", claude: "effort" };
// The efforts each engine takes. opencode's are its model variants: a model without them ignores the setting.
export const EFFORTS: Record<Engine, string[]> = {
  codex: ["low", "medium", "high", "xhigh"],
  "codex-openrouter": ["low", "medium", "high", "xhigh"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  openrouter: ["low", "medium", "high"],
};

/** Someone a task can be assigned to from the board: the user, the Researcher, an Engineer, or any other agent. */
export interface Assignee {
  key: string; // "me" or the agent id
  kind: "me" | "assistant" | "engineer" | "agent";
  name: string;
  engine?: Engine;
  defaultModel?: string;
  /** Models offered for this Engineer (config/paperclip.yaml `models`), besides Paperclip's list. */
  models?: string[];
  efforts?: string[];
  /** Its face's seed: the definition key (stable across renames), else the Paperclip id ("me" for the owner). */
  seed: string;
  /** A teammate's face (activity.ts teammateOf); none for "me" and hidden agents. */
  face?: RosterFace;
}

export function assignees(agents: Agent[]): Assignee[] {
  const live = agents.filter((a) => a.status !== "terminated");
  const out: Assignee[] = [{ key: "me", kind: "me", name: "You", seed: "me" }];
  const assistant = live.find((a) => a.metadata?.setupKey === "aidenhq:assistant");
  if (assistant) out.push({ key: assistant.id, kind: "assistant", name: assistant.name, ...withFace(assistant) });
  // Engineers: the runner's agents, which the setup marks `runnerEngine`.
  const isEngineer = (a: Agent) => (/^aidenhq:engineer(-|$)/.test(a.metadata?.setupKey ?? "") || a.metadata?.runnerEngine === true) && engineOf(a);
  const engineers = live.filter(isEngineer);
  engineers.sort((a, b) => ENGINES.indexOf(engineOf(a)!) - ENGINES.indexOf(engineOf(b)!));
  for (const a of engineers) {
    const engine = engineOf(a)!;
    const model = typeof a.metadata?.model === "string" ? a.metadata.model : "";
    const models = Array.isArray(a.metadata?.models) ? a.metadata.models.filter((m): m is string => typeof m === "string") : [];
    out.push({ key: a.id, kind: "engineer", name: a.name, engine, defaultModel: model || undefined, ...(models.length ? { models } : {}), efforts: EFFORTS[engine], ...withFace(a) });
  }
  for (const a of live) if (a !== assistant && !isEngineer(a)) out.push({ key: a.id, kind: "agent", name: a.name, ...withFace(a) });
  return out;
}

const withFace = (a: Agent) => {
  const face = teammateOf(a)?.face;
  return { seed: keyOf(a) ?? a.id, ...(face ? { face } : {}) };
};

export function assigneeKey(issue: Issue, list: Assignee[]): string | null {
  if (issue.assigneeAgentId) return list.some((a) => a.key === issue.assigneeAgentId) ? issue.assigneeAgentId : null;
  return issue.assigneeUserId ? "me" : null;
}

/** The task's model and effort override, when it's assigned to an Engineer. */
export function executorOf(issue: Issue, list: Assignee[]): { model?: string; effort?: string } | undefined {
  const a = list.find((x) => x.key === issue.assigneeAgentId && x.kind === "engineer");
  if (!a?.engine) return undefined;
  const config = issue.assigneeAdapterOverrides?.adapterConfig ?? {};
  const key = EFFORT_KEY[a.engine];
  const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined;
  const effort = key && typeof config[key] === "string" && config[key] ? String(config[key]) : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export interface Card {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  labels: { name: string; color: string }[];
  assignee: string | null;
  executor?: { model?: string; effort?: string };
  unread: boolean;
  createdAt: string;
  activityAt: string;
  /** A move scheduled for a later date. */
  scheduled?: { date: string; bucket: Bucket };
  /** In Today: how many workdays it has been carried over unfinished. */
  carried?: number;
  /** Set on recurring tasks: the rule in words and the next run. */
  recurring?: { summary: string; nextRun: string | null; paused: boolean };
  /** An agent is working on it now, or has it queued. */
  working?: { agent: string; since: string | null; queued: boolean };
  /** The agents on the task: its own agent, and those working in its sub-tasks. */
  crew?: CrewMember[];
  /** The kernel's state of the task (task-state.ts), set when the board is read; null when it has no facts. */
  state?: ShownState | null;
  /** Ids the filters match (labels, project). */
  labelIds: string[];
  projectId: string | null;
}

/** An Agent work card: one issue, never folded, with its kernel state (its lane) and the task it is part of. */
export interface WorkCard extends Card {
  state: ShownState | null;
  /** The delegating task's identifier, for a sub-task. */
  parent: string | null;
  /** The agents working in its sub-tasks (agent ids): the Agent filter matches them too. */
  crewIds: string[];
  /** When it closed (a Done card). */
  closedAt: string | null;
}

export function toCard(issue: Issue, list: Assignee[], seenAt: string): Card {
  const activityAt = issue.lastActivityAt ?? issue.updatedAt;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    labels: (issue.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    assignee: assigneeKey(issue, list),
    executor: executorOf(issue, list),
    unread: activityAt > seenAt,
    createdAt: issue.createdAt,
    activityAt,
    labelIds: issue.labelIds ?? (issue.labels ?? []).map((l) => l.id),
    projectId: issue.projectId ?? null,
  };
}

/** Its assignee is the issue's own (an agent removed from the roster stays its holder, named from the kernel's row). */
export function workCard(issue: Issue, list: Assignee[], state: ShownState | null, parent: string | null, crewIds: string[]): WorkCard {
  const closed = closedIssue(issue);
  const assignee = issue.assigneeAgentId ?? (issue.assigneeUserId ? "me" : null);
  return { ...toCard(issue, list, ""), assignee, unread: false, state, parent, crewIds, closedAt: closed ? closedAt(issue) : null };
}

const isBrief = (i: Issue) => (i.labels ?? []).some((l) => l.name === BRIEF_LABEL);
/** The owner's settings task as the board files it (made by no agent, held by none): a label alone hides nothing. */
const isSettings = (i: Issue) => !i.assigneeAgentId && !i.createdByAgentId && (i.labels ?? []).some((l) => l.name === SETTINGS_LABEL);
/** A task My day holds (app.ts mine(), and older search hits): assigned to a crew agent, or else to the owner. */
export const onMyDay = (i: { assigneeAgentId?: string | null; assigneeUserId?: string | null }, ctx: { me: string; assignees: Assignee[] }) =>
  i.assigneeAgentId ? ctx.assignees.some((a) => a.key === i.assigneeAgentId) : i.assigneeUserId === ctx.me;

/** A task Agent work shows: anything but the brief and the owner's settings tasks. */
export const isWork = (i: Issue) => !isBrief(i) && !isSettings(i);

export interface BoardInput {
  open: Issue[];
  closed: Issue[];
  placements: Map<string, Placement>;
  seen: Map<string, string>;
  schedules?: Map<string, { date: string; bucket: Bucket }>;
  recurring?: Map<string, NonNullable<Card["recurring"]>>;
  installedAt: string;
  assignees: Assignee[];
  /** Activity for the crew on each card; without it, cards have no crew. */
  crew?: Omit<CrewInput, "assignees">;
}

export interface Board {
  buckets: Record<Bucket, Card[]>;
  brief: { id: string; identifier: string; title: string; description: string } | null;
  done: Card[];
  /** Recurring tasks: outside the columns, by next run. */
  recurring: Card[];
}

/** Open tasks by bucket and rank, today's brief, recurring tasks, and recently closed tasks (newest first). */
export function buildBoard(input: BoardInput): Board {
  const seen = (id: string) => input.seen.get(id) ?? input.installedAt;
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, [] as Card[]])) as Record<Bucket, Card[]>;
  const ranked = new Map<string, number>();
  const unique = new Map(input.open.map((i) => [i.id, i]));
  const briefs = [...unique.values()].filter(isBrief).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recurring: Card[] = [];
  // Agents' sub-tasks fold into the card they work on.
  const all = [...new Map([...input.closed, ...input.open].map((i) => [i.id, i])).values()];
  const folded = foldedChildren(all, input.assignees);
  const children = new Map<string, Issue[]>();
  for (const i of all) if (folded.has(i.id)) children.set(folded.get(i.id)!, [...(children.get(folded.get(i.id)!) ?? []), i]);
  const crewInput = input.crew && { ...input.crew, assignees: input.assignees };
  const withCrew = (card: Card, issue: Issue) => {
    const crew = crewInput ? crewOf(issue, children.get(issue.id) ?? [], crewInput) : [];
    if (crew.length) card.crew = crew;
    return card;
  };
  for (const issue of unique.values()) {
    if (isBrief(issue) || isSettings(issue) || folded.has(issue.id)) continue;
    const card = withCrew(toCard(issue, input.assignees, seen(issue.id)), issue);
    const rule = input.recurring?.get(issue.id);
    if (rule) {
      recurring.push({ ...card, recurring: rule });
      continue;
    }
    const scheduled = input.schedules?.get(issue.id);
    if (scheduled) card.scheduled = { date: scheduled.date, bucket: scheduled.bucket };
    const p = input.placements.get(issue.id) ?? { bucket: "triage" as Bucket, rank: -Infinity, carried: 0 };
    if (p.bucket === "today" && p.carried > 0) card.carried = p.carried;
    buckets[p.bucket].push(card);
    ranked.set(issue.id, p.rank);
  }
  recurring.sort((a, b) => (a.recurring!.nextRun ?? "~").localeCompare(b.recurring!.nextRun ?? "~"));
  for (const b of BUCKETS) buckets[b].sort((x, y) => ranked.get(x.id)! - ranked.get(y.id)! || y.createdAt.localeCompare(x.createdAt));
  const brief = briefs[0];
  const done = [...new Map(input.closed.filter((i) => !isBrief(i) && !isSettings(i) && !folded.has(i.id) && !unique.has(i.id)).map((i) => [i.id, i])).values()]
    .sort((a, b) => closedAt(b).localeCompare(closedAt(a)))
    .map((i) => withCrew(toCard(i, input.assignees, seen(i.id)), i));
  return {
    buckets,
    brief: brief ? { id: brief.id, identifier: brief.identifier, title: brief.title, description: displayText(brief.description) } : null,
    done,
    recurring,
  };
}

export const closedAt = (i: Issue) => i.completedAt ?? i.cancelledAt ?? i.updatedAt;

/** Hidden markers (source, runner) never show; Markdown is rendered and sanitised in the browser. */
export function displayText(text: string | null | undefined): string {
  return String(text ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Hidden source markers: the task's own source, and the sources of tasks merged into it. */
export const SOURCE_MARKERS = /<!-- (?:merged-)?source:[^>]*-->/g;
/**
 * The task a delegation asked for, when Paperclip created it beside that task instead of under it
 * (services/shared/requested-parent.ts). It routes the task's delegator and notices, so an edit must keep it too.
 */
export const REQUESTED_PARENT_MARKER = /<!--\s*aidenhq:requested-parent:[A-Za-z0-9_-]{1,100}\s*-->/;

/**
 * Keep the source markers (merged tasks' too) when the user edits a description: deduplication depends on them. The requester
 * marker (requested-parent.ts) is kept FIRST, as the plugin writes it: a list row is cut to 1200 characters, and a marker at the
 * end of a long brief would be invisible to every reader that scans lists.
 */
export function keepMarkers(original: string | null | undefined, edited: string): string {
  const markers = String(original ?? "").match(SOURCE_MARKERS) ?? [];
  const requester = String(original ?? "").match(REQUESTED_PARENT_MARKER) ?? [];
  const text = displayText(edited);
  return [requester.join("\n"), text, markers.join("\n")].filter(Boolean).join("\n\n");
}

export interface CommentView {
  id: string;
  body: string;
  author: { kind: "me" | "board" | "agent" | "user"; name: string };
  createdAt: string;
}

/** A for-others comment that isn't the owner's own @mention: the channel bridge's relay of a colleague opens with its "[slack " header. */
export const relayed = (body: string) => forOthers(body) && displayText(body).startsWith("[slack ");

export function commentView(c: Comment, me: string, agents: Agent[]): CommentView {
  const author: CommentView["author"] =
    c.authorType === "agent"
      ? { kind: "agent", name: agents.find((a) => a.id === c.authorAgentId)?.name ?? "Agent" }
      : isSystemNote(c.body)
        ? { kind: "board", name: "Board" }
        : relayed(c.body) || (c.authorUserId && c.authorUserId !== me)
          ? { kind: "user", name: "Someone else" }
          : { kind: "me", name: "You" };
  return { id: c.id, body: displayText(c.body), author, createdAt: c.createdAt };
}

/**
 * Who reads a reply on this task (shown under the reply box). `agentsOnTask` says whether the owner's task has
 * agents working in parts of it: with no assigned agent, a message either way stays on the task until one is named.
 */
export function replyTarget(issue: Issue, list: Assignee[], agentsOnTask = false): string {
  const labels = new Set((issue.labels ?? []).map((l) => l.name));
  const a = list.find((x) => x.key === issue.assigneeAgentId);
  if (a?.kind === "engineer") return "The Engineer reads replies here and continues the coding job.";
  if (labels.has("needs-review")) return "AidenHQ applies review replies here (pick N, ignore).";
  if (a?.kind === "assistant") return "The Researcher is working on this and reads replies.";
  if (a) return `${a.name} reads replies here.`;
  if (agentsOnTask) return "This message stays on the task; @name sends it to an agent.";
  return "No agent is assigned; this message stays on the task. @name brings an agent in.";
}

// ------------------------------------------------------------------ edits

const id = z.string().regex(/^[0-9a-f-]{36}$/);
export const UpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(60_000),
    status: z.enum(["todo", "in_progress", "done", "cancelled"]),
    priority: z.enum(["critical", "high", "medium", "low"]),
    assignee: z.union([z.literal("me"), id]),
    model: z.string().trim().max(120).regex(/^[A-Za-z0-9._:/\[\]-]*$/),
    effort: z.string().max(10),
    labelIds: z.array(id).max(20),
  })
  .partial()
  .strict();
export type Update = z.infer<typeof UpdateSchema>;

/**
 * The Paperclip PATCH body for a board edit. Assignees are limited to the user and the listed agents; model and effort only apply to Engineers; labels must exist.
 */
export function paperclipUpdate(issue: Issue, u: Update, ctx: { me: string; assignees: Assignee[]; labels: Label[] }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (u.title !== undefined) body.title = u.title;
  if (u.description !== undefined) body.description = keepMarkers(issue.description, u.description);
  if (u.status !== undefined) body.status = u.status;
  if (u.priority !== undefined) body.priority = u.priority;
  if (u.labelIds !== undefined) {
    const known = new Set(ctx.labels.map((l) => l.id));
    if (u.labelIds.some((l) => !known.has(l))) throw new BadRequest("unknown label");
    body.labelIds = u.labelIds;
  }
  let target = ctx.assignees.find((a) => a.key === (issue.assigneeAgentId ?? (issue.assigneeUserId ? "me" : "")));
  if (u.assignee !== undefined) {
    target = ctx.assignees.find((a) => a.key === u.assignee);
    if (!target) throw new BadRequest("unknown assignee");
    if (target.kind === "me") Object.assign(body, { assigneeUserId: ctx.me, assigneeAgentId: null, assigneeAdapterOverrides: null });
    else Object.assign(body, { assigneeAgentId: target.key, assigneeUserId: null, assigneeAdapterOverrides: null });
  }
  if (u.model !== undefined || u.effort !== undefined) {
    if (target?.kind !== "engineer" || !target.engine) throw new BadRequest("model and effort only apply to an Engineer");
    const current = u.assignee !== undefined ? {} : executorOf(issue, ctx.assignees) ?? {};
    let model = u.model !== undefined ? u.model : current.model ?? "";
    if (model && openrouterEngine(target.engine) && !model.startsWith("openrouter/")) model = `openrouter/${model}`;
    const effort = u.effort !== undefined ? u.effort : current.effort ?? "";
    if (effort && !target.efforts?.includes(effort)) throw new BadRequest(`effort must be one of ${target.efforts?.join(", ") || "(none)"}`);
    const config: Record<string, string> = {};
    if (model && model !== target.defaultModel) config.model = model;
    if (effort) config[EFFORT_KEY[target.engine]] = effort;
    body.assigneeAdapterOverrides = Object.keys(config).length ? { adapterConfig: config } : null;
  }
  return body;
}

export const CreateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(60_000).default(""),
    bucket: z.enum(BUCKETS).default("triage"),
  })
  .strict();

/** Bring an agent onto one of your tasks with instructions. */
export const AddAgentSchema = z
  .object({
    agent: z.string().min(1).max(64),
    instructions: z.string().trim().min(1).max(30_000),
    model: z.string().trim().max(120).optional(),
    effort: z.string().trim().max(20).optional(),
  })
  .strict();

/** Give a stuck agent's part of a task to another agent. */
export const HandOverSchema = z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }).strict();
/** An agent passing one of the user's comments on to another agent: which comment, to whom, and who passes it. */
export const PassSchema = z.object({ comment: id, to: z.string().min(1).max(64), by: z.string().max(64).optional() }).strict();

export class BadRequest extends Error {}
