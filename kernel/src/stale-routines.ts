// Routine runs that ended blocked (e.g. configuration_incomplete) stay open forever; once a later run of the same routine
// finished done they are moot, so their own agent cancels them (outcomes.ts post, kind `stale`, never the owner). Not for a
// routine that enqueues a run per event (always_enqueue): another event's run finishing says nothing about this one's work.
// The wake inbox (wakes.ts) coalesces only open (todo, in_progress, in_review) runs, so a blocked one is left to this.
import type { Api } from "./channels.ts";
import type { Outcomes } from "./outcomes.ts";

interface RoutineIssue { id: string; identifier?: string; originKind?: string | null; originId?: string | null; status?: string; createdAt: string }

/**
 * Blocked routine runs overtaken by a later run of the same routine that finished done → [{ issue, by }] (by: the newest
 * such run). Filters here too: a list may hold more than was asked for.
 */
export function staleRoutineRuns<I extends RoutineIssue>(blocked: I[], done: I[], perEvent: Set<string> = new Set()): { issue: I; by: I }[] {
  const run = (i: I | undefined, status: string) => i?.originKind === "routine_execution" && i.status === status && i.originId;
  return blocked.filter((b) => run(b, "blocked") && !perEvent.has(b.originId!)).flatMap((b) => {
    const by = done.filter((d) => run(d, "done") && d.originId === b.originId && d.createdAt > b.createdAt).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    return by ? [{ issue: b, by }] : [];
  });
}

/** One agent's blocked routine runs (in `company`), read as the owner and cancelled as the agent when a later run succeeded. */
export async function closeStaleRoutineRuns(
  { owner, post, log = () => {} }: { owner: Api; post: Outcomes["post"]; log?: (msg: string, f?: Record<string, unknown>) => void },
  agent: string,
  company: string,
): Promise<void> {
  const list = async (query: string): Promise<RoutineIssue[]> => {
    const r = await owner("GET", `/api/companies/${encodeURIComponent(company)}/issues?originKind=routine_execution&${query}`);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`control plane GET issues → ${r.status}`);
    return r.json;
  };
  const blocked = await list(`status=blocked&assigneeAgentId=${encodeURIComponent(agent)}&limit=200`);
  const routines = [...new Set(blocked.map((b) => b.originId).filter((id): id is string => !!id))];
  if (!routines.length) return;
  const perEvent = new Set<string>();
  const done: RoutineIssue[] = [];
  for (const id of routines) {
    const def = await owner("GET", `/api/routines/${encodeURIComponent(id)}`);
    if (def.status !== 200 || def.json?.concurrencyPolicy === "always_enqueue") { perEvent.add(id); continue; }
    done.push(...(await list(`status=done&originId=${encodeURIComponent(id)}&limit=5`)));
  }
  for (const { issue, by } of staleRoutineRuns(blocked, done, perEvent)) {
    await post({ id: issue.id, agent, task: issue.id }, { kind: "stale", status: "cancelled", body: `Closed: a later run of this routine (${by.identifier}) succeeded.` });
    log("stale routine run cancelled", { task: issue.id, by: by.identifier });
  }
}
