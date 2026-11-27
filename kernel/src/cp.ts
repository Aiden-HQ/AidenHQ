// ANY /v1/cp/agent/<path>: a module acting as the job whose tool call it is serving. The module's own token plus the caller
// assertion it was handed (X-AidenHQ-Caller), which opens this route only while that call is in flight and only for the
// module it was addressed to (assert.ts). The path must be one of the control plane's agent routes below. The caller must be
// a kernel job (an agent on its task): its credential is the agent's own Paperclip key (secrets paperclip-agents/<agent>),
// which the kernel holds and never hands to a module; anything else is refused before anything runs.
// - Reads (GET) go to the control plane with that key.
// - Writes go through the paperclip-events plugin's signed `post` action (outcomes.ts createPluginPost, services/paperclip-events/
//   post.js), the only writer: Paperclip refuses an agent key's writes without a run. The kernel decides who writes where and
//   signs a `scope`; the plugin re-checks what it can see. A job writes on its own task (assigned to it), a task it created,
//   a child of a task assigned to it, and creates tasks as itself (under such a task, a part of its own under any task, or
//   top-level). A fleet overseer (the chief of staff, role fleet-admin, or the Fleet Steward, role fleet-audit) comments on any
//   task of its company; an agent comments on the tasks the
//   grants table names for it (review log, chat) and on the shared "Fleet issues" log task (grants `fleet_issues`). A fleet settler (role fleet-settle, the Fleet Steward) settles stuck work on any
//   task of its company an agent made, or a routine run with a holder agent (scope `settle`): a comment, a status (done only on a
//   task in review, through the finish gate, heard as the task's own close), and handing the task to any agent; never a task a
//   person made (the owner's own task or chat), a routine run with no agent, and never a log task. The evidence close (scope
//   `evidence`): an open task an agent made and handed to the owner is closed by its maker, the maker of a part of it, or a
//   fleet settler, with a comment (a cited link or task identifier for `done`) and at most a label. Anything else is
//   refused, naming whom to ask. Each write carries a tag (the plugin's once-only key): on the job's own task and the tasks its
//   grants list the job tag (wakes.ts SELF_TAG: it wakes nobody), elsewhere `aidenhq:op=`, which wakes the task's assignee as any
//   agent's comment does.
// - A status change to `done` is for the job's own task, a task the job's agent holds (from an earlier run that left it
//   open), or a fleet settler's task to settle; it passes the finish gate first (checks.ts): held or reopened, nothing is written and the answer says so (202).
// A user assignee is only ever the owner; a PATCH hands a task back (assigneeAgentId null, to the owner), and only a fleet
// settler's hands it to another agent.
// Every open task has a holder, an agent or the owner (leavesNoHolder): a create or a change that would leave one with neither
// is refused, here and on the board's owner writes.
// Answers look like Paperclip's: the task as it is now (a PATCH 200, a create 201 with `deduplicated`), a comment's {id} (201).
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Asserter } from "./assert.ts";
import type { Checks } from "./checks.ts";
import { factWriter, iso } from "./factlog.ts";
import type { Facts } from "./facts.ts";
import { MAX_ANSWER, readCapped, shareReads, TooLarge, TYPED } from "./cplimit.ts";
import type { Connection, Grant, Whoami } from "./identity.ts";
import type { Once } from "./once.ts";
import { delegateIds, OutcomeError, type PluginPost } from "./outcomes.ts";
import { fail } from "./proxy.ts";
import { ProjectError, type Projects } from "./projects.ts";
import { isLogTask, logTasks, scopeOf as taskScopeOf } from "./task-scope.ts";

// One path segment: never a dot segment, which URL resolution would turn into another route.
const ID = "(?!\\.+(?:/|$))[A-Za-z0-9_.:-]{1,100}";
/** The control plane's agent routes a module may use as the caller, by method (query strings are passed as they are). */
export const CP_AGENT_PATHS: [string, RegExp][] = [
  ["GET", /^\/api\/agents\/me$/],
  ["GET", new RegExp(`^/api/agents/${ID}/instructions-bundle/file$`)],
  ["GET", new RegExp(`^/api/companies/${ID}$`)],
  ["GET", new RegExp(`^/api/companies/${ID}/(agents|labels|issues)$`)],
  ["POST", new RegExp(`^/api/companies/${ID}/issues$`)],
  ["GET", new RegExp(`^/api/issues/${ID}$`)],
  ["PATCH", new RegExp(`^/api/issues/${ID}$`)],
  ["GET", new RegExp(`^/api/issues/${ID}/(comments|attachments)$`)],
  ["POST", new RegExp(`^/api/issues/${ID}/comments$`)],
  ["GET", new RegExp(`^/api/attachments/${ID}/content$`)],
];
/** A job's reads with its agent key: identical ones in flight share one request (cplimit.ts shareReads, keyed by the key). */
const agentFetch = shareReads(fetch);
/** The answer cap, enforced while the answer streams in (cplimit.ts readCapped). */
const capped = (r: Response) => readCapped(r, MAX_ANSWER).catch((e) => { throw e instanceof TooLarge ? fail(502, "too_large", e.message) : e; });
/**
 * What a PATCH may change besides its status and comment (post.js PATCH_KEYS), and what a create may carry. `project` is a
 * project's name, resolved here (projects.ts named: the one of that name, else a new one) and written as `projectId`.
 */
