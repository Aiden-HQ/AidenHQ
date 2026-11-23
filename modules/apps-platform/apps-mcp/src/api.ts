// app_api: an agent's narrow, audited path into an app's own API. The app declares `api: { callers, paths }`; only those
// agents, and as admin only under those path prefixes. A caller's entry may instead name one exact route (`POST /api/x/{id}/y`:
// the method, then `{name}` for one segment), holding it to the routes it uses rather than a namespace. role: "member" is the
// signed-in test-user identity app_view uses: the same caller gate and read-access policy, with the caller's own grant kept, so
// a public POST can be exercised end to end (a plain-string caller reaches any route the app serves). An app's optional
// `member_paths` extends that member grant to public routes outside its agent API. apps-mcp signs the call's identity token
// (identity.ts: agent:<key>, bound to this method and path) and adds it to the request; the agent never sees it.
import { IDENTITY_HEADER, memberScope, type Sign } from "./identity.js";
import type { App } from "./registry.js";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];
export const TIMEOUT_MS = 30_000;
export const BODY_CAP = 50_000;
/** An app's answer can carry a live session in these headers; they outlive the 300 s identity token, so the agent never
 * gets them. Everything else (a `Retry-After`, a content type) is the app's real answer. */
const SESSION_HEADERS = new Set(["set-cookie", "set-cookie2"]);
const HEADER_CAP = 4096;

/** An exact route entry: `METHOD /path`, with `{name}` standing for exactly one segment (`POST /api/x/{id}/y`). */
interface Route { method: Method; segments: (string | undefined)[] } // undefined: a {name}, one non-empty segment
const SEGMENT = /^(?:([A-Za-z0-9._~-]+)|\{([A-Za-z0-9_]+)\})$/;

/** The segments of a plain absolute path, without its leading slash: `/api/x/3` is ["api", "x", "3"]. */
const segmentsOf = (p: string) => p.slice(1).split("/");

/** A caller's `api.paths` entry read as one exact route, or undefined for a bare path, which stays a prefix (any method,
 * anything below it). One grammar: registry.ts accepts the form and checkPath holds calls to it. */
export function parseRoute(entry: string): Route | undefined {
  const [method, path, ...rest] = entry.split(" ");
  if (!path || !path.startsWith("/") || rest.length || !METHODS.includes(method as Method)) return undefined;
  const parts = segmentsOf(path).map((s) => SEGMENT.exec(s));
  // Every segment is a plain word or one whole {name}, and no segment is "." or "..": a route is never a traversal.
  if (parts.some((m) => !m || m[1] === "." || m[1] === "..")) return undefined;
  return { method: method as Method, segments: parts.map((m) => (m![2] !== undefined ? undefined : m![1]!)) };
}

/** A plain absolute path with an optional plain query string (no traversal, no escapes); returns the path part. */
export function plainPath(path: string): string {
  const [p = "", ...q] = path.split("?");
  const query = q.join("?");
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(p) || p.includes("//") || p.split("/").some((s) => s === "." || s === "..")) throw new Error(`bad path ${JSON.stringify(path)}: a plain absolute path, no '..', '//' or escapes`);
  if (q.length > 1 || !/^[A-Za-z0-9._~=&%+,:-]*$/.test(query)) throw new Error(`bad query string in ${JSON.stringify(path)}`);
  return p;
}

/** plainPath, under one of these prefixes (on a segment boundary) or on one of these exact routes for this method. A
 * member request may also use the app's member_paths; every other call only reaches its agent API. Refuses rather than normalizes. */
export function checkPath(app: App, path: string, paths = app.api!.paths, method?: string, member = false): void {
  const p = plainPath(path);
  const roots = member ? [...app.api!.paths, ...(app.api!.member_paths ?? [])] : app.api!.paths;
  const under = (pre: string) => p === pre || p.startsWith(pre.endsWith("/") ? pre : `${pre}/`);
  const seg = segmentsOf(p);
  const ok = (entry: string) => {
    const r = parseRoute(entry);
    if (!roots.some(under)) return false;
    if (!r) return under(entry);
    return r.method === method && r.segments.length === seg.length && r.segments.every((s, i) => (s === undefined ? seg[i] !== "" : s === seg[i]));
  };
  if (!paths.some(ok)) {
    // A call must be under both the app's grant and the caller's own grant; name each, so a gap in member_paths no
    // longer reads as the caller's own paths being wrong. The caller's grant is named only where it adds something:
    // an app probe checks the app's own paths, and there is no narrower caller grant to point at. An object caller is
    // compared against the app grant for this role, member_paths included, so a member route the caller lacks is shown.
    const appPaths = app.api!.paths.join(", ") || "none";
    const memberPaths = (app.api!.member_paths ?? []).join(", ") || "none";
    const grant = `the app grants api.paths (${appPaths})${member ? `, member_paths (${memberPaths})` : ""}`;
    const sameAsApp = paths.length === roots.length && paths.every((g, i) => g === roots[i]);
    const own = sameAsApp ? "" : `, and a call must also be under the caller's own paths (${paths.join(", ")})`;
    throw new Error(`${path} isn't under ${app.name}'s agent API paths for this caller: ${grant}${own}`);
  }
}

