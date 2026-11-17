// The agent page's reads (web/src/AgentPage.tsx): one agent's profile and its tasks, open and past.
import { roster, type RosterAgent } from "./activity.js";
import type { ChatState } from "./chats.js";
import type { Agent, Issue, Routine } from "./paperclip.js";

export interface AgentProfile {
  id: string;
  key: string;
  name: string;
  avatar?: string;
  title: string | null;
  status: string;
  trial: boolean;
  model: string | null;
  effort: string | null;
  reportsTo: string | null;
  /** Null for the instance's own agents. */
  source: { module: string; marketplace: string | null; tier: string | null; revision: string | null } | null;
  schedules: RosterAgent["schedules"];
}

export interface TaskRow {
  identifier: string;
  title: string;
  /** "stopped": a cancelled task (history). */
  state: ChatState | "stopped";
  updatedAt: string;
  /** The creator: an agent's name, "You" for the owner, null if unknown. */
  from: string | null;
}

/** States that wait on the owner. */
const NEEDS: string[] = ["waiting for you", "waiting for approval", "failed"];
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

/** The agent's open tasks (chats are not tasks), split into what waits on the owner and the rest, newest first. */
export function splitTasks(issues: Issue[], agentId: string, chatLabelId: string | undefined, stateOf: (i: Issue) => ChatState, agents: Agent[] = []): { needs: TaskRow[]; ongoing: TaskRow[] } {
  const rows = issues
    .filter((i) => i.assigneeAgentId === agentId && !(chatLabelId && (i.labelIds?.includes(chatLabelId) || i.labels?.some((l) => l.id === chatLabelId))))
    .map((i) => taskRow(i, stateOf(i), agents))
    .sort(newest);
  return { needs: rows.filter((r) => NEEDS.includes(r.state)), ongoing: rows.filter((r) => !NEEDS.includes(r.state)) };
}

/** One page of finished tasks (Paperclip filtered and paged them), chats left out; `next` is the following offset when the raw page was full. */
export function historyPage(closed: Issue[], offset: number, chatLabelId: string | undefined, agents: Agent[] = []): { rows: TaskRow[]; next: number | null } {
  const isChat = (i: Issue) => Boolean(chatLabelId && (i.labelIds?.includes(chatLabelId) || i.labels?.some((l) => l.id === chatLabelId)));
  return {
    rows: closed.filter((i) => !isChat(i)).map((i) => taskRow(i, i.status === "cancelled" ? "stopped" : "done", agents, i.updatedAt)),
    next: closed.length === HISTORY_PAGE ? offset + HISTORY_PAGE : null,
  };
}

export interface ProfileInputs {
  agent: Agent;
  agents: Agent[];
  routines: Routine[];
  effort: string | null;
  catalog: { name: string; marketplace?: string; tier?: string; revision?: string }[];
}

export function agentProfile({ agent, agents, routines, effort, catalog }: ProfileInputs): AgentProfile {
  const r = roster([agent], routines, new Map())[0]!;
  const module = typeof agent.metadata?.module === "string" ? agent.metadata.module : "";
  const entry = catalog.find((m) => m.name === module);
  return {
    id: agent.id,
    key: r.key ?? "",
    name: agent.name,
    ...(r.avatar ? { avatar: r.avatar } : {}),
    title: r.title,
    status: agent.status,
    trial: r.trial,
    model: r.model,
    effort: effort || null,
    reportsTo: agents.find((a) => a.id === agent.reportsTo)?.name ?? null,
    source: module && module !== "instance" ? { module, marketplace: entry?.marketplace ?? null, tier: entry?.tier ?? null, revision: entry?.revision?.slice(0, 7) ?? null } : null,
    schedules: r.schedules,
  };
}
