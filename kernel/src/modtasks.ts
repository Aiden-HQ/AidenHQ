// A task a module files for an agent (POST /v1/tasks, role kernel.tasks): a background workflow's fixed text (a Dependabot PR to
// handle, a UI head to review, a decision for the agent that asked), never an agent's or a person's words. The kernel creates it
// with the owner's client, assigned to the agent holding the role the module names (grants `roles`: never an agent's key) or
// to an agent by id (the asker of a task, which the module read from the task),
// marked as the module's (`<!-- aidenhq-module:<module> -->`, which the dispatch module reads as a module's request, not the
// owner's; `quiet`: filed in the backlog, a holder for records that wakes nobody) and keyed by the module's `source` (`<!-- source:<source> -->`, Paperclip idempotency key pw-<sha256>): filing the
// same source twice is one task. Its assignment wakes the agent (wakes.ts): no comment is needed to start it. The module
// closes its own tasks (POST /v1/tasks/:task/close) when their work is moot, and lists them by source (GET /v1/tasks?source=)
// so a sweep with no id in hand finds the ones it filed. Both read the module marker generically: a task is this module's
// only when it carries this module's marker and no other module's, whatever source or prose its description also holds.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { neutral, type Api } from "./channels.ts";
import type { PluginPost } from "./outcomes.ts";
import { agentPaused } from "../sdk/src/agent-paused.ts";

