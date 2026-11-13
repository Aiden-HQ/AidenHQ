// apps-mcp: deploys and runs sandboxed apps from the git registry; MCP over streamable HTTP, identified by Paperclip agent keys.
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statfsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { makeAuthorize } from "./agent-auth.js";
import { startLoops } from "./loops.js";
import { startPeople } from "./people.js";
import { appTokens, readAgentsOrg, readOrgs } from "./github-app.js";
import { buildServer, type Board } from "./mcp.js";
import { RUN_TIMEOUT_MS } from "./run.js";
import { createPlatform } from "./platform.js";
import { posix } from "node:path";
import { show } from "./git.js";
import { MANIFEST_FILE, parseManifest } from "./manifest.js";
import { graderView } from "./view.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "apps-mcp" }, redact: ["authorization", "*.authorization", "token", "*.token"] });
const need = (n: string): string => process.env[n] || (() => { throw new Error(`${n} is required`); })();
const file = (n: string): string => (process.env[`${n}_FILE`] ? readFileSync(process.env[`${n}_FILE`]!, "utf8").trim() : "");

const repoDir = need("REPO_DIR");
// The instance repo: holds apps.yaml (agent-created apps), committed and pushed (GitHub App token, else the deploy key).
const instanceDir = need("INSTANCE_DIR");
const appsData = need("APPS_DATA");
const internalToken = file("APPS_INTERNAL_TOKEN");
if (!internalToken) throw new Error("APPS_INTERNAL_TOKEN(_FILE) is required");
const tokenFile = process.env.GITHUB_TOKEN_FILE;
// The agents org is always allowed; its private repos are read with the instance's GitHub App when its key is mounted.
const agentsOrg = readAgentsOrg(instanceDir);
const orgs = readOrgs(instanceDir);
const appToken = appTokens(process.env.GITHUB_APP_DIR ?? "/secrets/github-app");

const p = createPlatform(
  {
    registryPath: `${instanceDir}/apps.yaml`,
    modulesRegistryPath: `${repoDir}/config/apps.modules.yaml`,
    appsData,
    secretsDir: process.env.APPS_SECRETS_DIR ?? "/secrets/apps",
    hostSecretsDir: need("APPS_HOST_SECRETS_DIR"),
    identityKeyFile: process.env.IDENTITY_KEY_FILE ?? "/secrets/identity_key",
    identityKeysHostFile: need("IDENTITY_KEYS_HOST_FILE"),
    dbPath: process.env.APPS_DB ?? "/data/apps-mcp.sqlite",
    urlBase: process.env.APPS_URL_BASE ?? "",
    edgeDir: process.env.APPS_EDGE_DIR ?? "/edge",
    healthImage: process.env.APPS_HEALTH_IMAGE ?? "aidenhq/apps-mcp:local",
    git: { appsData, gitDir: "/data/git", productDir: repoDir, ...(tokenFile ? { tokenFile } : {}), orgs, ...(agentsOrg ? { agentsOrg } : {}), ...(appToken ? { appToken } : {}), sshCommand: "ssh -i /secrets/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts" },
    webhookDir: "/run/secrets",
  },
  log,
);
// Who is calling, and may it use this tool: the run key against the grants table.
const authorize = makeAuthorize({ log });
// With the GitHub App, the registry is pulled and pushed over https with repo-narrowed App tokens (git.ts registryCmd);
// without it, the instance checkout's origin remote over SSH with the deploy key.
const repo = { dir: instanceDir, pushUrl: process.env.REGISTRY_PUSH_URL || (appToken && agentsOrg ? `https://github.com/${agentsOrg}/aidenhq-instance.git` : "origin") };

