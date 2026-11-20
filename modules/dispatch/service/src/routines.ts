// A routine's runs. Paperclip makes one task per tick and, with nothing running in it, never folds them: a run arriving while
// an earlier one of its routine is in flight is folded into it here (cancelled as its agent), and a blocked run is cancelled
// once a later run of the same routine finished. Not for an always_enqueue routine: each of its runs is its own event's work.
// "In flight" is a live job, or a wake still waiting to start one: an earlier run whose job ended and left the task idle (a run
// that never called task_finish, say) is not folded into, so it can't swallow every later tick of the routine; the kernel's
// idle sweep (kernel/src/idle.ts) wakes that run's holder instead. A run waiting behind another job of its agent keeps its wake
// (admission hands it back), so it stays in flight.
// Dispatch judges; the kernel only cancels an open or blocked routine run of an agent this module dispatches (POST /v1/routines/cancel).
import type { Kernel } from "./kernel.ts";
import type { Issue } from "./thread.ts";

const OPEN = "todo,in_progress,in_review";
const ENDED = new Set(["done", "failed", "cancelled", "timeout", "lost"]);
const SWEEP_MS = 60_000;
const ms = (t?: string) => (t ? Date.parse(t) || 0 : 0);

export function createRoutines(kernel: Kernel, log: (msg: string, f?: Record<string, unknown>) => void = () => {}) {
  let swept = 0;
  const perEvent = async (routine: string) => (await kernel.routine(routine)).concurrencyPolicy === "always_enqueue";
  const runs = (company: string, query: string) => kernel.issues(company, `originKind=routine_execution&${query}`);
  /** Whether a task is in flight now: a live job of its run, or a wake still waiting to start one. */
  const inFlight = async (t: Issue) => (await kernel.jobsOf(t.id)).some((j) => !ENDED.has(j.state)) || (await kernel.wakePending(t.id));

  return {
    /** A routine run's task: cancelled when an earlier run of its routine is in flight (true), else left to run. */
    async coalesce(task: Issue): Promise<boolean> {
      if (task.originKind !== "routine_execution" || !task.originId || !task.companyId || (await perEvent(task.originId))) return false;
      const earlier = (await runs(task.companyId, `originId=${encodeURIComponent(task.originId)}&status=${OPEN}&limit=100`))
        .find((o) => o.id !== task.id && (ms(o.createdAt) < ms(task.createdAt) || (ms(o.createdAt) === ms(task.createdAt) && o.id < task.id)));
      if (!earlier) return false;
      // An earlier run that is not in flight is idle, not the run this one belongs to: this run starts, and the idle one is left
      // to the kernel's idle sweep.
      if (!(await inFlight(earlier))) return false;
      await kernel.cancelRoutineRun(task.id, "coalesced", "Cancelled: an earlier run of this routine is still in flight, so this one is folded into it.");
      log("routine run coalesced", { task: task.id, into: earlier.id, routine: task.originId });
      return true;
    },
    /** Every agent's blocked routine runs a later run of the same routine finished (about once a minute). */
    async sweep(agents: () => Promise<string[]>) {
      if (Date.now() - swept < SWEEP_MS) return;
      swept = Date.now();
      for (const id of await agents().catch(() => [])) {
        try {
          const company = (await kernel.agent(id))?.companyId;
          if (!company) continue;
          const blocked = await runs(company, `status=blocked&assigneeAgentId=${encodeURIComponent(id)}&limit=200`);
          for (const routine of new Set(blocked.map((b) => b.originId).filter((r): r is string => !!r))) {
            if (await perEvent(routine)) continue;
            const done = await runs(company, `status=done&originId=${encodeURIComponent(routine)}&limit=5`);
            for (const b of blocked.filter((x) => x.originId === routine)) {
              const by = done.filter((d) => ms(d.createdAt) > ms(b.createdAt)).sort((x, y) => ms(y.createdAt) - ms(x.createdAt))[0];
              if (!by) continue;
              await kernel.cancelRoutineRun(b.id, "stale", `Closed: a later run of this routine (${by.identifier}) succeeded.`);
              log("stale routine run cancelled", { task: b.id, by: by.identifier });
            }
          }
        } catch (e) {
          log("stale routine runs not closed", { agent: id, err: (e as Error).message });
        }
      }
    },
  };
}
