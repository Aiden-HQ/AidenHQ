/**
 * Fleet Ops' detector (modules/fleet-ops): on a timer, checks the owner's alert thresholds in code and fires the Fleet Ops
 * routine's webhook only when something trips or recovers. Each incident fires once until it recovers, then once more with
 * a recovery note. Fleet Ops reads what is open and what recovered from fleet_status (`detector`). Off unless the module
 * is enabled (FLEET_OPS_INTERVAL_MINUTES) and setup has written the webhook's secret files.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Agent, Paperclip } from "./paperclip.js";
import type { Store } from "./store.js";
import { appsApi } from "./fleet.js";

const MIN = 60_000;
const STATE_KEY = "fleet_ops_detector";
const CARD_WAIT_MS = 120 * MIN; // a Tier 2 card waiting this long
const DOWN_MS = 15 * MIN; // an app incident open this long (the app-incident loop had its chance)
const STALE_MS = 60 * MIN; // a source with no good pass this long
/** Sources that pass on their own slower cadence: the security scanner runs daily. */
const STALE_FOR: Record<string, number> = { security: 26 * 60 * MIN };

type SourceRow = { source: string; last_ok: string | null; failing: boolean };
/** The sources to raise: no good pass within their allowance, or failing with the last good pass over 15 minutes old. */
export function staleSources(rows: SourceRow[], t: number): { key: string; reason: string }[] {
  return rows
    .filter((x) => age(x.last_ok, t) > (STALE_FOR[x.source] ?? STALE_MS) || (x.failing && age(x.last_ok, t) > DOWN_MS))
    .map((x) => ({ key: x.source, reason: `source src_${x.source}: last good pass ${x.last_ok ? `${mins(age(x.last_ok, t))} ago` : "never"}${x.failing ? "; its latest pass failed" : ""}` }));
}
const PR_OPEN_MS = 60 * MIN; // an agents-org pull request open this long without merging (the warehouse lags GitHub by up to 15 minutes)

type PrRow = { repo: string; number: number; opened_at: string };
/** The open agents-org PRs nobody has merged within the allowance; merged or closed ones are no longer in the rows. */
export function stalePrs(rows: PrRow[], t: number): { key: string; reason: string }[] {
  return rows
    .filter((x) => age(x.opened_at, t) > PR_OPEN_MS)
    .map((x) => ({ key: `${x.repo}#${x.number}`, reason: `${x.repo}#${x.number} open ${mins(age(x.opened_at, t))} without merging` }));
}
const STUCK_DEFAULT_MS = 180 * MIN; // a run with no known timeout, running this long
const FAILS = 3; // an agent's last finished runs, all failed

export interface Incident { key: string; reason: string }
interface Open { reason: string; at: string; fired: boolean }
interface State { open: Record<string, Open>; recovered: { key: string; reason: string; at: string; fired: boolean }[] }

/** What is open and what recovered lately (fleet_status shows it to Fleet Ops). */
export function detectorState(store: Pick<Store, "meta">): State {
  try {
    return { open: {}, recovered: [], ...JSON.parse(store.meta(STATE_KEY) ?? "{}") };
  } catch {
    return { open: {}, recovered: [] };
  }
}

/** A check group: its incidents, or undefined when it couldn't be checked (its open incidents stay open). */
type Check = () => Promise<Incident[] | undefined>;

/**
 * One tick: run the checks, open what newly tripped, close what recovered, and fire once for whatever is new (incidents and
 * recovery notes together). Marked fired only when the webhook took it; otherwise the next tick tries again.
 */
export async function tick(store: Pick<Store, "meta" | "setMeta">, checks: Record<string, Check>, fire: (body: unknown) => Promise<boolean>, now = new Date()): Promise<void> {
  const s = detectorState(store);
  const at = now.toISOString();
  for (const [group, check] of Object.entries(checks)) {
    const found = await check().catch(() => undefined);
    if (!found) continue;
    const tripped = new Map(found.map((i) => [`${group}:${i.key}`, i.reason]));
    for (const [key, reason] of tripped) if (!s.open[key]) s.open[key] = { reason, at, fired: false };
    for (const [key, o] of Object.entries(s.open)) {
      if (!key.startsWith(`${group}:`) || tripped.has(key)) continue;
      delete s.open[key];
      // Never told anyone it was down: nothing to say about it coming back.
      if (o.fired) s.recovered.push({ key, reason: o.reason, at, fired: false });
    }
  }
  const incidents = Object.entries(s.open).filter(([, o]) => !o.fired).map(([key, o]) => ({ key, reason: o.reason, since: o.at }));
  const recovered = s.recovered.filter((r) => !r.fired).map(({ key, reason, at }) => ({ key, reason, recovered_at: at }));
  if ((incidents.length || recovered.length) && (await fire({ incidents, recovered }).catch(() => false))) {
    for (const i of incidents) s.open[i.key]!.fired = true;
    for (const r of s.recovered) r.fired = true;
  }
  s.recovered = s.recovered.slice(-20);
  store.setMeta(STATE_KEY, JSON.stringify(s));
}

const age = (t: string | null | undefined, now: number) => (t ? now - Date.parse(t) : Infinity);
const mins = (ms: number) => `${Math.round(ms / MIN)} min`;