// app_run cards are filed on the board's internal API with the apps token (the board holds it too; agents don't).
const boardUrl = (process.env.BOARD_URL ?? "http://board:3122").replace(/\/$/, "");
// In-app requests and app roles (app_requests, app_role_set…) go the same way, under /internal/apps/.
const board: Board = async (path, req) => {
  const res = await fetch(`${boardUrl}/internal/apps/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${internalToken}` }, body: JSON.stringify(req), signal: AbortSignal.timeout(30_000) }).catch((e: Error) => {
    throw new Error(`the board is unreachable (${e.message})`);
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`board: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

/** An approved app_run: rechecked against the approved commit (and the script at it), then run once. Never throws. */
async function runApproved(b: any): Promise<{ ok: boolean; timed_out: boolean; output: string }> {
  try {
    const a = p.find(String(b?.name ?? ""));
    const plan = await p.runPlan(a, String(b?.script ?? ""), String(b?.service ?? ""));
    if (plan.sha !== b.sha) throw new Error(`${a.name} was redeployed (now ${plan.sha.slice(0, 12)}, approved ${String(b.sha).slice(0, 12)}); file a new request`);
    log.info({ app: a.name, script: b.script, approval: b.approval }, "app_run");
    return await p.engine.run(a, { script: b.script, service: plan.service, timeoutMs: RUN_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, timed_out: false, output: `refused: ${(err as Error).message}` };
  }
}

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
const internalAuthorized = (req: IncomingMessage): boolean => {
  const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(internalToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

// Nothing is published to the host: only containers on the compose network reach this port. /internal/* is the board's and
// watcher's API; the one write (a stateful deploy, already approved in chat) needs the internal token, which agents don't have.
let reconcile: () => Promise<void> = async () => undefined; // set once the loops start
const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname === "/internal/status" && req.method === "GET") return send(res, 200, p.apps().map((a) => p.cached(a)));
    if (url.pathname === "/internal/host" && req.method === "GET") {
      const f = statfsSync("/data"); // the host disk that holds the apps' data
      return send(res, 200, { disk_pct: Math.round((1 - Number(f.bavail) / Number(f.blocks)) * 100) });
    }
    if (url.pathname === "/internal/apps" && req.method === "GET") return send(res, 200, await p.listing());
    // Each source's last good pass and whether its latest pass failed (the board's Fleet Ops detector; never the error text,
    // which agents read with warehouse_query). No sources until the warehouse is set up.
    if (url.pathname === "/internal/sources" && req.method === "GET") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      let d;
      try {
        d = p.warehouse();
      } catch {
        return send(res, 200, {});
      }
      const r = await d.pool.query(
        "SELECT source, max(finished_at) FILTER (WHERE error IS NULL) AS last_ok, (array_agg(error IS NOT NULL ORDER BY finished_at DESC))[1] AS failing FROM src_meta.ingest_run GROUP BY source",
      );
      return send(res, 200, { sources: r.rows });
    }
    // Each app's quality checks from its last health probe (quality.ts): name, ok and count only, never samples (app data,
    // read through app_status by a caller who may read the app). The board's detector raises the failing ones for Fleet Ops.
    if (url.pathname === "/internal/quality" && req.method === "GET") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, { apps: p.qualityOf() });
    }
    // Open pull requests in the agents org's repos, from the warehouse (src_github syncs every 15 minutes): the board's Fleet Ops
    // detector raises the ones nobody has merged. Empty when there is no agents org or no warehouse yet.
    if (url.pathname === "/internal/open-prs" && req.method === "GET") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      let d;
      try {
        d = p.warehouse();
      } catch {
        return send(res, 200, {});
      }
      if (!agentsOrg) return send(res, 200, {});
      const r = await d.pool.query("SELECT repo, number, created_at_src AS opened_at FROM src_github.issues WHERE kind = 'pr' AND state = 'open' AND lower(repo) LIKE $1", [`${agentsOrg.toLowerCase()}/%`]);
      return send(res, 200, { prs: r.rows });
    }
    // Named pull requests' state from the warehouse (`?pr=owner/repo#12`, up to 100): the board's event wake-ups (wake.ts) wake
    // the agent waiting on one when it merges or closes. Empty when there is no warehouse yet.
    if (url.pathname === "/internal/pr-states" && req.method === "GET") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      const refs = url.searchParams.getAll("pr").slice(0, 100).map((r) => /^([\w.-]+\/[\w.-]+)#(\d{1,9})$/.exec(r)).filter((m) => m !== null);
      let d;
      try {
        d = p.warehouse();
      } catch {
        return send(res, 200, {});
      }
      if (!refs.length) return send(res, 200, { prs: [] });
      const r = await d.pool.query(
        "SELECT i.repo, i.number, i.state, i.merged_at, i.closed_at FROM src_github.issues i JOIN unnest($1::text[], $2::int[]) AS want(repo, number) ON lower(i.repo) = lower(want.repo) AND i.number = want.number WHERE i.kind = 'pr'",
        [refs.map((m) => m[1]), refs.map((m) => Number(m[2]))],
      );
      return send(res, 200, { prs: r.rows });
    }
    // The exact commit a deploy approval names (full sha + subject), on the app's branch; 400 when there's no such commit.
    if (url.pathname === "/internal/commit" && req.method === "GET") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      const name = url.searchParams.get("name") ?? "";
      return send(res, 200, await p.commit(p.find(name), url.searchParams.get("sha") ?? "").catch((err: Error) => ({ error: err.message })));
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
    // The grader's live view of one page of a deployed app (the runner, through the board): view.ts graderView.
    if (url.pathname === "/internal/view" && req.method === "POST") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      return send(res, 200, await graderView(p.find(String(b?.name ?? "")), { path: b?.path, width: b?.width }, { resolve: p.resolveApi, render: p.render, sign: p.sign, running: p.store.running, audit: p.auditView }));
    }
    if (url.pathname === "/internal/deploy" && req.method === "POST") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      if (!b?.name || !b.by || !b.approved_comment_id) return send(res, 400, { error: "name, by and approved_comment_id are required" });
      return send(res, 200, await p.engine.deploy(p.find(b.name), { sha: b.sha, by: `${b.by} (approved in ${b.approved_comment_id})`, allowStateful: true }));
    }
    // An approved app_run (the board, after the owner's tap): rechecked against the approved commit, run once.
    if (url.pathname === "/internal/run" && req.method === "POST") {
      if (!internalAuthorized(req)) return send(res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      // A run can outlast fetch's 5-minute header and body timeouts: headers now, a space every 30s, then the JSON.
      res.writeHead(200, { "content-type": "application/json" });
      const beat = setInterval(() => res.write(" "), 30_000);
      try {
        res.end(JSON.stringify(await runApproved(b)));
      } finally {
        clearInterval(beat);
      }
      return;
    }
    if (url.pathname !== "/mcp") return send(res, 404);
    if (req.method !== "POST") return send(res, 405);
    const body = await readBody(req);
    // Only the handshake and tool listing run without identity; every tool call needs a known agent granted that tool.
    const auth = await authorize(req, body);
    if (!auth.ok) return send(res, auth.status, auth.body);
    const caller = auth.caller ?? { id: "", key: "", name: "anonymous", roles: [], tools: {} };
    const server = buildServer(p, caller, repo, reconcile, board);
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
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => http.close(() => process.exit(0)));
reconcile = startLoops(p, log);
// People across sources: identity links proposed on exact email matches (src_meta.person_identity).
startPeople(p.warehouse, log);
