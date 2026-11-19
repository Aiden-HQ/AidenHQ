// A task a module files for an agent (POST /v1/tasks, role kernel.tasks): a background workflow's fixed text (a Dependabot PR to
// handle, a UI head to review, a decision for the agent that asked), never an agent's or a person's words. The kernel creates it
// with the owner's client, assigned to the agent holding the role the module names (grants `roles`: never an agent's key) or
// to an agent by id (the asker of a task, which the module read from the task),
// marked as the module's (`<!-- aidenhq-module:<module> -->`, which the dispatch module reads as a module's request, not the
// owner's) and keyed by the module's `source` (`<!-- source:<source> -->`, Paperclip idempotency key pw-<sha256>): filing the
// same source twice is one task. Its assignment wakes the agent (wakes.ts): no comment is needed to start it. The module
// closes its own tasks (POST /v1/tasks/:task/close) when their work is moot.
import { createHash } from "node:crypto";
import { neutral, type Api } from "./channels.ts";

/** The marker of a task a module filed (dispatch thread.ts reads it). */
export const MODULE_TASK = (module: string) => `<!-- aidenhq-module:${module} -->`;
const SOURCE = /^[\w.:/@#-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the owner holds the agent paused (or it is gone): Paperclip's lifecycle holds (manual, setup, budget, company
 * archived), never its runtime `status`, which stays "paused" while a pause or resume waits on Paperclip's stop proof. */
export const agentPaused = (a: { status: string; lifecycleHolds: string[] }) => a.status === "terminated" || a.lifecycleHolds.length > 0;

export class TaskError extends Error {
  name = "TaskError";
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function createModuleTasks({ owner, agents, log = () => {} }: {
  owner: Api;
  /** The grants table's agents, by Paperclip id. */
  agents: () => Record<string, { roles?: string[] } | undefined>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  /**
   * Close a task this module filed (its marker, and no agent made it): done or cancelled, with one line why. The line carries
   * the kernel's tag (wakes.ts SELF_TAG), so it wakes nobody and is never read as the owner's words.
   */
  async function close(module: string, id: string, b: { status?: unknown; body?: unknown }) {
    const body = typeof b.body === "string" ? neutral(b.body).trim().slice(0, 2000) : "";
    if (!UUID.test(id) || !["done", "cancelled"].includes(String(b.status)) || !body) throw new TaskError(400, "send {status: done|cancelled, body}");
    const r = await owner("GET", `/api/issues/${encodeURIComponent(id)}`);
    if (r.status !== 200) throw new TaskError(404, `no task ${id}`);
    if (r.json.createdByAgentId || !String(r.json.description ?? "").includes(MODULE_TASK(module))) throw new TaskError(403, `${r.json.identifier ?? id} isn't a task ${module} filed`);
    if (["done", "cancelled"].includes(r.json.status)) return { status: String(r.json.status), already: true };
    const u = await owner("PATCH", `/api/issues/${encodeURIComponent(id)}`, { status: b.status, comment: `${body}\n\n<!-- aidenhq:job=${module.replace(/[^\w-]/g, "")} kind=status -->` });
    if (u.status >= 300) throw new TaskError(502, `the control plane answered ${u.status}`);
    log("module task closed", { module, task: r.json.identifier, status: b.status });
    return { status: String(b.status), already: false };
  }

  async function file(module: string, b: { title?: unknown; description?: unknown; role?: unknown; agent?: unknown; source?: unknown; parent?: unknown }) {
    const title = typeof b.title === "string" ? neutral(b.title).trim().slice(0, 200) : "";
    const description = typeof b.description === "string" ? neutral(b.description).trim().slice(0, 20_000) : "";
    const by = typeof b.role === "string" ? "role" : typeof b.agent === "string" ? "agent" : "";
    if (!title || !description || !by || (b.role !== undefined && b.agent !== undefined) || typeof b.source !== "string" || !SOURCE.test(b.source)) throw new TaskError(400, "send {title, description, role | agent, source, parent?}");
    if (b.parent !== undefined && (typeof b.parent !== "string" || !UUID.test(b.parent))) throw new TaskError(400, "parent is a task id");
    const role = String(b.role ?? "");
    // The first agent holding the role, in the grants table's order (setup writes it in the compiled order): one per role. Or
    // a named agent (by Paperclip id: a task's asker), which must be in the grants table.
    const agent = by === "role" ? Object.entries(agents()).find(([, g]) => (g?.roles ?? []).includes(role))?.[0] : agents()[String(b.agent)] ? String(b.agent) : undefined;
    if (!agent) throw new TaskError(409, by === "role" ? `no agent holds the role ${role}` : `no agent ${String(b.agent).slice(0, 60)}`);
    const a = await owner("GET", `/api/agents/${encodeURIComponent(agent)}`);
    if (a.status !== 200 || !a.json?.companyId) throw new TaskError(502, `the control plane answered ${a.status} for the agent`);
    if (agentPaused(a.json)) throw new TaskError(409, `${role || "the"} agent ${agent} is paused`);
    const r = await owner("POST", `/api/companies/${encodeURIComponent(String(a.json.companyId))}/issues`, {
      title, description: `${description}\n\n<!-- source:${b.source} -->\n${MODULE_TASK(module)}`, status: "todo", priority: "medium",
      assigneeAgentId: agent, assigneeUserId: null, allowDuplicate: true, ...(b.parent ? { parentId: b.parent } : {}),
      idempotencyKey: `pw-${createHash("sha256").update(b.source).digest("hex").slice(0, 32)}`,
    });
    if (r.status >= 300 || !r.json?.id) throw new TaskError(502, `the control plane answered ${r.status}`);
    log("module task filed", { module, task: r.json.identifier, agent, source: b.source, deduplicated: Boolean(r.json.deduplicated) });
    return { id: String(r.json.id), identifier: String(r.json.identifier ?? ""), agent, deduplicated: Boolean(r.json.deduplicated) };
  }
  return { file, close };
}
export type ModuleTasks = ReturnType<typeof createModuleTasks>;