/** The owner's alert list, as checks. */
export function checks(pc: Paperclip, store: Pick<Store, "approvals">, now = () => Date.now()): Record<string, Check> {
  let appsOkAt = now(); // apps-mcp's last answer: a restart (an apply) is not an outage
  return {
    async card() {
      const t = now();
      return store.approvals.pending(t, 2).filter((a) => age(a.createdAt, t) > CARD_WAIT_MS).map((a) => ({ key: a.id, reason: `Tier 2 card ${a.id} (${a.action} ${a.target} on ${a.identifier}) waiting ${mins(age(a.createdAt, t))} for the owner` }));
    },
    async run() {
      const t = now();
      const co = `/api/companies/${pc.companyId}`;
      const [agents, runs] = await Promise.all([pc.request<Agent[]>("GET", `${co}/agents`), pc.request<{ agentId: string; status: string; startedAt?: string | null; createdAt: string }[]>("GET", `${co}/heartbeat-runs?summary=true&limit=500`)]);
      const out: Incident[] = [];
      for (const a of agents.filter((x) => x.status !== "terminated")) {
        const mine = runs.filter((r) => r.agentId === a.id).sort((x, y) => (y.startedAt ?? y.createdAt).localeCompare(x.startedAt ?? x.createdAt));
        const timeout = Number(a.adapterConfig?.timeoutSec) * 1000;
        const limit = timeout > 0 ? 2 * timeout : STUCK_DEFAULT_MS;
        const stuck = mine.find((r) => r.status === "running" && age(r.startedAt ?? r.createdAt, t) > limit);
        if (stuck) out.push({ key: `${a.id}:stuck`, reason: `${a.name}: a run has been running ${mins(age(stuck.startedAt ?? stuck.createdAt, t))} (limit ${mins(limit)})` });
        const finished = mine.filter((r) => !["running", "queued", "cancelled"].includes(r.status)).slice(0, FAILS);
        if (finished.length === FAILS && finished.every((r) => r.status !== "succeeded")) out.push({ key: `${a.id}:failing`, reason: `${a.name}: its last ${FAILS} runs failed (${finished.map((r) => r.status).join(", ")})` });
      }
      return out;
    },
    async app() {
      const t = now();
      // Unreachable: throws, so this group is "not checked" (its open incidents stay open); `service` reports the outage.
      const apps = await appsApi<{ name: string; incident?: { opened_at: string; kind: string; detail: string } }[]>("/internal/status");
      appsOkAt = t;
      return apps.filter((a) => a.incident && age(a.incident.opened_at, t) > DOWN_MS).map((a) => ({ key: a.name, reason: `app ${a.name} unhealthy for ${mins(age(a.incident!.opened_at, t))} (${a.incident!.kind}); the app-incident loop hasn't fixed it` }));
    },
    async service() {
      const down = now() - appsOkAt;
      return down > DOWN_MS ? [{ key: "apps-mcp", reason: `apps-mcp (the apps platform) not answering for ${mins(down)}` }] : [];
    },
    async source() {
      const t = now();
      const r = await appsApi<{ sources?: SourceRow[] }>("/internal/sources", undefined, { auth: true });
      if (!r.sources) return undefined; // the warehouse isn't set up
      // Which source and since when only: the agent reads the error itself with warehouse_query.
      return staleSources(r.sources, t);
    },
    async pr() {
      const r = await appsApi<{ prs?: PrRow[] }>("/internal/open-prs", undefined, { auth: true });
      if (!r.prs) return undefined; // no warehouse or no agents org
      return stalePrs(r.prs, now());
    },
  };
}

const readFile = (f: string | undefined) => {
  try {
    return f ? readFileSync(f, "utf8").trim() : "";
  } catch {
    return "";
  }
};

/** Fires the routine's webhook, signed like apps-mcp's incident webhook. False when it isn't wired yet or didn't take it. */
export async function fireWebhook(body: unknown, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const [url, secret] = [readFile(env.FLEET_OPS_WEBHOOK_URL_FILE), readFile(env.FLEET_OPS_WEBHOOK_SECRET_FILE)];
  if (!url || !secret) return false;
  const ts = String(Math.floor(Date.now() / 1000));
  const text = JSON.stringify(body);
  const sig = createHmac("sha256", secret).update(`${ts}.${text}`).digest("hex");
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-paperclip-timestamp": ts, "x-paperclip-signature": `sha256=${sig}` }, body: text, signal: AbortSignal.timeout(15_000) });
  // 409: a run is already going (coalesced): it reads the current state from fleet_status.
  return [200, 202, 409].includes(res.status);
}

/** Starts the detector when the module is on (main.ts). */
export function startDetector(pc: Paperclip, store: Store, log: { info(o: object, m: string): void; warn(o: object, m: string): void }, env: NodeJS.ProcessEnv = process.env): void {
  const minutes = Number(env.FLEET_OPS_INTERVAL_MINUTES);
  if (!(minutes > 0)) return;
  const all = checks(pc, store);
  let busy = false;
  const run = async () => {
    if (busy || !readFile(env.FLEET_OPS_WEBHOOK_URL_FILE)) return; // not wired yet: setup writes the webhook after compose starts
    busy = true;
    try {
      await tick(store, all, async (body) => {
        const ok = await fireWebhook(body, env);
        const b = body as { incidents: { key: string }[]; recovered: { key: string }[] };
        log.info({ ok, incidents: b.incidents.map((i) => i.key), recovered: b.recovered.map((r) => r.key) }, "fleet-ops webhook");
        return ok;
      });
    } catch (err) {
      log.warn({ err: String(err) }, "fleet-ops detector failed");
    } finally {
      busy = false;
    }
  };
  setInterval(run, Math.max(1, minutes) * MIN).unref();
  setTimeout(run, MIN).unref();
  log.info({ minutes }, "fleet-ops detector on");
}
