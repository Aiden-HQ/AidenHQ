// Plain-code watcher (no LLM, never posts comments): tells the owner when agent runs are failing on credits/auth
// or in bulk, once per cause per hour, and when they recover. Reads go through the kernel (GET /v1/cp/read). App incidents and
// host resources are the monitoring module's alerts (they reach this chat as the kernel's owner notices). Task follow-ups are the Chief of Staff's job.
import type { Store } from "./store.js";
import { OWNER } from "./chat.js";

export interface WatchDeps {
  api: (path: string) => Promise<any>;
  notify: (text: string) => Promise<boolean>;
  store: Pick<Store, "getKv" | "setKv">;
  now?: number;
  companyId?: string; // the owner's company; resolved by name (OWNER.company) when unset
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const CREDITS = /\b402\b|insufficient credits|payment required|out of credits|quota/i;
const AUTH = /\b401\b|invalid api key|incorrect api key|unauthori[sz]ed|authentication (failed|error)/i;
const t = (s: unknown): number => Date.parse(String(s ?? "")) || 0;

async function health(d: WatchDeps, companies: any[], names: Map<string, string>, now: number): Promise<void> {
  const failed: { cause: string; run: any }[] = [];
  let lastOk = 0;
  for (const c of companies) {
    for (const run of (await d.api(`/api/companies/${c.id}/heartbeat-runs?limit=100`)) as any[]) {
      const at = t(run.finishedAt ?? run.createdAt);
      if (run.status === "succeeded") lastOk = Math.max(lastOk, at);
      if (run.status !== "failed" || now - at > 15 * MIN) continue;
      let text = `${run.errorCode ?? ""} ${run.error ?? ""}`;
      if (run.errorCode === "configuration_incomplete" && !CREDITS.test(text) && !AUTH.test(text))
        text += ` ${String((await d.api(`/api/heartbeat-runs/${run.id}/log`).catch(() => ({}))).content ?? "").slice(-4000)}`;
      failed.push({ cause: CREDITS.test(text) ? "out of OpenRouter credits (402)" : AUTH.test(text) ? "API key rejected (401)" : "", run });
    }
  }
  const sig = failed.find((f) => f.cause) ?? (failed.length >= 3 ? { cause: "repeated failures", run: failed[0]!.run } : undefined);
  if (sig) {
    const last = Number(d.store.getKv(`health:${sig.cause}`) ?? 0);
    if (now - last < HOUR) return;
    const issue = sig.run.issueId ? await d.api(`/api/issues/${sig.run.issueId}`).catch(() => null) : null;
    const eg = `${names.get(sig.run.agentId) ?? "agent"}/${issue?.identifier ?? "no task"}`;
    if (await d.notify(`⚠️ Agents are failing: ${sig.cause} (${failed.length} failed runs, e.g. ${eg})`)) {
      d.store.setKv(`health:${sig.cause}`, String(now));
      d.store.setKv("health:alertedAt", String(now));
    }
  } else if (d.store.getKv("health:alertedAt") && lastOk > Number(d.store.getKv("health:alertedAt"))) {
    if (await d.notify("✅ Agents recovered")) d.store.setKv("health:alertedAt", "");
  }
}

export async function tick(d: WatchDeps): Promise<void> {
  const now = d.now ?? Date.now();
  const companies = ((await d.api("/api/companies")) as any[]).filter((c) => c.status !== "archived" && (d.companyId ? c.id === d.companyId : c.name === OWNER.company));
  const names = new Map<string, string>();
  for (const c of companies) for (const a of (await d.api(`/api/companies/${c.id}/agents`)) as any[]) names.set(a.id, a.name);
  await health(d, companies, names, now);
}

export function startWatch(read: (path: string) => Promise<any>, deps: Pick<WatchDeps, "notify" | "store" | "companyId">, log: { warn: (o: object, m: string) => void }, everyMs = 2 * MIN): void {
  const run = () => tick({ ...deps, api: read }).catch((err) => log.warn({ err: String(err) }, "watch tick failed"));
  void run();
  setInterval(run, everyMs).unref();
}
