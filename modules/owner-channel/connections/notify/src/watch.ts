// Plain-code watcher (no LLM, never posts comments): tells the owner when agents' kernel jobs fail for a known cause (out of
// OpenRouter credits, API key rejected: one failure is enough, once an hour per cause). Agents that simply keep failing are
// the Fleet Steward's incidents, so they are not messaged to the owner. Jobs come from the kernel's job ledger (GET /v1/work,
// role kernel.work-read); names through the kernel's control-plane read. App incidents and host resources are the monitoring
// module's alerts (they reach the owner through notify too). Task follow-ups are the Chief of Staff's job.
import type { Store } from "./store.js";

/** One kernel job, as GET /v1/work lists it. */
export interface Job { agent: string; task: string; state: string; ended_at: string | null; error?: string | null }

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
const CREDITS = /\b402\b|insufficient credits|payment required|out of credits|quota/i;
// The model key's own refusal only: a tool's "authentication failed" in a job's last line (a session's websocket) is not it.
const AUTH = /\b401\b|invalid api key|incorrect api key|no auth credentials/i;
const causeOf = (error: unknown): string => (CREDITS.test(String(error ?? "")) ? "out of OpenRouter credits (402)" : AUTH.test(String(error ?? "")) ? "API key rejected (401)" : "");
const t = (s: unknown): number => Date.parse(String(s ?? "")) || 0;

export async function tick(d: WatchDeps): Promise<void> {
  const now = d.now ?? Date.now();
  const { recent } = await d.work();
  const failed = recent.filter((j) => FAILED.includes(j.state) && now - t(j.ended_at) <= 15 * MIN);
  const name = async (j: Job) => {
    const agent = await d.api(`/api/agents/${encodeURIComponent(j.agent)}`).catch(() => null);
    const issue = await d.api(`/api/issues/${encodeURIComponent(j.task)}`).catch(() => null);
    return `${agent?.name ?? "agent"}/${issue?.identifier ?? "no task"}`;
  };
  const alert = async (key: string, text: (eg: string) => string, j: Job): Promise<void> => {
    if (now - Number(d.store.getKv(key) || 0) < HOUR) return;
    if (await d.notify(text(await name(j)), "alert")) {
      d.store.setKv(key, String(now));
    }
  };
  const causes = [...new Set(failed.map((j) => causeOf(j.error)).filter(Boolean))];
  for (const cause of causes) {
    const mine = failed.filter((j) => causeOf(j.error) === cause);
    await alert(`health:${cause}`, (eg) => `⚠️ Agents are failing: ${cause} (${mine.length} failed jobs, e.g. ${eg})`, mine[0]!);
  }
}

export function startWatch(deps: Omit<WatchDeps, "now">, log: { warn: (o: object, m: string) => void }, everyMs = 2 * MIN): void {
  const run = () => tick(deps).catch((err) => log.warn({ err: String(err) }, "watch tick failed"));
  void run();
  setInterval(run, everyMs).unref();
}
