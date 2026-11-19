/**
 * Setup-owned agents (setupKey aidenhq:<key>) that are no longer configured (pruned, or their module disabled) are
 * terminated, so they leave the board's agent list and its "needs you" count; the routines of a setup-owned agent that are
 * no longer configured are archived. ensureAgents ignores terminated agents and creates a fresh one if the key returns,
 * and ensureRoutines reactivates an archived routine by title.
 */
export async function retireUnconfigured({ api, companyId, cfg, step }) {
  const keys = new Set(Object.keys(cfg.agents ?? {}).map((k) => `aidenhq:${k}`));
  const titles = new Set(Object.values(cfg.routines ?? {}).map((r) => r.title));
  const { json: all } = await api("GET", `/api/companies/${companyId}/agents`);
  const owned = all.filter((x) => String(x.metadata?.setupKey ?? "").startsWith("aidenhq:") && x.status !== "terminated");
  const ownedIds = new Set(owned.map((x) => x.id));
  const { json: routines } = await api("GET", `/api/companies/${companyId}/routines`);
  for (const r of routines.filter((r) => ownedIds.has(r.assigneeAgentId) && !titles.has(r.title) && r.status !== "archived")) {
    await api("PATCH", `/api/routines/${r.id}`, { status: "archived" });
    step(`Archived routine ${r.title} (no longer configured)`);
  }
  for (const x of owned.filter((x) => !keys.has(x.metadata.setupKey))) {
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
 * An agent's open issues cannot stay assigned to it once it is terminated: nothing resolves that key, so no wake or dispatch
 * reaches them again. Before the terminate, each open issue goes to the one remaining agent in the same department, or, when
 * that department has none or several, back to the owner unassigned. Every move is commented on, and a failure on one issue
 * or comment is reported and skipped so the rest still move and the agent is still retired.
 *
 * Returns whether the agent may be terminated: the list is retried, and false when it still can't be read, because
 * terminating then would strand every task on the dead key, which is the defect this exists to prevent.
 */
async function handOverIssues({ api, companyId, agent, agents, cfg, step }) {
  const department = typeof agent.metadata?.department?.id === "string" ? agent.metadata.department.id : null;
  const peers = department == null ? [] : Object.entries(cfg.agents ?? {}).filter(([, a]) => typeof a.department?.id === "string" && a.department.id === department);
  const successor = peers.length === 1 ? agents.find((x) => x.metadata?.setupKey === `aidenhq:${peers[0][0]}` && x.status !== "terminated") ?? null : null;
  let issues;
  try {
    issues = await listWithRetry(api, companyId, agent.id);
  } catch (e) {
    console.warn(`! couldn't list the open tasks of ${agent.name}: ${e.message}`);
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
      console.warn(`! couldn't read the owner's user id (${e.message}); the open tasks of ${agent.name} go unassigned`);
    }
  }
  const patch = successor ? { assigneeAgentId: successor.id, assigneeUserId: null } : { assigneeAgentId: null, assigneeUserId: ownerId, status: "todo" };
  const note = successor ? `${agent.name} was retired; this task was handed to ${successor.name}.`
    : ownerId ? `${agent.name} was retired; this task was unassigned and returned to the owner.`
    : `${agent.name} was retired; this task was left unassigned.`;
  let moved = 0;
  for (const issue of issues) {
    try {
      await api("PATCH", `/api/issues/${issue.id}`, patch);
      moved++;
    } catch (e) {
      console.warn(`! couldn't move ${issue.identifier ?? issue.id} from ${agent.name}; leaving it: ${e.message}`);
      continue;
    }
    try {
      await api("POST", `/api/issues/${issue.id}/comments`, { body: note });
    } catch (e) {
      console.warn(`! moved ${issue.identifier ?? issue.id} but couldn't comment on it: ${e.message}`);
    }
  }
  const to = successor ? successor.name : ownerId ? "the owner" : "nobody (unassigned)";
  step(`Handed ${moved} of ${issues.length} open task${issues.length === 1 ? "" : "s"} of ${agent.name} to ${to} (no longer configured)`);
  return true;
}

/** The list, retried: a transient failure on the first try must not leave an agent unterminated for good. */
async function listWithRetry(api, companyId, agentId, tries = 3) {
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
async function openIssues(api, companyId, agentId) {
  const all = [];
  for (let offset = 0; ; offset += 500) {
    const q = new URLSearchParams({ status: OPEN, assigneeAgentId: agentId, limit: "500", offset: String(offset) });
    const page = (await api("GET", `/api/companies/${companyId}/issues?${q}`)).json;
    all.push(...page);
    if (page.length < 500) return all;
  }
}
