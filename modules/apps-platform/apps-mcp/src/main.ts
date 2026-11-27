// apps-mcp: deploys and runs sandboxed apps from the git registry; MCP over streamable HTTP behind the kernel (service key bearer, caller assertion).
import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.js";
import { startLoops } from "./loops.js";
import { openPrs, recordedOpenPrs, type OpenPr, type WarehouseRow } from "./open-prs.js";
import { startPeople } from "./people.js";
import { buildServer, refreshRegistry, type Board, type Caller } from "./mcp.js";
import { appsExecutor } from "./executor.js";
import { serveExecutor } from "./aidenhq-sdk/executor.js";
import { createPlatform } from "./platform.js";
import { resolveOwnImage } from "./self-image.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { posix } from "node:path";
import { show } from "./git.js";
import { MANIFEST_FILE, parseManifest } from "./manifest.js";
import { GRADER_SNAPSHOT_CAP, SNAPSHOT_CAP, graderView } from "./view.js";
import { githubApi, startPreviews } from "./previews.js";
import { bootRegistry, inAgentsOrg } from "./git.js";
import { codeHostOps, isLocal, localChanges, localRepos, localRoot, readFleetOrg, readOrgs, withLocal } from "./codehost.js";
import { previewApp, previewName } from "./previews.js";
import { appsReader, appsReaderIdentity, bearerIs } from "./readers.js";
import { scopeIssues, sourceHealth } from "./sources.js";
import { pageCanary } from "./canary.js";
import type { Canary } from "./mcp.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "apps-mcp" }, redact: ["authorization", "*.authorization", "token", "*.token"] });
const need = (n: string): string => process.env[n] || (() => { throw new Error(`${n} is required`); })();
const file = (n: string): string => (process.env[`${n}_FILE`] ? readFileSync(process.env[`${n}_FILE`]!, "utf8").trim() : "");

const repoDir = need("REPO_DIR");
// The instance checkout (the apply's): read for instance.yaml only. apps.yaml (agent-created apps) is read and written in
// apps-mcp's own clone of the instance (registryDir), committed to main through the code host's commit op (else pushed with the deploy key).
const instanceDir = need("INSTANCE_DIR");
const registryDir = "/data/registry";
const appsData = need("APPS_DATA");
const internalToken = file("APPS_INTERNAL_TOKEN");
if (!internalToken) throw new Error("APPS_INTERNAL_TOKEN(_FILE) is required");
const serviceKey = file("APPS_SERVICE_KEY");
if (!serviceKey) throw new Error("APPS_SERVICE_KEY(_FILE) is required");
const kernelUrl = (process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/$/, "");
// The fleet org (github_fleet_org where instance.yaml sets it, else the compiled catalog's repos.fleet_org; unset means
// none) is always allowed; its repos are fetched and commented on through the kernel's code host operations, as the owner,
// so no token reaches this service.
const agentsOrg = readFleetOrg(instanceDir, repoDir);
const orgs = readOrgs(instanceDir);
const ops = codeHostOps(kernelUrl, serviceKey);
// This server's repos (codehost-local), read-only at /codehost when the instance enables it: `local/*` apps build from them.
const codehost = localRoot(repoDir);

// Helper containers (health, app_api, identity probes) run in apps-mcp's own image; refuse to start without it.
const helperImage = await resolveOwnImage((args) => promisify(execFile)("docker", args).then((r) => r.stdout));
log.info({ helperImage }, "helper containers run apps-mcp's own image");

