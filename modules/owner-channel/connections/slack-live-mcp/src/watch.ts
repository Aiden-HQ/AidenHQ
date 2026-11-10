// Plain-code watcher (no LLM, never posts comments): tells the owner when agent runs are failing on credits/auth
// or in bulk, once per cause per hour, and when they recover; and when the DevOps Engineer couldn't fix an app. Task follow-ups are the Chief of Staff's job.
import type { Store } from "./store.js";
import { OWNER } from "./chat.js";

export interface WatchDeps {
  api: (path: string) => Promise<any>;
  notify: (text: string) => Promise<boolean>;
  store: Pick<Store, "getKv" | "setKv">;
  now?: number;
  companyId?: string; // the owner's company; resolved by name (OWNER.company) when unset
  apps?: () => Promise<AppStatus[]>; // apps-mcp /internal/status
  diskPct?: () => Promise<number>; // apps-mcp /internal/host
}

export interface AppStatus { name: string; incident?: { opened_at: number; kind: string; detail: string }; stats?: { mem_bytes: number; mem_limit_bytes: number } }

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
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

/**
 * App incidents wake the DevOps Engineer first (apps-mcp fires its routine). The owner is told only when an incident has stayed
 * open over 30 minutes or the app had 3 or more incidents in 24 hours, once per hour, and once when it recovers.
 */
async function appIncidents(d: WatchDeps, now: number): Promise<void> {
  for (const app of await d.apps!()) {
    const paged = `apppaged:${app.name}`;
    const inc = app.incident;
    if (!inc) {
      if (d.store.getKv(paged) && (await d.notify(`✅ ${app.name} recovered`))) d.store.setKv(paged, "");
      continue;
    }
    const seen = new Set<number>((JSON.parse(d.store.getKv(`appinc:${app.name}`) ?? "[]") as number[]).filter((at) => now - at < DAY));
    seen.add(inc.opened_at);
    d.store.setKv(`appinc:${app.name}`, JSON.stringify([...seen]));
    if (now - inc.opened_at < 30 * MIN && seen.size < 3) continue;
    if (now - Number(d.store.getKv(paged) || 0) < HOUR) continue;
    if (await d.notify(`⚠️ DevOps Engineer couldn't fix ${app.name}: ${inc.detail}`)) d.store.setKv(paged, String(now));
  }
}

/** Resource alerts, once per hour per cause: an app over 90% of its memory limit, or the VM disk over 85%. */
async function resources(d: WatchDeps, now: number): Promise<void> {
  const alert = async (key: string, text: string) => {
    if (now - Number(d.store.getKv(key) || 0) < HOUR) return;
    if (await d.notify(text)) d.store.setKv(key, String(now));
  };
  for (const a of await d.apps!()) {
    const m = a.stats;
    if (m && m.mem_limit_bytes > 0 && m.mem_bytes / m.mem_limit_bytes > 0.9) await alert(`appmem:${a.name}`, `⚠️ ${a.name} is using ${Math.round((100 * m.mem_bytes) / m.mem_limit_bytes)}% of its memory limit`);
  }
  const disk = d.diskPct ? await d.diskPct() : 0;
  if (disk > 85) await alert("vmdisk", `⚠️ VM disk is ${disk}% full`);
}

export async function tick(d: WatchDeps): Promise<void> {
  const now = d.now ?? Date.now();
  const companies = ((await d.api("/api/companies")) as any[]).filter((c) => c.status !== "archived" && (d.companyId ? c.id === d.companyId : c.name === OWNER.company));
  const names = new Map<string, string>();
  for (const c of companies) for (const a of (await d.api(`/api/companies/${c.id}/agents`)) as any[]) names.set(a.id, a.name);
  await health(d, companies, names, now);
  if (d.apps) {
    await appIncidents(d, now);
    await resources(d, now);
  }
}

export function startWatch(cfg: { paperclipUrl: string; boardKey: string }, deps: Pick<WatchDeps, "notify" | "store" | "companyId">, log: { warn: (o: object, m: string) => void }, everyMs = 2 * MIN): void {
  const api = async (path: string) => {
    const res = await fetch(new URL(path, cfg.paperclipUrl), { headers: { authorization: `Bearer ${cfg.boardKey}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
  };
  const appsUrl = process.env.APPS_STATUS_URL ?? "http://apps-mcp:8090/internal/status";
  const apps = async (): Promise<AppStatus[]> => {
    const res = await fetch(appsUrl, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GET ${appsUrl} -> ${res.status}`);
    return res.json() as Promise<AppStatus[]>;
  };
  const hostUrl = appsUrl.replace(/status$/, "host");
  const diskPct = async (): Promise<number> => ((await (await fetch(hostUrl, { signal: AbortSignal.timeout(20_000) })).json()) as { disk_pct: number }).disk_pct;
  const run = () => tick({ ...deps, api, apps, diskPct }).catch((err) => log.warn({ err: String(err) }, "watch tick failed"));
  void run();
  setInterval(run, everyMs).unref();
}
