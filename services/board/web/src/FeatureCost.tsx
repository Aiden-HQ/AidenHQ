// What a feature (a task and everything delegated under it) cost and how long it took: the strip under a task's header
// (src/feature-cost.ts). The same figures, for the last 14 days of features, are a card on the Costs tab.
import { useCallback, useState } from "react";
import { api } from "./api";
import { useLive } from "./events";
import type { FeatureCost } from "./types";

export const money = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

export function FeatureCostStrip({ refId }: { refId: string }) {
  const [cost, setCost] = useState<FeatureCost | null>(null);
  const load = useCallback(() => api.featureCost(refId).then((r) => setCost(r.cost), () => undefined), [refId]);
  useLive(["tasks", "approvals"], load, 30_000);
  if (!cost) return null;
  return (
    <div className="lin-strip fc-strip">
      <span className="lin-lead">Feature cost</span>
      <span className="lin-num" title="Billed model spend on this task and everything delegated under it">{money(cost.usd)}</span>
      <span className="lin-num" title={cost.running ? "From the first task's creation to now: work is still open" : "From the first task's creation to the last completion or merge"}>
        {duration(cost.elapsedMs)}{cost.running ? " so far" : ""}
      </span>
      <span className="lin-num" title="Engineer jobs, and the time they ran (the span of each job's model calls)">
        {cost.jobs} job{cost.jobs === 1 ? "" : "s"}{cost.jobs > 0 ? ` · ${duration(cost.jobMs)}` : ""}
      </span>
      <span className="lin-num">{cost.prs} PR{cost.prs === 1 ? "" : "s"} merged</span>
      <span className="lin-num">{cost.tasks} tasks{cost.truncated ? " (more not counted)" : ""}</span>
    </div>
  );
}
