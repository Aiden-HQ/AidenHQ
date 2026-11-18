// The Fleet Steward's service (the board's detectors, moved here): the detector on a timer, Alertmanager's webhook, the module's
// MCP connection (fleet_detector, coach_due, coach_evidence, fleet_generation_status) and Prometheus text. Everything it knows of
// the fleet it reads through the kernel with its own module token (kernel.cp-read, kernel.work-read) and apps-mcp (apps.read);
// it files a task for the Steward (kernel.tasks) and tells the owner (kernel.owner-notice). State: /data/state.json.
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { alertIncidents, firing, parseAlerts, receiveAlerts } from "./alerts.ts";
import { coachReads } from "./coach.ts";
import { checks, detectorState, QUIET_MS, tick, type Kv } from "./detector.ts";
import { createMcp, fleetTools } from "./mcp.ts";

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
const notify = async (text: string) => void (await kernel.call("POST", "/v1/notify", { kind: "alert", text, dedupe_key: `steward:${createHash("sha256").update(text).digest("hex").slice(0, 16)}` }));

/** The check task: fixed text, never an incident's own words (the Steward reads those with fleet_detector, fenced). */
async function fileCheck(body: { incidents: { key: string; critical?: boolean }[]; recovered: { key: string }[] }, at = new Date()): Promise<boolean> {
  const critical = body.incidents.filter((i) => i.critical).length;
  const description = `The fleet detector tripped or recovered: ${body.incidents.length} new incident${body.incidents.length === 1 ? "" : "s"}${critical ? ` (${critical} critical)` : ""} and ${body.recovered.length} recovered. Follow your fleet-check skill: \`fleet_detector\` lists what is open and what recovered. Close this task with one line.`;
  await kernel.call("POST", "/v1/tasks", { title: "Fleet Ops: check", description, role: "fleet-audit", source: `fleet-check:${at.toISOString()}` });
  return true;
}

const coach = coachReads({ kernel, kv, apps });
const all = checks({ kernel, apps, alerts: () => alertIncidents(kv, notify), openKeys: () => Object.keys(detectorState(kv).open) });
let busy = false;
const run = async () => {
  if (busy) return;
  busy = true;
  try {
    await tick(kv, all, async (b) => {
      const ok = await fileCheck(b).then(() => true, (e) => (log("check task not filed", { err: String(e.message ?? e) }), false));
      log("fleet check", { ok, incidents: b.incidents.map((i) => i.key), recovered: b.recovered.map((r) => r.key) });
      return ok;
    }, notify, new Date(), QUIET_MS);
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
}));
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);

const same = (a: string, b: string) => Boolean(a && b) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const body = async (req: IncomingMessage, max = 2_000_000) => {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) throw Object.assign(new Error("too large"), { status: 413 }); chunks.push(c as Buffer); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
};
const send = (res: ServerResponse, status: number, v: unknown, type = "application/json") => res.writeHead(status, { "content-type": type }).end(typeof v === "string" ? v : JSON.stringify(v));

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  try {
    if (path === "/healthz") return send(res, 200, { ok: true });
    // Alertmanager's webhook and Prometheus's scrape: no credentials; the network is the boundary (only they share it with this service).
    if (path === "/alerts" && req.method === "POST") {
      const r = await receiveAlerts(kv, parseAlerts(await body(req)), notify);
      void run();
      return send(res, 200, r);
    }
    if (path === "/metrics" && req.method === "GET") {
      const g = (name: string, help: string, v: number) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${v}\n`;
      return send(res, 200, g("aidenhq_steward_incidents_open", "Fleet detector incidents open.", Object.keys(detectorState(kv).open).length) + g("aidenhq_steward_alerts_firing", "Monitoring alerts firing, as this service last heard from Alertmanager.", Object.keys(firing(kv)).length), "text/plain; version=0.0.4; charset=utf-8");
    }
    if (path === "/mcp" && req.method === "POST") {
      if (!same(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), serviceKey)) return void res.writeHead(401).end();
      const msg = await body(req);
      const out = Array.isArray(msg) ? (await Promise.all(msg.map((m) => mcp(m, () => verifyCaller(req, jwks, "fleet-steward"))))).filter(Boolean) : await mcp(msg, () => verifyCaller(req, jwks, "fleet-steward"));
      return out === undefined ? void res.writeHead(202).end() : send(res, 200, out);
    }
    return void res.writeHead(404).end();
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return send(res, status, { error: String((e as Error).message ?? e).slice(0, 300) });
  }
}).listen(Number(env.PORT ?? 8097), () => log("listening", { port: env.PORT ?? 8097 }));
