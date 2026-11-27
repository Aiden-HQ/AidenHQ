// No dead ends (ported from the runner's tellAsker, askDelegator, tellOwner and reportToParent): what an agent's task needs
// reaches whoever asked for it. An open parent hears it as a wake notice, which wakes its agent; with no open parent, what
// someone must decide goes to the asking agent as a task of its own (kernel POST /v1/tasks), and when that agent is paused or
// gone, to the owner through the one notify (kernel POST /v1/notify), in fixed words. A comment on a closed parent would reopen
// it, so a closed parent hears nothing.
import { createHash } from "node:crypto";
import { KernelError, type Kernel } from "./kernel.ts";
import { agentMade, type Directory, type Issue } from "./thread.ts";
import { requestedParentOf, requesterOfListed } from "./requested-parent.ts";

const CLOSED = new Set(["done", "cancelled"]);
const h16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Who heard it: the open parent, the asking agent's own task (with the card it is filed as or already had), the owner, or nobody
 * (an owner's task: its note stays on it).
 */
export type Told = { heard: "parent"; } | { heard: "asker"; card: string } | { heard: "owner" } | { heard: false };

export function createAsker(kernel: Kernel) {
  /** `needs`: what the owner's line says the task needs ("was stopped"); without it only an open delegator hears. */
  async function tell(task: Issue, text: string, needs?: string, key = text): Promise<Told> {
    // The task that asked for this one, not the task the control plane placed it under: a grandchild request becomes a
    // sibling of its requester, and its requester still hears it (requested-parent.ts).
    const asked = requestedParentOf(task);
    const parent = asked ? await kernel.task(asked).catch(() => undefined) : undefined;
    if (parent && !CLOSED.has(String(parent.status))) return (await kernel.wake(parent.id, text), { heard: "parent" });
    if (!needs || !agentMade(task)) return { heard: false };
    try {
      const card = await kernel.fileTask({
        agent: task.createdByAgentId!, title: `Decision needed: ${task.identifier}`, source: `escalation:${task.id}:${h16(key)}`,
        description: `${text}\n\nDecide on ${task.identifier} itself (it is not this task), as the note above says: your comment there is read as your next word on it. Then close this task.`,
      });
      return { heard: "asker", card: card?.id ?? "" };
    } catch (e) {
      if (!(e instanceof KernelError && e.status === 409)) throw e; // 409: the asker is paused or gone
    }
    await kernel.notify({ kind: "decision", task: String(task.identifier), dedupe_key: `owner-told:${task.id}:${h16(key)}`,
      text: `🔧 **${task.identifier} ${needs}**, and the agent that asked for it is paused or gone. What it needs is on ${task.identifier}: reply there to carry on, or cancel it.` });
    return { heard: "owner" };
  }

  /**
   * When the last of a parent's agent-made sub-tasks ends a run, one summary for whoever asked (the parent's agent), so the
   * parent isn't silent while the results sit on N tasks. `ended`: each sub-task's last run (state), from the kernel's jobs;
   * `live`: sub-tasks with a run going. Skipped when every sub-task was cancelled.
   * Returns the key of the batch it reported (the newest job), or undefined while a sibling is still busy.
   */
  async function summarize(task: Issue, { ended, live, dir }: { ended: (task: string) => Promise<{ seq: number; state: string } | undefined>; live: (task: string) => Promise<boolean>; dir: Directory }) {
    // The requester's batch: the tasks filed under it, the ones a delegation asked it for but the control plane placed beside
    // it included (requested-parent.ts), and not a task that asked for one of those.
    const asked = requestedParentOf(task);
    if (!asked) return undefined;
    // The requester's tasks wherever the control plane placed them: beside it under its parent, or at the top level when the
    // create didn't authorize the placement (kernel.children reads both). A list cuts a long description to 1200 chars, so a
    // row that may hide the requester is read whole (requested-parent.ts). The task itself is one of the batch.
    const listed = new Map<string, Issue>();
    for (const place of [asked, task.parentId].filter(Boolean) as string[]) for (const c of await kernel.children(place, task.companyId!)) listed.set(c.id, c);
    listed.set(task.id, task);
    const found = await Promise.all([...listed.values()].map(async (c) => ({
      ...c, asked: await requesterOfListed(c, (id) => kernel.task(id)),
    })));
    const siblings = found.filter((c) => c.asked === asked).filter((c) => agentMade(c) && c.assigneeAgentId && dir[c.assigneeAgentId]);
    const runs = await Promise.all(siblings.map(async (c) => ({ c, run: await ended(c.id), live: await live(c.id) })));
    if (!siblings.length || runs.some((r) => r.live || (!r.run && ["todo", "in_progress"].includes(String(r.c.status))))) return undefined;
    const rows = runs.sort((a, b) => String(a.c.identifier).localeCompare(String(b.c.identifier), undefined, { numeric: true }));
    const batch = Math.max(...rows.map((r) => r.run?.seq ?? 0));
    const failed = rows.filter((r) => r.c.status !== "cancelled" && r.run && r.run.state !== "done");
    if (!failed.length && rows.every((r) => r.c.status === "cancelled")) return batch;
    const text = `**The ${rows.length} task${rows.length === 1 ? "" : "s"} for this have finished a run:**\n\n${rows.map((r) => `- ${r.c.identifier}: ${r.c.status}${r.run ? `, last run ${r.run.state}` : ""}`).join("\n")}\n\nTheir replies are on each task.`;
    await tell(task, text, failed.length ? `has ${failed.length === 1 ? "a run" : "runs"} that stopped` : undefined);
    return batch;
  }
  return { tell, summarize };
}