const p = createPlatform(
  {
    registryPath: `${registryDir}/apps.yaml`,
    modulesRegistryPath: `${repoDir}/config/apps.modules.yaml`,
    appsData,
    secretsDir: process.env.APPS_SECRETS_DIR ?? "/secrets/apps",
    hostSecretsDir: need("APPS_HOST_SECRETS_DIR"),
    identityKeyFile: process.env.IDENTITY_KEY_FILE ?? "/secrets/identity_key",
    identityKeysHostFile: need("IDENTITY_KEYS_HOST_FILE"),
    dbPath: process.env.APPS_DB ?? "/data/apps-mcp.sqlite",
    urlBase: process.env.APPS_URL_BASE ?? "",
    edgeDir: process.env.APPS_EDGE_DIR ?? "/edge",
    healthImage: helperImage,
    git: { appsData, gitDir: "/data/git", productDir: repoDir, orgs, ...(agentsOrg ? { agentsOrg } : {}), ops, ...(codehost ? { localRoot: codehost } : {}), sshCommand: "ssh -i /secrets/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts" },
    webhookDir: "/run/secrets",
    gateFile: `${repoDir}/config/gate.json`,
    appsNodeFile: `${repoDir}/config/apps-node`,
    previewsFile: process.env.APPS_PREVIEWS_FILE ?? "/previews/previews.json",
    doorsFile: process.env.APPS_DOORS_FILE ?? "/previews/doors.json",
    notify: async (text, key) => {
      const res = await fetch(`${kernelUrl}/v1/notify`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serviceKey}` }, body: JSON.stringify({ kind: "decision", text, dedupe_key: key }), signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`kernel notify: ${res.status}`);
    },
    // role kernel.events: this module's service key speaks as apps-platform, the apps connection's module.
    event: async (e) => {
      const res = await fetch(`${kernelUrl}/v1/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serviceKey}` }, body: JSON.stringify(e), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`kernel events: ${res.status}`);
    },
  },
  log,
);
const jwks = kernelJwks();
// An https github.com registry is fetched and committed through the code host's ops (git.ts); any other URL (the instance
// checkout's origin) over SSH with the deploy key.
const repo = { dir: registryDir, pushUrl: process.env.REGISTRY_PUSH_URL || (agentsOrg ? `https://github.com/${agentsOrg}/aidenhq-instance.git` : execFileSync("git", ["-C", instanceDir, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim()) };
// A fetch that fails after its retries serves the registry already on disk (/data/registry survives a recreate), and the
// reconcile loop's beforeTick retries it in the background. Only a first boot with no registry yet fails closed.
await bootRegistry(p.cfg.git, repo.dir, repo.pushUrl);

// In-app requests and app roles (app_requests, app_role_set…) go to the kernel, which holds the accounts and app access
// (lean 3g): POST /v1/apps/<op> on the backplane with this module's own token (its service key).
const board: Board = async (op, req) => {
  const res = await fetch(`${kernelUrl}/v1/apps/${op}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serviceKey}` }, body: JSON.stringify(req), signal: AbortSignal.timeout(30_000) }).catch((e: Error) => {
    throw new Error(`the kernel is unreachable (${e.message})`);
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`kernel: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

// The write kinds' executor (executor@1): the kernel calls it with the service key, for approved records only.
const executor = serveExecutor(appsExecutor(p), { key: serviceKey, log: (msg, f) => log.warn(f ?? {}, msg) });

const send = (res: ServerResponse, code: number, body?: unknown) => void res.writeHead(code, { "content-type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));
const readBody = async (req: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(), 15_000);
  try {
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 1_000_000) throw Object.assign(new Error("body too large"), { status: 413 });
      chunks.push(c as Buffer);
    }
  } finally {
    clearTimeout(timer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
};
const internalAuthorized = (req: IncomingMessage): boolean => bearerIs(req, internalToken);
// The reads of a module holding apps.read (readers.ts): the grader's deploys and view, the Fleet Steward's quality and open PRs and (besides
// the board's internal token, for its connections view) its sources.
const reader = appsReader(kernelUrl);
const readerIdentity = appsReaderIdentity(kernelUrl);

// Nothing is published to the host: only containers on the compose network reach this port. /internal/* is the board's and
// watcher's API, and the grader's reads (a module holding apps.read); the one write (a stateful deploy, already approved in
// chat) needs the internal token, which agents and modules don't have.
let reconcile: () => Promise<void> = async () => undefined; // set once the loops start
const http = createServer(async (req, res) => {
  let url: URL;
  try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return void res.writeHead(400).end(); }
  try {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname === "/internal/status" && req.method === "GET") return send(res, 200, p.apps().map((a) => p.cached(a)));
    // The apps node's login link is a bearer secret: the board's internal token only.
    if (url.pathname === "/internal/apps-node" && req.method === "GET") return internalAuthorized(req) ? send(res, 200, p.nodeState()) : send(res, 401, { error: "unauthorized" });
    if (url.pathname === "/internal/host" && req.method === "GET") {
      const f = statfsSync("/data"); // the host disk that holds the apps' data
      return send(res, 200, { disk_pct: Math.round((1 - Number(f.bavail) / Number(f.blocks)) * 100) });
    }
    if (url.pathname === "/internal/apps" && req.method === "GET") return send(res, 200, await p.listing());
    // Each source's last good pass and whether its latest pass failed (the board's Fleet Ops detector; never the error text,
    // which agents read with warehouse_query). No sources until the warehouse is set up.
    if (url.pathname === "/internal/sources" && req.method === "GET") {
      const who = internalAuthorized(req) ? "internal" : await readerIdentity(req); // verified once: it also decides the detail below
      if (typeof who === "number") return send(res, 401, { error: "unauthorized" });
      let d;
      try {
        d = p.warehouse();
      } catch {
        return send(res, 200, {});
      }
      const sources = await sourceHealth(d);
      // The detail (scope and error text) goes only to the board's internal token and the Fleet Steward (the module that
      // reads the warehouse's health); other apps.read callers get the summary rows. A scope still recording runs (one within 8
      // days: weekly ones too) whose passes have all failed for 24 hours, counted from its first failure after its last good
      // pass; a scope retired by its writer (its newest pass is `status = 'retired'`) is in neither list. The last good pass is
      // found once per scope.
      const detail = who === "internal" || who.module === "fleet-steward";
      // The two scope lists (sources.ts scopeIssues), each dropping a scope whose newest pass is retired: a scope no longer
      // configured stops being reported at once, not after the 8-day window.
      const { failing, short } = detail ? await scopeIssues(d) : { failing: [], short: [] };
      return send(res, 200, { sources, failing_scopes: failing, short_scopes: short });
    }
    // Each app's quality checks from its last health probe (quality.ts): name, ok and count only, never samples (app data,
    // read through app_status by a caller who may read the app). The board's detector raises the failing ones for Fleet Ops.
    if (url.pathname === "/internal/quality" && req.method === "GET") {
      if ((await reader(req)) !== 0) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, { apps: p.qualityOf() });
    }
    // Open pull requests the fleet opened (open-prs.ts): the kernel's records of them (GET /v1/objects, the code host's publishes and PR
    // records), in any repo and with or without a fleet org, with their open and draft state from the warehouse where it syncs the repo
    // (src_github, every 15 minutes), and the open change requests of this server's repos (codehost-local), each with its preview's URL
    // when one runs. The Fleet Steward's detector raises the ones nobody has merged.
    if (url.pathname === "/internal/open-prs" && req.method === "GET") {
      if ((await reader(req)) !== 0) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, await openPrs(async () => (codehost ? await localOpenPrs() : []), githubOpenPrs, (e) => log.warn({ err: String(e) }, "open-prs: the fleet's GitHub PRs could not be read")));
    }
    // Named pull requests' state from the warehouse (`?pr=owner/repo#12`, up to 100): the kernel wake inbox (kernel/src/wakes.ts) wakes
    // the agent waiting on one when it merges or closes. Empty when there is no warehouse yet.
    if (url.pathname === "/internal/pr-states" && req.method === "GET") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      const all = url.searchParams.getAll("pr").slice(0, 100).map((r) => /^([\w.-]+\/[\w.-]+)#(\d{1,9})$/.exec(r)).filter((m) => m !== null);
      // This server's change requests answer from their refs (the read-only mount), the rest from the warehouse.
      const local = codehost ? await localStates(all.filter((m) => isLocal(codehost, m[1]!))) : [];
      const refs = all.filter((m) => !isLocal(codehost, m[1]!));
      let d;
      try {
        d = p.warehouse();
      } catch {
        return send(res, 200, codehost ? { prs: local } : {});
      }
      if (!refs.length) return send(res, 200, { prs: local });
      const r = await d.pool.query(
        "SELECT i.repo, i.number, i.state, i.merged_at, i.closed_at FROM src_github.issues i JOIN unnest($1::text[], $2::int[]) AS want(repo, number) ON lower(i.repo) = lower(want.repo) AND i.number = want.number WHERE i.kind = 'pr'",
        [refs.map((m) => m[1]), refs.map((m) => Number(m[2]))],
      );
      return send(res, 200, { prs: [...r.rows, ...local] });
    }
    // Every deploy of one exact commit, over the app's whole deploy table (the grading module): a commit the bounded status
    // list has moved past is still provable here, and a commit with no row really was never deployed.
    const deployHistory = /^\/internal\/deploys\/([a-z0-9-]{1,63})\/([0-9a-f]{40})$/.exec(url.pathname);
    if (deployHistory && req.method === "GET") {
      const refused = await reader(req);
      if (refused) return send(res, refused, { error: refused === 403 ? `role apps.read is required` : "unauthorized" });
      const a = p.find(deployHistory[1]!);
      return send(res, 200, { deploys: p.store.deploysOf(a.name, deployHistory[2]!).map(({ sha, at, by, status }) => ({ sha, at, by, status })) });
    }
    // A shared app's manifest (custom roles, default role) at the commit that is running (the board's app access).
    const manifestPath = /^\/internal\/apps\/([a-z][a-z0-9-]{1,30})\/manifest$/.exec(url.pathname);
    if (manifestPath && req.method === "GET") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      const a = p.find(manifestPath[1]!);
      const sha = p.store.running(a.name);
      if (!sha) return send(res, 200, { sha: null, roles: [] });
      return send(res, 200, { sha, ...parseManifest(await show(p.cfg.git, a, sha, posix.join(a.path, MANIFEST_FILE))) });
    }
    // The grader's live view of one page of a deployed app (the grading module): view.ts graderView. The larger snapshot is
    // the grading module's alone: any other apps.read caller (the Fleet Steward) gets the ordinary SNAPSHOT_CAP, and no caller
    // can raise it from the request.
    if (url.pathname === "/internal/view" && req.method === "POST") {
      const who = await readerIdentity(req);
      if (typeof who === "number") return send(res, who, { error: who === 403 ? `role apps.read is required` : "unauthorized" });
      const b = await readBody(req);
      const cap = who.module === "grading" ? GRADER_SNAPSHOT_CAP : SNAPSHOT_CAP;
      return send(res, 200, await graderView(p.find(String(b?.name ?? "")), { path: b?.path, width: b?.width, cap }, { resolve: p.resolveApi, render: p.render, sign: p.sign, running: p.store.running, noHttpProven: p.noHttpProven, audit: p.auditView }));
    }
    if (url.pathname === "/internal/deploy" && req.method === "POST") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      if (!b?.name || !b.by || !b.approved_comment_id) return send(res, 400, { error: "name, by and approved_comment_id are required" });
      return send(res, 200, await p.engine.deploy(p.find(b.name), { sha: b.sha, by: `${b.by} (approved in ${b.approved_comment_id})`, allowStateful: true }));
    }
    if (await executor(req, res)) return;
    if (url.pathname !== "/mcp") return send(res, 404);
    if (!bearerIs(req, serviceKey)) return send(res, 401, { error: "unauthorized" });
    if (req.method !== "POST") return send(res, 405);
    const body = await readBody(req);
    // Only the handshake and tool listing run without identity; every tool call needs the kernel's assertion of its caller.
    const msgs = (Array.isArray(body) ? body : [body]) as { id?: unknown; method?: unknown }[];
    let caller: Caller = { id: "", key: "", name: "anonymous", roles: [] };
    if (msgs.some((m) => m?.method === "tools/call")) {
      try {
        const c = await verifyCaller(req, jwks, process.env.AIDENHQ_MODULE ?? "apps-platform");
        caller = { id: c.agent, key: c.key, name: c.name, roles: c.roles };
      } catch (err) {
        const reason = (err as Error).message;
        log.warn({ reason }, "tool call refused");
        const refusal = (m: { id?: unknown }) => ({ jsonrpc: "2.0", id: m?.id ?? null, result: { isError: true, content: [{ type: "text", text: `Refused: ${reason}` }] } });
        return send(res, 200, Array.isArray(body) ? msgs.map(refusal) : refusal(msgs[0]!));
      }
    }
    // The test-user canary (canary.ts): its kernel calls carry this tool call's own in-flight assertion, never a body's say-so.
    const assertion = String(req.headers["x-aidenhq-caller"] ?? "");
    const canary: Canary = (app, a) => pageCanary(app, a, {
      kernel: async (path, body) => {
        const r = await fetch(`${kernelUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serviceKey}`, ...(assertion ? { "x-aidenhq-caller": assertion } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).catch((e: Error) => { throw new Error(`the kernel is unreachable (${e.message})`); });
        const text = await r.text();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = { error: text.slice(0, 300) }; }
        return { status: r.status, json };
      },
      run: (network, script, input, timeout, before) => p.canaryRun(network, script, input, timeout, before),
      log: (o) => log.info(o, "app_page_canary"),
    });
    const server = buildServer(p, caller, repo, reconcile, board, canary);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if ((err as { status?: number }).status === 413) return send(res, 413, { error: "body too large" });
    log.error({ err: (err as Error).message }, "request failed");
    if (!res.headersSent) send(res, 500, { error: (err as Error).message });
  }
});

