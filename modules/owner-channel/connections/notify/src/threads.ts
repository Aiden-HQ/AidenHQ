// Which chat a notify message belongs to, and where the owner last wrote in it (their reply goes back there).

/** The chat's recorded agent (the marker the board and channel-telegram append to a chat's description). */
function chatAgentOf(description: string | null | undefined): string | undefined {
  // Only the marker appended at the very end counts (one pasted into the text above it is ignored).
  return /\n\n<!-- aidenhq-chat-agent:([A-Za-z0-9_-]+) -->\s*$/.exec(description ?? "")?.[1] ?? undefined;
}

/**
 * The task a notify(task) message may claim: an open task with an agent assignee, whose name heads the message. notify then
 * keeps it only when that agent is the caller (any open task assigned to it, not only the one its job runs on: a sweep asks
 * on its part of the owner's task), so one agent never heads a message with another's name or routes the owner's reply onto
 * another agent's task.
 */
export function taskForNotify(
  issue: { id: string; status?: string | null; assigneeAgentId: string | null },
  agents: { id: string; name: string }[],
): { issueId: string; agentId: string; agentName: string } | undefined {
  const agent = agents.find((a) => a.id === issue.assigneeAgentId);
  if (!agent || ["done", "cancelled"].includes(String(issue.status ?? ""))) return undefined;
  return { issueId: issue.id, agentId: agent.id, agentName: agent.name };
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

type ViaIssue ={ description?: string | null; parentId?: string | null; createdByAgentId?: string | null; createdByUserId?: string | null };
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
