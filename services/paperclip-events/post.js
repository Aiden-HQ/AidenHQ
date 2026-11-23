// The `post` action (worker.js): every write an agent makes on the control plane, run-free (POST
// /api/plugins/aidenhq.events/actions/post {companyId, params}): a job's outcome (kernel/src/outcomes.ts) and every write a
// module makes for a job through /v1/cp/agent (kernel/src/cp.ts). Plugin writes skip Paperclip's route checks (access, run cap,
// reopen) and the host never checks which agent a plugin writes as, so the kernel decides and this action is its signed executor:
// - Only the kernel calls it: every request is signed (sign.js, HMAC with paperclip_post_key, the kernel's and this plugin's
//   only) over the company, the agent and every param, stamped `ts` within SKEW_MS, and each signature is taken once. An agent
//   key alone, a changed field, a stale or a replayed request is refused.
// - The writer is the authenticated caller only (context.actor, filled by the host from the credential): an agent key, never a
//   user (the board key), never a run's token. Params name no writer.
// - The task is in the caller's company (the host forces context.companyId), and `scope` says why the kernel let this agent
//   write on it; what this action can see it checks again: `own` (assigned to the agent), `child` (its parent is), `created`
//   (the agent created it), `part` (a new task assigned to the agent itself, under any task). `admin` (the chief of staff's
//   comment anywhere) and `listed` (a task the grants table names for the agent: its memory inbox, review log or chat) are
//   the kernel's word alone: a comment, nothing else. `settle` (a fleet settler, role fleet-settle, on a task an agent made) is
//   the kernel's word too: a comment, a status or a patch on that task (handing it to the one agent in `delegateTo`), never a
//   new task.
// - Writes (a project as its id: the kernel resolved the agent's name, kernel/src/projects.ts): a comment; a status from STATUSES (`blocked` names its blockers, as the REST route requires; `done` only with
//   `gated`, the kernel's word that its finish gate passed); a `patch` of PATCH_KEYS; a new task (`child`: under `issueId`,
//   or top-level without one) assigned to the caller, to an agent in `delegateTo`, or to a user.
// - Once: every write carries the kernel's tag (a job's `aidenhq:job=` tag wakes nobody, wakes.ts SELF_TAG; a cp write on
//   someone else's task carries `aidenhq:op=`, which wakes its assignee as any agent comment does). A new task's origin is the
//   tag. The kernel runs each tag's write once (once.ts); `again` marks its retry after an unknown outcome (the kernel died or
//   timed out after Paperclip wrote), and only then a task or comment the tag already made, by this agent, is returned
//   (`found`) rather than made twice. Setting a status is the same twice.
// A refusal is returned as {refused}, never thrown: a thrown error reaches the caller as 502, which means "unknown, retry".
import { HOST_PARAMS, SKEW_MS, verify } from "./sign.js";

export const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const PARAMS = ["sig", "ts", "tag", "again", "scope", "issueId", "body", "status", "blockedBy", "gated", "patch", "child", "delegateTo"];
const SCOPES = ["own", "child", "created", "part", "admin", "listed", "settle"];
const PATCH_KEYS = ["title", "description", "priority", "assigneeAgentId", "assigneeUserId", "blockedByIssueIds", "labelIds", "projectId"];
const CHILD_KEYS = ["title", "description", "priority", "status", "assigneeAgentId", "assigneeUserId", "labelIds", "projectId"];
/** The origin kind of every task this action makes (Paperclip allows a plugin only its own, `plugin:<id>`): a retry finds its task by it. */
export const ORIGIN = "plugin:aidenhq.events";
const PRIORITIES = ["critical", "high", "medium", "low"];
const TAG = /^<!-- aidenhq:(?:job=[A-Za-z0-9_-]{1,64} kind=[a-z_]{1,32}|op=[A-Za-z0-9_-]{1,64}) -->$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 100_000;
/** Paperclip's refusals of a task's blockers (services/issues.js: a cycle, itself, another company, unresolved ones). */
const BLOCKER_REFUSAL = /^(Blocking relations cannot contain cycles|Issue cannot be blocked by itself|Blocked-by issues must belong to the same company|Issue is blocked by unresolved blockers)/;
const text = (s, max) => String(s).replace(/<!--\s*aidenhq:/gi, "<!-- (quoted) aidenhq:").slice(0, max);
const ids = (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && UUID.test(x));
const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
const user = (v) => v === null || (typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v));

