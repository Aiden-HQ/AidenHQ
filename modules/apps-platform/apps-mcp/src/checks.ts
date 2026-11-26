// Post-deploy checks: a very light look at a freshly deployed app, not QA. Each deploy (auto-deploy, app_deploy) and each
// app_rollback runs them after the health wait; app_check runs them on demand. Three kinds, picked from what the app is:
//   health  every app: the existing health wait (health.url answers under 400, or its containers are healthy).
//   render  web apps (exposed, with a port and health.url): load the pages in the headless renderer (view.ts's browser image, in the
//           app's own network namespace) and report what looks broken (a CSP violation, a stylesheet or script that failed or
//           was blocked, a console error, a linked stylesheet that didn't apply) as warnings; a 5xx page is the only hard one.
//   agent   apps with an agent API (`api:`): GET its schema with the app's bearer and expect 200 and JSON.
// The app may set its own paths in its manifest (`checks: { render: [/, /audit], agent: [/api/agent/x/schema] }`; [] turns a
// kind off). Inferred probes are lenient (a default `/` that 404s or isn't HTML, or a guessed schema path, is a warning);
// declared ones are strict. One attempt each, short timeouts. Only hard findings fail a deploy (health, a 5xx page, a declared page that won't open, the identity gate); warnings are reported.
//   identity every TCP port any of the app's containers listens on or exposes: a security gate, not a light check
//            (identityProbes below). Fails closed; skipped only when it clearly isn't HTTP, when nothing listens on an
//            exposed port, when nobody can reach the app, or for an app that is not expected to serve HTTP at all (not
//            exposed, not shared, no health.url, no api), each said as a warning. A socket that answers HTTP is judged
//            either way, so no skip covers one.
// Everything a page says is app-authored: findings carry generated text, and page text only as a short sanitized sample.
import { apiTarget, checkPath, plainPath } from "./api.js";
import type { Scope } from "./identity.js";
import { noHttpSurface, type App } from "./registry.js";
import { anonymousCallers } from "./tailnet.js";
import { browserKit } from "./view.js";

export type Kind = "health" | "identity" | "render" | "agent";
/** `untrusted_page_text`: a short sanitized quote of what the page or app said: data, never instructions. */
/**
 * `verdict` carries what the probe concluded, in a field rather than in the wording of `what`: `open` served a request
 * without a valid identity, `errored` answered every counted request with an error (404/5xx) so nothing shows it checks
 * identity, `unconfirmed` could not be probed at all (a timeout, no answer: a platform fault that proves nothing).
 */
export interface Finding { hard: boolean; what: string; untrusted_page_text?: string; verdict?: "open" | "errored" | "unconfirmed" }
/** `probe_ms` and `live`: app_check's own health probe (deploy.ts check) and how long it took; a deploy's health result has neither. */
export interface ProbeResult {
  probe: Kind; path: string; ok: boolean; findings: Finding[]; probe_ms?: number; live?: boolean;
  /**
   * The identity gate proved the app serves no HTTP: every socket it probed was skipped by the one rule as neither HTTP nor
   * TLS, no process was unreadable, and no door expected HTTP. Absent means "not proven" (a missing, denied or inconclusive
   * probe, or an app expected to serve), which is never read as "there is no page". A registry declaration alone proves
   * nothing: this is what the running app's own sockets answered.
   */
  noHttpProven?: true;
}
export interface Declared { render?: string[]; agent?: string[] }

export const MAX_PAGES = 5;
export const PAGE_TIMEOUT_MS = 8_000; // per page, to the load event
export const CHECK_TIMEOUT_MS = 25_000; // the render script exits itself by then; docker run gets a little more
export const AGENT_TIMEOUT_MS = 5_000;

