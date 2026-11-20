// Recurring runs start here: each minute the board claims the runs that are due (automation.ts claimDue: the user's task
// for the period is created on top of Today) and starts the Researcher's "Run recurring task" routine on it with the
// owner's Paperclip key. The period's GitHub activity is the Researcher's to read with its own GitHub tools (skill
// recurring-reports). A run that fails to start stays claimed: claimDue hands it out again, then gives up on the task.
import type { Logger } from "pino";
import { claimDue } from "./automation.js";
import type { Paperclip } from "./paperclip.js";
import type { Store } from "./store.js";

export const RECURRING_ROUTINE = "Run recurring task";

export interface RecurringDeps {
  pc: Paperclip;
  store: Store;
  timezone: string;
  log: Logger;
}

/** One pass: start every due run. */
export async function recurringTick({ pc, store, timezone, log }: RecurringDeps): Promise<void> {
  const [me, labels] = await Promise.all([pc.me(), pc.labels()]);
  for (const run of await claimDue(pc, store, { me, labels }, timezone, log)) {
    try {
      const routine = (await pc.routines()).find((r) => r.title === RECURRING_ROUTINE);
      if (!routine) throw new Error(`routine "${RECURRING_ROUTINE}" not found (run scripts/paperclip-setup.ts)`);
      await pc.request("POST", `/api/routines/${encodeURIComponent(routine.id)}/run`, {
        source: "api",
        variables: { definition: run.definition, task: run.output, since: run.sinceLocal, until: run.untilLocal, timezone: run.timezone, previous: run.previous ?? "none (first run)" },
      });
      store.setRunState(run.definitionId, run.occurrence, "started");
      log.info({ definition: run.definition, output: run.output, occurrence: run.occurrence, attempt: run.attempt }, "recurring run started");
    } catch (err) {
      log.warn({ output: run.output, attempt: run.attempt, err: String(err).slice(0, 300) }, "recurring run failed to start");
    }
  }
}

/** Every minute, one pass at a time. */
export function startRecurringRuns(deps: RecurringDeps): void {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await recurringTick(deps);
    } catch (err) {
      deps.log.warn({ err: String(err).slice(0, 300) }, "recurring check failed");
    } finally {
      busy = false;
    }
  };
  setInterval(run, 60_000).unref();
  setTimeout(run, 5_000).unref();
}