/** Why fields `f` (a patch or a child) can't be written, or undefined. */
function fields(f, keys, what) {
  if (!obj(f) || Object.keys(f).some((k) => !keys.includes(k))) return `${what} takes ${keys.join(", ")}`;
  for (const k of ["title", "description"]) if (f[k] !== undefined && typeof f[k] !== "string") return `${what}.${k} is text`;
  if (f.priority !== undefined && !PRIORITIES.includes(f.priority)) return `${what}.priority is one of ${PRIORITIES.join(", ")}`;
  if (f.assigneeAgentId !== undefined && !(f.assigneeAgentId === null || (typeof f.assigneeAgentId === "string" && UUID.test(f.assigneeAgentId)))) return `${what}.assigneeAgentId is an agent id or null`;
  if (f.assigneeUserId !== undefined && !user(f.assigneeUserId)) return `${what}.assigneeUserId is a user id or null`;
  for (const k of ["blockedByIssueIds", "labelIds"]) if (f[k] !== undefined && !ids(f[k])) return `${what}.${k} is a list of ids`;
  if (f.projectId !== undefined && !(typeof f.projectId === "string" && UUID.test(f.projectId))) return `${what}.projectId is a project id`;
  return undefined;
}

/** Why these params can't be written, or undefined. */
function invalid(p) {
  const extra = Object.keys(p).filter((k) => !PARAMS.includes(k) && !HOST_PARAMS.includes(k));
  if (extra.length) return `unknown params: ${extra.join(", ")} (the writer is the caller; params never name one)`;
  if (p.issueId !== undefined && (typeof p.issueId !== "string" || !UUID.test(p.issueId))) return "issueId must be a task id";
  if (p.issueId === undefined && (p.child === undefined || p.body !== undefined || p.status !== undefined || p.patch !== undefined || (p.scope ?? "own") !== "own")) return "without issueId, only a new top-level task (child)";
  if (typeof p.tag !== "string" || !TAG.test(p.tag)) return "tag must be <!-- aidenhq:job=<job> kind=<kind> --> or <!-- aidenhq:op=<op> -->";
  const scope = p.scope ?? "own";
  if (!SCOPES.includes(scope)) return `scope is one of ${SCOPES.join(", ")}`;
  if (p.body === undefined && p.status === undefined && p.child === undefined && p.patch === undefined) return "send a body, a status, a patch or a child";
  if ((scope === "admin" || scope === "listed") && (p.status !== undefined || p.patch !== undefined || p.child !== undefined)) return `scope ${scope} writes a comment only`;
  if (scope === "settle" && p.child !== undefined) return "scope settle changes a task; it makes none";
  if (scope === "part" && (p.body !== undefined || p.status !== undefined || p.patch !== undefined)) return "scope part makes a task (child) only";
  if (scope === "part" && p.child?.assigneeAgentId === undefined) return "scope part makes a task assigned to the caller";
  if (p.body !== undefined && (typeof p.body !== "string" || !p.body.trim())) return "body must be text";
  if (p.status !== undefined && !STATUSES.includes(p.status)) return `status must be one of ${STATUSES.join(", ")}`;
  if (p.blockedBy !== undefined && p.status !== "blocked") return "blockedBy goes with status blocked";
  if (p.status === "blocked" && !(ids(p.blockedBy) && p.blockedBy.length && !p.blockedBy.includes(p.issueId))) return "blocked needs blockedBy: the ids of the tasks it waits on";
  if (p.status === "blocked" && p.patch?.blockedByIssueIds !== undefined) return "blocked takes its blockers in blockedBy";
  if (p.status === "done" && p.gated !== true) return "done needs the kernel's finish gate (gated)";
  if (p.delegateTo !== undefined && !ids(p.delegateTo)) return "delegateTo is a list of agent ids";
  if (p.patch !== undefined) { const why = fields(p.patch, PATCH_KEYS, "patch"); if (why) return why; }
  if (p.child !== undefined) {
    const why = fields(p.child, CHILD_KEYS, "child");
    if (why) return why;
    if (typeof p.child.title !== "string" || !p.child.title.trim()) return "a child needs a title";
    if (p.child.status !== undefined && !["backlog", "todo"].includes(p.child.status)) return "a new task starts in backlog or todo";
  }
  return undefined;
}

/** Signatures already taken, until they'd be stale anyway: a replayed request is refused. */
const seen = new Map();