/** The marker of a task a module filed (dispatch thread.ts reads it). */
export const MODULE_TASK = (module: string) => `<!-- aidenhq-module:${module} -->`;
const SOURCE = /^[\w.:/@#-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only source family a module lists, and the one the release train's sweep owns: a release's commit. */
export const RELEASE_SOURCE = "release:instance:";
const RELEASE_MARK = /<!--\s*source:(release:instance:[0-9a-f]{40})\s*-->/;
/** Any source marker, whatever its family (modtasks.ts `file()` writes one; a task may carry text like anyone's). */
const SOURCE_TAG = /<!--\s*source:(\S+)\s*-->/g;
/** Every module marker on a description (`file()` writes one; a task's text may hold more, from anyone). */
const MODULE_MARK = /<!--\s*aidenhq-module:([\w-]+)\s*-->/g;
/** The code host owns the release train's source family; no other module lists or sweeps it. */
const RELEASE_MODULE = "github";

/**
 * Whether the task is this module's, generically: it carries this module's marker and no other module's. A task with a second
 * module's marker is that other module's too, so neither module may close it as its own (a marker anyone can type, so the
 * control plane's `createdByAgentId` is checked beside it).
 */
function ownTask(module: string, description: string) {
  const marks = [...description.matchAll(MODULE_MARK)].map((m) => m[1]);
  return marks.length > 0 && marks.every((m) => m === module);
}

/**
 * The release family's marker is the task's only source marker: a task that also carries another family's (`<!-- source:x -->`)
 * is one the train doesn't own, whatever else its text says, and is neither listed nor closed by it.
 */
function releaseOnly(description: string) {
  const marks = [...description.matchAll(SOURCE_TAG)].map((m) => m[1]);
  return marks.length === 1 && RELEASE_MARK.test(description);
}

export class TaskError extends Error {
  name = "TaskError";
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function createModuleTasks({ db, owner, agents, plugin, rubric, log = () => {} }: {
  db: DatabaseSync;
  owner: Api;
  /** The grants table's agents, by Paperclip id. */
  agents: () => Record<string, { roles?: string[] } | undefined>;
  /** The kernel's post action, as a card's agent (outcomes.ts): skips the control plane's reopen, so a closed card stays closed. */
  plugin: () => PluginPost;
  /** Files the rubric of a task the module filed (checks.ts rubric), as that module. */
  rubric?: (task: { id: string; identifier?: string }, module: string, b: { rubric: string[]; deliverable: unknown }) => Promise<void>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  db.exec("DROP TABLE IF EXISTS graded_tasks");
  // Who filed each task (admission.ts reads it): a module's task carries no platform authority, whatever role it went to. A
  // module's row keeps the source it filed under: a module's job tool (jobtools.ts createModuleTool) reads it there, never from
  // the task's text, which its assignee may edit.
  db.exec("CREATE TABLE IF NOT EXISTS task_filers (task TEXT PRIMARY KEY, filer TEXT NOT NULL)");
  if (!(db.prepare("PRAGMA table_info(task_filers)").all() as { name: string }[]).some((c) => c.name === "source")) db.exec("ALTER TABLE task_filers ADD COLUMN source TEXT");
  /**
   * Close a task this module filed (its marker, and no agent made it): done or cancelled, with one line why. The line carries
   * the kernel's tag (wakes.ts SELF_TAG), so it wakes nobody and is never read as the owner's words.
   */
  async function close(module: string, id: string, b: { status?: unknown; body?: unknown }) {
    const body = typeof b.body === "string" ? neutral(b.body).trim().slice(0, 2000) : "";
    if (!UUID.test(id) || !["done", "cancelled"].includes(String(b.status)) || !body) throw new TaskError(400, "send {status: done|cancelled, body}");
    const r = await owner("GET", `/api/issues/${encodeURIComponent(id)}`);
    if (r.status !== 200) throw new TaskError(404, `no task ${id}`);
    if (r.json.createdByAgentId || !ownTask(module, String(r.json.description ?? ""))) throw new TaskError(403, `${r.json.identifier ?? id} isn't a task ${module} filed`);
    if (["done", "cancelled"].includes(r.json.status)) return { status: String(r.json.status), already: true };
    const u = await owner("PATCH", `/api/issues/${encodeURIComponent(id)}`, { status: b.status, comment: `${body}\n\n<!-- aidenhq:job=${module.replace(/[^\w-]/g, "")} kind=status -->` });
    if (u.status >= 300) throw new TaskError(502, `the control plane answered ${u.status}`);
    log("module task closed", { module, task: r.json.identifier, status: b.status });
    return { status: String(b.status), already: false };
  }

  /**
   * A comment on a task this module filed (its marker, and no agent made it), as the card's own agent through the kernel's post
   * path: it carries the kernel's tag (SELF_TAG: it wakes nobody) and skips the control plane's reopen, so a card its delegator
   * closed stays closed. A card keeps its first words and takes each later reason here while it is open, so one card stays the
   * record of one escalation.
   */
  async function comment(module: string, id: string, b: { body?: unknown }) {
    const body = typeof b.body === "string" ? neutral(b.body).trim().slice(0, 2000) : "";
    if (!UUID.test(id) || !body) throw new TaskError(400, "send {body}");
    const r = await owner("GET", `/api/issues/${encodeURIComponent(id)}`);
    if (r.status !== 200) throw new TaskError(404, `no task ${id}`);
    if (r.json.createdByAgentId || !ownTask(module, String(r.json.description ?? ""))) throw new TaskError(403, `${r.json.identifier ?? id} isn't a task ${module} filed`);
    if (["done", "cancelled"].includes(String(r.json.status))) return { comment: "", already: true };
    const agent = String(r.json.assigneeAgentId ?? "");
    if (!UUID.test(agent)) throw new TaskError(409, `${r.json.identifier ?? id} isn't assigned to an agent`);
    const posted = await plugin().post(agent, { issueId: id, body, scope: "own", tag: `<!-- aidenhq:job=${id} kind=comment -->` });
    if (posted.status >= 300 || posted.data?.refused || !posted.data?.comment) throw new TaskError(502, `the control plane refused the comment: ${posted.data?.refused ?? posted.status}`);
    log("module task commented", { module, task: r.json.identifier });
    return { comment: String(posted.data.comment) };
  }

  /**
   * The open tasks of this module's own source family, for a sweep that has no id in hand: a source starting `<module>:` (the
   * design module's `design:pass:`), or the release train's `release:instance:` for the code host (its stranded bumps). The
   * control plane's listing matches the source text; each row is checked again here (the module's marker, and the kernel's record
   * that this module filed it under that family), so a task that merely mentions the family, or that another module or an agent
   * made, is never returned. No module reads another's tasks this way.
   */
  async function list(module: string, source: string) {
    const release = module === RELEASE_MODULE && source === RELEASE_SOURCE;
    if (!release && !(source.startsWith(`${module}:`) && SOURCE.test(source))) throw new TaskError(400, `source: a family of your own (${module}:…)${module === RELEASE_MODULE ? ` or ${RELEASE_SOURCE}` : ""}`);
    // A module's own family is the kernel's filing record (task_filers: who filed it, under which source), never the task's
    // editable text; the release train's tasks predate that record, so their markers decide.
    const filed = db.prepare("SELECT source FROM task_filers WHERE task = ? AND filer = ?");
    const own = (id: string, description: string) => {
      if (release) return releaseOnly(description) ? RELEASE_MARK.exec(description)?.[1] : undefined;
      const s = (filed.get(id, `module:${module}`) as { source: string | null } | undefined)?.source;
      return s?.startsWith(source) ? s : undefined;
    };
    const companies = await owner("GET", "/api/companies");
    if (companies.status !== 200 || !Array.isArray(companies.json)) throw new TaskError(502, `the control plane answered ${companies.status} for its companies`);
    const tasks: { id: string; identifier: string; status: string; createdAt: string; source: string }[] = [];
    for (const c of companies.json as { id?: unknown }[]) {
      const q = new URLSearchParams({ q: source, status: "backlog,todo,in_progress,in_review,blocked", limit: "200", excludeRoutineExecutions: "true" });
      const r = await owner("GET", `/api/companies/${encodeURIComponent(String(c.id ?? ""))}/issues?${q}`);
      if (r.status !== 200 || !Array.isArray(r.json)) throw new TaskError(502, `the control plane answered ${r.status} for a company's issues`);
      for (const i of r.json as { id?: unknown; identifier?: unknown; status?: unknown; createdAt?: unknown; description?: unknown }[]) {
        const description = String(i.description ?? "");
        const found = ownTask(module, description) ? own(String(i.id ?? ""), description) : undefined;
        if (!found) continue;
        tasks.push({ id: String(i.id ?? ""), identifier: String(i.identifier ?? ""), status: String(i.status ?? ""), createdAt: String(i.createdAt ?? ""), source: found });
      }
    }
    return { tasks: tasks.filter((t) => t.id) };
  }

  async function file(module: string, b: { title?: unknown; description?: unknown; role?: unknown; agent?: unknown; source?: unknown; parent?: unknown; deliverable?: unknown; rubric?: unknown; quiet?: unknown }) {
    const title = typeof b.title === "string" ? neutral(b.title).trim().slice(0, 200) : "";
    const description = typeof b.description === "string" ? neutral(b.description).trim().slice(0, 20_000) : "";
    const by = typeof b.role === "string" ? "role" : typeof b.agent === "string" ? "agent" : "";
    if (!title || !description || !by || (b.role !== undefined && b.agent !== undefined) || typeof b.source !== "string" || !SOURCE.test(b.source)) throw new TaskError(400, "send {title, description, role | agent, source, parent?, deliverable?, rubric?, quiet?}");
    if (b.quiet !== undefined && typeof b.quiet !== "boolean") throw new TaskError(400, "quiet is true or false");
    // A rubric goes with its deliverable: both or neither (grading checks their contents).
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
      title, description: `${description}\n\n<!-- source:${b.source} -->\n${MODULE_TASK(module)}`, status: b.quiet ? "backlog" : "todo", priority: "medium",
      assigneeAgentId: agent, assigneeUserId: null, allowDuplicate: true, ...(b.parent ? { parentId: b.parent } : {}),
      // A task with a rubric is keyed by its module too, so another module's source can never hit it.
      idempotencyKey: `pw-${createHash("sha256").update(graded ? `${module}\0${b.source}` : b.source).digest("hex").slice(0, 32)}`,
    });
    if (r.status >= 300 || !r.json?.id) throw new TaskError(502, `the control plane answered ${r.status}`);
    // A dedup hit records the filing too when this module made the task (its marker, no agent): a filing whose first answer was
    // lost before the row was written is recorded on its retry.
    if (!r.json.deduplicated || (!r.json.createdByAgentId && ownTask(module, String(r.json.description ?? "")))) db.prepare("INSERT OR IGNORE INTO task_filers (task, filer, source) VALUES (?, ?, ?)").run(String(r.json.id), `module:${module}`, b.source);
    // The rubric module records its filer (this module, the kernel's word): a retry files the same rubric again, a no-op.
    if (graded) await rubric!({ id: String(r.json.id), identifier: String(r.json.identifier ?? "") }, module, { rubric: b.rubric as string[], deliverable: b.deliverable }).catch((e: { name?: string; status?: number; message: string }) => { throw new TaskError(e.status ?? 502, `the task is filed but its rubric isn't (${e.message}): file it again`); });
    log("module task filed", { module, task: r.json.identifier, agent, source: b.source, deduplicated: Boolean(r.json.deduplicated) });
    return { id: String(r.json.id), identifier: String(r.json.identifier ?? ""), agent, deduplicated: Boolean(r.json.deduplicated) };
  }
  return { file, close, comment, list };
}
export type ModuleTasks = ReturnType<typeof createModuleTasks>;
