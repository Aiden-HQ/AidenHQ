// What the agents are doing: the kernel's jobs.
import { z } from "zod";
import { agentPaused } from "./aidenhq-sdk/agent-paused.js";
import type { Step } from "./codex-activity.js";
import type { KernelActivity, LiveRun, PastRun } from "./runs.js";
import { type Agent, type Issue, type Routine } from "./paperclip.js";
import { faceKitProblem, type FaceKit } from "./face-kit.js";

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
  /** The agent behind the run. */
  agentId: string | null;
  state: "working" | "queued";
  startedAt: string | null;
  /** The agent's latest message, when its session log has one. */
  said?: string;
  saidAt?: string;
  /** The agent's own task list (Codex's plan). */
  plan?: PlanItem[];
  /** Its tool calls so far. */
  steps?: Step[];
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
  /** A teammate (an agent the owner sees by name); without one the agent is hidden staff. */
  teammate?: RosterTeammate;
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
  /** What the kernel's jobs say (agentState); paused is the owner's setting on the agent. A team record rolls up its members. */
  state: AgentState;
  /** Failing: the latest failure's first error line. Waiting: why the earliest wait was parked. */
  stateNote?: string;
  /** Waiting: when the earliest parked wait is due. */
  waitUntil?: string;
  /** Running and waiting jobs now, and when the oldest running one started. */
  running: number;
  queued: number;
  workingSince: string | null;
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

/** The agent's definition key ("aidenhq:fleet-ops" → "fleet-ops"). */
export function keyOf(a: Pick<Agent, "metadata">): string | undefined {
  const k = a.metadata?.setupKey;
  return typeof k === "string" && k.startsWith("aidenhq:") ? k.slice(8) : undefined;
}

/** A teammate's face: its shipped file the board serves, the kit spec its module picked, or none (the kit draws one from the key). */
export type RosterFace = { src: string } | { kit: FaceKit } | null;
export interface RosterTeammate { job: string; sample: string; staff: string[]; controls: string[]; face: RosterFace }
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The teammate block setup wrote (scripts/paperclip-setup.ts display()), or undefined for a hidden agent: the one parser. */
export function teammateOf(a: Pick<Agent, "metadata">): RosterTeammate | undefined {
  const t = a.metadata?.teammate as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object" || typeof t.job !== "string" || typeof t.sample !== "string") return undefined;
  const key = keyOf(a);
  const face: RosterFace = typeof t.face === "string" && key ? { src: `/api/faces/${key}` } : t.face && !faceKitProblem(t.face) ? { kit: t.face as FaceKit } : null;
  return { job: t.job, sample: t.sample, staff: strings(t.staff), controls: strings(t.controls), face };
}

function identity(a: Pick<Agent, "metadata">): { key?: string; teammate?: RosterTeammate } {
  const key = keyOf(a);
  const teammate = teammateOf(a);
  return { ...(key ? { key } : {}), ...(teammate ? { teammate } : {}) };
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

export type AgentState = "working" | "queued" | "waiting" | "idle" | "failing" | "paused";

/** Working: a running kernel job. Failing: the agent's last 3 jobs all failed or were lost. Queued: work that can start now. Waiting: only waits it parked for later. Paused: the owner's setting. */
function agentState(a: Agent, act: KernelActivity): Pick<RosterAgent, "state" | "stateNote" | "waitUntil" | "running" | "queued" | "workingSince"> {
  const running = act.running.filter((r) => r.agent === a.id);
  const queued = act.queued.find((q) => q.agent === a.id)?.n ?? 0;
  const failing = act.failing.find((f) => f.agent === a.id);
  const parked = act.parked.find((p) => p.agent === a.id);
  const workingSince = running.map((r) => r.started_at).filter((t): t is string => Boolean(t)).sort()[0] ?? null;
  const state = agentPaused(a) ? "paused" : running.length ? "working" : failing ? "failing" : queued ? "queued" : parked ? "waiting" : "idle";
  return { state, ...(failing && state === "failing" ? { stateNote: failing.error } : {}), ...(parked && state === "waiting" ? { stateNote: parked.cause, waitUntil: parked.until } : {}), running: running.length, queued, workingSince };
}

/** A team record never runs: it is working if any member is, failing if every member is, queued if any is queued, waiting if any is. */
function rolledUp(team: RosterAgent, members: RosterAgent[]): Partial<RosterAgent> {
  const any = (s: AgentState) => members.some((m) => m.state === s);
  const state: AgentState = team.state === "paused" ? "paused" : any("working") ? "working" : members.length && members.every((m) => m.state === "failing") ? "failing" : members.some((m) => m.queued) ? "queued" : any("waiting") ? "waiting" : "idle";
  const since = members.map((m) => m.workingSince).filter((t): t is string => Boolean(t)).sort()[0] ?? null;
  const next = members.filter((m) => m.waitUntil).sort((x, y) => x.waitUntil!.localeCompare(y.waitUntil!))[0];
  return { state, ...(state === "failing" ? { stateNote: members[0]!.stateNote } : {}), ...(state === "waiting" && next ? { stateNote: next.stateNote, waitUntil: next.waitUntil } : {}), running: members.reduce((n, m) => n + m.running, 0), queued: members.reduce((n, m) => n + m.queued, 0), workingSince: since };
}

/** The live agents (terminated ones never show) with their schedules, state and newest run. */
export function roster(agents: Agent[], routines: Routine[], last: Map<string, { at: string; status: string }>, act: KernelActivity): RosterAgent[] {
  const rows = agents
    .filter((a) => a.status !== "terminated")
    .map((a): RosterAgent => ({
      id: a.id,
      name: a.name,
      ...identity(a),
      title: a.title?.trim() || null,
      system: Boolean(a.metadata?.module) && a.metadata?.tier !== "local",
      department: departmentOf(a),
      model: shortModel(a),
      reportsTo: a.reportsTo ?? null,
      ...teamOf(a),
      ...agentState(a, act),
      schedules: routines
        .filter((r) => r.assigneeAgentId === a.id && r.status !== "archived" && (r.triggers ?? []).some((t) => t.kind === "schedule" || t.nextRunAt))
        .map((r) => ({ title: r.title, paused: r.status === "paused", nextRunAt: (r.triggers ?? []).filter((t) => t.enabled !== false).map((t) => t.nextRunAt).filter((x): x is string => Boolean(x)).sort()[0] ?? null })),
      lastRunAt: last.get(a.id)?.at ?? null,
      lastRunStatus: last.get(a.id)?.status ?? null,
    }));
  return rows.map((r) => (r.team && r.key ? { ...r, ...rolledUp(r, rows.filter((m) => m.memberOf === r.key)) } : r));
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
  // Every run's task is looked up at once (each is a task read), then read back in order.
  const looked = new Map<string | null, Promise<RunContext>>();
  const resolve = (id: string | null) => {
    if (!looked.has(id)) looked.set(id, input.resolve(id));
    return looked.get(id)!;
  };
  const shown = (r: PastRun) => !!r.finishedAt && now - Date.parse(r.finishedAt) <= FINISHED_WINDOW_MS;
  for (const id of [...input.live.map((r) => r.issueId), ...input.past.filter(shown).map((r) => r.issueId)]) void resolve(id);
  const sessions: Session[] = [];
  for (const r of input.live) {
    const { run, tasks } = await resolve(r.issueId);
    sessions.push({
      id: r.id,
      agent: name(r.agentId),
      agentId: r.agentId,
      state: "working",
      startedAt: r.startedAt,
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
