// A green change request on this server asks for its merge itself (the local equivalent of the agents-org auto-merge): no
// Engineer runs `aidenhq merge`. The kernel files the same Tier 1 `local-merge` record an Engineer would, as the task's own
// agent, so the AI reviewer still reads the diff and the caps still apply. A pass is pure over its seams (main.ts wires the
// host's open changes, the control plane's task, the grants table, the records and writes), so its rules are tested directly.
//
// Asked for: the change is open, every named check is green on its head, its task is open and assigned to a granted agent, and
// no live record of the task already names this change at this head and this base (once per head *and* base: a merge asked
// before the base moved is not this one). Never asked for: a done or cancelled task, a change whose checks are red or still
// running, or one with no checks at all.
//
// A check is keyed to the head and the base it ran against. A base that moved under an open change (another merge landed)
// leaves it with no check for the new base: the pass asks for it again, at most once per head and base per `restartAfterMs`, so
// a green change still merges without a nudge. That is `missing` (the check couldn't run, or not yet asked), never `red`.
import type { Rec } from "./records.ts";

export type OpenChange = {
  repo: string; number: number; url: string; head: string; base: string; task?: string;
  checks: { ok: boolean; pending: boolean; missing?: boolean }[];
};
/** What the control plane says of the task a change names (the kernel reads the assignee and whether it is closed). */
export type ChangeTask = { status?: string; assigneeAgentId?: string | null };

/** Whether this change's merge should be filed now: open, green, its task open and assigned, and not asked for at this head/base. */
export function shouldAskMerge(
  c: OpenChange,
  task: ChangeTask | undefined,
  prior: { args?: unknown; targets?: Record<string, unknown> }[],
): boolean {
  if (!task || !task.assigneeAgentId || ["done", "cancelled"].includes(String(task.status))) return false;
  if (!c.checks.length || c.checks.some((x) => !x.ok)) return false;
  const base = (r: { targets?: Record<string, unknown> }) => (r.targets?.[`${c.repo}#${c.number}`] as { base_sha?: string } | undefined)?.base_sha ?? c.base;
  const names = (r: { args?: unknown }) => (r.args as { prs?: { repo?: string; number?: number; head?: string }[] } | null)?.prs ?? [];
  return !prior.some((r) => names(r).some((p) => p.repo === c.repo && p.number === c.number && p.head === c.head) && base(r) === c.base);
}

/** Whether this change needs a check started again: one is missing (never asked, or it couldn't run) on this head and base. */
export const needsCheck = (c: OpenChange) => c.checks.some((x) => x.missing === true);

/** When this process last asked for a check again, by change, head and base: the throttle spans passes, not one pass. */
const restarts = new Map<string, number>();

/**
 * One pass over every open change on this server. `live(change)`: the task's own record for this change, at this head and
 * base, still undecided (or already run) — the ask that already exists. Returns what it filed, and what it restarted.
 */
export async function localMergePass({
  open, task, grant, prior, file, restart, now = Date.now, restartAfterMs = 10 * 60_000, asked = restarts, log = () => {},
}: {
  open: () => Promise<OpenChange[]>;
  /** The control plane's task, or undefined when it can't be read now (never asked on a guess). */
  task: (id: string) => Promise<ChangeTask | undefined>;
  /** The grants table's entry for an agent (its key), or undefined when it isn't there (never asked for a stranger). */
  grant: (agent: string) => { key?: string } | undefined;
  /** The task's records for merges (records.list over every decided and undecided state). */
  prior: (task: string) => { args?: unknown; targets?: Record<string, unknown> }[];
  /** Files the merge as the task's agent (writes.fileLocalMerge). */
  file: (b: { agent: string; key: string; name: string; task: string; args: unknown }) => Promise<Rec>;
  /** Asks for a check again at this head and base (the kernel's check job start). */
  restart: (c: OpenChange) => Promise<unknown>;
  now?: () => number;
  restartAfterMs?: number;
  /** When each check was last asked for again (module scope by default, so the window spans passes). */
  asked?: Map<string, number>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}): Promise<{ filed: { change: string; record: string; tier: number; state: string }[]; restarted: string[]; skipped: { change: string; why: string }[] }> {
  const out: { filed: { change: string; record: string; tier: number; state: string }[]; restarted: string[]; skipped: { change: string; why: string }[] } = { filed: [], restarted: [], skipped: [] };
  for (const c of await open()) {
    if (!c.task) { out.skipped.push({ change: c.url, why: "no task" }); continue; }
    let t: ChangeTask | undefined;
    try { t = await task(c.task); } catch (e) { out.skipped.push({ change: c.url, why: `task unreadable: ${String((e as Error).message ?? e).slice(0, 120)}` }); continue; }
    if (!shouldAskMerge(c, t, prior(c.task))) {
      // A base that moved leaves the change with no check for it; ask again, at most once per head and base per window.
      const key = `${c.url} ${c.head} ${c.base}`;
      if (t && !["done", "cancelled"].includes(String(t.status)) && t.assigneeAgentId && grant(t.assigneeAgentId) && needsCheck(c) && now() - (asked.get(key) ?? 0) > restartAfterMs) {
        asked.set(key, now());
        try { await restart(c); out.restarted.push(c.url); } catch (e) { log("local check didn't start", { change: c.url, err: String((e as Error).message ?? e).slice(0, 200) }); }
      }
      continue;
    }
    const g = grant(t!.assigneeAgentId!)!;
    try {
      const r = await file({ agent: t!.assigneeAgentId!, key: String(g.key ?? ""), name: String(g.key ?? t!.assigneeAgentId), task: c.task, args: { prs: [{ repo: c.repo, number: c.number, head: c.head }] } });
      out.filed.push({ change: c.url, record: r.id, tier: r.tier, state: r.state });
      log("local change merge asked for", { change: c.url, record: r.id, tier: r.tier, state: r.state });
    } catch (e) {
      out.skipped.push({ change: c.url, why: String((e as Error).message ?? e).slice(0, 200) });
      log("local change merge not asked", { change: c.url, err: String((e as Error).message ?? e).slice(0, 300) });
    }
  }
  return out;
}