export function authorize(app: App, callerKey: string, path: string, method?: string, role: "admin" | "member" = "admin"): void {
  if (!app.api) throw new Error(`${app.name} has no agent API (no api: block in the registry)`);
  const keyOf = (c: string | { agent: string }) => (typeof c === "string" ? c : c.agent);
  const c = callerKey ? app.api.callers.find((x) => keyOf(x) === callerKey) : undefined;
  if (!c) throw new Error(`${callerKey || "this agent"} may not call ${app.name}'s API (callers: ${app.api.callers.map(keyOf).join(", ")})`);
  // A member request is a signed-in test-user request to the app's own public route. Keep the caller gate (the app's
  // api.callers) and, for a caller held to its own routes or prefixes (the object form), that narrower grant too: being
  // listed for one integration never widens to the app's whole public surface. A plain-string caller is granted any route.
  if (role === "member") {
    plainPath(path);
    if (typeof c !== "string") checkPath(app, path, c.paths, method, true);
    return;
  }
  checkPath(app, path, typeof c === "string" ? app.api.paths : c.paths, method);
}

export interface ApiRequest { url: string; method: Method; headers: Record<string, string>; body?: string; timeout?: number }
export type ResponseHeaders = Record<string, string | string[]>;
/** Delivers one request from inside the given container's network namespace (platform.ts: a one-shot container on `--network container:<id>`) and returns status, headers and body text. */
export type Send = (app: App, req: ApiRequest, container: string) => Promise<{ status: number; headers: ResponseHeaders; body: string }>;

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

export async function callApi(app: App, callerKey: string, req: { method: Method; path: string; body?: unknown; role?: "admin" | "member" }, d: { sign: Sign; send: Send; resolve: Resolve; audit?: (o: object) => void }): Promise<{ status: number; headers: ResponseHeaders; body: unknown }> {
  if (!METHODS.includes(req.method)) throw new Error(`method must be one of ${METHODS.join(", ")}`);
  const role = req.role ?? "admin";
  if (role !== "admin" && role !== "member") throw new Error(`role must be admin or member, not ${JSON.stringify(req.role)}`);
  authorize(app, callerKey, req.path, req.method, role);
  const t = apiTarget(app);
  const container = await targetContainer(app, t.service, d.resolve);
  const base = `${t.protocol}//127.0.0.1${t.port ? `:${t.port}` : ""}`;
  const url = new URL(base + req.path);
  if (url.origin !== base || url.pathname !== req.path.split("?")[0]) throw new Error(`bad path ${req.path}`);
  // authorize() confined admin calls to api.paths; the token holds only this method and path. The default is admin
  // there; role: "member" reuses app_view's signed-in member identity for a public-route check.
  const token = d.sign(app.name, callerKey, { ...memberScope([req.method]), ...(role === "admin" ? { role: "admin" } : {}), path: url.pathname });
  const hide = (s: string) => s.replaceAll(token, "***"); // the token never reaches the agent
  const headers: Record<string, string> = { [IDENTITY_HEADER]: token, accept: "application/json" };
  const body = req.body === undefined ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  if (body !== undefined) headers["content-type"] = "application/json"; // a string body is taken as JSON already serialized
  const audit = (status: number | string) => d.audit?.({ caller: callerKey, app: app.name, method: req.method, path: req.path, role, status });
  let res: { status: number; headers: ResponseHeaders; body: string };
  try {
    res = await d.send(app, { url: url.href, method: req.method, headers, ...(body !== undefined ? { body } : {}) }, container);
  } catch (e) {
    audit("error");
    throw new Error(hide(`${app.name} API call failed: ${String((e as Error).message ?? e)}`));
  }
  audit(res.status);
  // A null prototype: a header named `constructor` or `__proto__` is data, never an inherited property.
  const responseHeaders: ResponseHeaders = Object.create(null);
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    const key = k.toLowerCase();
    if (SESSION_HEADERS.has(key)) continue;
    const values = (Array.isArray(v) ? v : [v]).map((x) => hide(String(x))).filter((x) => x.length <= HEADER_CAP);
    if (values.length) responseHeaders[key] = values.length === 1 ? values[0]! : values;
  }
  const text = hide(res.body).slice(0, BODY_CAP);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: responseHeaders, body: parsed };
}

/** The one-shot request inside the app's network: reads the request JSON on stdin (never argv), prints only {status, headers, body}. */
export const SEND_SCRIPT = `let s="";process.stdin.on("data",c=>s+=c).on("end",async()=>{const r=JSON.parse(s);try{const res=await fetch(r.url,{method:r.method,headers:r.headers,body:r.body,redirect:"manual",signal:AbortSignal.timeout(r.timeout||${TIMEOUT_MS})});const t=await res.text();process.stdout.write(JSON.stringify({status:res.status,headers:(()=>{const h=Object.create(null);for(const [k,v] of res.headers){(h[k]??=[]).push(String(v).slice(0,8192))}return h})(),body:t.slice(0,${BODY_CAP * 2})}))}catch(e){process.stdout.write(JSON.stringify({status:0,headers:{},body:String(e&&e.message||e)}))}})`;