const PATCH = ["title", "description", "priority", "assigneeAgentId", "assigneeUserId", "labelIds", "blockedByIssueIds", "project"];
const CREATE = ["title", "description", "priority", "status", "assigneeAgentId", "assigneeUserId", "labelIds", "parentId", "idempotencyKey", "allowDuplicate", "project"];
type Issue = { id: string; identifier?: string; companyId?: string; projectId?: string | null; assigneeAgentId?: string | null; assigneeUserId?: string | null; createdByAgentId?: string | null; createdByUserId?: string | null; parentId?: string | null; status?: string; originKind?: string | null };
/** The role that settles stuck work on another agent's task (the Fleet Steward): see `settle` above. */
export const SETTLE = "fleet-settle";

/** Every open task has a holder: an agent, or the owner's user. Whether a create (`cur` undefined) or a change to who holds a task would leave it open with neither. */
export function leavesNoHolder(cur: { status?: string | null; assigneeAgentId?: string | null; assigneeUserId?: string | null } | undefined, b: Record<string, unknown>): boolean {
  if (cur && b.assigneeAgentId === undefined && b.assigneeUserId === undefined) return false;
  if (["done", "cancelled"].includes(String(b.status ?? cur?.status ?? ""))) return false;
  const agent = b.assigneeAgentId !== undefined ? b.assigneeAgentId : cur?.assigneeAgentId;
  const user = b.assigneeUserId !== undefined ? b.assigneeUserId : cur?.assigneeUserId;
  return !agent && !user;
}
/** Evidence a close cites: a link, or a task identifier (a duplicate's survivor, the report that supersedes it). */
const EVIDENCE = /https?:\/\/\S+|\b[A-Z][A-Z0-9]*-\d+\b/;
export const NO_HOLDER = "every open task has a holder: an agent (assigneeAgentId, yourself included) or the owner (assigneeUserId)";