/** `postKey`: paperclip_post_key as the plugin reads it (worker.js). */
export async function post(ctx, params, context, postKey, now = Date.now()) {
  const actor = context?.actor;
  const p0 = params && typeof params === "object" ? params : {};
  if (!verify(postKey, String(context?.companyId ?? ""), String(actor?.agentId ?? ""), p0)) return { refused: "only the AidenHQ kernel calls this action (a signed request)" };
  if (typeof p0.ts !== "number" || Math.abs(now - p0.ts) > SKEW_MS) return { refused: "the request is stale" };
  for (const [s, at] of seen) if (now - at > 2 * SKEW_MS) seen.delete(s);
  if (seen.has(p0.sig)) return { refused: "the request was already used" };
  seen.set(p0.sig, now);
  if (actor?.type !== "agent" || !actor.agentId) return { refused: "only an agent's own key posts as the agent" };
  if (actor.runId) return { refused: "a Paperclip run writes through Paperclip's routes, not this action" };
  const companyId = context.companyId;
  if (!companyId) return { refused: "no company" };
  const p = p0;
  const why = invalid(p);
  if (why) return { refused: why };
  const agent = actor.agentId;
  const scope = p.scope ?? "own";
  const issue = p.issueId ? await ctx.issues.get(p.issueId, companyId) : undefined;
  if (p.issueId && !issue) return { refused: "no such task" };
  if (issue && scope === "own" && issue.assigneeAgentId !== agent) return { refused: "the task isn't assigned to this agent" };
  if (issue && scope === "created" && issue.createdByAgentId !== agent) return { refused: "this agent didn't create the task" };
  if (issue && scope === "child" && (!issue.parentId || (await ctx.issues.get(issue.parentId, companyId))?.assigneeAgentId !== agent)) return { refused: "the task's parent isn't assigned to this agent" };
  if (scope === "part" && p.child.assigneeAgentId !== agent) return { refused: "a part is assigned to the agent itself" };
  const may = (to) => !to || to === agent || (p.delegateTo ?? []).includes(to);
  if (!may(p.child?.assigneeAgentId) || !may(p.patch?.assigneeAgentId)) return { refused: "a task goes to the agent itself or one it delegates to" };
  const as = { actorAgentId: agent };
  const out = { comment: null, child: null, found: false, status: issue?.status ?? null };
  const change = { ...(p.patch ?? {}), ...(p.status !== undefined && p.status !== issue?.status ? { status: p.status } : {}), ...(p.blockedBy ? { blockedByIssueIds: p.blockedBy } : {}) };
  if (change.description !== undefined) change.description = text(change.description, MAX);
  if (Object.keys(change).length) {
    try {
      out.status = (await ctx.issues.update(p.issueId, change, companyId, as)).status;
    } catch (e) {
      // Paperclip's own refusal of the blockers (a cycle, unresolved ones): the caller's to resolve, never "unknown". Only the
      // message crosses from the host (its status and details stay there), and a retry would get the same answer forever.
      if (BLOCKER_REFUSAL.test(String(e?.message ?? ""))) return { refused: String(e.message) };
      throw e;
    }
  }
  if (p.child !== undefined) {
    const origin = p.tag.slice(5, -4); // aidenhq:job=<job> kind=<kind>, or aidenhq:op=<op>
    const had = p.again ? (await ctx.issues.list({ companyId, originId: origin })).find((i) => i.originKind === ORIGIN && i.originId === origin && i.createdByAgentId === agent) : undefined;
    const c = p.child;
    out.found = Boolean(had);
    out.child = (had ?? await ctx.issues.create({
      companyId, title: text(c.title, 200), originKind: ORIGIN, originId: origin, actor: as,
      ...(p.issueId ? { parentId: p.issueId } : {}),
      ...(c.description !== undefined ? { description: text(c.description, MAX) } : {}),
      ...Object.fromEntries(["priority", "status", "assigneeAgentId", "assigneeUserId", "labelIds", "projectId"].filter((k) => c[k] !== undefined).map((k) => [k, c[k]])),
    })).id;
  }
  if (p.body !== undefined) {
    const had = p.again ? (await ctx.issues.listComments(p.issueId, companyId)).find((c) => c.authorAgentId === agent && String(c.body).endsWith(`\n\n${p.tag}`)) : undefined;
    out.comment = (had ?? await ctx.issues.createComment(p.issueId, `${text(p.body, MAX)}\n\n${p.tag}`, companyId, { authorAgentId: agent })).id;
  }
  return out;
}
