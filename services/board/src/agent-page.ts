// The agent page's reads (web/src/AgentPage.tsx): one agent's profile and its tasks, open and past.
import { roster, type AgentState, type RosterAgent } from "./activity.js";
import type { KernelActivity } from "./runs.js";
import { needsOwner, type ShownState } from "./task-state.js";
import type { Agent, Issue, Routine } from "./paperclip.js";

export interface AgentProfile {
  id: string;
  key: string;
  name: string;
  avatar?: string;
  title: string | null;
  state: AgentState;
  stateNote?: string;
  model: string | null;
  effort: string | null;
  reportsTo: string | null;
  /** Where its module comes from (a local module: the instance's own). */
  source: { module: string; marketplace: string | null; tier: string | null; revision: string | null } | null;
  schedules: RosterAgent["schedules"];
}

export interface TaskRow {
  identifier: string;
  title: string;
  /** The kernel's state of the task (none when it has no facts). */
  state: ShownState | null;
  updatedAt: string;
  /** The creator: an agent's name, "You" for the owner, null if unknown. */
  from: string | null;
}

export const HISTORY_PAGE = 30;

export function agentByKey(agents: Agent[], key: string): Agent | undefined {
  return agents.find((a) => a.metadata?.setupKey === `aidenhq:${key}` && a.status !== "terminated");
}

const when = (i: Issue) => i.lastActivityAt ?? i.updatedAt;
const newest = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);

export function taskRow(i: Issue, state: TaskRow["state"], agents: Agent[], updatedAt = when(i)): TaskRow {
  const from = i.createdByAgentId ? (agents.find((a) => a.id === i.createdByAgentId)?.name ?? null) : i.createdByUserId ? "You" : null;
  return { identifier: i.identifier, title: i.title, state, updatedAt, from };
}

/** The agent's open tasks (chats are not tasks). */
export const tasksOf = (issues: Issue[], agentId: string, chatLabelId: string | undefined): Issue[] =>
  issues.filter((i) => i.assigneeAgentId === agentId && !(chatLabelId && (i.labelIds?.includes(chatLabelId) || i.labels?.some((l) => l.id === chatLabelId))));

/** Those tasks split into what waits on the owner (`needs`, by the kernel's attention) and the rest, newest first. */
export function splitTasks(mine: Issue[], states: Map<string, ShownState>, agents: Agent[] = []): { needs: TaskRow[]; ongoing: TaskRow[] } {
  const rows = (list: Issue[]) => list.map((i) => taskRow(i, states.get(i.id) ?? null, agents)).sort(newest);
  return { needs: rows(mine.filter((i) => needsOwner(states.get(i.id)))), ongoing: rows(mine.filter((i) => !needsOwner(states.get(i.id)))) };
}

/** One page of finished tasks (Paperclip filtered and paged them), chats left out; `next` is the following offset when the raw page was full. */
export function historyPage(closed: Issue[], offset: number, chatLabelId: string | undefined, states: Map<string, ShownState>, agents: Agent[] = []): { rows: TaskRow[]; next: number | null } {
  const isChat = (i: Issue) => Boolean(chatLabelId && (i.labelIds?.includes(chatLabelId) || i.labels?.some((l) => l.id === chatLabelId)));
  return {
    rows: closed.filter((i) => !isChat(i)).map((i) => taskRow(i, states.get(i.id) ?? null, agents, i.updatedAt)),
    next: closed.length === HISTORY_PAGE ? offset + HISTORY_PAGE : null,
  };
}

export interface ProfileInputs {
  agent: Agent;
  agents: Agent[];
  routines: Routine[];
  activity: KernelActivity;
  effort: string | null;
  catalog: { name: string; marketplace?: string; tier?: string; revision?: string }[];
}

export function agentProfile({ agent, agents, routines, activity, effort, catalog }: ProfileInputs): AgentProfile {
  const r = roster([agent], routines, new Map(), activity)[0]!;
  const module = typeof agent.metadata?.module === "string" ? agent.metadata.module : "";
  const entry = catalog.find((m) => m.name === module);
  return {
    id: agent.id,
    key: r.key ?? "",
    name: agent.name,
    ...(r.avatar ? { avatar: r.avatar } : {}),
    title: r.title,
    state: r.state,
    ...(r.stateNote ? { stateNote: r.stateNote } : {}),
    model: r.model,
    effort: effort || null,
    reportsTo: agents.find((a) => a.id === agent.reportsTo)?.name ?? null,
    source: module ? { module, marketplace: entry?.marketplace ?? null, tier: entry?.tier ?? null, revision: entry?.revision?.slice(0, 7) ?? null } : null,
    schedules: r.schedules,
  };
}