export function createCp({ whoami, asserter, plugin, once, sawn = () => 0, agentKey, grants, fleetIssues = () => "", controlUrl, checks, appOwners, facts, observe, projects, log = () => {} }: {
  /** Projects (projects.ts): an agent's `project` tag by name. */
  projects?: Pick<Projects, "serial" | "named">;
  /** The wake inbox's observe (wakes.ts): a task this route just changed has its facts recorded at once, from the issue the write returned. */
  observe?: (issue: Issue, actor: string) => Promise<void>;
  /** Flow's fact log (facts.ts): task.commented for each comment a job writes through here. */
  facts?: Facts;
  whoami: Whoami; asserter: Asserter; plugin: PluginPost;
  /** The one durable once-only write (once.ts): each write is keyed by its call, and a retry returns the first run's result. */
  once: Once;
  /** How many comment steps a job has read (jobs.ts sawn): a comment it writes carries it in its tag, so a reader knows which messages it answers. */
  sawn?: (job: string) => number;
  /** An agent's own Paperclip key (secrets paperclip-agents/<id>), or "". */
  agentKey: (agent: string) => string;
  /** The grants table's agents: roles, delegation targets and the tasks it names for each agent. */
  grants: () => Record<string, Grant>;
  /** The shared "Fleet issues" log task's identifier (grants `fleet_issues`; setup's ensureFleetIssues), or "". */
  fleetIssues?: () => string;
  /** The keys of the agents that own an app (apps-mcp's registry), for a `delegate_to` that names app-owners. */
  appOwners?: () => Promise<string[]>;
  controlUrl: string; checks?: Checks; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const fact = factWriter(facts, log);
  /** The tag each op's first write used (see tagOf), for its retries. */
  const tagIds = new Map<string, string>();
  /** `who`: the module and the agent the call is for, as soon as they are known (a refusal's log line names them). */
  async function handle(req: IncomingMessage, res: ServerResponse, path: string, query: string, who: { module?: string; agent?: string }): Promise<void> {
    const mod = await whoami(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim()).catch(() => undefined);
    if (mod?.kind !== "module" || !mod.module) throw fail(401, "unauthorized", "a module's own token is required");
    who.module = mod.module;
    const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), mod.module);
    if (!live) throw fail(401, "unauthorized", "the caller assertion isn't for a call in flight to this module");
    who.agent = live.caller.key;
    const method = String(req.method);
    if (!CP_AGENT_PATHS.some(([m, re]) => m === method && re.test(path))) throw fail(403, "forbidden", `${method} ${path} isn't an agent route`);
    // The credential first: only a kernel job (an agent on its task) has one, and nothing runs for a caller without it.
    const c = live.caller;
    const agent = c.kind === "run" && c.agent && c.task ? c.agent : "";
    const key = agent ? agentKey(agent) : "";
    if (!key) throw fail(403, "forbidden", "this caller has no control-plane identity (only a kernel job acts on the control plane)");
    const task = c.task!;
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const ch of req) { n += ch.length; if (n > 4 * 1024 * 1024) throw fail(413, "too_large", "too large"); chunks.push(ch); }
    const read = async (p: string) => {
      const r = await agentFetch(new URL(p, controlUrl), { signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${key}`, accept: String(req.headers.accept ?? "application/json") } });
      return { status: r.status, type: r.headers.get("content-type") ?? "application/json", out: await capped(r) };
    };
    const answer = (status: number, out: Buffer, type = "application/json") => {
      log("cp", { module: mod.module, agent: c.key, method, path, status });
      res.writeHead(status, { "content-type": type, "content-length": out.length }).end(out);
    };
    if (method === "GET") { const r = await read(`${path}${query}`); return answer(r.status, r.out, r.type); }

    let b: Record<string, unknown>;
    try { b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw fail(400, "bad_request", "the body must be JSON"); }
    if (!b || typeof b !== "object" || Array.isArray(b)) throw fail(400, "bad_request", "the body must be a JSON object");
    const issue = async (ref: string): Promise<Issue> => {
      const r = await read(`/api/issues/${encodeURIComponent(ref)}`);
      if (r.status === 404) throw fail(404, "not_found", `no task ${ref}`);
      if (r.status !== 200) throw fail(502, "bad_upstream", `the control plane answered ${r.status} for task ${ref}`);
      return JSON.parse(r.out.toString("utf8")) as Issue;
    };
    const table = grants();
    const roles = c.roles ?? [];
    const keyOf = (id?: string | null) => (id ? String(table[id]?.key ?? "another agent") : "");
    /** Why this job may write on task `t` (post.js scopes), or undefined. */
    // Setup's log tasks (grants): held by an agent, they take comments only, and never a child (task-scope.ts).
    const logs = logTasks({ agents: table as never, fleet_issues: fleetIssues() });
    const scopeOf = (t: Issue) => taskScopeOf(t, agent, issue, logs);
    /** A comment-only write's scope where the job has no other: the grants table's tasks for it, the Fleet issues log, a fleet overseer (the chief of staff, fleet-admin, or the Fleet Steward, fleet-audit) anywhere. */
    const commentScope = (t: Issue) => {
      const own = table[agent] ?? {};
      if ([own.review_log, own.chat_task].includes(t.id)) return "listed";
      const fleet = fleetIssues();
      if (fleet && t.identifier === fleet) return "listed";
      return roles.includes("fleet-admin") || roles.includes("fleet-audit") ? "admin" : undefined;
    };
    /** A routine run: a task a routine wakes on its own timetable, with no agent as its creator (wakes.ts, admission.ts). */
    const isRoutineRun = (t: Issue) => t.originKind === "routine_execution";
    /**
     * A task a fleet settler may change: one an agent made (never a person's own task or chat) or a routine run with a holder
     * agent (a routine run has no creator agent), and not a log task.
     */
    const settleScope = (t: Issue) =>
      roles.includes(SETTLE) && !isLogTask(t, logs) && !t.createdByUserId && (t.createdByAgentId || (isRoutineRun(t) && t.assigneeAgentId)) ? "settle" : undefined;
    /** A settler is told the state that blocks it, not to ask itself to pass the task on. */
    const refuse = (t: Issue, child = false): never => {
      const who = t.assigneeAgentId ? `its assignee (${keyOf(t.assigneeAgentId)})` : "the owner";
      if (roles.includes(SETTLE)) {
        // A log task never reaches here: a status or patch write on one is refused above, naming itself.
        const blocked = child ? "only its holder or the agent that made it adds a child under it, or a part assigned to you"
          : isRoutineRun(t) && !t.assigneeAgentId ? "it has no agent to hold it"
          : t.createdByUserId ? "it is the owner's own task"
          : "no agent made it";
        throw fail(403, "forbidden", `${t.identifier ?? t.id} can't be settled: ${blocked}`);
      }
      throw fail(403, "forbidden", `${t.identifier ?? t.id} isn't yours to change: ask ${who} or the Fleet Steward to pass it on`);
    };
    // The write's once-only key: this call's write itself, so a module's retry of it within the call is the same op.
    const op = createHash("sha256").update(`${c.call}\n${method}\n${path}\n${JSON.stringify(b)}`).digest("base64url").slice(0, 32);
    /** The plugin's call (outcomes.ts), its errors as this route's: an unknown outcome is looked for on the retry (once.ts). */
    const viaPlugin = async <T>(f: () => Promise<T>): Promise<T> => {
      try { return await f(); } catch (e) {
        const o = e as { name?: string; status?: number; code?: string; message: string };
        if (o.name !== "OutcomeError") throw e;
        throw fail(o.status!, o.code!, o.message);
      }
    };
    const delegateTo = await delegateIds(table, agent, appOwners);
    /** A user assignee is the owner only (the company's responsible user). */
    const ownerOnly = async (user: unknown) => {
      if (user === undefined || user === null) return;
      const co = await viaPlugin(() => plugin.company(agent));
      const r = await read(`/api/companies/${encodeURIComponent(co)}`);
      const owner = r.status === 200 ? JSON.parse(r.out.toString("utf8")).defaultResponsibleUserId : undefined;
      if (!owner || user !== owner) throw fail(403, "forbidden", "a task goes to an agent or to the owner, no other user");
    };
    const send = async (params: Record<string, unknown>) => {
      type Data = { comment: string | null; child: string | null; found: boolean; status: string | null };
      const refused = { r: undefined as { refused: string; details?: unknown } | undefined };
      const d = await viaPlugin(async () => ((r) => ({ ...r.value, found: r.value.found || r.again }))(await once(`cp:${op}`, async (retry): Promise<Data> => {
        const r = await plugin.post(agent, { ...params, ...(retry ? { again: true } : {}) });
        if (r.status >= 500 || !r.data) throw new OutcomeError(502, "unknown", `the post action answered ${r.status}; retry the same write`);
        if (r.status >= 300) throw new OutcomeError(502, "bad_upstream", `the post action answered ${r.status}`);
        if (r.data.refused) { refused.r = r.data; throw new OutcomeError(409, "refused", r.data.refused); }
        return r.data;
      }))).catch((e) => {
        if (!refused.r) throw e;
        if (refused.r.details) return void answer(409, Buffer.from(JSON.stringify({ error: refused.r.refused, details: refused.r.details })));
        throw e;
      });
      return d;
    };
    const issueAnswer = async (id: string, status: number, extra: Record<string, unknown> = {}) => {
      const r = await read(`/api/issues/${encodeURIComponent(id)}`);
      // The write stands whether or not its facts are recorded now: the poll reconciles what observe missed.
      if (r.status === 200) await observe?.(JSON.parse(r.out.toString("utf8")), `agent:${c.key}`).catch((e: Error) => log("observe failed", { task: id, err: e.message }));
      answer(r.status === 200 ? status : r.status, r.status === 200 ? Buffer.from(JSON.stringify({ ...JSON.parse(r.out.toString("utf8")), ...extra })) : r.out);
    };
    // The kernel's self tag (wakes.ts SELF_TAG: wakes nobody) on the agent's own task and the tasks its grants list; anywhere
    // else (a child, a part, a fleet overseer's comment on another agent's task) the op tag, so the task's own agent hears it
    // by the dispatch rules (who started work there), never the writer itself.
    // The job's read step is part of the tag, fixed at the op's first write: a retry of the same op looks for the same tag.
    const tagOf = (scope: string, op: string) => {
      if (scope !== "own" && scope !== "listed") return `<!-- aidenhq:op=${op} -->`;
      const job = live.flight.job;
      let id = job ? tagIds.get(op) : undefined;
      if (job && !id) {
        id = `${job}_${sawn(job)}_${op}`;
        tagIds.set(op, id);
        if (tagIds.size > 2000) tagIds.delete(tagIds.keys().next().value!);
      }
      return `<!-- aidenhq:job=${id ?? op} kind=cp -->`;
    };

    /** A project's id by name (`project`), made when there is none; its errors as this route's. */
    const projectNamed = async (co: string, name: unknown): Promise<string> => {
      if (!projects) throw fail(503, "unavailable", "projects are off");
      if (typeof name !== "string" || !name.trim()) throw fail(400, "bad_request", "project is a project's name");
      try { return await projects.named(co, name); } catch (e) { throw e instanceof ProjectError ? fail(400, "bad_request", e.message) : e; }
    };
    /** `f` alone with every other project write (projects.ts serial) when it sets a project: a PR's fill never lands over a tag. */
    const tagged = <T>(on: boolean, f: () => Promise<T>) => (on && projects ? projects.serial(f) : f());

    // POST /api/companies/:cid/issues: a new task, as the job's agent, in its own company.
    const company = method === "POST" ? new RegExp(`^/api/companies/(${ID})/issues$`).exec(path)?.[1] : undefined;
    if (company) {
      const extra = Object.keys(b).filter((k) => !CREATE.includes(k));
      if (extra.length) throw fail(400, "bad_request", `a new task takes ${CREATE.join(", ")}; not ${extra.join(", ")}`);
      if (decodeURIComponent(company) !== (await viaPlugin(() => plugin.company(agent)))) throw fail(403, "forbidden", "a job creates tasks in its own company only");
      await ownerOnly(b.assigneeUserId);
      if (leavesNoHolder(undefined, b)) throw fail(400, "bad_request", NO_HOLDER);
      const parent = typeof b.parentId === "string" && b.parentId ? await issue(b.parentId) : undefined;
      if (parent && isLogTask(parent, logs)) throw fail(403, "forbidden", `${parent.identifier ?? parent.id} is a log task: it takes comments only`);
      const scope = parent ? (await scopeOf(parent)) ?? (b.assigneeAgentId === agent ? "part" : refuse(parent, true)) : "own";
      const child: Record<string, unknown> = Object.fromEntries(CREATE.slice(0, 7).filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
      const tag = tagOf("created", op);
      // A named project goes on the projects chain (projects.ts serial); an inherited one is read as it is, and a create never
      // waits behind other project writes for it.
      const d = await tagged(b.project !== undefined, async () => {
        // Its project: the one named, else its parent's, else (none there either) that of the task the job works on.
        const projectId = b.project !== undefined ? await projectNamed(decodeURIComponent(company), b.project) : (parent ? (await issue(parent.id)).projectId : undefined) ?? (await issue(task)).projectId;
        if (projectId) child.projectId = projectId;
        return send({ tag, ...(parent ? { issueId: parent.id, scope } : {}), child, delegateTo });
      });
      if (!d) return;
      return issueAnswer(d.child!, 201, { deduplicated: d.found });
    }

    /**
     * The evidence close: an open task an agent made and handed to the owner is closed (`done` or `cancelled`) by the agent
     * that made it, the agent that made a part of it (the follow-up chaser on a `waiting-on` task), or a fleet settler, with
     * a comment; `done` cites its evidence (a link or a task identifier) and still passes the finish gate. A label is the only
     * other change (`auto-closed`, which Home's Since reads). Never a task the owner made.
     */
    async function evidenceClose(t: Issue, status: unknown, patch: Record<string, unknown>, comment: unknown): Promise<boolean> {
      if (status !== "done" && status !== "cancelled") return false;
      if (!t.assigneeUserId || t.assigneeAgentId || !t.createdByAgentId || t.createdByUserId || ["done", "cancelled"].includes(String(t.status)) || isLogTask(t, logs)) return false;
      const may = t.createdByAgentId === agent || roles.includes(SETTLE) || (await partMaker(t));
      if (!may) return false;
      const beyond = Object.keys(patch).filter((k) => k !== "labelIds");
      if (beyond.length) throw fail(403, "forbidden", `closing the owner's task on evidence changes its status, comment and labels only; not ${beyond.join(", ")}`);
      if (typeof comment !== "string" || !comment.trim()) throw fail(400, "bad_request", `closing ${t.identifier ?? t.id} for the owner needs a comment saying why`);
      if (status === "done" && !EVIDENCE.test(comment)) throw fail(400, "bad_request", `closing ${t.identifier ?? t.id} as done for the owner cites its evidence: a link (the reply, the delivery, the merged PR) or a task identifier`);
      return true;
    }
    /** Whether this job's agent made a part (a child) of task `t`. */
    async function partMaker(t: Issue): Promise<boolean> {
      const co = t.companyId ?? (await viaPlugin(() => plugin.company(agent)));
      const r = await read(`/api/companies/${encodeURIComponent(co)}/issues?${new URLSearchParams({ parentId: t.id, status: "backlog,todo,in_progress,in_review,blocked,done,cancelled", limit: "100" })}`);
      if (r.status !== 200) return false;
      const kids = JSON.parse(r.out.toString("utf8")) as Issue[];
      return Array.isArray(kids) && kids.some((k) => k.parentId === t.id && k.createdByAgentId === agent);
    }

    // A comment, or a PATCH: on a task the job may write on.
    const ref = decodeURIComponent(/^\/api\/issues\/([^/]+)/.exec(path)![1]!);
    const t = await issue(ref);
    const comment = method === "POST" ? b.body : b.comment;
    if (method === "POST" && (typeof comment !== "string" || Object.keys(b).some((k) => k !== "body"))) throw fail(400, "bad_request", "a comment is {body}");
    const status = method === "PATCH" ? b.status : undefined;
    const patch = method === "PATCH" ? Object.fromEntries(Object.entries(b).filter(([k]) => k !== "status" && k !== "comment")) : {};
    const extra = Object.keys(patch).filter((k) => !PATCH.includes(k));
    if (extra.length) throw fail(400, "bad_request", `a task's change takes status, comment, ${PATCH.join(", ")}; not ${extra.join(", ")}`);
    // Setup's log tasks take comments only, even from the agent that holds them.
    if ((status !== undefined || Object.keys(patch).length) && isLogTask(t, logs)) throw fail(403, "forbidden", `${t.identifier ?? t.id} is a log task: it takes comments only`);
    // A settler acts as one on any task it may settle, its own and its delegations included.
    const settling = settleScope(t) === "settle";
    const evidence = await evidenceClose(t, status, patch, comment);
    const scope = evidence ? "evidence" : (await scopeOf(t)) ?? (settling ? "settle" : undefined) ?? (status === undefined && !Object.keys(patch).length ? commentScope(t) : undefined) ?? refuse(t);
    // On a task it holds by settling alone, a settler changes only what settling needs: the status, who holds it (an agent; never
    // handed to a person) and its blockers (a cycle broken); never its title, brief, priority or labels.
    if (scope === "settle") {
      // Settling moves open work: a closed task (done or cancelled) stays closed; new work is a new task.
      if ((status !== undefined || Object.keys(patch).length) && ["done", "cancelled"].includes(String(t.status))) throw fail(409, "refused", `${t.identifier ?? t.id} is ${t.status}: a settler moves open work only`);
      const beyond = Object.keys(patch).filter((k) => !["assigneeAgentId", "assigneeUserId", "blockedByIssueIds"].includes(k) || (k === "assigneeUserId" && patch[k] !== null));
      if (beyond.length) throw fail(403, "forbidden", `a settler changes another agent's task's status, holder (an agent) and blockers only; not ${beyond.join(", ")}`);
    }
    const handTo = patch.assigneeAgentId !== undefined && patch.assigneeAgentId !== null ? String(patch.assigneeAgentId) : undefined;
    // Only a settler hands a task to another agent here, and only to an agent of the grants table.
    if (handTo && !settling) throw fail(403, "forbidden", "a task is handed to another agent by its delegator, not reassigned here (assigneeAgentId: null hands it back)");
    if (handTo && !table[handTo]) throw fail(400, "bad_request", "assigneeAgentId is not an agent of this instance");
    await ownerOnly(patch.assigneeUserId);
    if (leavesNoHolder(t, { ...patch, ...(status !== undefined ? { status } : {}) })) throw fail(400, "bad_request", `${NO_HOLDER}: handing a task back names the owner (assigneeUserId)`);
    let gated = false;
    if (status === "done") {
      // The finish gate. Only this job's own task, one this job's agent holds (an orphaned routine run's), or, for a fleet settler,
      // a task it may settle that waits in review (finished work nobody closed; work still in progress is cancelled or routed,
      // never closed over its agent) is finished here; the checks hear the close as the task's own.
      const own = t.id === task || t.assigneeAgentId === agent;
      if (!own && !evidence && !(settling && t.status === "in_review")) throw fail(403, "forbidden", `only this job's own task is finished here; ${t.identifier ?? t.id} is finished by its assignee${settling ? " (a settler closes another agent's task only once it waits in review)" : ""}`);
      if (checks) {
        const tool = String(c.tool ?? "").split(".").pop()!;
        const f = await checks.finish(t.id, { agent, tool, via: tool });
        if (!f.pass) {
          log("cp", { module: mod.module, agent: c.key, method, path, finish: "held" in f ? "held" : "reopened" });
          return answer(202, Buffer.from(JSON.stringify("held" in f ? { held: { state: f.state, reason: f.reason } } : { reopened: { reason: f.reason } })));
        }
      }
      gated = true;
    }
    const blocked = status === "blocked";
    const { blockedByIssueIds, project, ...rest } = patch;
    const d = await tagged(project !== undefined, async () => {
    if (project !== undefined) rest.projectId = await projectNamed(String(t.companyId ?? (await viaPlugin(() => plugin.company(agent)))), project);
    return send({
      issueId: t.id, tag: tagOf(scope, op), scope,
      ...(typeof comment === "string" && comment.trim() ? { body: comment } : {}),
      ...(status !== undefined ? { status } : {}), ...(gated ? { gated } : {}),
      ...(blocked ? { blockedBy: blockedByIssueIds ?? [] } : {}),
      ...(handTo ? { delegateTo: [handTo] } : {}),
      ...(Object.keys(rest).length || (!blocked && blockedByIssueIds !== undefined) ? { patch: { ...rest, ...(!blocked && blockedByIssueIds !== undefined ? { blockedByIssueIds } : {}) } } : {}),
    });
    });
    if (!d) return;
    if (d.comment) fact({ type: "task.commented", subject: `task:${t.id}`, version: String(d.comment), at: iso(Date.now()), actor: `agent:${c.key}`, task: t.id, data: { kind: "cp", job: live.flight.job ?? c.run } });
    if (method === "POST") return answer(201, Buffer.from(JSON.stringify({ id: d.comment, issueId: t.id })));
    return issueAnswer(t.id, 200);
  }
  // A refusal is logged where it is raised: the module's answer carries it back as a tool error, and the journal shows it too.
  return async function cp(req: IncomingMessage, res: ServerResponse, path: string, query: string): Promise<void> {
    const who: { module?: string; agent?: string } = {};
    try { return await handle(req, res, path, query, who); } catch (e) {
      const f = e as { status?: number; message?: string };
      if (typeof f.status === "number") log("cp refused", { ...who, method: req.method, path, status: f.status, message: String(f.message).slice(0, 200) });
      throw e;
    }
  };
}

