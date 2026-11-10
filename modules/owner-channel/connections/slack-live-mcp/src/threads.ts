// Which chat an owner message belongs to: a reply to an agent's message continues that chat; a leading
// @name starts a new chat with that agent (an unknown or paused name goes to Aiden, with a note); anything else goes
// to Aiden's daily chat.
import type { Store } from "./store.js";

export interface AgentLite {
  id: string;
  name: string;
  status: string;
  metadata?: { setupKey?: unknown } | null;
}
export type OwnerRoute = { kind: "reply"; issueId: string } | { kind: "new"; agentId: string; note?: string } | { kind: "aiden" };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function routeOwnerMessage(text: string, replyTo: { chatId: string; messageId: string } | undefined, store: Store, agents: AgentLite[]): OwnerRoute {
  const issueId = replyTo ? store.threadOf("telegram", replyTo.chatId, replyTo.messageId) : undefined;
  if (issueId) return { kind: "reply", issueId };
  const m = /^@(\S+(?:[ -]\S+){0,3})/.exec(text.trim());
  if (!m) return { kind: "aiden" };
  const said = norm(m[1]!);
  const aiden = agents.find((a) => a.metadata?.setupKey === "aidenhq:chief-of-staff") ?? agents[0];
  const hit = agents
    .filter((a) => a.status !== "paused" && a.status !== "terminated")
    .flatMap((a) => [norm(a.name), norm(String(a.metadata?.setupKey ?? "").replace(/^aidenhq:/, ""))].filter(Boolean).map((n) => ({ a, n })))
    .filter(({ n }) => said === n || said.startsWith(`${n} `))
    .sort((x, y) => y.n.length - x.n.length)[0];
  if (hit) return { kind: "new", agentId: hit.a.id };
  if (!aiden) return { kind: "aiden" };
  return { kind: "new", agentId: aiden.id, note: `(No agent called @${m[1]!.split(/\s/)[0]}; sent to Aiden.)` };
}

/**
 * The chat a notify_owner(task) message may claim: only a task its own agent is running on right now. Until shared
 * tools know who is calling, this keeps one agent from heading a message with another agent's name or
 * routing the owner's reply onto another agent's task.
 */
export function taskForNotify(
  issue: { id: string; assigneeAgentId: string | null },
  live: { issueId: string | null; agentId: string }[],
  agents: { id: string; name: string }[],
): { issueId: string; agentId: string; agentName: string } | undefined {
  const agent = agents.find((a) => a.id === issue.assigneeAgentId);
  if (!agent || !live.some((r) => r.issueId === issue.id && r.agentId === agent.id)) return undefined;
  return { issueId: issue.id, agentId: agent.id, agentName: agent.name };
}

/** Recorded in a chat's description when it is created (same marker as the board's): the agent the chat belongs to. */
export const chatAgentMarker = (agentId: string) => `<!-- aidenhq-chat-agent:${agentId} -->`;

/** The chat's recorded agent; never whoever commented last (any agent could comment to capture the owner's reply). */
export function chatAgentOf(description: string | null | undefined): string | undefined {
  // Only the marker appended at the very end counts (one pasted into the text above it is ignored).
  return /\n\n<!-- aidenhq-chat-agent:([A-Za-z0-9_-]+) -->\s*$/.exec(description ?? "")?.[1] ?? undefined;
}

/**
 * Where the owner last wrote in a chat: the bridge prefixes Telegram and Slack messages ("[telegram] …"); anything else they
 * wrote is the board. Agent comments and system notices (aidenhq markers) don't count; the opening message counts when
 * nothing later does.
 */
export function ownerVia(description: string | null | undefined, comments: { body: string; authorType?: string | null }[]): "board" | "telegram" | "slack" | undefined {
  const from = (t: string) => (/^\[telegram/.test(t) ? "telegram" : /^\[slack/.test(t) ? "slack" : "board");
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (c.authorType === "agent" || c.body.includes("<!-- aidenhq-")) continue;
    if (c.body.trim()) return from(c.body.trim());
  }
  const opening = String(description ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  return opening ? from(opening) : undefined;
}

type ViaIssue = { description?: string | null; parentId?: string | null; createdByAgentId?: string | null; createdByUserId?: string | null };
type ViaComment = { body: string; authorType?: string | null };
/**
 * Where an agent's message on a task goes: where the owner last wrote on it. Work handed out from a chat (a sub-task its
 * own agent or the owner created, e.g. Aiden's delegation) goes where the owner talks in that chat until they write on the
 * sub-task itself; its description is the delegating agent's words, not theirs. Another agent's sub-task never borrows it.
 */
export function ownerViaOf(issue: ViaIssue, comments: ViaComment[], parent?: { issue: ViaIssue & { assigneeAgentId?: string | null }; comments: ViaComment[] }): "board" | "telegram" | "slack" | undefined {
  const own = ownerVia(issue.parentId ? null : issue.description, comments);
  if (own || !issue.parentId || !parent) return own;
  const parentAgent = parent.issue.assigneeAgentId ?? chatAgentOf(parent.issue.description);
  const handedOut = issue.createdByAgentId ? issue.createdByAgentId === parentAgent : Boolean(issue.createdByUserId);
  return handedOut ? ownerVia(parent.issue.description, parent.comments) : undefined;
}
