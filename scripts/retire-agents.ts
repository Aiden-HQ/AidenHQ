import type { Api } from "./record-agent.ts";

/** The parts of the compiled config these functions read, and a Paperclip row. */
interface Cfg { agents?: Record<string, { roles?: string[]; member_of?: string }>; routines?: Record<string, { title?: string }> }
type Step = (msg: string) => void;
type Row = Record<string, any>;

/**
 * Setup-owned agents (setupKey aidenhq:<key>) that are no longer configured (pruned, or their module disabled) are
 * terminated, so they leave the board's agent list and its "needs you" count (setup's routine sync archives the routines
 * no longer configured, by identity: paperclip-diff.ts syncRoutines). ensureAgents ignores terminated agents and creates a
 * fresh one if the key returns. Then every open task a terminated agent still holds is re-homed (rehomeStranded), whenever
 * and however its agent went.
 */
export async function retireUnconfigured({ api, companyId, cfg, step }: { api: Api; companyId: string; cfg: Cfg; step: Step }) {
  const keys = new Set(Object.keys(cfg.agents ?? {}).map((k) => `aidenhq:${k}`));
  const { json: all } = await api("GET", `/api/companies/${companyId}/agents`);
  const owned = all.filter((x: Row) => String(x.metadata?.setupKey ?? "").startsWith("aidenhq:") && x.status !== "terminated");
  for (const x of owned.filter((x: Row) => !keys.has(x.metadata.setupKey))) {
    await api("POST", `/api/agents/${x.id}/terminate`, {});
    step(`Terminated ${x.name} (no longer configured)`);
  }
  await rehomeStranded({ api, companyId, cfg, step });
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
    const open = await openIssues(api, companyId, x.id);
    if (open.length) out.push({ name: x.name, tasks: open.map((i: Row) => i.identifier ?? i.id) });
  }
  return out;
}

/**
 * Every open task held by an agent that is no longer live (terminated, or gone) moves to backlog, held by its successor: the
 * live agent with the gone agent's key (it came back), else the configured agent holding one of its roles (its metadata's,
 * written by setup), else the chief of staff (role fleet-admin). Backlog wakes nobody: each successor gets ONE todo task
 * listing what it now holds, to close or re-delegate each. Idempotent: once nothing is held by a gone agent, a run moves
 * nothing and files nothing. A task whose move fails stays where it is, named in the output, and the next run tries it again.
 */
export async function rehomeStranded({ api, companyId, cfg, step }: { api: Api; companyId: string; cfg: Cfg; step: Step }) {
  const live = (await api("GET", `/api/companies/${companyId}/agents`)).json.filter((x: Row) => x.status !== "terminated");
  const liveIds = new Set(live.map((x: Row) => x.id));
  const stranded = (await openIssues(api, companyId)).filter((i) => i.assigneeAgentId && !liveIds.has(i.assigneeAgentId));
  if (!stranded.length) return;
  const byKey = (key: string) => live.find((x: Row) => x.metadata?.setupKey === `aidenhq:${key}`);
  const leads = Object.entries(cfg.agents ?? {}).filter(([, a]) => !a.member_of);
  const chief = leads.find(([, a]) => a.roles?.includes("fleet-admin"));
  const successors = new Map<string, Row | undefined>();
  /** The successor of a holder missing from the agent list, or undefined when it isn't gone (its record isn't terminated or 404). */
  const successor = async (id: string) => {
    if (successors.has(id)) return successors.get(id);
    const gone: Row | null = await api("GET", `/api/agents/${id}`).then((r) => r.json ?? null, (e: Error) => (/\b404\b/.test(e.message) ? null : Promise.reject(e)));
    if (gone && gone.status !== "terminated") { successors.set(id, undefined); return undefined; }
    const key = String(gone?.metadata?.setupKey ?? "").replace(/^aidenhq:/, "");
    const roles: string[] = Array.isArray(gone?.metadata?.roles) ? gone!.metadata.roles : [];
    const heir = leads.find(([k, a]) => a.roles?.some((r) => roles.includes(r)) && byKey(k));
    const to = (key && byKey(key)) || (heir && byKey(heir[0])) || (chief && byKey(chief[0]));
    if (!to) console.warn(`! the open tasks of ${gone?.name ?? id} stay on it: no live successor and no chief of staff`);
    successors.set(id, to ? { ...to, from: gone?.name ?? id } : undefined);
    return successors.get(id);
  };
  const plan = new Map<string, { to: Row; tasks: Row[] }>();
  for (const i of stranded) {
    const to = await successor(i.assigneeAgentId);
    if (to) (plan.get(to.id) ?? plan.set(to.id, { to, tasks: [] }).get(to.id)!).tasks.push({ ...i, from: to.from });
  }
  // The triage task first: a move that fails later is listed once more by the next run's, never lost from both.
  for (const { to, tasks } of plan.values()) {
    const lines = tasks.map((i) => `- ${i.identifier ?? i.id}: ${i.title ?? ""} (was ${i.from}'s, ${i.status})`);
    const description = `These open tasks were held by agents that are no longer configured, so nothing would ever run them. Setup moved each to your backlog. For each one: close it if it is done or no longer wanted, or delegate it to the agent that does that work now.\n\n${lines.join("\n")}`;
    await api("POST", `/api/companies/${companyId}/issues`, { title: `Triage ${tasks.length} task${tasks.length === 1 ? "" : "s"} from retired agents`, description, status: "todo", assigneeAgentId: to.id });
    let n = 0;
    for (const i of tasks) {
      try {
        await api("PATCH", `/api/issues/${i.id}`, { status: "backlog", assigneeAgentId: to.id, assigneeUserId: null });
        n++;
      } catch (e) {
        console.warn(`! couldn't move ${i.identifier ?? i.id} off its retired holder (the next setup tries again): ${(e as Error).message}`);
      }
    }
    step(`Moved ${n} of ${tasks.length} open task${tasks.length === 1 ? "" : "s"} of retired agents to ${to.name}'s backlog, with one task to triage them`);
  }
}

/** The company's open issues, paged: done and cancelled rows are never touched. */
async function openIssues(api: Api, companyId: string, assigneeAgentId?: string) {
  const all: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const q = new URLSearchParams({ status: OPEN, ...(assigneeAgentId ? { assigneeAgentId } : {}), limit: "500", offset: String(offset) });
    const page = (await api("GET", `/api/companies/${companyId}/issues?${q}`)).json;
    all.push(...page);
    if (page.length < 500) return all;
  }
}
