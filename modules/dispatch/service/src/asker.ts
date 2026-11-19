// No dead ends (ported from the runner's tellAsker, askDelegator, tellOwner and reportToParent): what an agent's task needs
// reaches whoever asked for it. An open parent hears it as a wake notice, which wakes its agent; with no open parent, what
// someone must decide goes to the asking agent as a task of its own (kernel POST /v1/tasks), and when that agent is paused or
// gone, to the owner through the one notify (kernel POST /v1/notify), in fixed words. A comment on a closed parent would reopen
// it, so a closed parent hears nothing.
import { createHash } from "node:crypto";
import { KernelError, type Kernel } from "./kernel.ts";
import { agentMade, type Directory, type Issue } from "./thread.ts";

const CLOSED = new Set(["done", "cancelled"]);
const h16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Who heard it: the open parent, the asking agent's own task, the owner, or nobody (an owner's task: its note stays on it). */
export type Told = "parent" | "asker" | "owner" | false;

export function createAsker(kernel: Kernel) {
  /** `needs`: what the owner's line says the task needs ("was stopped"); without it only an open parent hears. */
  async function tell(task: Issue, text: string, needs?: string, key = text): Promise<Told> {
    const parent = task.parentId ? await kernel.task(task.parentId).catch(() => undefined) : undefined;
    if (parent && !CLOSED.has(String(parent.status))) return (await kernel.wake(parent.id, text), "parent");
    if (!needs || !agentMade(task)) return false;
    try {
      await kernel.fileTask({
        agent: task.createdByAgentId!, title: `Decision needed: ${task.identifier}`, source: `escalation:${task.id}:${h16(key)}`,
        description: `${text}\n\nDecide on ${task.identifier} itself (it is not this task), as the note above says: your comment there is read as your next word on it. Then close this task.`,
      });
      return "asker";
    } catch (e) {
      if (!(e instanceof KernelError && e.status === 409)) throw e; // 409: the asker is paused or gone
    }
    await kernel.notify({ kind: "decision", task: String(task.identifier), dedupe_key: `owner-told:${task.id}:${h16(key)}`,
      text: `🔧 **${task.identifier} ${needs}**, and the agent that asked for it is paused or gone. What it needs is on ${task.identifier}: reply there to carry on, or cancel it.` });
    return "owner";
  }

  /**
   * When the last of a parent's agent-made sub-tasks ends a run, one summary for whoever asked (the parent's agent), so the
   * parent isn't silent while the results sit on N tasks. `ended`: each sub-task's last run (state), from the kernel's jobs;
   * `live`: sub-tasks with a run going. Skipped when every run finished and every one is graded (the grader speaks then).
   * Returns the key of the batch it reported (the newest job), or undefined while a sibling is still busy.
   */
  async function summarize(task: Issue, { ended, live, dir }: { ended: (task: string) => Promise<{ seq: number; state: string } | undefined>; live: (task: string) => Promise<boolean>; dir: Directory }) {
    const siblings = (await kernel.children(task.parentId!, task.companyId!)).filter((c) => agentMade(c) && c.assigneeAgentId && dir[c.assigneeAgentId]);
    const runs = await Promise.all(siblings.map(async (c) => ({ c, run: await ended(c.id), live: await live(c.id) })));
    if (!siblings.length || runs.some((r) => r.live || (!r.run && ["todo", "in_progress"].includes(String(r.c.status))))) return undefined;
    const rows = runs.sort((a, b) => String(a.c.identifier).localeCompare(String(b.c.identifier), undefined, { numeric: true }));
    const batch = Math.max(...rows.map((r) => r.run?.seq ?? 0));
    const failed = rows.filter((r) => r.c.status !== "cancelled" && r.run && r.run.state !== "done");
    if (!failed.length && rows.every((r) => r.c.status === "cancelled" || dir[r.c.assigneeAgentId!]?.graded)) return batch;
    const text = `**The ${rows.length} task${rows.length === 1 ? "" : "s"} for this have finished a run:**\n\n${rows.map((r) => `- ${r.c.identifier}: ${r.c.status}${r.run ? `, last run ${r.run.state}` : ""}`).join("\n")}\n\nTheir replies are on each task.`;
    await tell(task, text, failed.length ? `has ${failed.length === 1 ? "a run" : "runs"} that stopped` : undefined);
    return batch;
  }
  return { tell, summarize };
}
