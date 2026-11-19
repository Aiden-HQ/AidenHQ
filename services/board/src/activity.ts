// What the agents are doing: Paperclip's agent runs.
import { z } from "zod";
import type { Step } from "./codex-activity.js";
import { type Agent, type Issue, type LiveRun, type PastRun, type Routine } from "./paperclip.js";

const UUID = /^[0-9a-f-]{36}$/;
const IDENT = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

const PlanItemSchema = z.object({ text: z.string().max(200), state: z.enum(["todo", "doing", "done"]) }).strict();
export type PlanItem = z.infer<typeof PlanItemSchema>;

const FINISHED_WINDOW_MS = 12 * 3_600_000;

export interface TaskRef {
  identifier: string;
  title?: string;
}

export interface Session {
  id: string;
  agent: string;
  /** The Paperclip agent behind the run. */
  agentId: string | null;
  state: "working" | "queued";
  startedAt: string | null;
  /** Paperclip's status line for the run ("Receiving agent output"). */
  doing?: string;
  tool?: string;
  /** The agent's latest message, when Paperclip has one. */
  said?: string;
  saidAt?: string;
  /** The agent's own task list (Codex's plan). */
  plan?: PlanItem[];
  /** Its tool calls so far. */
  steps?: Step[];
  /** No output for a long while (Paperclip's silence warning). */
  quiet?: boolean;
  /** The task the run belongs to: the user's task, or a routine's run task ("Process task replies"). */
  run: TaskRef | null;
  /** The user's tasks it works on: the task itself, or those a routine run names. */
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

export interface AgentsView {
  sessions: Session[];
  finished: Finished[];
  /** Every live agent, for the Agents page (only with the past runs). */
  roster?: RosterAgent[];
}

export interface RosterAgent {
  id: string;
  name: string;
  /** Its definition key (module.yaml / agents/<key>), when setup made it. */
  key?: string;
  /** A bundled portrait: /crew/<avatar>.svg. */
  avatar?: string;
  /** Its one-line routing description. */
  title: string | null;
  /** Where it sits on the Agents page, from what setup wrote (never from its name): a module's agent or the instance's own. */
  system: boolean;
  /** Its definition's `department:`, resolved from the one registry. */
  department: Department;
  model: string | null;
  /** Who it reports to (an agent id): the Agents page's reporting tree. */
  reportsTo: string | null;
  /** A team record (compile's teams): its members, in order. The record never runs. */
  team?: { name: string; members: { key: string; name: string }[] };
  /** A team member: its team record's key. */
  memberOf?: string;
  /** Its parallel jobs (an Engineer's `max_parallel`), the team's capacity. */
  maxParallel?: number;
  /** Paperclip's status: active, idle, running, paused, error… */
  status: string;
  trial: boolean;
  schedules: { title: string; paused: boolean; nextRunAt: string | null }[];
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

const ENGINE_LABEL: Record<string, string> = { codex: "Codex", "codex-openrouter": "Codex", claude: "Claude Code", openrouter: "OpenRouter" };

/** "~deepseek/deepseek-flash-latest" → "deepseek-flash-latest". */
export function shortModel(a: Pick<Agent, "metadata">): string | null {
  const model = typeof a.metadata?.model === "string" ? a.metadata.model : "";
  if (model) return model.replace(/^openrouter\//, "").replace(/^~/, "").split("/").at(-1)!;
  return a.metadata?.runnerEngine ? (ENGINE_LABEL[String(a.metadata?.engine)] ?? null) : null;
}

export interface Department {
  id: string;
  name: string;
  description?: string;
  /** Its place in the registry (kernel/defaults.json `departments`, then the instance's). */
  order: number;
}
const GENERAL: Department = { id: "general", name: "General", order: 1_000 };

/** The agent's department as setup wrote it (compile resolves it from the registry); General without one. */
export function departmentOf(a: Pick<Agent, "metadata">): Department {
  const d = a.metadata?.department as Partial<Department> | undefined;
  if (typeof d?.id !== "string" || typeof d.name !== "string" || typeof d.order !== "number") return GENERAL;
  return { id: d.id, name: d.name, ...(typeof d.description === "string" ? { description: d.description } : {}), order: d.order };
}

/** The agent's definition key ("aidenhq:fleet-ops" → "fleet-ops") and bundled portrait, for its avatar on the board. */
function identity(a: Pick<Agent, "metadata">): { key?: string; avatar?: string } {
  const m = a.metadata ?? {};
  const key = typeof m.setupKey === "string" && m.setupKey.startsWith("aidenhq:") ? m.setupKey.slice(8) : undefined;
  const avatar = typeof m.avatar === "string" && /^[a-z0-9-]{1,40}$/.test(m.avatar) ? m.avatar : undefined;
  return { ...(key ? { key } : {}), ...(avatar ? { avatar } : {}) };
}

/** The org metadata setup writes for a team (metadata.team on the record, metadata.memberOf on a member). */
function teamOf(a: Pick<Agent, "metadata">): Pick<RosterAgent, "team" | "memberOf" | "maxParallel"> {
  const m = a.metadata ?? {};
  const t = m.team as { name?: unknown; members?: unknown } | undefined;
  const members = Array.isArray(t?.members) ? t.members.filter((x): x is { key: string; name: string } => typeof x?.key === "string" && typeof x.name === "string") : [];
  return {
    ...(typeof t?.name === "string" && members.length ? { team: { name: t.name, members } } : {}),
    ...(typeof m.memberOf === "string" ? { memberOf: m.memberOf } : {}),
    ...(typeof m.maxParallel === "number" ? { maxParallel: m.maxParallel } : {}),
  };
}

/** The live agents (terminated ones never show) with their schedules and newest run. */
export function roster(agents: Agent[], routines: Routine[], last: Map<string, { at: string; status: string }>): RosterAgent[] {
  return agents
    .filter((a) => a.status !== "terminated")
    .map((a) => ({
      id: a.id,
      name: a.name,
      ...identity(a),
      title: a.title?.trim() || null,
      system: Boolean(a.metadata?.module) && a.metadata?.module !== "instance",
      department: departmentOf(a),
      model: shortModel(a),
      reportsTo: a.reportsTo ?? null,
      ...teamOf(a),
      status: a.status,
      trial: a.metadata?.trial === true,
      schedules: routines
        .filter((r) => r.assigneeAgentId === a.id && r.status !== "archived" && (r.triggers ?? []).some((t) => t.kind === "schedule" || t.nextRunAt))
        .map((r) => ({ title: r.title, paused: r.status === "paused", nextRunAt: (r.triggers ?? []).filter((t) => t.enabled !== false).map((t) => t.nextRunAt).filter((x): x is string => Boolean(x)).sort()[0] ?? null })),
      lastRunAt: last.get(a.id)?.at ?? null,
      lastRunStatus: last.get(a.id)?.status ?? null,
    }));
}

/** The user's tasks a run works on: a routine run names them in its description, any other run is on one. */
export function runTasks(issue: Pick<Issue, "identifier" | "title" | "description" | "originKind">, prefix: string): TaskRef[] {
  if (issue.originKind !== "routine_execution") return [{ identifier: issue.identifier, title: issue.title }];
  if (!prefix) return [];
  const re = new RegExp(`\\b${prefix.replace(/[^A-Z0-9]/g, "")}-\\d{1,7}\\b`, "g");
  return [...new Set((issue.description ?? "").match(re) ?? [])].filter((r) => r !== issue.identifier).map((identifier) => ({ identifier }));
}

export interface RunContext {
  run: TaskRef | null;
  tasks: TaskRef[];
}

const isLive = (status: string) => status === "running" || status === "queued";

/** Assemble the view from runs already resolved to their tasks (`resolve`). */
export async function agentsView(input: {
  live: LiveRun[];
  past: PastRun[];
  agents: Agent[];
  resolve: (issueId: string | null) => Promise<RunContext>;
  now?: number;
}): Promise<AgentsView> {
  const now = input.now ?? Date.now();
  const name = (id: string, fallback?: string) => input.agents.find((a) => a.id === id)?.name ?? fallback ?? "Agent";
  // Every run's task is looked up at once (each is a Paperclip round trip), then read back in order.
  const looked = new Map<string | null, Promise<RunContext>>();
  const resolve = (id: string | null) => {
    if (!looked.has(id)) looked.set(id, input.resolve(id));
    return looked.get(id)!;
  };
  const shown = (r: PastRun) => !isLive(r.status) && !!r.finishedAt && now - Date.parse(r.finishedAt) <= FINISHED_WINDOW_MS;
  for (const id of [...input.live.map((r) => r.issueId), ...input.past.filter(shown).map((r) => r.issueId)]) void resolve(id);
  const sessions: Session[] = [];
  for (const r of input.live) {
    const { run, tasks } = await resolve(r.issueId);
    sessions.push({
      id: r.id,
      agent: name(r.agentId, r.agentName),
      agentId: r.agentId,
      state: r.status === "queued" ? "queued" : "working",
      startedAt: r.startedAt ?? r.createdAt,
      doing: r.currentStatusMessage ?? undefined,
      tool: r.currentToolName ?? undefined,
      said: r.lastAssistantSnippet ? r.lastAssistantSnippet.slice(0, 400) : undefined,
      quiet: r.outputSilence?.level !== undefined && r.outputSilence.level !== "ok",
      run,
      tasks,
    });
  }
  const finished: Finished[] = [];
  for (const r of input.past) {
    if (!shown(r) || !r.finishedAt) continue;
    const { run, tasks } = await resolve(r.issueId);
    finished.push({ id: r.id, agent: name(r.agentId), agentId: r.agentId, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, detail: r.error ?? undefined, run, tasks });
  }
  finished.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  return { sessions, finished: finished.slice(0, 25) };
}

export interface Working {
  agent: string;
  since: string | null;
  queued: boolean;
  said?: string;
  saidAt?: string;
  plan?: PlanItem[];
  /** What a Codex agent has done so far, from its session log (live-activity.ts). */
  steps?: Step[];
}

/** Which of the user's tasks have an agent working on them, by identifier, with what it says it's on. */
export function workingOn(sessions: Session[]): Map<string, Working> {
  const out = new Map<string, Working>();
  for (const s of sessions) {
    for (const t of s.tasks) {
      const prev = out.get(t.identifier);
      if (!prev || (prev.queued && s.state === "working")) out.set(t.identifier, { agent: s.agent, since: s.startedAt, queued: s.state === "queued", ...(s.said ? { said: s.said, saidAt: s.saidAt } : {}), ...(s.plan?.length ? { plan: s.plan } : {}), ...(s.steps?.length ? { steps: s.steps } : {}) });
    }
  }
  return out;
}
