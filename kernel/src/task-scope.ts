// What a job may write on, in one place: the control plane's rule (cp.ts) and the kernel's own when a conn.tool call names
// the task its record belongs to (writes.ts fileTool). A task is a job's to write on when it is assigned to the job's agent,
// was created by it, or is a child of a task assigned to it. Nothing else; naming a task never widens authority.
export type TaskIssue = { id: string; identifier?: string | null; assigneeAgentId?: string | null; createdByAgentId?: string | null; parentId?: string | null; status?: string };

/** Why `agent` may write on task `t` (`own`, `created`, `child`), or undefined. `issue` reads a parent by id. */
export async function scopeOf(t: TaskIssue, agent: string, issue: (ref: string) => Promise<TaskIssue | undefined>): Promise<"own" | "created" | "child" | undefined> {
  if (t.assigneeAgentId === agent) return "own";
  if (t.createdByAgentId === agent) return "created";
  if (t.parentId) {
    const parent = await issue(t.parentId).catch(() => undefined);
    if (parent?.assigneeAgentId === agent) return "child";
  }
  return undefined;
}
