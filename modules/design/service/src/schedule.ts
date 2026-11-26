// When a pass starts on its own: the scheduler's tick (main.ts, every 60 s, one at a time). Each tick
//   1. reconciles the passes holding their app's slot: one whose task closed (finished, cancelled, the owner's Stop) or ran past
//      PASS_MS frees it once its job has ended (a finished run stays `done`; else `stopped` for a Stop, or `failed: <why>`); a live
//      job keeps it busy, and a filing whose answer was lost is filed again (one task per source);
//   2. reads the kernel's event log (module.yaml `subscribes:`): apps-platform's `app.deployed` of an app by its name, and the
//      github change feed's `push` (its default branch only) of an app's repo, start a pass of each `after-deploy` app they name;
//   3. starts the next pass of each `always` app that has none running.
// Every start goes through passes.ts startPass, so one pass runs per app and none starts at the app's day cap. A 24/7 app rests
// for the rest of the UTC day after the owner's Stop or after FAILED_MAX failed passes, so a pass that dies at once can't refile
// every minute.
import { PASS_MS, utcDay, type App, type Passes } from "./passes.ts";
import type { Store } from "./store.ts";

/** A pass whose task isn't bound this long after it started (its filing's answer was lost) is filed again. */
const FILING_MS = 2 * 60_000;
/** A 24/7 app's failed passes in one UTC day before it rests until the next. */
export const FAILED_MAX = 3;

export type FeedEvent = { seq: number; kind: string; resource: string; data?: Record<string, unknown> };
export type FeedPage = { events: FeedEvent[]; next: number; gap?: boolean };

export interface ScheduleDeps {
  store: Store;
  passes: Passes;
  apps: () => App[];
  kernel: {
    /** This module's open tasks of a source prefix (GET /v1/tasks?source=). */
    openTasks: (prefix: string) => Promise<{ id: string; source: string }[]>;
    /** A task's status as the kernel last saw it, and whether a job of it is admitted or running (GET /v1/work?task=). */
    taskWork: (task: string) => Promise<{ status: string | null; live: boolean }>;
    closeTask: (task: string, body: string) => Promise<void>;
  };
  /** The kernel's event log of one subscribed connection after `after` (none: its watermark). Throws with `status` 403 when not subscribed. */
  feed: (connection: "apps" | "github", after?: number) => Promise<FeedPage>;
  now?: () => number;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}

export function createScheduler(d: ScheduleDeps) {
  const now = d.now ?? Date.now, log = d.log ?? (() => {});
  /** Each feed's cursor in this process (code-review's way): the first read takes the watermark, so a restart replays nothing. */
  const cursors: Partial<Record<"apps" | "github", number>> = {};
  /** A feed this install doesn't subscribe to (`github?` compiled out): not read again in this process. */
  const off = new Set<string>();

  async function reconcile() {
    const runs = d.store.holding();
    if (!runs.length) return;
    let openIds: Set<string>;
    try { openIds = new Set((await d.kernel.openTasks("design:pass:")).map((t) => t.id)); } catch (e) { return log("WARNING: the pass tasks weren't listed; reconcile waits", { err: String((e as Error).message).slice(0, 200) }); }
    for (const r of runs) {
      const age = now() - Date.parse(r.started), overdue = age > PASS_MS;
      const task = r.task;
      try {
        if (!task) {
          // A filing whose answer was lost (a restart, a timeout, a kernel down): filed again under its source, which gets the
          // same task back if it was made; one that never could be is failed once the pass is past its time.
          if (age < FILING_MS) continue;
          if (overdue) d.store.endPass(r.id, "failed", "its task was never filed");
          else await d.passes.file(r);
          continue;
        }
        if (openIds.has(task)) {
          // A Stop asked before its task was filed, or a pass past its time: close its task; the dispatcher stops the job.
          if (r.stopping || overdue) await d.kernel.closeTask(task, r.stopping ? `Stopped from the UI testing page (design run ${r.id}).` : `The pass ran past ${PASS_MS / 3_600_000} hours (design run ${r.id}).`);
          continue;
        }
        // Not listed open: the slot is freed only when the kernel saw the task closed (or the pass is past its time) and no job of it
        // lives. A pass that finished its run keeps `done`.
        const w = await d.kernel.taskWork(task);
        if (w.live || !(["done", "cancelled"].includes(String(w.status)) || overdue)) continue;
        if (r.stopping) d.store.endPass(r.id, "stopped", "stopped by the owner");
        else d.store.endPass(r.id, "failed", overdue ? `it ran past ${PASS_MS / 3_600_000} hours` : `its task was ${w.status === "done" ? "finished" : "cancelled"} before design_run_finish`);
      } catch (e) { log("WARNING: a pass wasn't reconciled; the next tick tries again", { run: r.id, err: String((e as Error).message).slice(0, 200) }); }
    }
  }

  /**
   * One feed's events after this process's cursor, each handled before the cursor moves (a failed read or handler leaves it, so
   * the next tick reads them again). The first read takes the watermark; a feed this install lacks is skipped.
   */
  async function feed(connection: "apps" | "github", handle: (events: FeedEvent[]) => Promise<void>) {
    if (off.has(connection)) return;
    try {
      if (cursors[connection] === undefined) { cursors[connection] = (await d.feed(connection)).next; return; }
      const page = await d.feed(connection, cursors[connection]);
      if (page.gap) log("WARNING: the event log has a gap; missed deploys start no pass", { connection });
      await handle(page.events);
      cursors[connection] = page.next;
    } catch (e) {
      if ((e as { status?: number }).status === 403) { off.add(connection); return log("no event feed on this install", { connection }); }
      log("WARNING: an event feed wasn't read; the next tick tries again", { connection, err: String((e as Error).message).slice(0, 200) });
    }
  }

  /** Starts a pass of each `after-deploy` app an event names (once per app per page). */
  async function deployed(events: FeedEvent[], kind: string, match: (a: App, resource: string) => boolean) {
    const names = new Set<string>();
    for (const e of events) if (e.kind === kind) for (const a of d.apps()) if (a.schedule === "after-deploy" && match(a, e.resource.toLowerCase())) names.add(a.name);
    for (const name of names) {
      const r = await d.passes.startPass(name, "deploy");
      log("deploy pass", { app: name, ...("refused" in r ? { refused: r.refused } : { run: r.run }) });
    }
  }

  async function deploys() {
    await feed("apps", (ev) => deployed(ev, "app.deployed", (a, res) => a.name === res));
    await feed("github", (ev) => deployed(ev, "push", (a, res) => a.repo?.toLowerCase() === res));
  }

  async function always() {
    const dayStart = `${utcDay(now())}T00:00:00.000Z`;
    for (const a of d.apps()) {
      if (a.schedule !== "always" || d.store.active(a.name)) continue;
      const today = d.store.passesSince(a.name, dayStart);
      if (today.some((p) => (p.stopping ?? "") >= dayStart) || today.filter((p) => p.status === "failed" && (p.ended ?? "") >= dayStart).length >= FAILED_MAX) continue;
      const r = await d.passes.startPass(a.name, "always");
      if ("run" in r) log("24/7 pass", { app: a.name, run: r.run });
    }
  }

  /** One tick: each step's failure is logged and the next step still runs. */
  async function tick() {
    for (const [step, f] of [["reconcile", reconcile], ["deploys", deploys], ["always", always]] as const) {
      try { await f(); } catch (e) { log(`WARNING: ${step} failed; the next tick tries again`, { err: String((e as Error).message).slice(0, 300) }); }
    }
  }
  return { tick };
}