http.listen(Number(process.env.PORT ?? 8090), "0.0.0.0", () => log.info("apps-mcp listening"));
// A restart (an apply recreating this container) waits for the deploys, rollbacks, previews and runs in flight, so it never
// kills an app's build half way. stop_grace_period in compose.yaml is a minute longer.
const DRAIN_MS = 600_000;
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    log.info("stopping: waiting for in-flight app deploys");
    void p.engine.drain(DRAIN_MS).then((left) => {
      if (left) log.warn({ left }, "drain timed out");
      process.exit(0);
    });
  });
reconcile = startLoops(p, log, () => refreshRegistry(p.cfg.git, repo.dir, repo.pushUrl));
// Preview deploys of open PRs on agents-org app repos and of open change requests on this server's (previews.ts): their own
// loop, with the code host's ops for GitHub repos and the read-only mount for local ones.
if (agentsOrg || codehost)
  startPreviews({ apps: p.apps, store: p.store, engine: p.engine, github: withLocal(codehost, agentsOrg ? githubApi(ops) : undefined), agentsRepo: (r) => inAgentsOrg(p.cfg.git, r) || isLocal(codehost, r), url: p.previewUrl, secretsDir: p.cfg.secretsDir, gitDir: p.cfg.git.gitDir, syncEdge: p.syncEdge, dropDb: p.dropPreviewDb, log });