/** The control plane's routes the board reads as the owner (GET /v1/cp/read/<path> with the board's key). */
export const BOARD_READ_PATHS: RegExp[] = [
  /^\/api\/cli-auth\/me$/,
  new RegExp(`^/api/companies/${ID}$`),
  new RegExp(`^/api/companies/${ID}/(agents|labels|issues|live-runs|heartbeat-runs|routines|approvals|projects)$`),
  new RegExp(`^/api/companies/${ID}/costs/(by-agent|by-agent-model)$`),
  new RegExp(`^/api/heartbeat-runs/${ID}(/log)?$`),
  new RegExp(`^/api/issues/${ID}(/comments|/attachments)?$`),
  new RegExp(`^/api/routines/${ID}$`),
  new RegExp(`^/api/attachments/${ID}/content$`),
  new RegExp(`^/api/agents/${ID}/instructions-bundle/file$`),
];
/** The owner's writes the board makes (ANY /v1/cp/owner/<path> with the board's key), by method. */
export const BOARD_WRITE_PATHS: [string, RegExp][] = [
  ["POST", new RegExp(`^/api/companies/${ID}/(labels|approvals|issues)$`)],
  ["POST", new RegExp(`^/api/companies/${ID}/issues/${ID}/attachments$`)],
  ["POST", new RegExp(`^/api/agents/${ID}/(pause|resume|clear-error|wakeup)$`)],
  ["PATCH", new RegExp(`^/api/issues/${ID}$`)],
  ["POST", new RegExp(`^/api/issues/${ID}/(comments|recovery-actions/resolve)$`)],
  ["DELETE", new RegExp(`^/api/issues/${ID}/approvals/${ID}$`)],
  ["POST", new RegExp(`^/api/approvals/${ID}/reject$`)],
  ["POST", new RegExp(`^/api/heartbeat-runs/${ID}/cancel$`)],
  ["POST", new RegExp(`^/api/companies/${ID}/routines$`)],
  ["PATCH", new RegExp(`^/api/routines/${ID}$`)],
  ["POST", new RegExp(`^/api/routines/${ID}/(run|triggers)$`)],
  ["PATCH", new RegExp(`^/api/routine-triggers/${ID}$`)],
];
// An attachment the board uploads (10 MB, multipart) fits; nothing else comes near.
const BOARD_MAX_BODY = 16 * 1024 * 1024;

