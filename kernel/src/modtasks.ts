// A task a module files for an agent (POST /v1/tasks, role kernel.tasks): a background workflow's fixed text (a Dependabot PR to
// handle, a UI head to review, a decision for the agent that asked), never an agent's or a person's words. The kernel creates it
// with the owner's client, assigned to the agent holding the role the module names (grants `roles`: never an agent's key) or
// to an agent by id (the asker of a task, which the module read from the task),
// marked as the module's (`<!-- aidenhq-module:<module> -->`, which the dispatch module reads as a module's request, not the
// owner's) and keyed by the module's `source` (`<!-- source:<source> -->`, Paperclip idempotency key pw-<sha256>): filing the
// same source twice is one task. Its assignment wakes the agent (wakes.ts): no comment is needed to start it. The module
// closes its own tasks (POST /v1/tasks/:task/close) when their work is moot, and lists them by source (GET /v1/tasks?source=)
// so a sweep with no id in hand finds the ones it filed.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { neutral, type Api } from "./channels.ts";
import { agentPaused } from "../sdk/src/agent-paused.ts";

/** The marker of a task a module filed (dispatch thread.ts reads it). */
export const MODULE_TASK = (module: string) => `<!-- aidenhq-module:${module} -->`;
const SOURCE = /^[\w.:/@#-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only source family a module lists, and the one the release train's sweep owns (a runner-era bump too: an ms stamp). */
export const RELEASE_SOURCE = "release:instance:";
const RELEASE_MARK = /<!--\s*source:(release:instance:(?:[0-9a-f]{40}|\d+))\s*-->/;
/** The runner-era stamp alone (a millisecond count, never the train's 40-hex sha): the only card-less bump a close may settle. */
const RUNNER_MARK = /<!--\s*source:release:instance:\d+\s*-->/;
/** The code host files these; the family is never opened up to another module. */
const RELEASE_MODULE = "codehost-github";

export class TaskError extends Error {
  name = "TaskError";
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function createModuleTasks({ db, owner, agents, rubric, applies = () => [], log = () => {} }: {
  /** The kernel's database: which tasks were filed graded, by which module (the finish check holds one with no grade row). */
  db: DatabaseSync;
  owner: Api;
  /** The grants table's agents, by Paperclip id. */
  agents: () => Record<string, { roles?: string[] } | undefined>;
  /** The kernel.apply records filed on a task (newest first), with the module that filed each. */
  applies?: (task: string) => { module: string }[];
  /** Files the grading rubric of a task the module filed (checks.ts rubric), as that module. */
  rubric?: (task: { id: string; identifier?: string }, module: string, b: { rubric: string[]; deliverable: unknown }) => Promise<void>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS graded_tasks (task TEXT PRIMARY KEY, module TEXT NOT NULL)");
  /**
   * Close a task this module filed (its marker, and no agent made it): done or cancelled, with one line why. The line carries
   * the kernel's tag (wakes.ts SELF_TAG), so it wakes nobody and is never read as the owner's words.
   */
  async function close(module: string, id: string, b: { status?: unknown; body?: unknown; uncarded?: unknown }) {
    const body = typeof b.body === "string" ? neutral(b.body).trim().slice(0, 2000) : "";
    if (!UUID.test(id) || !["done", "cancelled"].includes(String(b.status)) || !body) throw new TaskError(400, "send {status: done|cancelled, body}");
    const r = await owner("GET", `/api/issues/${encodeURIComponent(id)}`);
    if (r.status !== 200) throw new TaskError(404, `no task ${id}`);
    // `uncarded` is its own, narrower path for the one card-less task the sweep settles (the runner's ms stamp); the ownership
    // guard itself never admits a task with no kernel.apply, so a record-less bump can never pass it by vacuous truth.
    const own = String(r.json.description ?? "").includes(MODULE_TASK(module));
    const ok = !r.json.createdByAgentId && (own || releaseBump(module, r.json) || (b.uncarded === true && runnerBumpUncarded(module, r.json)));
    if (!ok) throw new TaskError(403, `${r.json.identifier ?? id} isn't a task ${module} filed`);
    if (["done", "cancelled"].includes(r.json.status)) return { status: String(r.json.status), already: true };
    const u = await owner("PATCH", `/api/issues/${encodeURIComponent(id)}`, { status: b.status, comment: `${body}\n\n<!-- aidenhq:job=${module.replace(/[^\w-]/g, "")} kind=status -->` });
    if (u.status >= 300) throw new TaskError(502, `the control plane answered ${u.status}`);
    log("module task closed", { module, task: r.json.identifier, status: b.status });
    return { status: String(b.status), already: false };
  }

  /**
   * A stranded release-train bump: the sweep-era and runner-era tasks carry the train's source marker, never its module marker.
   * It is the code host's only when no other module's marker is on it and at least one kernel.apply exists on it, every one
   * filed by the code host: a bare id or another module's record refuses, and an empty list never passes by default.
   */
  function releaseBump(module: string, task: { id: string; description?: unknown }) {
    const description = String(task.description ?? "");
    if (module !== RELEASE_MODULE || !RELEASE_MARK.test(description) || /<!--\s*aidenhq-module:/.test(description)) return false;
    const records = applies(task.id);
    return records.length > 0 && records.every((c) => c.module === RELEASE_MODULE);
  }

  /**
   * The one bump that legitimately has no card: the runner filed it straight through the control plane with its millisecond
   * stamp (`release:instance:<ms>`) and never carded it. The candidate sweep settles exactly that task, once it is past the
   * batch window, with "no apply card was ever filed". A separate predicate, never an empty `every()`: a 40-hex bump with no
   * card is the current train's (it carries the module marker, closed above) and a 40-hex task without that marker is refused.
   */
  function runnerBumpUncarded(module: string, task: { id: string; description?: unknown }) {
    const description = String(task.description ?? "");
    if (module !== RELEASE_MODULE || !RUNNER_MARK.test(description) || /<!--\s*aidenhq-module:/.test(description)) return false;
    return applies(task.id).length === 0;
  }

  /**
   * The open tasks of this module's own source family, for a sweep that has no id in hand (the release train's stranded bumps).
   * The control plane's listing matches the source text; each row's marker is read again here, so a task that merely mentions
   * the family in prose is never returned. Only `release:instance:` is listable: no module reads another's tasks this way.
   */
  async function list(module: string, source: string) {
    if (module !== RELEASE_MODULE || source !== RELEASE_SOURCE) throw new TaskError(400, `source: ${RELEASE_SOURCE}`);
    const companies = await owner("GET", "/api/companies");
    if (companies.status !== 200 || !Array.isArray(companies.json)) throw new TaskError(502, `the control plane answered ${companies.status} for its companies`);
    const tasks: { id: string; identifier: string; status: string; createdAt: string; source: string }[] = [];
    for (const c of companies.json as { id?: unknown }[]) {
      const q = new URLSearchParams({ q: source, status: "backlog,todo,in_progress,in_review,blocked", limit: "200", excludeRoutineExecutions: "true" });
      const r = await owner("GET", `/api/companies/${encodeURIComponent(String(c.id ?? ""))}/issues?${q}`);
      if (r.status !== 200 || !Array.isArray(r.json)) throw new TaskError(502, `the control plane answered ${r.status} for a company's issues`);
      for (const i of r.json as { id?: unknown; identifier?: unknown; status?: unknown; createdAt?: unknown; description?: unknown }[]) {
        const found = RELEASE_MARK.exec(String(i.description ?? ""))?.[1];
        if (!found) continue;
        tasks.push({ id: String(i.id ?? ""), identifier: String(i.identifier ?? ""), status: String(i.status ?? ""), createdAt: String(i.createdAt ?? ""), source: found });
      }
    }
    return { tasks: tasks.filter((t) => t.id) };
  }

  async function file(module: string, b: { title?: unknown; description?: unknown; role?: unknown; agent?: unknown; source?: unknown; parent?: unknown; deliverable?: unknown; rubric?: unknown }) {
    const title = typeof b.title === "string" ? neutral(b.title).trim().slice(0, 200) : "";
    const description = typeof b.description === "string" ? neutral(b.description).trim().slice(0, 20_000) : "";
    const by = typeof b.role === "string" ? "role" : typeof b.agent === "string" ? "agent" : "";
    if (!title || !description || !by || (b.role !== undefined && b.agent !== undefined) || typeof b.source !== "string" || !SOURCE.test(b.source)) throw new TaskError(400, "send {title, description, role | agent, source, parent?, deliverable?, rubric?}");
    // A rubric is graded against its deliverable: both or neither (grading checks their contents).
    const graded = b.deliverable !== undefined || b.rubric !== undefined;
    if (graded && !(b.deliverable && typeof b.deliverable === "object" && Array.isArray(b.rubric) && b.rubric.every((c) => typeof c === "string"))) throw new TaskError(400, "deliverable {kind, ref} and rubric [criteria] go together");
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
      // A graded task's key names its module, so another module's source can never hit it (and its rubric is never attached to it).
      idempotencyKey: `pw-${createHash("sha256").update(graded ? `${module}\0${b.source}` : b.source).digest("hex").slice(0, 32)}`,
    });
    if (r.status >= 300 || !r.json?.id) throw new TaskError(502, `the control plane answered ${r.status}`);
    // Graded status is the kernel's own row, never the task's editable text. A dedup hit takes a rubric only on a task this
    // module filed graded.
    if (graded) {
      const had = (db.prepare("SELECT module FROM graded_tasks WHERE task = ?").get(String(r.json.id)) as { module: string } | undefined)?.module;
      if (r.json.deduplicated ? had !== module : false) throw new TaskError(409, `${r.json.identifier ?? "that task"} isn't a graded task ${module} filed`);
      db.prepare("INSERT OR IGNORE INTO graded_tasks (task, module) VALUES (?, ?)").run(String(r.json.id), module);
    }
    if (graded) await rubric!({ id: String(r.json.id), identifier: String(r.json.identifier ?? "") }, module, { rubric: b.rubric as string[], deliverable: b.deliverable }).catch((e: { name?: string; status?: number; message: string }) => { throw new TaskError(e.status ?? 502, `the task is filed but not graded (${e.message}): file it again`); });
    log("module task filed", { module, task: r.json.identifier, agent, source: b.source, deduplicated: Boolean(r.json.deduplicated) });
    return { id: String(r.json.id), identifier: String(r.json.identifier ?? ""), agent, deduplicated: Boolean(r.json.deduplicated) };
  }
  return { file, close, list };
}
export type ModuleTasks = ReturnType<typeof createModuleTasks>;
