// The Fleet Steward's service (the board's detectors, moved here): the detector on a timer, Alertmanager's webhook, the module's
// MCP connection (fleet_detector, coach_due, coach_evidence, fleet_generation_status) and Prometheus text (server.ts). Everything it knows of
// the fleet it reads through the kernel with its own module token (kernel.cp-read, kernel.work-read) and apps-mcp (apps.read);
// it files a task for the Steward (kernel.tasks) and tells the owner (kernel.owner-notice) only when the Steward itself is lost. State: /data/state.json.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { alertIncidents, firing, parseAlerts, receiveAlerts } from "./alerts.ts";
import { coachReads } from "./coach.ts";
import { checks, detectorState, gateActivity, QUIET_MS, snoozeFollowup, staleFollowups, stewardOn, tick, type Kv } from "./detector.ts";
import { createMcp, fleetTools } from "./mcp.ts";
import { isModule } from "./module-caller.ts";
import { createStewardServer } from "./server.ts";

const env = process.env;
const log = (msg: string, f: Record<string, unknown> = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(f));
const secret = (name: string) => { try { return readFileSync(env[name] ?? "", "utf8").trim(); } catch { return ""; } };
const kernelUrl = (env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/$/, "");
const token = secret("FLEET_STEWARD_TOKEN_FILE");
const serviceKey = secret("FLEET_STEWARD_SERVICE_KEY_FILE");
const kernel = kernelClient(kernelUrl, token);
const appsUrl = (env.APPS_MCP_URL ?? "http://apps-mcp:8090").replace(/\/$/, "");

const stateFile = env.FLEET_STEWARD_STATE_FILE ?? "/data/state.json";
const state: Record<string, string> = (() => { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return {}; } })();
const kv: Kv = {
  get: (k) => state[k],
  set(k, v) {
    state[k] = v;
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
    renameSync(`${stateFile}.tmp`, stateFile);
  },
};