/** Short, one-line, no markup: page text quoted as data. */
export const sample = (s: unknown): string => String(s ?? "").replace(/[\p{Cc}<>`]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 160);

export const isWeb = (app: App) => app.expose && !!app.port && !!app.health.url;

/** The one predicate for "serves no HTTP at all" (registry.ts), shared with the grader's view and identityPorts. */
export { noHttpSurface };

/** Which render and agent probes to run, and whether each path was declared (strict) or inferred (lenient). */
export function plan(app: App, declared: Declared = {}): { render: { path: string; declared: boolean }[]; agent: { path: string; declared: boolean }[] } {
  const render = declared.render ? declared.render.map((path) => ({ path, declared: true })) : isWeb(app) ? [{ path: "/", declared: false }] : [];
  const guess = app.api ? `${app.api.paths[0]!.replace(/\/$/, "")}/schema` : undefined;
  const agent = declared.agent ? declared.agent.map((path) => ({ path, declared: true })) : guess ? [{ path: guess, declared: false }] : [];
  return { render, agent };
}

/**
 * The agent probe's identity, the same on every deploy and every app_check whoever asks: the platform's own `deploy-check`,
 * never the caller's, so any agent granted app_check gets a real signed answer without being one of the app's api.callers.
 * It can only read: GET alone, bound to the one probe path (the running commit's manifest `checks.agent`, or the guessed
 * schema path; never the caller's), which must sit under the app's agent API paths. Only the status and whether it was JSON
 * come back (judgeAgent), never the body.
 */
export function agentProbeScope(app: App, path: string): Scope {
  checkPath(app, path, app.api!.paths, "GET"); // the bearer goes only under the app's own agent API paths, and only reads
  return { role: "admin", methods: ["GET"], path: plainPath(path) };
}

/** What the render script reports for one page (all of it page data, bounded by the script). */
export interface PageFacts {
  path: string;
  error?: string; // the page couldn't be opened at all
  status?: number;
  contentType?: string;
  timedOut?: boolean;
  csp?: string[];
  console?: string[];
  failed?: { type: string; url: string; why: string }[];
  sheets?: { href: string; applied: boolean }[];
}

/** One page's facts → its findings. Hard only for a 5xx and a declared page that is missing or not HTML; what the render shows is a warning. */
export function judgePage(f: PageFacts, declared: boolean): Finding[] {
  const out: Finding[] = [];
  const strict = (what: string, s?: string) => out.push({ hard: declared, what, ...(s ? { untrusted_page_text: sample(s) } : {}) });
  if (f.error) return strict("the page couldn't be opened", f.error), out;
  const status = f.status ?? 0;
  if (status >= 500) return [{ hard: true, what: `the page answered ${status}` }];
  if (status >= 400) return strict(`the page answered ${status}`), out;
  if (f.contentType && !/text\/html|application\/xhtml/i.test(f.contentType)) return strict("not an HTML page", f.contentType.split(";")[0]), out;
  if (f.timedOut && !status) return strict(`the page never answered within ${PAGE_TIMEOUT_MS / 1000} s`), out;
  if (f.timedOut) out.push({ hard: false, what: `didn't finish loading within ${PAGE_TIMEOUT_MS / 1000} s (checked what had loaded)` });
  for (const c of f.csp ?? []) out.push({ hard: false, what: "Content Security Policy blocked part of the page", untrusted_page_text: sample(c) });
  for (const r of f.failed ?? []) {
    const code = sample(r.why);
    if (r.type === "stylesheet" || r.type === "script") out.push({ hard: false, what: `a ${r.type} failed to load (${code})`, untrusted_page_text: sample(r.url) });
    else out.push({ hard: false, what: `a ${sample(r.type)} failed to load (${code})`, untrusted_page_text: sample(r.url) });
  }
  // Unstyled: it links stylesheets and none applied.
  const unapplied = (f.sheets ?? []).filter((s) => !s.applied);
  if (unapplied.length) {
    const none = unapplied.length === f.sheets!.length;
    out.push({ hard: false, what: none ? "no linked stylesheet applied (the page renders unstyled)" : `${unapplied.length} of ${f.sheets!.length} linked stylesheets applied nothing`, untrusted_page_text: sample(unapplied.map((s) => s.href).join(" ")) });
  }
  for (const c of f.console ?? []) out.push({ hard: false, what: "console error", untrusted_page_text: sample(c) });
  return out;
}

/** The agent probe's response → its findings. */
export function judgeAgent(r: { status: number; body: string }, declared: boolean): Finding[] {
  if (r.status === 200) {
    try {
      JSON.parse(r.body);
      return [];
    } catch {
      return [{ hard: true, what: "answered 200 but not with JSON" }];
    }
  }
  if (!r.status) return [{ hard: declared, what: "no answer", untrusted_page_text: sample(r.body) }];
  // A guessed schema path that doesn't exist says nothing about the app.
  if (!declared && (r.status === 404 || r.status === 405)) return [{ hard: false, what: `no schema at the guessed path (${r.status}); declare checks.agent in aidenhq-app.yaml` }];
  return [{ hard: declared || r.status >= 500, what: `answered ${r.status}` }];
}

/** The identity gate's finding, word for word in the deploy result, its record and the app's incident. */
export const NO_SIGN_IN = "the app answers without the platform's sign-in: keep the starter's identity check (aidenhq-identity protect) in server.mjs";
/**
 * What the app's identity middleware answers when it refuses. 503 is deliberately absent: the middleware answers it when
 * it cannot read its keys, which proves nothing about whether an app checks identity at all (a handler that 503s every
 * request would otherwise pass).
 */
const REFUSED = new Set([401, 403]);
const UNCONFIRMED = "couldn't confirm the app refuses requests without the platform's sign-in";

/**
 * One request of the identity gate: a forged identity (a well-formed token no platform key signed) or none. `counts`: whether
 * its answer is judged; a token-less request to a tailnet-only app is still sent (it shows a port speaks HTTP) but may pass.
 */
export interface IdentityProbe { method: "GET" | "HEAD"; path: string; forged: boolean; counts: boolean }

/**
 * The identity gate's requests (docs/design/app-identity.md): an app on the platform wraps its whole handler in the identity
 * middleware, so every request but GET on its health path needs a valid signed identity. From the registry alone, never the
 * app's manifest: `/`, the app's agent API and HEAD on its health path (the one path every HTTP app serves), each with a
 * forged identity and with none. A token-less answer counts unless the platform itself lets token-less callers in (a
 * tailnet-only app behind a real apps node, AIDENHQ_ANONYMOUS: tailnet.ts anonymousCallers). No other way to make an app
 * public exists.
 */
export function identityProbes(app: App, node: boolean, healthPath?: string): IdentityProbe[] {
  const reqs: { method: "GET" | "HEAD"; path: string }[] = [{ method: "GET", path: "/" }];
  if (app.api) reqs.push({ method: "GET", path: app.api.paths[0]! });
  if (healthPath) reqs.push({ method: "HEAD", path: healthPath });
  const unique = reqs.filter((r, i) => !(r.method === "GET" && r.path === healthPath) && reqs.findIndex((x) => x.method === r.method && x.path === r.path) === i);
  return unique.flatMap((r) => [{ ...r, forged: true, counts: true }, { ...r, forged: false, counts: !anonymousCallers(app, node) }]);
}

/** A port the registry says is HTTP: a service and its container port, and the health path when it is the health.url's. */
export interface Door { service: string; port: string; health?: string }

/**
 * The app's ports the registry says are HTTP, in its sandboxed compose: the service publishing its registry port when exposed
 * or shared (where the apps node and the gate send people) and the health.url service (where agents' calls go). Each must
 * answer the identity gate over HTTP. Every other port its containers listen on is probed too (identityPorts), not only these.
 */
export function identityDoors(app: App, compose: { services?: Record<string, any> }): Door[] {
  const doors = new Map<string, Door>();
  if (app.port && (app.expose || app.share?.host))
    for (const [service, s] of Object.entries<any>(compose.services ?? {}))
      for (const p of s.ports ?? []) if (Number(p.published) === app.port) doors.set(`${service}:${p.target}`, { service, port: String(p.target) });
  if (app.health.url) {
    const t = apiTarget(app);
    if (t.protocol !== "http:") throw new Error(`${app.name}'s health.url isn't http`);
    const port = t.port || "80";
    doors.set(`${t.service}:${port}`, { service: t.service, port, health: new URL(app.health.url).pathname });
  }
  return [...doors.values()];
}

/** A container (docker inspect) that is a finished one-shot job: exited 0, never restarted (restart no or on-failure). */
export const finishedJob = (c: any): boolean => c?.State?.Status === "exited" && c.State.ExitCode === 0 && ["", "no", "on-failure"].includes(String(c.HostConfig?.RestartPolicy?.Name ?? ""));

/**
 * The compose services the gate can't probe: those without a running container. A service may listen without declaring a
 * port and may start later, so each fails it, except a one-shot job of this very deploy that is done: every container of
 * the service finished (finishedJob) and carries this deploy's config hash (`hashes`, `docker compose config --hash`; an
 * old deploy's exited container proves nothing), and it declares no port (ports, expose, or its image's EXPOSE: a server
 * must be running and probed). `containers`: docker inspect of every container of the app, running or not.
 */
export function unprobedServices(compose: { services?: Record<string, any> }, containers: any[], hashes: Record<string, string>): string[] {
  const label = (c: any, k: string) => String(c?.Config?.Labels?.[`com.docker.compose.${k}`] ?? "");
  return Object.entries<any>(compose.services ?? {}).filter(([n, s]) => {
    const mine = containers.filter((c) => label(c, "service") === n);
    if (mine.some((c) => c?.State?.Running)) return false;
    const job = mine.length > 0 && !s.ports?.length && !s.expose?.length && mine.every((c) => finishedJob(c) && !!hashes[n] && label(c, "config-hash") === hashes[n] && !Object.keys(c.Config?.ExposedPorts ?? {}).length);
    return !job;
  }).map(([n]) => n);
}

/**
 * The answers (status 0: none) → the gate's result. A counted answer under 400 served the request without a valid identity;
 * a request with no answer is inconclusive; and at least one counted request must have been refused by the middleware, else
 * nothing shows the app checks identity at all.
 */
export function judgeIdentity(answers: { probe: IdentityProbe; status: number }[]): ProbeResult {
  const where = [...new Set(answers.map((a) => a.probe.path))].join(" ");
  const say = (a: { probe: IdentityProbe; status: number }) => `${a.probe.method} ${a.probe.path} with ${a.probe.forged ? "a forged identity" : "no identity"} answered ${a.status}`;
  const counted = answers.filter((a) => a.probe.counts);
  const served = counted.filter((a) => a.status > 0 && a.status < 400);
  if (served.length) return probeResult("identity", where, [{ hard: true, verdict: "open", what: `${NO_SIGN_IN} (${served.slice(0, 2).map(say).join("; ")})` }]);
  const silent = answers.filter((a) => !a.status);
  if (silent.length) return probeResult("identity", where, [{ hard: true, verdict: "unconfirmed", what: `${UNCONFIRMED}: ${silent[0]!.probe.method} ${silent[0]!.probe.path} got no answer` }]);
  // Only a request actually served without a valid identity is an app that answers without sign-in. Requests that all
  // errored (5xx, 404, ...) never show the app checks identity: `errored`, never a confirmed-open verdict.
  if (!counted.some((a) => REFUSED.has(a.status)))
    return probeResult("identity", where, [{ hard: true, verdict: "errored", what: counted.length ? `${UNCONFIRMED}: every request without a valid identity errored (${counted.slice(0, 2).map(say).join("; ")})` : `${UNCONFIRMED}: no request without a valid identity was counted` }]);
  return probeResult("identity", where, []);
}

/**
 * One socket of one container (a listening or exposed port, on one address it can be reached at) and what each identity
 * probe got there (status 0: no HTTP answer). `raw`, when nothing answered HTTP, is a plain TCP look: `banner` it spoke
 * something that isn't HTTP, `refused` nothing listens, `http` it said HTTP after all, `closed` it hung up silently, `silent`
 * no answer at all. `tls` is the ClientHello's verdict, and it alone decides whether a skip may cover the socket.
 */
export interface PortAnswers {
  service: string; port: number; host: string; listening: boolean;
  raw?: "banner" | "refused" | "http" | "closed" | "silent";
  /** What a TLS ClientHello got on a socket that answered no HTTP: `tls` a TLS record header, `no` anything else. */
  tls?: "tls" | "no";
  answers: { probe: IdentityProbe; status: number }[];
}

/**
 * The gate over every socket of every container (IDENTITY_SCRIPT's findings). A socket that answered HTTP is judged by
 * judgeIdentity, and one that answered HTTP bytes without a counted status is hard too: no skip covers either. One that
 * didn't is skipped when it clearly isn't HTTP (a non-HTTP banner), when nothing listens on an exposed port, or when the
 * app serves no HTTP at all (`noHttp`: not exposed, not shared, no health.url, no api), so its ports are recorded as
 * non-hard "not probed" findings; never on a port the registry says is HTTP (required). The plaintext look cannot tell a
 * database from a TLS listener that hangs up on a GET, so every socket that answered no HTTP gets a TLS ClientHello too,
 * on every app shape: a TLS record is "answers HTTPS" and hard before any skip, and a socket on an app the skip may cover
 * is only skipped when the ClientHello says no TLS. Any other silence, `closed` and `silent` included, fails closed. No
 * socket at all: nobody can reach the app, the one skip, every skip a non-hard finding.
 */
export function identityPorts(ports: PortAnswers[], required: Door[], denied: string[] = [], noHttp = false): ProbeResult {
  const name = (p: { service: string; port: number | string }) => `${p.service}:${p.port}`;
  const at = (p: PortAnswers) => `${name(p)} on ${p.host}`;
  const findings: Finding[] = [];
  // Whether every socket took the one non-HTTP/non-TLS skip: any other outcome (an HTTP or TLS answer, an unprobed or refused
  // socket, a hard finding) clears it, so the verdict below is only ever positive on a complete, unambiguous probe.
  let allSkipped = ports.length > 0;
  // A process no scan could read may hold a listener nobody probed: fail closed, naming it.
  if (denied.length) findings.push({ hard: true, verdict: "unconfirmed", what: `${UNCONFIRMED}: couldn't read the sockets of process ${denied.join(", ")}` });
  for (const d of required) if (!ports.some((p) => p.listening && name(p) === name(d))) findings.push({ hard: true, verdict: "unconfirmed", what: `${UNCONFIRMED}: nothing listens on ${name(d)}` });
  if (!ports.length && !findings.length) return probeResult("identity", "*", [{ hard: false, what: "not probed: no container of the app listens on or exposes a TCP port, so nothing can reach it" }]);
  for (const p of ports) {
    const req = required.some((d) => name(d) === name(p));
    const hard = (what: string) => findings.push({ hard: true, verdict: "unconfirmed", what: `${at(p)}: ${what}` });
    // An HTTP answer is judged, counted or not, before any skip can apply.
    if (p.answers.some((a) => a.status > 0)) {
      allSkipped = false;
      findings.push(...judgeIdentity(p.answers).findings.map((f) => ({ ...f, what: `${at(p)}: ${f.what}` })));
      continue;
    }
    if (p.raw === "http") {
      allSkipped = false;
      hard("answers HTTP (a plaintext GET got an HTTP reply), so it isn't a database speaking its own protocol: not skipped");
      continue;
    }
    // A TLS record in answer to a ClientHello is an HTTPS listener on any app shape: never skipped, whatever the plaintext
    // look read its alert as.
    if (p.tls === "tls") {
      allSkipped = false;
      hard("answers HTTPS (a TLS ClientHello got a TLS record), so it isn't a database speaking its own protocol: not skipped");
      continue;
    }
    // A port nothing listens on on an exposed app is a skip, on any app shape, before the app-level rule.
    if (p.raw === "refused" && !p.listening && !req) {
      allSkipped = false;
      findings.push({ hard: false, what: `${at(p)} is exposed but nothing listens: not probed` });
      continue;
    }
    // The one skip rule: a socket that showed it isn't HTTP and isn't TLS, on a port the registry doesn't call HTTP. Always a
    // recorded non-hard finding, never a silent pass. The plaintext byte look alone doesn't decide it for an app that may be
    // skipped: the TLS ClientHello does, because a TLS listener hangs up on a GET exactly as a database does.
    const why = req ? undefined
      : noHttp ? (p.tls === "no" ? "the app isn't exposed, isn't shared and has no health.url or api, so it isn't expected to serve HTTP (not HTTP, not TLS)" : undefined)
      : p.raw === "banner" && p.tls === "no" ? "speaks something other than HTTP"
      : undefined;
    if (why) {
      // Only the app-level skip (the registry expects no HTTP, and this socket answered neither HTTP nor TLS) supports the
      // no-HTTP verdict. A single non-HTTP banner on an app that otherwise serves pages proves nothing about the app.
      if (!(noHttp && p.tls === "no")) allSkipped = false;
      findings.push({ hard: false, what: `${at(p)}: not probed: ${why}` });
      continue;
    }
    allSkipped = false;
    if (noHttp) findings.push({ hard: true, verdict: "unconfirmed", what: `${at(p)}: ${UNCONFIRMED}: the TLS probe didn't answer, so a listener that serves HTTPS can't be ruled out (no HTTP answer: ${p.raw ?? "none"})` });
    else findings.push({ hard: true, verdict: "unconfirmed", what: `${at(p)}: ${UNCONFIRMED}: no HTTP answer (${p.raw ?? "none"})` });
  }
  // Hard findings first, so the deploy's summary keeps the sentence.
  const result = probeResult("identity", [...new Set(ports.map(name))].join(" ") || "*", [...findings.filter((f) => f.hard), ...findings.filter((f) => !f.hard)]);
  // Proven only from a complete probe of a real socket: every finding a non-hard skip, nothing denied, no door expecting HTTP.
  if (allSkipped && !denied.length && !required.length && !findings.some((f) => f.hard)) return { ...result, noHttpProven: true };
  return result;
}

export const PORT_PROBE_MS = 3_000;
/**
 * Run as `node -e` in a one-shot container on `--network container:<id>` and `--pid container:<id>`, so /proc/net/tcp{,6} and
 * the pids are that container's own. The network namespace is shared with helpers the platform runs there (the render's
 * Chrome keeps an ephemeral DevTools listener for the life of a render), so a listening socket is the app's only when a
 * process of this pid namespace holds it: its inode appears as a `socket:[<inode>]` fd of some /proc/<pid>/fd. A listener
 * no fd attributes (it vanished between the two reads) is dropped too; the registry's required doors are still checked.
 * stdin { ports: number[] (exposed or required), ips: string[] (the container's addresses), probes: { method, path,
 * headers }[], tls: boolean (send a TLS ClientHello to a socket that answered no HTTP: an HTTPS listener is never skipped), and `proc`, the proc root those pids and
 * net tables are read from (the platform leaves it unset: /proc; a test passes a fixture tree). Every such socket (but
 * Docker's DNS on 127.0.0.11) is probed on the address it is bound to; a wildcard bind on loopback and every container
 * address; a given port nothing listens on, on the same. Every probe is sent to every socket; one that answered none gets a
 * plain TCP look, and (when `tls`) a ClientHello. Prints { sockets: [{ port, host, listening, raw?, tls?, statuses }] }.
 */
export const IDENTITY_SCRIPT = String.raw`
const fs = require("fs"), net = require("net");
const v4 = (h) => [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16)).join(".");
const v6 = (h) => {
  const b = [];
  for (let w = 0; w < 4; w++) for (let i = 6; i >= 0; i -= 2) b.push(parseInt(h.slice(w * 8 + i, w * 8 + i + 2), 16));
  if (b.slice(0, 10).every((x) => !x) && b[10] === 255 && b[11] === 255) return b.slice(12).join(".");
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16));
  return g.join(":");
};
const raw = (host, port) => new Promise((done) => {
  let got = "";
  const end = (r) => { s.destroy(); done(r); };
  const s = net.connect({ host, port, timeout: ${PORT_PROBE_MS} });
  s.on("connect", () => s.write("GET / HTTP/1.0\r\n\r\n"));
  s.on("data", (d) => { got += d; if (got.length >= 5) end(got.startsWith("HTTP/") ? "http" : "banner"); });
  s.on("timeout", () => end(got ? "banner" : "silent"));
  s.on("end", () => end(got ? (got.startsWith("HTTP/") ? "http" : "banner") : "closed"));
  s.on("error", (e) => end(e.code === "ECONNREFUSED" ? "refused" : got ? "banner" : "silent"));
});
// A well-formed TLS 1.2 ClientHello (TLS 1.3 versions offered, x25519 and P-256 key shares, the TLS 1.3 suites): a real TLS
// server answers with a handshake record, while a server that only speaks its own protocol hangs up or reads a nonsense
// length, as a database does. Built field by field so no length can drift out of step.
const HELLO = (() => {
  const u8 = (...a) => Buffer.from(a.flat());
  const u16 = (n) => u8(n >> 8, n & 0xff);
  const u24 = (n) => u8(n >> 16, (n >> 8) & 0xff, n & 0xff);
  const vec16 = (items) => { const b = Buffer.concat(items); return Buffer.concat([u16(b.length), b]); };
  const ext = (type, body) => Buffer.concat([u16(type), u16(body.length), body]);
  const share = (group, key) => Buffer.concat([u16(group), u16(key.length), key]);
  const point = Buffer.concat([u8(4), Buffer.alloc(64, 9)]); // an uncompressed P-256 point: well-formed for any server
  const exts = Buffer.concat([
    ext(0x002b, Buffer.concat([u8(4), u16(0x0304), u16(0x0303)])),            // supported_versions: TLS 1.3, 1.2
    ext(0x000a, vec16([u16(0x001d), u16(0x0017)])),                          // supported_groups: x25519, P-256
    ext(0x000d, vec16([u16(0x0403), u16(0x0401), u16(0x0503), u16(0x0501)])), // signature_algorithms
    ext(0x0033, vec16([share(0x001d, Buffer.alloc(32, 9)), share(0x0017, point)])), // key_share
  ]);
  const body = Buffer.concat([
    u16(0x0303), Buffer.alloc(32, 7), u8(0),
    vec16([u16(0x1301), u16(0x1302), u16(0x1303), u16(0xc02f), u16(0xc030)]),
    u8(1), u8(0), u16(exts.length), exts,
  ]);
  const hs = Buffer.concat([u8(1), u24(body.length), body]);
  return Buffer.concat([u8(0x16), u16(0x0301), u16(hs.length), hs]);
})();
const tlsLook = (host, port) => new Promise((done) => {
  let got = Buffer.alloc(0), finished = false;
  // A TLS record content type (change_cipher_spec, alert, handshake, application_data) in answer to a hello is TLS evidence,
  // even truncated; a type byte followed by something other than a 0x03 version is not. A first byte of 0x15 alone is not
  // read as a plain banner: a listener that begins a TLS record and hangs up could serve HTTPS, so it stays hard.
  const verdict = () => {
    if (!got.length || ![0x14, 0x15, 0x16, 0x17].includes(got[0])) return "no";
    return got.length < 2 || got[1] === 0x03 ? "tls" : "no";
  };
  const end = () => { if (finished) return; finished = true; s.destroy(); done(verdict()); };
  const s = net.connect({ host, port, timeout: ${PORT_PROBE_MS} });
  s.on("connect", () => s.write(HELLO));
  s.on("data", (d) => { got = Buffer.concat([got, d]); end(); });
  s.on("timeout", end); s.on("end", end); s.on("error", end);
});
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", async () => {
  const r = JSON.parse(s);
  const proc = r.proc ?? "/proc";
  const wild = ["127.0.0.1", ...r.ips];
  const held = new Set(), denied = [];
  for (const p of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(p)) continue;
    let fds;
    // A process that exited is gone; any other unreadable fd table is listed (a scan as its own uid reads it).
    try { fds = fs.readdirSync(proc + "/" + p + "/fd"); } catch (e) { if (e.code !== "ENOENT" && e.code !== "ESRCH") denied.push(p); continue; }
    for (const f of fds) {
      let t;
      try { t = fs.readlinkSync(proc + "/" + p + "/fd/" + f); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(t);
      if (m) held.add(m[1]);
    }
  }
  const sockets = new Map();
  const add = (port, host, listening) => { const k = host + " " + port; if (!sockets.has(k) || listening) sockets.set(k, { port, host, listening }); };
  for (const [f, dec] of [[proc + "/net/tcp", v4], [proc + "/net/tcp6", v6]]) {
    let t = "";
    try { t = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const l of t.split("\n").slice(1)) {
      const c = l.trim().split(/\s+/);
      if (c[3] !== "0A" || !held.has(c[9])) continue;
      const [hex, ph] = c[1].split(":");
      const addr = dec(hex), port = parseInt(ph, 16);
      if (addr === "127.0.0.11") continue;
      if (addr === "0.0.0.0" || addr === "0:0:0:0:0:0:0:0") for (const h of [...wild, ...(addr.includes(":") ? ["::1"] : [])]) add(port, h, true);
      else add(port, addr, true);
    }
  }
  const listening = new Set([...sockets.values()].map((x) => x.port));
  for (const port of r.ports) if (!listening.has(port)) for (const h of wild) add(port, h, false);
  const out = [];
  for (const k of [...sockets.values()].sort((a, b) => a.port - b.port)) {
    const base = "http://" + (k.host.includes(":") ? "[" + k.host + "]" : k.host) + ":" + k.port;
    const statuses = [];
    for (const p of r.probes) {
      let status = 0;
      try {
        const res = await fetch(base + p.path, { method: p.method, headers: p.headers, redirect: "manual", signal: AbortSignal.timeout(${PORT_PROBE_MS}) });
        status = res.status;
        await res.body?.cancel();
      } catch {}
      statuses.push(status);
    }
    const plain = statuses.some((x) => x) ? {} : { raw: await raw(k.host, k.port) };
    const tls = r.tls && !statuses.some((x) => x) ? { tls: await tlsLook(k.host, k.port) } : {};
    out.push({ ...k, statuses, ...plain, ...tls });
  }
  process.stdout.write(JSON.stringify({ sockets: out, denied }));
});
`;

/** The distinct uids of a container's processes, from `docker top <id> -eo uid,pid`; none fails the gate loudly. */
export function processUids(top: string): number[] {
  const uids = [...new Set(top.split("\n").slice(1).map((l) => l.trim().split(/\s+/)[0] ?? "").filter((u) => /^\d+$/.test(u)).map(Number))];
  if (!uids.length) throw new Error("docker top lists no process of the container");
  return uids;
}

/**
 * One container's scans, one per uid, merged. Any scan's evidence counts, whichever one attributed the listener: one uid can
 * read a socket another could not, so a later scan must never erase an earlier one's answer. A socket listens when any scan
 * attributed it; a process stays denied only when every scan was refused it. Everything else is joined so evidence can only
 * get stronger, never weaker: a probe's status keeps the answer that is strongest evidence of a problem (a served request
 * first, then a refusal, then any other answer, then silence), `raw` keeps the strongest look (`http`, then a hang-up, then a
 * banner, then a refusal), and the TLS answer is `tls` if any scan saw a TLS record, `no` if any answered `no`, and absent
 * only when no scan answered. Losing any of these could turn an HTTP or TLS listener into a skip (identityPorts).
 */
export function mergeScans(scans: { sockets: { port: number; host: string; listening: boolean; raw?: PortAnswers["raw"]; tls?: PortAnswers["tls"]; statuses: number[] }[]; denied?: string[] }[]) {
  const sockets = new Map<string, (typeof scans)[number]["sockets"][number]>();
  for (const sc of scans) for (const k of sc.sockets) {
    const key = `${k.host} ${k.port}`, had = sockets.get(key);
    if (!had) { sockets.set(key, k); continue; }
    // The scan that attributed the listener supplies the socket's own fields; every piece of evidence is joined, so no
    // scan can weaken another's answer.
    const owner = k.listening && !had.listening ? k : had;
    const raw = strongestRaw([had.raw, k.raw]);
    const tls = had.tls || k.tls ? (had.tls === "tls" || k.tls === "tls" ? "tls" as const : "no" as const) : undefined;
    sockets.set(key, {
      port: owner.port,
      host: owner.host,
      listening: had.listening || k.listening,
      statuses: Array.from({ length: Math.max(had.statuses.length, k.statuses.length) }, (_, i) => strongestStatus(had.statuses[i] ?? 0, k.statuses[i] ?? 0)),
      ...(raw ? { raw } : {}),
      ...(tls ? { tls } : {}),
    });
  }
  const denied = (scans[0]?.denied ?? []).filter((p) => scans.every((sc) => (sc.denied ?? []).includes(p)));
  return { sockets: [...sockets.values()], denied };
}

/**
 * Which of two answers to the same probe is stronger evidence, never weaker. The order follows what judgeIdentity needs to
 * pass: a served status (under 400) is hard on its own; silence is hard on its own; an answer that is not a refusal is hard
 * when no counted request was refused; and a refusal is the only answer that lets the gate pass. So a served status beats
 * silence, silence beats other answers, and every answer beats a refusal. Keeping the first non-zero answer let one scan's
 * 401 hide another scan's 200, and ranking a refusal above other answers let the same 401 clear a 500 or a silence.
 */
export function strongestStatus(a: number, b: number): number {
  const rank = (s: number) => (s > 0 && s < 400 ? 4 : s === 0 ? 3 : REFUSED.has(s) ? 1 : 2);
  return rank(a) >= rank(b) ? a : b;
}

/** The same, for the plaintext look: an HTTP reply, then a hang-up or silence, then a banner, then a refusal. `refused` is
 * the weakest (nothing listens), so it must never win over a look that got an answer. */
export function strongestRaw(seen: (PortAnswers["raw"] | undefined)[]): PortAnswers["raw"] | undefined {
  const rank = (r: PortAnswers["raw"] | undefined) => (r === "http" ? 4 : r === "closed" || r === "silent" ? 3 : r === "banner" ? 2 : r === "refused" ? 1 : 0);
  return seen.reduce<PortAnswers["raw"] | undefined>((best, r) => (rank(r) > rank(best) ? r : best), undefined);
}

/**
 * `docker run` argv for one container's identity scan. Its network namespace is the app's door, and its pid namespace is what
 * makes the scan the app's own: peers the platform runs there (the render's browser) share the network but not these pids, so
 * IDENTITY_SCRIPT drops their listeners. The helper runs with no capabilities, once per uid the container's processes run
 * as: a process's /proc/<pid>/fd is readable by its own uid, so no ptrace or DAC capability is needed (DAC_READ_SEARCH
 * would re-open open_by_handle_at, a container-escape primitive). A process no scan could read fails the gate.
 */
export function identityProbeArgs(image: string, id: string, uid: number): string[] {
  return ["run", "--rm", "-i", "--pull", "never", "--user", `${uid}:${uid}`, "--network", `container:${id}`, "--pid", `container:${id}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", image, "node", "-e", IDENTITY_SCRIPT];
}

export const probeResult = (probe: Kind, path: string, findings: Finding[]): ProbeResult => ({ probe, path, ok: !findings.some((f) => f.hard), findings: findings.slice(0, 10) });
export const failed = (rs: ProbeResult[]) => rs.filter((r) => !r.ok);

/** Generated text only (no page samples): for deploy records, incidents and the webhook. */
export function summary(rs: ProbeResult[]): string {
  const bad = failed(rs).map((r) => `${r.probe} ${r.path}: ${r.findings.filter((f) => f.hard).map((f) => f.what).join("; ")}`);
  if (bad.length) return `post-deploy check failed (${bad.join(" | ")})`.slice(0, 400);
  const warn = rs.flatMap((r) => r.findings.filter((f) => !f.hard).map((f) => `${r.probe} ${r.path}: ${f.what}`));
  return warn.length ? `checks passed with ${warn.length} warning${warn.length === 1 ? "" : "s"} (${warn.slice(0, 3).join(" | ")})`.slice(0, 400) : "";
}

// The render check, run as `node -e` in view.ts's browser image with { pages: [{ path, url }], headers? } on stdin. One browser
// and tab for all pages; each page has its own load timeout and the script exits itself at CHECK_TIMEOUT_MS. Prints
// { pages: PageFacts[] } or { error }. The facts come from the tab's own DevTools events (console, log, exceptions, network),
// as a person's DevTools would show them. Gate headers (shared apps) go only to the app's own origin, as in view.ts.
export const CHECK_SCRIPT = browserKit(PAGE_TIMEOUT_MS) + String.raw`
const results = [];
setTimeout(() => out({ pages: results, error: "render check timed out" }), ${CHECK_TIMEOUT_MS - 2000});
const cap = (a, n) => a.slice(0, n).map((s) => typeof s === "string" ? s.slice(0, 300) : s);
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", async () => {
  try {
    const r = JSON.parse(s);
    await ab("open"); // the launch, on about:blank
    const dt = await devtools();
    if (r.headers) await guard(dt, r.headers, new URL(r.pages[0].url).origin);
    let f = null; // the page being read; after its stylesheets are read nothing more is collected
    const live = () => f && !f.read;
    const urls = new Map();
    const log = (t) => {
      if (!live()) return;
      if (/Content Security Policy/i.test(t)) f.csp.push(t);
      else if (!/^Failed to load resource/.test(t)) f.console.push(t); // load failures are judged by resource type below
    };
    dt.on["Runtime.consoleAPICalled"] = (p) => { if (p.type === "error") log(p.args.map((a) => a.value !== undefined ? String(a.value) : a.description || "").join(" ")); };
    dt.on["Log.entryAdded"] = ({ entry }) => { if (entry.level === "error") log(entry.text); };
    dt.on["Runtime.exceptionThrown"] = ({ exceptionDetails: d }) => { if (live()) f.console.push(String((d.exception && d.exception.description) || d.text).split("\n")[0]); };
    dt.on["Network.requestWillBeSent"] = (p) => urls.set(p.requestId, p.request.url);
    const main = await tab(dt, ["Network", "Log", "Runtime"]);
    const isPage = (p) => p.type === "Document" && p.frameId === main;
    dt.on["Network.responseReceived"] = (p) => {
      if (!live()) return;
      const res = p.response;
      if (isPage(p)) { f.status = res.status; f.contentType = Object.entries(res.headers || {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] || ""; }
      else if (res.status >= 400) f.failed.push({ type: String(p.type || "other").toLowerCase(), url: res.url, why: String(res.status) });
    };
    // Aborted loads (a navigation away under a request) say nothing about the page.
    dt.on["Network.loadingFailed"] = (p) => { if (live() && !isPage(p) && !/ERR_ABORTED/.test(p.errorText || "")) f.failed.push({ type: String(p.type || "other").toLowerCase(), url: urls.get(p.requestId) || "", why: p.blockedReason ? "blocked:" + p.blockedReason : p.errorText || "failed" }); };
    for (const p of r.pages) {
      // The last page is left first (a blank page), so nothing it still does lands on the next one.
      if (results.length) await within(ab("open", "about:blank"), 3000, null);
      f = { path: p.path, csp: [], console: [], failed: [], sheets: [] };
      results.push(f);
      try {
        await ab("open", p.url); // to the load event, within PAGE_TIMEOUT_MS (the launch's default)
      } catch (e) {
        if (timedOut(e)) f.timedOut = true;
        else { f.error = line(e).slice(0, 200); f.read = true; continue; }
      }
      // A blocked or failed sheet still has a CSSStyleSheet, empty or unreadable: a same-origin sheet applied when its rules
      // read and there are some; a cross-origin sheet's rules can't be read, so there a sheet object is all we can see.
      const sheets = await within(ab("eval", "JSON.stringify([...document.querySelectorAll('link[rel~=\"stylesheet\"]')].map((l) => { let applied = !!l.sheet; if (applied && new URL(l.href, location.href).origin === location.origin) { try { applied = l.sheet.cssRules.length > 0; } catch { applied = false; } } return { href: l.href, applied }; }))"), 2000, {});
      try { f.sheets = JSON.parse(sheets.result || "[]"); } catch { f.sheets = []; }
      f.read = true;
      f.csp = cap(f.csp, 5); f.console = cap(f.console, 5); f.failed = f.failed.slice(0, 10); f.sheets = f.sheets.slice(0, 20);
    }
    out({ pages: results });
  } catch (e) {
    out({ pages: results, error: line(e) });
  }
});
`;
