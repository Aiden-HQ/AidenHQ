// The `post` action (worker.js): one agent's write on its own task, run-free (POST /api/plugins/aidenhq.events/actions/post {companyId, params}).
// Plugin writes skip Paperclip's route checks (access, run cap, reopen) and the host never checks which agent a plugin writes
// as, so this action is the check:
// - Only the kernel calls it: every request is signed (sign.js, HMAC with paperclip_post_key, the kernel's and this plugin's
//   only) over the company, the agent and every param, stamped `ts` within SKEW_MS, and each signature is taken once. An agent
//   key alone (a Paperclip-run agent holds one), a changed field, a stale or a replayed request is refused.
// - The writer is the authenticated caller only (context.actor, filled by the host from the credential): an agent key, never a
//   user (the board key), never a run's token (Paperclip-run agents write through Paperclip's own routes). Params name no identity.
// - The task (a child's parent) is assigned to that agent, in the caller's company (the host forces context.companyId).
// - Writes: a comment, a status from STATUSES (`blocked` names its blockers, as the REST route requires; `done` only with
//   `gated`, the kernel's word that its finish gate passed), a child task assigned to the caller or to an agent in
//   `delegateTo` (the ids the kernel resolved from the caller's grants `delegate_to`).
// - Once: every write carries the caller's tag; with `again` (a retry after an unknown outcome) a write the tag already
//   found, by this agent, isn't made twice. Setting a status is the same twice.
// A refusal is returned as {refused}, never thrown: a thrown error reaches the caller as 502, which means "unknown, retry".
import { SKEW_MS, verify } from "./sign.js";

export const STATUSES = ["in_progress", "in_review", "blocked", "done", "cancelled"];
const PARAMS = ["sig", "ts", "issueId", "tag", "again", "body", "status", "blockedBy", "gated", "child", "delegateTo"];
const TAG = /^<!-- aidenhq:job=[A-Za-z0-9_-]{1,64} kind=[a-z_]{1,32} -->$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 100_000;
const text = (s, max) => String(s).replace(/<!--\s*aidenhq:/gi, "<!-- (quoted) aidenhq:").slice(0, max);

/** Why these params can't be written, or undefined. */
function invalid(p) {
  const extra = Object.keys(p).filter((k) => !PARAMS.includes(k));
  if (extra.length) return `unknown params: ${extra.join(", ")} (the writer is the caller; params never name one)`;
  if (typeof p.issueId !== "string" || !UUID.test(p.issueId)) return "issueId must be a task id";
  if (typeof p.tag !== "string" || !TAG.test(p.tag)) return "tag must be <!-- aidenhq:job=<job> kind=<kind> -->";
  if (p.body === undefined && p.status === undefined && p.child === undefined) return "send a body, a status or a child";
  if (p.body !== undefined && (typeof p.body !== "string" || !p.body.trim())) return "body must be text";
  if (p.status !== undefined && !STATUSES.includes(p.status)) return `status must be one of ${STATUSES.join(", ")}`;
  if (p.blockedBy !== undefined && p.status !== "blocked") return "blockedBy goes with status blocked";
  if (p.status === "blocked" && !(Array.isArray(p.blockedBy) && p.blockedBy.length && p.blockedBy.every((x) => typeof x === "string" && UUID.test(x) && x !== p.issueId))) return "blocked needs blockedBy: the ids of the tasks it waits on";
  if (p.status === "done" && p.gated !== true) return "done needs the kernel's finish gate (gated)";
  if (p.delegateTo !== undefined && !(Array.isArray(p.delegateTo) && p.delegateTo.every((x) => typeof x === "string" && UUID.test(x)))) return "delegateTo is a list of agent ids";
  if (p.child !== undefined) {
    const c = p.child;
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((k) => !["title", "description", "assigneeAgentId"].includes(k))) return "child is {title, description?, assigneeAgentId?}";
    if (typeof c.title !== "string" || !c.title.trim()) return "a child needs a title";
    if (c.description !== undefined && typeof c.description !== "string") return "a child's description is text";
    if (c.assigneeAgentId !== undefined && (typeof c.assigneeAgentId !== "string" || !UUID.test(c.assigneeAgentId))) return "a child's assignee is an agent id";
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
  const p = params ?? {};
  const why = invalid(p);
  if (why) return { refused: why };
  const agent = actor.agentId;
  const issue = await ctx.issues.get(p.issueId, companyId);
  if (!issue) return { refused: "no such task" };
  if (issue.assigneeAgentId !== agent) return { refused: "the task isn't assigned to this agent" };
  const to = p.child?.assigneeAgentId;
  if (to && to !== agent && !(p.delegateTo ?? []).includes(to)) return { refused: "a child goes to the agent itself or one it delegates to" };
  const as = { actorAgentId: agent };
  const out = { comment: null, child: null, status: issue.status };
  if (p.status !== undefined && p.status !== issue.status) {
    out.status = (await ctx.issues.update(p.issueId, { status: p.status, ...(p.blockedBy ? { blockedByIssueIds: p.blockedBy } : {}) }, companyId, as)).status;
  }
  if (p.child !== undefined) {
    const origin = p.tag.slice(5, -4); // aidenhq:job=<job> kind=<kind>
    const had = p.again ? (await ctx.issues.list({ companyId, originId: origin })).find((i) => i.parentId === p.issueId && i.createdByAgentId === agent) : undefined;
    out.child = (had ?? await ctx.issues.create({
      companyId, parentId: p.issueId, title: text(p.child.title, 200), originId: origin, actor: as,
      ...(p.child.description !== undefined ? { description: text(p.child.description, MAX) } : {}),
      ...(p.child.assigneeAgentId ? { assigneeAgentId: p.child.assigneeAgentId } : {}),
    })).id;
  }
  if (p.body !== undefined) {
    const had = p.again ? (await ctx.issues.listComments(p.issueId, companyId)).find((c) => c.authorAgentId === agent && String(c.body).includes(p.tag)) : undefined;
    out.comment = (had ?? await ctx.issues.createComment(p.issueId, `${text(p.body, MAX)}\n\n${p.tag}`, companyId, { authorAgentId: agent })).id;
  }
  return out;
}
