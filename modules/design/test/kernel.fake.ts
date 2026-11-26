// The kernel as the design service sees it, in memory: filed tasks, their state and jobs, the ledger's charges and the event logs.
import type { PassKernel } from "../service/src/passes.ts";
import type { FeedEvent, ScheduleDeps } from "../service/src/schedule.ts";

export type Filed = { id: string; title: string; description: string; role: string; source: string; status: string; live: boolean };

export function fakeKernel() {
  const filed: Filed[] = [];
  const charges: { source: string; at: string; cost_usd: number }[] = [];
  const logs: Record<"apps" | "github", FeedEvent[]> = { apps: [], github: [] };
  const unsubscribed = new Set<string>();
  let seq = 0, refuse = false;
  const byId = (id: string) => filed.find((t) => t.id === id)!;
  const passes: PassKernel = {
    fileTask: async (t) => {
      if (refuse) throw new Error("kernel down");
      const task: Filed = { id: `task-${filed.length + 1}`, ...t, status: "todo", live: true };
      filed.push(task);
      return { id: task.id, agent: "ui-agent" };
    },
    closeTask: async (id) => { const t = byId(id); if (!["done", "cancelled"].includes(t.status)) t.status = "cancelled"; },
    spend: async (prefix, day) => charges.filter((c) => c.source.startsWith(prefix) && c.at.slice(0, 10) === day).map((c) => ({ task: c.source, source: c.source, cost_usd: c.cost_usd })),
  };
  const schedule: ScheduleDeps["kernel"] = {
    openTasks: async (prefix) => filed.filter((t) => t.source.startsWith(prefix) && !["done", "cancelled"].includes(t.status)).map((t) => ({ id: t.id, source: t.source })),
    taskWork: async (id) => { const t = byId(id); return { status: t.status, live: t.live }; },
    closeTask: passes.closeTask,
  };
  const feed: ScheduleDeps["feed"] = async (connection, after) => {
    if (unsubscribed.has(connection)) throw Object.assign(new Error("not subscribed"), { status: 403 });
    const all = logs[connection];
    return { events: after === undefined ? [] : all.filter((e) => e.seq > after), next: all.at(-1)?.seq ?? after ?? 0 };
  };
  return {
    passes, schedule, feed, filed, byId,
    /** The task ends (its job too): done or cancelled. */
    close: (id: string, status: "done" | "cancelled") => Object.assign(byId(id), { status, live: false }),
    /** The task's job is still running (a Stop not yet taken). */
    jobLive: (id: string, live: boolean) => { byId(id).live = live; },
    charge: (source: string, at: string, cost_usd: number) => void charges.push({ source, at, cost_usd }),
    event: (connection: "apps" | "github", kind: string, resource: string) => void logs[connection].push({ seq: ++seq, kind, resource }),
    unsubscribe: (connection: string) => void unsubscribed.add(connection),
    refuse: (on: boolean) => { refuse = on; },
  };
}
