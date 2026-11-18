// The end-of-run status check's rule, apart from worker.js so it can be tested without the SDK.
/** When this task's persisted check is due (Paperclip's `executionPolicy.monitor.nextCheckAt`), if it has one. */
const monitorAt = (issue) => {
  const at = issue?.executionPolicy?.monitor?.nextCheckAt;
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : undefined;
};
/** A check this task armed that is still ahead: the run settled into it, it did not abandon the task. */
export const settledWait = (issue, now = Date.now()) => {
  const at = monitorAt(issue);
  return at !== undefined && at > now;
};
/** A task this agent left in progress with no check ahead. Never a chat (label `chat`): a chat stays open between turns. */
export const leftInProgress = (issue, agentId, now = Date.now()) =>
  Boolean(issue) && issue.status === "in_progress" && issue.assigneeAgentId === agentId && !(issue.labels ?? []).some((l) => l?.name === "chat") && !settledWait(issue, now);