/** apps-mcp's internal reads as this module (a module holding apps.read: the kernel vouches for the token). */
async function apps<T>(path: string): Promise<T> {
  const r = await fetch(`${appsUrl}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  if (!r) throw new Error("apps-mcp is not reachable");
  const body = await r.text();
  if (!r.ok) throw new Error(`apps-mcp: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/** The owner's lines: only the Steward itself unreachable, or dispatch stalled (the self-healer, or every agent, is down, so
 * someone outside the fleet must know). */
const ownerNotice = async (text: string) => void (await kernel.call("POST", "/v1/notify", { kind: "alert", text, dedupe_key: `steward:${hashOf(text)}` }));
/**
 * Every other fleet notice (a component down, a critical alert, a jammed gate) is a check task for the Steward itself, which
 * owns it to its live resolution: fixed text from code, one per notice and day. The owner and the chief of staff hear nothing
 * of them. Under quiet start, until the owner turns the Steward on, nothing is filed: the call fails, so the notice is tried
 * again once it is on.
 */
const toSteward = async (text: string, key = hashOf(text), at = new Date()) => {
  if (!(await stewardOn(kernel, env.FLEET_STEWARD_QUIET_START))) throw new Error("quiet start: the Steward is off");
  await kernel.call("POST", "/v1/tasks", {
    title: `Fleet Ops: check: ${text.split(/\.\s/)[0]!.slice(0, 100)}`,
    description: `${text}\n\nFollow your fleet-check skill: own it until it is resolved live and its cause is fixed at the source. Close this task with one line.`,
    role: "fleet-audit",
    source: `fleet-notice:${key.replace(/[^\w.:/@#-]/g, "-").slice(0, 120)}:${at.toISOString().slice(0, 10)}`,
  });
};

/** The check task: fixed text, never an incident's own words (the Steward reads those with fleet_detector, fenced). Its source
 * says whether something new tripped (fleet-incident:, Flow's DORA incidents) or only recovered (fleet-check:). */
async function fileCheck(body: { incidents: { key: string; critical?: boolean }[]; recovered: { key: string }[] }, at = new Date()): Promise<boolean> {
  const critical = body.incidents.filter((i) => i.critical).length;
  const description = `The fleet detector tripped or recovered: ${body.incidents.length} new incident${body.incidents.length === 1 ? "" : "s"}${critical ? ` (${critical} critical)` : ""} and ${body.recovered.length} recovered. Follow your fleet-check skill: \`fleet_detector\` lists what is open and what recovered. Close this task with one line.`;
  await kernel.call("POST", "/v1/tasks", { title: "Fleet Ops: check", description, role: "fleet-audit", source: `${body.incidents.length ? "fleet-incident" : "fleet-check"}:${at.toISOString()}` });
  return true;
}

/** A gate jammed two hours that the Steward's check runs didn't clear: the detector's own keys name each task or card; one task per batch of keys. */
const fileJam = (keys: string[]) => toSteward(`Gates jammed: these have been jammed for over two hours and the Fleet Steward has not cleared them (a pull request waiting on code review, an approval card with the AI reviewer, or a task that never resumed after its answer): ${keys.map((k) => `\`${k}\``).join(", ")}. Each key names its task or card.`, `jammed:${hashOf([...keys].sort().join(","))}`);

const coach = coachReads({ kernel, kv, apps });
const all = checks({ kernel, kv, apps, alerts: () => alertIncidents(kv, toSteward), openKeys: () => Object.keys(detectorState(kv).open), notify: toSteward, owner: ownerNotice, log });
let busy = false;
const run = async () => {
  if (busy) return;
  busy = true;
  try {
    await tick(kv, all, async (b) => {
      const ok = await fileCheck(b).then(() => true, (e) => (log("check task not filed", { err: String(e.message ?? e) }), false));
      log("fleet check", { ok, incidents: b.incidents.map((i) => i.key), recovered: b.recovered.map((r) => r.key) });
      return ok;
    }, ownerNotice, new Date(), QUIET_MS, await stewardOn(kernel, env.FLEET_STEWARD_QUIET_START).catch(() => false), gateActivity({ kernel }), (keys) => fileJam(keys));
  } catch (err) {
    log("detector failed", { err: String(err) });
  } finally {
    busy = false;
  }
};
const minutes = Number(env.FLEET_OPS_INTERVAL_MINUTES);
if (minutes > 0) {
  setInterval(run, Math.max(1, minutes) * 60_000).unref();
  setTimeout(run, 60_000).unref();
  log("fleet detector on", { minutes });
}

const mcp = createMcp(fleetTools({
  detector: () => { const s = detectorState(kv); return { open: Object.entries(s.open).map(([key, o]) => ({ key, since: o.at, reason: o.reason, ...(o.critical ? { critical: true } : {}) })), recovered: s.recovered.map((r) => ({ key: r.key, reason: r.reason, recovered_at: r.at })) }; },
  due: (agent) => coach.due(agent),
  evidence: (caller, key) => coach.evidence(caller, key),
  generations: () => kernel.call("GET", "/v1/work?generations=1"),
  followups: () => staleFollowups({ kernel, kv }),
  flow: (q) => kernel.call("GET", `/v1/flow?${new URLSearchParams(q)}`),
  snooze: (task, days) => snoozeFollowup(kv, task, days),
  // The kernel's answer whole: a refusal says why (the Steward reads it and changes the request).
  ownerCards: (after, limit) => kernel.call("GET", `/v1/work?${new URLSearchParams({ owner_cards: "1", limit: String(limit), ...(after ? { after } : {}) })}`),
  routing: async (op, args, assertion) => { const r = await kernel.raw("POST", `/v1/routing/${op}`, args, { "x-aidenhq-caller": assertion }); if (r.status >= 300) throw new Error(`Refused: ${String(r.json?.error?.message ?? r.status)}`); return r.json; },
}));
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);

createStewardServer({
  serviceKey,
  isMonitoring: (authorization) => isModule(kernelUrl, authorization, "monitoring"),
  receiveAlerts: async (b) => { const r = await receiveAlerts(kv, parseAlerts(b), toSteward); void run(); return r; },
  // Its own gauges plus the kernel's job metrics (aidenhq_kernel_jobs_*, role kernel.work-read): Prometheus scrapes only this service.
  metrics: async () => {
    const jobs = await fetch(`${kernelUrl}/v1/work/metrics`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`kernel metrics ${r.status}`))));
    const g = (name: string, help: string, v: number) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${v}\n`;
    return g("aidenhq_steward_incidents_open", "Fleet detector incidents open.", Object.keys(detectorState(kv).open).length) + g("aidenhq_steward_alerts_firing", "Monitoring alerts firing, as this service last heard from Alertmanager.", Object.keys(firing(kv)).length) + jobs;
  },
  mcp,
  caller: async (req) => ({ ...(await verifyCaller(req, jwks, "fleet-steward")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }),
}).listen(Number(env.PORT ?? 8097), () => log("listening", { port: env.PORT ?? 8097 }));
