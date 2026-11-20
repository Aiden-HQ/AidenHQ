import type { Api } from "./record-agent.ts";

/** The parts of the compiled config these functions read, and a Paperclip row. */
interface Cfg { agents?: Record<string, { department?: { id?: unknown } }>; routines?: Record<string, { title?: string }> }
type Step = (msg: string) => void;
type Row = Record<string, any>;

/**
 * Setup-owned agents (setupKey aidenhq:<key>) that are no longer configured (pruned, or their module disabled) are
 * terminated, so they leave the board's agent list and its "needs you" count; the routines of a setup-owned agent that are
 * no longer configured are archived. ensureAgents ignores terminated agents and creates a fresh one if the key returns,
 * and ensureRoutines reactivates an archived routine by title.
 */
export async function retireUnconfigured({ api, companyId, cfg, step }: { api: Api; companyId: string; cfg: Cfg; step: Step }) {
  const keys = new Set(Object.keys(cfg.agents ?? {}).map((k) => `aidenhq:${k}`));
  const titles = new Set(Object.values(cfg.routines ?? {}).map((r) => r.title));
  const { json: all } = await api("GET", `/api/companies/${companyId}/agents`);
  const owned = all.filter((x: Row) => String(x.metadata?.setupKey ?? "").startsWith("aidenhq:") && x.status !== "terminated");
  const ownedIds = new Set(owned.map((x: Row) => x.id));
  const { json: routines } = await api("GET", `/api/companies/${companyId}/routines`);
  // The routines the board makes for the owner's recurring tasks (services/board/src/recurring.ts ROUTINE_PREFIX) aren't configuration.
  for (const r of routines.filter((r: Row) => ownedIds.has(r.assigneeAgentId) && !titles.has(r.title) && !r.title.startsWith("Repeats: ") && r.status !== "archived")) {
    await api("PATCH", `/api/routines/${r.id}`, { status: "archived" });
    step(`Archived routine ${r.title} (no longer configured)`);
  }
  for (const x of owned.filter((x: Row) => !keys.has(x.metadata.setupKey))) {
    // Its open tasks are what termination makes unreachable: when they can't be listed, this agent stays live (and its
    // tasks reachable) and the other agents are still retired. The next setup run tries it again.
    if (!(await handOverIssues({ api, companyId, cfg, agent: x, agents: all, step }))) {
      console.warn(`! left ${x.name} in place: its open tasks couldn't be listed, and terminating it would strand them`);
      step(`Not terminated ${x.name} (its open tasks couldn't be listed)`);
      continue;
    }
    await api("POST", `/api/agents/${x.id}/terminate`, {});
    step(`Terminated ${x.name} (no longer configured)`);
  }
}

const OPEN = "backlog,todo,in_progress,in_review,blocked";

/**
 * Team members (metadata.memberOf) no longer configured that still hold open tasks, each with their identifiers. A member is
 * retired only once drained or handed off: setup refuses to go on while any is listed (its peers are many, so no one successor).
 */
export async function busyRemovedMembers({ api, companyId, cfg }: { api: Api; companyId: string; cfg: Cfg }) {
  const { json: all } = await api("GET", `/api/companies/${companyId}/agents`);
  const gone = all.filter((x: Row) => x.metadata?.memberOf && x.status !== "terminated" && !Object.hasOwn(cfg.agents ?? {}, String(x.metadata.setupKey ?? "").replace(/^aidenhq:/, "")));
  const out: { name: string; tasks: string[] }[] = [];
  for (const x of gone) {
    const open = await listWithRetry(api, companyId, x.id);
    if (open.length) out.push({ name: x.name, tasks: open.map((i: Row) => i.identifier ?? i.id) });
  }
  return out;
}

/**
 * An agent's open issues cannot stay assigned to it once it is terminated: nothing resolves that key, so no wake or dispatch
 * reaches them again. Before the terminate, each open issue goes to the one remaining agent in the same department, or, when
 * that department has none or several, back to the owner unassigned. Every move is commented on.
 *
 * A failure to move or comment on one issue is reported, with the issue's identifier, and skipped: the remaining issues
 * still move and the agent is still terminated. That is deliberate, and the one case where a task can be left on the dead
 * key: a board that rejects some patches must not keep an unconfigured agent alive run after run, which would leave every
 * one of its tasks on a key that is only still resolvable by accident. The operator sees each stranded identifier in the
 * warning and can reassign it by hand. The list itself is different — see the return value.
 *
 * Returns whether the agent may be terminated: the list is retried, and false when it still can't be read, because
 * terminating then would strand every task on the dead key, which is the defect this exists to prevent.
 */
