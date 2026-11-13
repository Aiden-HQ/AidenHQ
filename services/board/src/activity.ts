// What the agents are doing: Paperclip's agent runs plus the runner's Engineer jobs, which it
// reports to the internal API (the runner works outside Paperclip, on the host).
import { z } from "zod";
import type { Step } from "./codex-activity.js";
import { type Agent, type Issue, type LiveRun, type PastRun, type Routine } from "./paperclip.js";

const UUID = /^[0-9a-f-]{36}$/;
const IDENT = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

const PlanItemSchema = z.object({ text: z.string().max(200), state: z.enum(["todo", "doing", "done"]) }).strict();
export type PlanItem = z.infer<typeof PlanItemSchema>;

const RunnerJobSchema = z
  .object({
    issueId: z.string().regex(UUID),
    identifier: z.string().regex(IDENT),
    engine: z.string().max(200).optional(),
    mode: z.string().max(40).optional(),
    repo: z.string().max(200).optional(),
    status: z.string().max(40).optional(),
    startedAt: z.string().max(40),
    finishedAt: z.string().max(40).nullable().optional(),
    /** While it works: the agent's latest words and its own task list. */
    said: z.string().max(600).optional(),
    saidAt: z.string().max(40).optional(),
    plan: z.array(PlanItemSchema).max(20).optional(),
    /** Its tool calls so far, newest last (the runner keeps the latest 30). */
    steps: z.array(z.object({ at: z.string().max(40), kind: z.enum(["tool", "thought", "message"]), text: z.string().max(300) }).strict()).max(30).optional(),
  })
  .strict();

export const RunnerReportSchema = z
  .object({
    running: z.array(RunnerJobSchema).max(50),
    queued: z.array(z.object({ issueId: z.string().regex(UUID), identifier: z.string().regex(IDENT) }).strict()).max(200),
    recent: z.array(RunnerJobSchema).max(50),
    /** Each task's latest job result, so a stuck part stays visible after it leaves `recent`. */
    latest: z.array(z.object({ identifier: z.string().regex(IDENT), status: z.string().max(40) }).strict()).max(500).optional(),
  })
  .strict();

export type RunnerReport = z.infer<typeof RunnerReportSchema> & { at: string };
type RunnerJob = z.infer<typeof RunnerJobSchema>;

/** The runner polls every ~20 seconds; a minute of silence while it acts on a request is normal. */
export const RUNNER_STALE_MS = 5 * 60_000;
const FINISHED_WINDOW_MS = 12 * 3_600_000;

export interface TaskRef {
  identifier: string;
  title?: string;
}

