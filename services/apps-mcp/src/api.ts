// app_api: an agent's narrow, audited write path into an app's own API. The app declares `api: { token, callers, paths }`;
// only those agents, only under those path prefixes. apps-mcp holds the bearer token (a vault file it generates on the
// first deploy, mounted into the app like any secret) and adds it to the request; the agent never sees it.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { put } from "./database.js";
import { GATE_SECRET, type App } from "./registry.js";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];
export const TIMEOUT_MS = 30_000;
export const BODY_CAP = 50_000;

/** On deploy: the app's token file, generated once (32 random bytes, hex) and never rotated. */
export function ensureApiToken(app: App, secretsDir: string): void {
  // share.host: the gate's per-app secret (X-AidenHQ-Gate) the same way; compile also creates it before the gate starts.
  for (const k of [app.api?.token, app.share?.host ? GATE_SECRET : undefined]) {
    if (k && !existsSync(`${secretsDir}/${app.name}/${k}`)) put(`${secretsDir}/${app.name}`, k, randomBytes(32).toString("hex"));
  }
}

/** A plain absolute path with an optional plain query string (no traversal, no escapes); returns the path part. */
export function plainPath(path: string): string {
  const [p = "", ...q] = path.split("?");
  const query = q.join("?");
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(p) || p.includes("//") || p.split("/").some((s) => s === "." || s === "..")) throw new Error(`bad path ${JSON.stringify(path)}: a plain absolute path, no '..', '//' or escapes`);
  if (q.length > 1 || !/^[A-Za-z0-9._~=&%+,:-]*$/.test(query)) throw new Error(`bad query string in ${JSON.stringify(path)}`);
  return p;
}

/** plainPath, under one of the app's prefixes (on a segment boundary). Refuses rather than normalizes. */
export function checkPath(app: App, path: string): void {
  const p = plainPath(path);
  const under = (pre: string) => p === pre || p.startsWith(pre.endsWith("/") ? pre : `${pre}/`);
  if (!app.api!.paths.some(under)) throw new Error(`${path} isn't under ${app.name}'s agent API paths (${app.api!.paths.join(", ")})`);
}

export function authorize(app: App, callerKey: string, path: string): void {
  if (!app.api) throw new Error(`${app.name} has no agent API (no api: block in the registry)`);
  if (!callerKey || !app.api.callers.includes(callerKey)) throw new Error(`${callerKey || "this agent"} may not call ${app.name}'s API (callers: ${app.api.callers.join(", ")})`);
  checkPath(app, path);
}

export interface ApiRequest { url: string; method: Method; headers: Record<string, string>; body?: string }
/** Delivers one request from inside the given container's network namespace (platform.ts: a one-shot container on `--network container:<id>`) and returns status + body text. */
export type Send = (app: App, req: ApiRequest, container: string) => Promise<{ status: number; body: string }>;

/** The service and port app_api targets, from health.url (which must name the app's compose service, e.g. http://app:8080/...). */
export function apiTarget(app: App): { service: string; protocol: string; port: string } {
  const u = new URL(app.health.url!);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(u.hostname) || /^[\d.]+$/.test(u.hostname)) throw new Error(`${app.name}'s health.url must name its compose service (e.g. http://app:8080/...)`);
  return { service: u.hostname, protocol: u.protocol, port: u.port };
}

/** Finds the app's container by Docker identity: ids of containers labelled with the service (on the app's network). */
export type Resolve = (app: App, service: string) => Promise<{ ids: string; inspect: (id: string) => Promise<string> }>;

/**
 * The full id of the app's own container for the service. Never a name: an app that `connects` to this one joins its network
 * and could answer to the same service name, and compose container names can collide across projects (app x service a-b vs
 * app x-a service b). Exactly one container, whose compose labels name this app's project and service. The request is then sent
 * from inside that container's network namespace to 127.0.0.1, so it can't land elsewhere if the IP changes hands meanwhile.
 */