/**
 * The board's only way to the control plane: GET /v1/cp/read/<path> (reads) and ANY /v1/cp/owner/<path> (the owner's
 * writes), both with the board's key on the kernel (the backplane checks it). Only the kernel holds the control plane's
 * owner key (paperclip_board_key); the board holds none. Each path must be on the board's list for its method. Bodies and
 * answers pass as they are (an attachment upload is multipart, its content bytes). `X-AidenHQ-Account` names the signed-in
 * admin a write is for (none: the board's own timers and notices); it is logged with the write.
 */
export function createBoardCp({ controlUrl, key, fetch = globalThis.fetch, observe, facts, ownerFiled = () => {}, log = () => {} }: { /** A task the owner filed on the board (admission.ts reads it: platform authority). */ ownerFiled?: (task: string) => void; /** The fact log: the owner's comments are recorded here, whichever agents are polled. */ facts?: Facts; controlUrl: string; key: () => string; fetch?: typeof globalThis.fetch; observe?: (issue: { id: string }, actor: string) => Promise<void>; log?: (msg: string, f?: Record<string, unknown>) => void }) {
  return async function boardCp(req: IncomingMessage, res: ServerResponse, lane: string, path: string, query: string): Promise<void> {
    const method = String(req.method);
    const allowed = lane === "read" ? method === "GET" && BOARD_READ_PATHS.some((re) => re.test(path)) : BOARD_WRITE_PATHS.some(([m, re]) => m === method && re.test(path));
    if (!allowed) throw fail(403, "forbidden", `${method} ${path} isn't one of the board's ${lane === "read" ? "read" : "owner"} routes`);
    const account = String(req.headers["x-aidenhq-account"] ?? "");
    if (account && !/^[A-Za-z0-9_-]{1,100}$/.test(account)) throw fail(400, "bad_request", "X-AidenHQ-Account isn't an account id");
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > BOARD_MAX_BODY) throw fail(413, "too_large", "too large"); chunks.push(c); }
    const body = method === "GET" ? undefined : Buffer.concat(chunks);
    const type = req.headers["content-type"];
    // An owner write that would leave an open task with no holder (leavesNoHolder) is refused before it reaches the control plane.
    const created = method === "POST" && /^\/api\/companies\/[^/]+\/issues$/.test(path), changed = method === "PATCH" && /^\/api\/issues\/[^/]+$/.test(path);
    // A routine the board makes is an owner's recurring task, titled "Repeats: …": that prefix is the board's alone (compile
    // refuses it for a module's routine), so setup can tell the board's routines from its own.
    if (method === "POST" && /^\/api\/companies\/[^/]+\/routines$/.test(path)) {
      let title = "";
      try { title = String(JSON.parse(body!.toString("utf8") || "{}").title ?? ""); } catch { /* refused below */ }
      if (!title.startsWith("Repeats: ")) throw fail(403, "forbidden", 'the board makes only recurring tasks\' routines, titled "Repeats: …"');
    }
    if (created || changed) {
      let b: Record<string, unknown>;
      try { b = JSON.parse(body!.toString("utf8") || "{}"); } catch { throw fail(400, "bad_request", "the body must be JSON"); }
      let cur: { status?: string; assigneeAgentId?: string | null; assigneeUserId?: string | null } | undefined;
      if (changed && (b.assigneeAgentId !== undefined || b.assigneeUserId !== undefined)) {
        const r = await fetch(new URL(path, controlUrl), { signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${key()}`, accept: "application/json" } });
        if (!r.ok) throw fail(r.status === 404 ? 404 : 502, "upstream", `the control plane answered ${r.status} for ${path}`);
        cur = (await r.json()) as typeof cur;
      }
      if (leavesNoHolder(changed ? cur ?? {} : undefined, b)) throw fail(400, "bad_request", NO_HOLDER);
    }
    const r = await fetch(new URL(`${path}${query}`, controlUrl), {
      method, signal: AbortSignal.timeout(60_000),
      // The board's own typed-words mark (its compose box, crew instructions) passes to the owner-key caller, which strips it (cplimit.ts markCode).
      headers: { authorization: `Bearer ${key()}`, accept: String(req.headers.accept ?? "application/json"), ...(body?.length && type ? { "content-type": String(type) } : {}), ...(req.headers[TYPED] === "owner" ? { [TYPED]: "owner" } : {}) },
      ...(body?.length ? { body } : {}),
    });
    const out = await capped(r);
    if (lane === "owner") log("cp owner", { method, path, status: r.status, ...(account ? { account } : {}) });
    // The owner's comment is a fact at once (version = its id), whoever holds the task.
    if (lane === "owner" && r.ok && method === "POST") {
      const m = /^\/api\/issues\/([^/]+)\/comments$/.exec(path);
      try {
        const c = JSON.parse(out.toString("utf8")) as { id?: unknown; createdAt?: unknown };
        if (m && typeof c.id === "string") factWriter(facts, log)({ type: "task.commented", subject: `task:${decodeURIComponent(m[1]!)}`, version: c.id, at: typeof c.createdAt === "string" ? c.createdAt : iso(Date.now()), actor: account ? `account:${account}` : "unknown", task: decodeURIComponent(m[1]!), data: { kind: "comment" } });
      } catch { /* not JSON: nothing to record */ }
    }
    // A task the owner just changed or made has its facts recorded at once, from the issue the write returned; the write stands if that fails.
    if (lane === "owner" && r.ok && (created || changed)) {
      try {
        const issue = JSON.parse(out.toString("utf8")) as { id?: unknown };
        if (typeof issue.id === "string" && created && !(issue as { deduplicated?: unknown }).deduplicated) ownerFiled(issue.id);
        if (typeof issue.id === "string") await observe?.(issue as { id: string }, account ? `account:${account}` : "unknown");
      } catch (e) { log("observe failed", { path, err: (e as Error).message }); }
    }
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json", "content-length": out.length }).end(out);
  };
}

/**
 * A module's model call for the caller it serves (an advisor or fan-out tool), billed to that caller's run: only
 * for a module whose connection declares model_as_caller, and only while that caller's tool call is in flight. Returns the
 * caller's own credential for the gateway to identify, or undefined when the request carries no assertion.
 */
export function createAsCaller({ whoami, connections, asserter, log = () => {} }: {
  whoami: Whoami; connections: () => Record<string, Connection>; asserter: Asserter; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  return async function asCaller(req: IncomingMessage): Promise<string | undefined> {
    const jwt = String(req.headers["x-aidenhq-caller"] ?? "");
    if (!jwt) return undefined;
    const mod = await whoami(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim()).catch(() => undefined);
    if (mod?.kind !== "module" || !mod.module) throw fail(401, "unauthorized", "a caller assertion needs a module's own token");
    if (!Object.values(connections()).some((c) => c.module === mod.module && c.model_as_caller === true)) throw fail(403, "forbidden", `${mod.module} doesn't make model calls for its callers`);
    const live = await asserter.inFlight(jwt, mod.module);
    if (!live?.flight.bearer) throw fail(401, "unauthorized", "the caller assertion isn't for a kernel job's call in flight to this module");
    log("model as caller", { module: mod.module, agent: live.caller.key, tool: live.caller.tool });
    return live.flight.bearer;
  };
}
