// Plain-code watcher (no LLM, never posts comments): tells the owner when agents' kernel jobs keep failing (3 or more ended
// failed, timed out or lost in 15 minutes), once an hour, and once when a job succeeds again. Jobs come from the kernel's
// job ledger (GET /v1/work, role kernel.work-read); names through the kernel's control-plane read. App incidents and host
// resources are the monitoring module's alerts (they reach the owner through notify too). Task follow-ups are the Chief of
// Staff's job.
import type { Store } from "./store.js";

/** One kernel job, as GET /v1/work lists it. */
export interface Job { agent: string; task: string; state: string; ended_at: string | null }

export interface WatchDeps {
  /** The kernel's recent activity: its running and recently ended jobs. */
  work: () => Promise<{ recent: Job[] }>;
  /** A control-plane read (names for the alert). */
  api: (path: string) => Promise<any>;
  notify: (text: string, kind: "alert" | "done") => Promise<boolean>;
  store: Pick<Store, "getKv" | "setKv">;
  now?: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const FAILED = ["failed", "timeout", "lost"];
const t = (s: unknown): number => Date.parse(String(s ?? "")) || 0;

export async function tick(d: WatchDeps): Promise<void> {
  const now = d.now ?? Date.now();
  const { recent } = await d.work();
  const failed = recent.filter((j) => FAILED.includes(j.state) && now - t(j.ended_at) <= 15 * MIN);
  const lastOk = Math.max(0, ...recent.filter((j) => j.state === "done").map((j) => t(j.ended_at)));
  if (failed.length >= 3) {
    if (now - Number(d.store.getKv("health:alertedAt") || 0) < HOUR) return;
    const eg = failed[0]!;
    const agent = await d.api(`/api/agents/${encodeURIComponent(eg.agent)}`).catch(() => null);
    const issue = await d.api(`/api/issues/${encodeURIComponent(eg.task)}`).catch(() => null);
    if (await d.notify(`⚠️ Agents are failing: ${failed.length} failed jobs in 15 minutes, e.g. ${agent?.name ?? "agent"}/${issue?.identifier ?? "no task"}`, "alert")) d.store.setKv("health:alertedAt", String(now));
  } else if (d.store.getKv("health:alertedAt") && lastOk > Number(d.store.getKv("health:alertedAt"))) {
    if (await d.notify("✅ Agents recovered", "done")) d.store.setKv("health:alertedAt", "");
  }
}

export function startWatch(deps: Omit<WatchDeps, "now">, log: { warn: (o: object, m: string) => void }, everyMs = 2 * MIN): void {
  const run = () => tick(deps).catch((err) => log.warn({ err: String(err) }, "watch tick failed"));
  void run();
  setInterval(run, everyMs).unref();
}