async function handOverIssues({ api, companyId, agent, agents, cfg, step }: { api: Api; companyId: string; agent: Row; agents: Row[]; cfg: Cfg; step: Step }) {
  const department = typeof agent.metadata?.department?.id === "string" ? agent.metadata.department.id : null;
  const peers = department == null ? [] : Object.entries(cfg.agents ?? {}).filter(([, a]) => typeof a.department?.id === "string" && a.department.id === department);
  const successor = peers.length === 1 ? agents.find((x: Row) => x.metadata?.setupKey === `aidenhq:${peers[0]![0]}` && x.status !== "terminated") ?? null : null;
  let issues: Row[];
  try {
    issues = await listWithRetry(api, companyId, agent.id);
  } catch (e) {
    console.warn(`! couldn't list the open tasks of ${agent.name}: ${(e as Error).message}`);
    return false;
  }
  if (!issues.length) return true;
  // Without a successor the tasks go to the owner; an unreadable user id still leaves them unassigned and todo, never on the
  // dead key, but the warning says nobody holds them.
  let ownerId = null;
  if (!successor) {
    try {
      ownerId = (await api("GET", "/api/cli-auth/me")).json?.userId ?? null;
    } catch (e) {
      console.warn(`! couldn't read the owner's user id (${(e as Error).message}); the open tasks of ${agent.name} go unassigned`);
    }
  }
  const patch = successor ? { assigneeAgentId: successor.id, assigneeUserId: null } : { assigneeAgentId: null, assigneeUserId: ownerId, status: "todo" };
  const note = successor ? `${agent.name} was retired; this task was handed to ${successor.name}.`
    : ownerId ? `${agent.name} was retired; this task was unassigned and returned to the owner.`
    : `${agent.name} was retired; this task was left unassigned.`;
  const moved: string[] = [];
  const stranded: string[] = [];
  for (const issue of issues) {
    const label = issue.identifier ?? issue.id;
    try {
      await api("PATCH", `/api/issues/${issue.id}`, patch);
      moved.push(label);
    } catch (e) {
      stranded.push(label);
      console.warn(`! couldn't move ${label} from ${agent.name}; leaving it on the dead key: ${(e as Error).message}`);
      continue;
    }
    try {
      await api("POST", `/api/issues/${issue.id}/comments`, { body: note });
    } catch (e) {
      console.warn(`! moved ${issue.identifier ?? issue.id} but couldn't comment on it: ${(e as Error).message}`);
    }
  }
  const to = successor ? successor.name : ownerId ? "the owner" : "nobody (unassigned)";
  step(`Handed ${moved.length} of ${issues.length} open task${issues.length === 1 ? "" : "s"} of ${agent.name} to ${to} (no longer configured)`);
  if (stranded.length) {
    // Reported, not fatal: the terminate still happens, as the handover is best-effort per issue. These identifiers are the
    // tasks an operator still has to pick up.
    step(`Left ${stranded.length} open task${stranded.length === 1 ? "" : "s"} of ${agent.name} on its key after a failed move: ${stranded.join(", ")}`);
  }
  return true;
}

/** The list, retried: a transient failure on the first try must not leave an agent unterminated for good. */
async function listWithRetry(api: Api, companyId: string, agentId: string, tries = 3): Promise<Row[]> {
  for (let n = 1; ; n++) {
    try {
      return await openIssues(api, companyId, agentId);
    } catch (e) {
      if (n >= tries) throw e;
      await new Promise((r) => setTimeout(r, 200 * n));
    }
  }
}

/** The agent's open issues, paged: done and cancelled rows are never touched. */
async function openIssues(api: Api, companyId: string, agentId: string) {
  const all: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const q = new URLSearchParams({ status: OPEN, assigneeAgentId: agentId, limit: "500", offset: String(offset) });
    const page = (await api("GET", `/api/companies/${companyId}/issues?${q}`)).json;
    all.push(...page);
    if (page.length < 500) return all;
  }
}
