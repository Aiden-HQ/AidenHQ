// The end-of-run status check's rule, apart from worker.js so it can be tested without the SDK.
/** A task this agent left in progress. Never a chat (label `chat`): a chat stays open between turns. */
export const leftInProgress = (issue, agentId) =>
  Boolean(issue) && issue.status === "in_progress" && issue.assigneeAgentId === agentId && !(issue.labels ?? []).some((l) => l?.name === "chat");