export async function targetContainer(app: App, service: string, resolve: Resolve): Promise<string> {
  const project = `app-${app.name}`;
  const r = await resolve(app, service);
  const ids = r.ids.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length !== 1) throw new Error(`${app.name}: expected one running ${service} container, found ${ids.length}`);
  const c = (JSON.parse(await r.inspect(ids[0]!)) as any[])[0];
  const labels = c?.Config?.Labels ?? {};
  if (labels["com.docker.compose.project"] !== project || labels["com.docker.compose.service"] !== service) throw new Error(`${app.name}: the ${service} container isn't this app's`);
  if (!/^[0-9a-f]{64}$/.test(c?.Id ?? "")) throw new Error(`${app.name}: the ${service} container has no id`);
  return c.Id;
}

/**
 * A shared app (share.host) rejects requests lacking its gate secret: apps-mcp is an internal caller, so it presents it (never
 * to a non-shared app, never to the agent). Agents' identity contract: X-AidenHQ-User `agent:<key>`, role `admin` for app_api
 * (its paths are bearer-authenticated) and `member` for app_view, X-AidenHQ-App the app's name, no name.
 */
export function gateHeaders(app: App, secretsDir: string, user: string, role: "member" | "admin"): Record<string, string> {
  if (!app.share?.host) return {};
  const file = `${secretsDir}/${app.name}/${GATE_SECRET}`;
  const secret = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (!secret) throw new Error(`${app.name} is shared but has no gate secret yet: deploy it once (app_deploy) and it is generated`);
  return { "x-aidenhq-gate": secret, "x-aidenhq-user": `agent:${user}`, "x-aidenhq-role": role, "x-aidenhq-name": "", "x-aidenhq-app": app.name };
}

export async function callApi(app: App, callerKey: string, req: { method: Method; path: string; body?: unknown }, d: { secretsDir: string; send: Send; resolve: Resolve; audit?: (o: object) => void }): Promise<{ status: number; body: unknown }> {
  authorize(app, callerKey, req.path);
  if (!METHODS.includes(req.method)) throw new Error(`method must be one of ${METHODS.join(", ")}`);
  const t = apiTarget(app);
  const file = `${d.secretsDir}/${app.name}/${app.api!.token}`;
  if (!existsSync(file)) throw new Error(`${app.name} has no API token yet: deploy it once (app_deploy) and it is generated`);
  const container = await targetContainer(app, t.service, d.resolve);
  const base = `${t.protocol}//127.0.0.1${t.port ? `:${t.port}` : ""}`;
  const url = new URL(base + req.path);
  if (url.origin !== base || url.pathname !== req.path.split("?")[0]) throw new Error(`bad path ${req.path}`);
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new Error(`${app.name}'s API token is empty in the vault; delete it and redeploy`);
  // authorize() already confined the path to api.paths, which are bearer-authenticated: admin there.
  const gate = gateHeaders(app, d.secretsDir, callerKey, "admin");
  const hide = (s: string) => [token, gate["x-aidenhq-gate"]].reduce<string>((t, secret) => (secret ? t.replaceAll(secret, "***") : t), s); // neither secret reaches the agent
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json", ...gate };
  const body = req.body === undefined ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  if (body !== undefined) headers["content-type"] = "application/json"; // a string body is taken as JSON already serialized
  const audit = (status: number | string) => d.audit?.({ caller: callerKey, app: app.name, method: req.method, path: req.path, status });
  let res: { status: number; body: string };
  try {
    res = await d.send(app, { url: url.href, method: req.method, headers, ...(body !== undefined ? { body } : {}) }, container);
  } catch (e) {
    audit("error");
    throw new Error(hide(`${app.name} API call failed: ${String((e as Error).message ?? e)}`));
  }
  audit(res.status);
  const text = hide(res.body).slice(0, BODY_CAP);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

/** The one-shot request inside the app's network: reads the request JSON on stdin (never argv), prints only {status, body}. */
export const SEND_SCRIPT = `let s="";process.stdin.on("data",c=>s+=c).on("end",async()=>{const r=JSON.parse(s);try{const res=await fetch(r.url,{method:r.method,headers:r.headers,body:r.body,redirect:"manual",signal:AbortSignal.timeout(${TIMEOUT_MS})});const t=await res.text();process.stdout.write(JSON.stringify({status:res.status,body:t.slice(0,${BODY_CAP * 2})}))}catch(e){process.stdout.write(JSON.stringify({status:0,body:String(e&&e.message||e)}))}})`;
