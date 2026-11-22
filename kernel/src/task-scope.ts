// What a job may write on, in one place: the control plane's rule (cp.ts) and the kernel's own when a conn.tool call names
// the task its record belongs to (writes.ts fileTool). A task is a job's to write on when it is assigned to the job's agent,
// was created by it, or is a child of a task assigned to it. Nothing else; naming a task never widens authority.
export type TaskIssue = { id: string; identifier?: string | null; assigneeAgentId?: string | null; createdByAgentId?: string | null; parentId?: string | null; status?: string };

/** The grants table as setup writes it: each agent's log tasks, and the shared Fleet issues log (its identifier). */
export type LogGrants = { agents?: Record<string, { review_log?: string; chat_task?: string } | undefined>; fleet_issues?: string };

/**
 * Setup's log tasks (scripts/modules.ts ensureLogTasks, ensureFleetIssues), by id or identifier, from the grants table only:
 * an agent holds each, but holding one never widens what it may write there (comments only, cp.ts), and none wakes anyone.
 */
export function logTasks(g: LogGrants): Set<string> {
  return new Set([...Object.values(g.agents ?? {}).flatMap((a) => [a?.review_log, a?.chat_task]), g.fleet_issues].filter((x): x is string => typeof x === "string" && x !== ""));
}
export const isLogTask = (t: { id: string; identifier?: string | null }, logs: Set<string>) => logs.has(t.id) || Boolean(t.identifier && logs.has(t.identifier));

/**
 * Why `agent` may write on task `t` (`own`, `created`, `child`), or undefined. `issue` reads a parent by id. A log task, or a
 * child of one, is never in scope (`logs`): its holder only comments there.
 */
export async function scopeOf(t: TaskIssue, agent: string, issue: (ref: string) => Promise<TaskIssue | undefined>, logs: Set<string> = new Set()): Promise<"own" | "created" | "child" | undefined> {
  if (isLogTask(t, logs)) return undefined;
  if (t.assigneeAgentId === agent) return "own";
  if (t.createdByAgentId === agent) return "created";
  if (t.parentId) {
    const parent = await issue(t.parentId).catch(() => undefined);
    if (parent && !isLogTask(parent, logs) && parent.assigneeAgentId === agent) return "child";
  }
  return undefined;
}