export interface Session {
  id: string;
  source: "agent" | "runner";
  agent: string;
  /** The Paperclip agent behind it: the run's agent, or the Engineer of a runner job's engine. */
  agentId: string | null;
  state: "working" | "queued";
  startedAt: string | null;
  /** Paperclip's status line for the run ("Receiving agent output"), or the runner's mode and repo. */
  doing?: string;
  tool?: string;
  /** The agent's latest message, when Paperclip (or the runner) has one. */
  said?: string;
  saidAt?: string;
  /** A runner job's own task list (Claude Code's tasks, Codex's plan). */
  plan?: PlanItem[];
  /** A runner job's tool calls so far. */
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
  source: "agent" | "runner";
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
  runner: { reportedAt: string | null; stale: boolean };
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
  /** Paperclip's status: active, idle, running, paused, error… */
  status: string;
  trial: boolean;
  schedules: { title: string; paused: boolean; nextRunAt: string | null }[];
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

const ENGINE_LABEL: Record<string, string> = { codex_local: "Codex", claude_local: "Claude Code", opencode_local: "OpenRouter" };

/** "~deepseek/deepseek-flash-latest" → "deepseek-flash-latest"; a runner Engineer without a model → its engine. */
export function shortModel(a: Pick<Agent, "adapterType" | "adapterConfig" | "metadata">): string | null {
  const model = typeof a.adapterConfig?.model === "string" ? a.adapterConfig.model : "";
  if (model) return model.replace(/^openrouter\//, "").replace(/^~/, "").split("/").at(-1)!;
  return a.metadata?.runnerEngine ? (ENGINE_LABEL[a.adapterType] ?? null) : null;
}

export interface Department {
  id: string;
  name: string;
  description?: string;
  /** Its place in the registry (modules/core/module.yaml `departments:`, then the instance's). */
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
  const p = m.persona as { avatar?: unknown } | undefined;
  const pic = typeof p?.avatar === "string" ? p.avatar : m.avatar;
  const avatar = typeof pic === "string" && /^[a-z0-9-]{1,40}$/.test(pic) ? pic : undefined;
  return { ...(key ? { key } : {}), ...(avatar ? { avatar } : {}) };
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
  /** Who the run's task is assigned to: tells which Engineer a queued runner job is for. */
  assigneeAgentId?: string | null;
}

const isLive = (status: string) => status === "running" || status === "queued";

/** Assemble the view from runs already resolved to their tasks (`resolve`). */
export async function agentsView(input: {
  live: LiveRun[];
  past: PastRun[];
  runner: RunnerReport | undefined;
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
  for (const id of [...input.live.map((r) => r.issueId), ...(input.runner?.queued ?? []).map((j) => j.issueId), ...input.past.filter(shown).map((r) => r.issueId)]) void resolve(id);
  const sessions: Session[] = [];
  for (const r of input.live) {
    const { run, tasks } = await resolve(r.issueId);
    sessions.push({
      id: r.id,
      source: "agent",
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
  const runner = input.runner;
  const fresh = runner && now - Date.parse(runner.at) < RUNNER_STALE_MS ? runner : undefined;
  const ref = (j: { identifier: string }) => ({ run: { identifier: j.identifier }, tasks: [{ identifier: j.identifier }] });
  for (const j of fresh?.running ?? []) {
    sessions.push({ id: `runner:${j.issueId}`, source: "runner", agent: engineerName(j, input.agents), agentId: engineerOf(j.engine, input.agents), state: "working", startedAt: j.startedAt, doing: jobDoing(j), said: j.said, saidAt: j.saidAt, plan: j.plan, steps: j.steps, ...ref(j) });
  }
  for (const j of fresh?.queued ?? []) {
    const agentId = (await resolve(j.issueId)).assigneeAgentId ?? null;
    sessions.push({ id: `runner:queued:${j.issueId}`, source: "runner", agent: (agentId && name(agentId, "Engineer")) || "Engineer", agentId, state: "queued", startedAt: null, doing: "Waiting for a free slot", ...ref(j) });
  }

  const finished: Finished[] = [];
  for (const r of input.past) {
    if (!shown(r) || !r.finishedAt) continue;
    const { run, tasks } = await resolve(r.issueId);
    finished.push({ id: r.id, source: "agent", agent: name(r.agentId), agentId: r.agentId, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, detail: r.error ?? undefined, run, tasks });
  }
  for (const j of runner?.recent ?? []) {
    if (!j.finishedAt || now - Date.parse(j.finishedAt) > FINISHED_WINDOW_MS) continue;
    finished.push({ id: `runner:${j.issueId}:${j.startedAt}`, source: "runner", agent: engineerName(j, input.agents), agentId: engineerOf(j.engine, input.agents), status: j.status ?? "finished", startedAt: j.startedAt, finishedAt: j.finishedAt, detail: jobDoing(j), ...ref(j) });
  }
  finished.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  return { sessions, finished: finished.slice(0, 25), runner: { reportedAt: runner?.at ?? null, stale: !fresh } };
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

/** The Engineer for a runner job, from the engine label it reports ("Claude Code (opus)", "Codex", "OpenRouter …"). */
const LABEL_ADAPTER: [RegExp, string][] = [[/^Codex\b/, "codex_local"], [/^Claude Code\b/, "claude_local"], [/^OpenRouter\b/, "opencode_local"]];
function engineerOf(label: string | undefined, agents: Agent[]): string | null {
  const adapter = LABEL_ADAPTER.find(([re]) => re.test(label ?? ""))?.[1];
  const agent = adapter && agents.find((a) => a.adapterType === adapter && /^aidenhq:engineer(-|$)/.test(a.metadata?.setupKey ?? "") && a.status !== "terminated");
  return agent ? agent.id : null;
}

// The Engineer's own name (from its handbook), then the engine it ran on; without such an agent, the engine label alone.
const engineerName = (j: RunnerJob, agents: Agent[]) => {
  const id = engineerOf(j.engine, agents);
  const own = id && agents.find((a) => a.id === id)?.name;
  return own && !own.startsWith("Engineer") ? (j.engine ? `${own} · ${j.engine}` : own) : j.engine ? `Engineer · ${j.engine}` : "Engineer";
};
const jobDoing = (j: RunnerJob) => [j.mode && j.mode[0]!.toUpperCase() + j.mode.slice(1), j.repo].filter(Boolean).join(" in ") || undefined;