// People across sources: identity links proposed on exact email matches (src_meta.person_identity).
startPeople(p.warehouse, log);

/** The PRs the kernel's records say the fleet opened in the last 90 days (GET /v1/objects?type=pr), as lowercase repo and number. */
async function fleetPrs(kernel: string, key: string): Promise<{ repo: string; number: number }[]> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const r = await fetch(`${kernel}/v1/objects?type=pr&since=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`the kernel said ${r.status}`);
  const refs = ((await r.json()) as { refs?: string[] }).refs ?? [];
  return refs.flatMap((ref) => {
    const m = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
    return m ? [{ repo: m[1]!.toLowerCase(), number: Number(m[2]) }] : [];
  });
}

/** The open GitHub PRs the kernel's records name (open-prs.ts recordedOpenPrs): state from the warehouse's row, `ready_at` from its last draft-to-ready change, and the code host's list for a repo the warehouse doesn't hold. */
async function githubOpenPrs(): Promise<OpenPr[]> {
  const ours = await fleetPrs(kernelUrl, serviceKey);
  if (!ours.length) return [];
  let rows: WarehouseRow[] = [];
  try {
    const r = await p.warehouse().pool.query(
      "SELECT i.repo, i.number, i.kind, i.state, i.created_at_src AS opened_at, i.draft, (SELECT max(c.observed_at) FROM src_github.changes c WHERE c.entity = 'issue' AND c.field = 'draft' AND c.new_value = 'false' AND c.entity_id = i.repo || '/' || i.number) AS ready_at FROM src_github.issues i JOIN unnest($1::text[], $2::int[]) AS o(repo, number) ON lower(i.repo) = o.repo AND i.number = o.number",
      [ours.map((o) => o.repo), ours.map((o) => o.number)],
    );
    rows = r.rows;
  } catch (e) {
    log.warn({ err: String(e) }, "open-prs: no warehouse rows for the fleet's PRs, asking the code host");
  }
  return (await recordedOpenPrs(ours, rows, (repo) => ops.read(repo, { kind: "prs" }), ops.pr)).map((x) => ({ ...x, ...previewOf(x.repo, x.number) }));
}

/** The URL of a running preview of `repo`'s change or PR `n`, as the board's open-PR rows show it. */
function previewOf(repo: string, n: number): { preview_url?: string } {
  const app = p.apps().find((a) => a.repo.toLowerCase() === repo.toLowerCase() && !a.module);
  const row = app && p.store.previews().find((r) => r.name === previewName(app.name, n) && r.status === "healthy");
  const url = app && row ? p.previewUrl(previewApp(app, n, row.port)) : undefined;
  return url ? { preview_url: url } : {};
}

/** The open change requests of every repo on this server, in the open-PR rows' shape. */
async function localOpenPrs() {
  const out = [];
  for (const repo of localRepos(codehost!, (d) => readdirSync(d)))
    for (const c of (await localChanges(codehost!, repo).catch(() => [])).filter((x) => x.state === "open"))
      out.push({ repo, number: c.number, opened_at: c.opened_at, draft: c.draft, ...previewOf(repo, c.number) });
  return out;
}

/** Named change requests' state from their refs, in the warehouse rows' shape (a merged one is closed with merged_at). */
async function localStates(refs: RegExpExecArray[]) {
  const out = [];
  for (const m of refs) {
    const c = (await localChanges(codehost!, m[1]!).catch(() => [])).find((x) => x.number === Number(m[2]));
    if (c) out.push({ repo: c.repo, number: c.number, state: c.state === "open" ? "open" : "closed", merged_at: c.state === "merged" ? c.closed_at : null, closed_at: c.state === "open" ? null : c.closed_at });
  }
  return out;
}
