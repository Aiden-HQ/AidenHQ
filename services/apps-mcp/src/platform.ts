// Shared wiring: registry, engine, health probe, status rows, incident webhook.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { provisionDatabase, WAREHOUSE } from "./database.js";
import { createEngine, type Engine } from "./deploy.js";
import { apiTarget, SEND_SCRIPT, targetContainer, TIMEOUT_MS, type ApiRequest, type Resolve, type Send } from "./api.js";
import { AGENT_TIMEOUT_MS, CHECK_SCRIPT, CHECK_TIMEOUT_MS, agentProbeScope, judgeAgent, judgePage, plan, probeResult, type Declared, type Kind, type PageFacts, type ProbeResult } from "./checks.js";
import { MANIFEST_FILE, parseManifest } from "./manifest.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { RENDER_TIMEOUT_MS, renderArgs, VIEW_IMAGE, VIEW_SCRIPT, type Lookup, type Render, type ViewResult } from "./view.js";
import { checkout, commitMessage, diffForDeploy, resolveCommit, show, type GitEnv } from "./git.js";
import { loadRegistry, type App } from "./registry.js";
import { pickService, scriptCommand } from "./run.js";
import { posix } from "node:path";
import { openStore, type Store } from "./store.js";
import { EDGE_CONTAINER, edgeTarget, exposes, writeServeConfig, type EdgeTarget } from "./tailnet.js";
import { agentSigner, IDENTITY_HEADER } from "./identity.js";
import { readonlyPool, type WarehouseDeps } from "./sources.js";
import { parseChecks, PROBE, withoutSamples, type Quality } from "./quality.js";

const run = promisify(execFile);

export interface PlatformConfig {
  registryPath: string;
  modulesRegistryPath: string;
  appsData: string;
  secretsDir: string;
  hostSecretsDir: string;
  identityKeyFile: string; // apps-mcp's Ed25519 key (vault identity/apps.pem): agents' identity at apps (identity.ts)
  identityKeysHostFile: string; // the public keys.json as the Docker daemon sees it: mounted into every app
  dbPath: string;
  urlBase: string; // https://aidenhq-apps.<tailnet>.ts.net: the apps' own tailnet node, never the board's host
  edgeDir: string; // the apps node's serve config dir (tailnet.ts)
  healthImage: string;
  git: GitEnv;
  webhookDir?: string; // holds apps_incident_webhook_url and _secret
}

export function createPlatform(cfg: PlatformConfig, log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void }) {
  const sign = agentSigner(cfg.identityKeyFile);
  const store = openStore(cfg.dbPath);
  const apps = (): App[] => loadRegistry(cfg.registryPath, cfg.modulesRegistryPath);
  const find = (name: string): App => apps().find((a) => a.name === name) ?? (() => { throw new Error(`unknown app ${name}`); })();
  const healthy = new Map<string, boolean>();
  // Each app's quality checks from its last probe (quality.ts): findings only, never part of `healthy`.
  const quality = new Map<string, Quality>();
  const failures = new Map<string, string>(); // why each app's last failed health probe failed, when the app itself answered
  const cache = new Map<string, Awaited<ReturnType<typeof status>>>(); // last computed status per app: the health tick fills it
  const errors = new Map<string, string>(); // why the last reconcile of an app failed before anything started

  const exec: (args: string[], o?: { env?: Record<string, string>; input?: string; timeout?: number; both?: boolean }) => Promise<string> = async (args, o) => {
    try {
      const p = run("docker", args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("DOCKER_"))), ...o?.env }, maxBuffer: 50e6, timeout: o?.timeout ?? 900_000 });
      if (o?.input !== undefined) p.child.stdin?.end(o.input); // stdin, so SQL with a password never shows in argv
      const r = await p;
      return o?.both ? `${r.stdout}${r.stderr}` : r.stdout;
    } catch (err: any) {
      const e = new Error(`docker ${args.slice(0, 3).join(" ")} failed${err.killed ? " (timed out)" : ""}: ${String(err.stderr || err.message).trim().slice(-600)}`);
      throw Object.assign(e, { stdout: String(err.stdout ?? ""), killed: Boolean(err.killed), code: typeof err.code === "number" ? err.code : undefined });
    }
  };

  const probe = async (app: App): Promise<boolean> => {
      let ok: boolean;
      if (app.health.url) {
        const out = await exec(["run", "--rm", "--pull", "never", "--network", `app-${app.name}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "64m", cfg.healthImage, "node", "-e", PROBE, app.health.url]).then(
          (o) => (failures.delete(app.name), o),
          (e) => {
            // The probe's own exit 2 with `HTTP <status>`: the app answered with an error (never app text: a status code only).
            const status = e.code === 2 ? /^HTTP ([45]\d\d)$/.exec(String(e.stdout).trim())?.[1] : undefined;
            if (status) failures.set(app.name, `health answered HTTP ${status}`);
            else failures.delete(app.name);
            return undefined;
          },
        );
        ok = out !== undefined;
        // Down: its checks weren't evaluated (unknown keeps their findings open; the outage is the availability incident's).
        quality.set(app.name, out !== undefined ? parseChecks(out) : { state: "unknown", why: "the health check failed" });
      } else ok = await engine.containersHealthy(app);
      healthy.set(app.name, ok);
      return ok;
    };

  const engine: Engine = createEngine({
    exec,
    store,
    appsData: cfg.appsData,
    secretsDir: cfg.secretsDir,
    hostSecretsDir: cfg.hostSecretsDir,
    identityKeysHostFile: cfg.identityKeysHostFile,
    checkout: (app, sha) => checkout(cfg.git, app, sha),
    probe: (app) => probe(app),
    check: (app, declared) => checkApp(app, declared),
    expose: () => syncEdge().catch((err) => log.warn({ err: String(err) }, "apps node sync failed")),
    // Over the Docker socket as the superuser (local socket auth inside the container): no network path or password needed.
    provisionDb: (app) => provisionDatabase(app, { secretsDir: cfg.secretsDir, sql: (q) => exec(["exec", "-i", WAREHOUSE.container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "warehouse", "-d", WAREHOUSE.db], { input: q }).then(() => undefined) }),
  });

  /**
   * The apps' tailnet node (tailnet.ts): serves exactly the exposed, once-healthy local apps, joins each one's own network
   * and leaves the networks of the rest (before reap's `compose down`, which can't remove a network the node is on).
   */
  async function syncEdge(): Promise<void> {
    const want = new Map<string, EdgeTarget>();
    for (const app of apps()) {
      if (!exposes(app) || app.host !== "local" || !store.goodDeploys(app.name).length) continue;
      const t = engine.deployed(app) ? edgeTarget(app, engine.compose(app)) : undefined;
      if (t) want.set(`app-${app.name}`, t);
    }
    writeServeConfig(cfg.edgeDir, [...want.values()]);
    const joined = Object.keys(JSON.parse(await exec(["inspect", EDGE_CONTAINER, "--format", "{{json .NetworkSettings.Networks}}"])) ?? {}).filter((n) => n.startsWith("app-"));
    const changes = [
      ...joined.filter((n) => !want.has(n)).map((n) => ["disconnect", n]),
      ...[...want.keys()].filter((n) => !joined.includes(n)).map((n) => ["connect", n]),
    ];
    for (const [op, net] of changes) await exec(["network", op!, net!, EDGE_CONTAINER]).catch((err) => log.warn({ net, err: String(err) }, `apps node network ${op} failed`));
  }

  const url = (app: App): string | undefined => (app.share?.host ? `https://${app.share.host}` : exposes(app) ? `${cfg.urlBase}:${app.port}` : undefined);

  async function status(app: App) {
    const last = store.lastDeploy(app.name);
    const inc = store.openIncident(app.name);
    const state = !last ? "not deployed" : last.status === "failed" ? "failed" : (healthy.get(app.name) ?? (await engine.containersHealthy(app).catch(() => false))) ? "healthy" : "unhealthy";
    const stats = last && last.status !== "failed" ? await engine.stats(app).catch(() => undefined) : undefined;
    return {
      name: app.name, repo: app.repo, healthy: state === "healthy", state, sha: last?.sha, deployed_at: last?.at, deployed_by: last?.by, auto_deploy: app.auto_deploy, owner: app.owner, url: url(app),
      // Recent deploys (newest first): who deployed which commit and how it ended, so a reader can check a merged commit was
      // deployed by the platform's own auto-deploy rather than by hand. Deep enough that a graded commit hasn't scrolled out.
      deploys: store.recentDeploys(app.name, 20).map(({ sha, at, by, status }) => ({ sha, at, by, status })),
      ...(inc ? { incident: { opened_at: inc.opened_at, kind: inc.kind, detail: inc.detail } } : {}),
      ...(stats ? { stats } : {}),
    };
  }

  // Before the first health tick the row is still identified (repo and auto_deploy), so a reader can match it to its app.
  const cached = (app: App) => cache.get(app.name) ?? { name: app.name, repo: app.repo, auto_deploy: app.auto_deploy, healthy: false, state: "unknown" };
  const refresh = async (app: App) => void cache.set(app.name, await status(app));

  /** Registry plus (cached) status, for the catalog. */
  async function listing() {
    return apps().map((a) => ({ name: a.name, description: a.description, owner: a.owner, repo: a.repo, url: url(a), access: a.access, stateful: a.stateful, sources: a.sources, connects: a.connects, status: cached(a).state }));
  }

  /** Wakes the DevOps Engineer: signed like slack-live's triage webhook. Skipped when the routine's secrets aren't mounted. */
  async function fire(app: string, kind: string, detail: string): Promise<boolean> {
    const read = (f: string) => (cfg.webhookDir && existsSync(`${cfg.webhookDir}/${f}`) ? readFileSync(`${cfg.webhookDir}/${f}`, "utf8").trim() : "");
    const [webhook, secret] = [read("apps_incident_webhook_url"), read("apps_incident_webhook_secret")];
    if (!webhook || !secret) return true; // not wired: nothing to retry
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ app, kind, detail: detail.slice(0, 200) });
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const res = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json", "x-paperclip-timestamp": ts, "x-paperclip-signature": `sha256=${sig}` }, body, signal: AbortSignal.timeout(15_000) }).catch((err) => log.warn({ err: String(err) }, "incident webhook failed"));
    if (res && ![202, 409].includes(res.status)) log.warn({ status: res.status }, "incident webhook failed");
    return !!res && [202, 409].includes(res.status);
  }

  /** Re-fires the webhook of open incidents it hasn't reached yet (each tick, until it succeeds). */
  async function notifyPending(): Promise<void> {
    for (const i of store.unnotified()) if (await fire(i.app, i.kind, i.detail)) store.markNotified(i.id);
  }

  /** Opens an incident unless one is already open (coalesced), and wakes the maintainer. */
  async function raise(app: string, kind: string, detail: string): Promise<void> {
    if (store.openIncident(app)) return;
    const id = store.addIncident(app, kind, detail.slice(0, 200));
    if (await fire(app, kind, detail)) store.markNotified(id);
  }

  // The commit a deploy card names, and what deploying it changes from the running commit.
  const commit = async (app: App, sha: string) => {
    const c = await resolveCommit(cfg.git, app, sha);
    // Only the app's own directory: that is all the deploy rebuilds. A diff that can't be read (too big, an object
    // missing) never blocks the card: it just can't be reviewed (Tier 2).
    return { ...c, ...(await diffForDeploy(cfg.git, app, store.lastDeploy(app.name)?.sha, c.sha).catch(() => ({ diff: "", truncated: true }))) };
  };

  /** What an app_run would run now: the healthy deployed commit, the service, and the script's command at that commit. */
  async function runPlan(app: App, script: string, service?: string): Promise<{ sha: string; service: string; command: string }> {
    const last = store.lastDeploy(app.name);
    if (!last || last.status !== "healthy") throw new Error(`${app.name} isn't running a healthy deploy (${last?.status ?? "not deployed"})`);
    const command = scriptCommand(await show(cfg.git, app, last.sha, posix.join(app.path, "package.json")), script);
    const svc = pickService(engine.services(app), service);
    return { sha: last.sha, service: svc, command };
  }
  /** app_api's transport: a one-shot container on the app's network (like the probe); the request, bearer included, goes on stdin, never argv. */
  /** status 0: the request got no answer (body: why). Throws only when the container couldn't run. */
  const sendRaw = async (req: ApiRequest, container: string): Promise<{ status: number; body: string }> => {
    if (!/^[0-9a-f]{64}$/.test(container)) throw new Error("bad container id");
    const out = await exec(["run", "--rm", "-i", "--pull", "never", "--network", `container:${container}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", cfg.healthImage, "node", "-e", SEND_SCRIPT], { input: JSON.stringify(req), timeout: (req.timeout ?? TIMEOUT_MS) + 15_000 });
    return JSON.parse(out) as { status: number; body: string };
  };
  const sendApi: Send = async (_app, req, container) => {
    const r = await sendRaw(req, container);
    if (!r.status) throw new Error(r.body);
    return r;
  };
  /** app_api's target lookup by compose labels (api.ts targetContainer re-checks them on the full id). */
  const resolveApi: Resolve = async (app, service) => ({
    ids: await exec([...(app.host === "local" ? [] : ["--context", app.host]), "ps", "-q", "--filter", `label=com.docker.compose.project=app-${app.name}`, "--filter", `label=com.docker.compose.service=${service}`, "--filter", `network=app-${app.name}`]),
    inspect: (id) => exec([...(app.host === "local" ? [] : ["--context", app.host]), "inspect", id]),
  });
  const auditApi = (o: object) => log.info(o, "app_api"); // who called which app path, and the status; never bodies or the token

  // app_view / web_view: at most two renders at once; the pinned image is pulled once (it is ~1 GB, so never inside a render).
  let renders = 0;
  const queue: (() => void)[] = [];
  let pulled: Promise<unknown> | undefined;
  const ensureImage = () => (pulled ??= exec(["image", "inspect", VIEW_IMAGE]).catch(() => exec(["pull", "-q", VIEW_IMAGE], { timeout: 600_000 })).catch((e) => { pulled = undefined; throw e; }));
  /** One run of a renderer script (view.ts's image and hardening) on a docker network: its stdout. */
  const renderWith = async (network: string, script: string, input: object, timeout: number): Promise<string> => {
    await ensureImage();
    if (renders >= 2) await new Promise<void>((ok) => queue.push(ok));
    renders++;
    const name = `aidenhq-view-${randomBytes(6).toString("hex")}`;
    try {
      const args = renderArgs(network, VIEW_IMAGE, script);
      args.splice(1, 0, "--name", name);
      return await exec(args, { input: JSON.stringify(input), timeout });
    } catch (e) {
      await exec(["rm", "-f", name]).catch(() => undefined); // a killed `docker run` leaves its container running
      throw e;
    } finally {
      renders--;
      queue.shift()?.();
    }
  };
  const render: Render = async (network, req) => {
    const r = JSON.parse(await renderWith(network, VIEW_SCRIPT, req, RENDER_TIMEOUT_MS)) as ViewResult;
    if (r.error) throw new Error(r.error);
    return r;
  };

  /**
   * The render and agent probes (checks.ts) on a deployed local app, from inside its own container's network namespace like
   * app_view and app_api. A probe that can't run (remote host, renderer or Docker trouble) is a warning, never a failure.
   */
  async function checkApp(app: App, declared: Declared): Promise<ProbeResult[]> {
    const p = plan(app, declared);
    const all: [Kind, string][] = [...p.render.map((x): [Kind, string] => ["render", x.path]), ...p.agent.map((x): [Kind, string] => ["agent", x.path])];
    const skip = (why: string) => all.map(([k, path]) => probeResult(k, path, [{ hard: false, what: `not checked: ${why}` }]));
    if (!all.length) return [];
    if (app.host !== "local") return skip(`${app.name} runs on docker context ${app.host}`);
    if (!app.health.url) return skip("no health.url names the service and port");
    const t = apiTarget(app);
    const container = await targetContainer(app, t.service, resolveApi);
    const base = `${t.protocol}//127.0.0.1${t.port ? `:${t.port}` : ""}`;
    const out: ProbeResult[] = [];
    // The renderer image (~1 GB) is never pulled inside a deploy: absent, the render probes are skipped and it is pulled
    // in the background for next time.
    const haveImage = p.render.length ? await exec(["image", "inspect", VIEW_IMAGE]).then(() => true, () => false) : false;
    if (p.render.length && !haveImage) {
      void ensureImage().catch(() => undefined);
      out.push(...p.render.map((x) => probeResult("render", x.path, [{ hard: false, what: "not checked: the renderer image is being pulled (try app_check in a few minutes)" }])));
    }
    if (p.render.length && haveImage) {
      const secret = sign(app.name, "deploy-check", { role: "member", methods: ["GET", "HEAD"] });
      const headers = { [IDENTITY_HEADER]: secret };
      let facts: { pages: PageFacts[]; error?: string } = { pages: [] };
      try {
        const raw = await renderWith(`container:${container}`, CHECK_SCRIPT, { pages: p.render.map((x) => ({ path: x.path, url: base + x.path })), headers }, CHECK_TIMEOUT_MS + 10_000);
        facts = JSON.parse(raw.replaceAll(secret, "***"));
      } catch (e) {
        facts = { pages: [], error: String((e as Error).message ?? e) };
      }
      for (const x of p.render) {
        const f = facts.pages.find((g) => g.path === x.path);
        out.push(probeResult("render", x.path, f ? judgePage(f, x.declared) : [{ hard: false, what: `not checked: the renderer didn't finish${facts.error ? ` (${facts.error.slice(0, 120)})` : ""}` }]));
      }
    }
    for (const x of p.agent) {
      if (!app.api) {
        out.push(probeResult("agent", x.path, [{ hard: true, what: "checks.agent is declared but the app has no agent API (api: in the registry)" }]));
        continue;
      }
      let token: string;
      try {
        token = sign(app.name, "deploy-check", agentProbeScope(app, x.path));
      } catch (e) {
        out.push(probeResult("agent", x.path, [{ hard: true, what: String((e as Error).message) }]));
        continue;
      }
      const req: ApiRequest = { url: base + x.path, method: "GET", headers: { [IDENTITY_HEADER]: token, accept: "application/json" }, timeout: AGENT_TIMEOUT_MS };
      const r = await sendRaw(req, container).catch(() => ({ status: -1, body: "" }));
      out.push(probeResult("agent", x.path, r.status < 0 ? [{ hard: false, what: "not checked: the probe container didn't run" }] : judgeAgent(r, x.declared)));
    }
    return out;
  }

  /**
   * app_check: the probes now, with the running commit's declared paths (its manifest; unreadable: the inferred ones). The
   * caller picks only the app: the probes and their identity are the deploy's own (agentProbeScope), whoever asks.
   */
  async function checkNow(app: App): Promise<ProbeResult[]> {
    const sha = store.running(app.name);
    const text = sha ? await show(cfg.git, app, sha, posix.join(app.path, MANIFEST_FILE)).catch(() => undefined) : undefined;
    let declared: Declared = {};
    try {
      declared = parseManifest(text).checks ?? {};
    } catch {}
    return engine.check(app, declared);
  }
  const lookup: Lookup = (host) => dnsLookup(host, { all: true });
  const auditView = (o: object) => log.info(o, "view");
  // Agents' warehouse reads (sources.ts): the readonly login, opened on first use (the warehouse may deploy after us).
  let roPool: ReturnType<typeof readonlyPool>;
  const warehouse = (): WarehouseDeps => {
    roPool ??= readonlyPool(cfg.secretsDir);
    if (!roPool) throw new Error("the warehouse isn't set up (no apps/warehouse/READONLY_PASSWORD in the vault)");
    return {
      pool: roPool,
      sql: (script, vars) => exec(["exec", "-i", WAREHOUSE.container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-U", "warehouse", "-d", WAREHOUSE.db], { input: script }),
    };
  };
  /** Why the app's last health probe failed when the app answered with an HTTP error (post-deploy watch evidence), else undefined. */
  const healthFailure = (app: App): string | undefined => failures.get(app.name);
  /** A deployed commit whose message carries a `No-Auto-Rollback:` trailer (a security fix): the watch only raises it. Unreadable counts as marked. */
  const noAutoRollback = async (app: App, sha: string): Promise<boolean> =>
    commitMessage(cfg.git, app, sha).then((m) => /^no-auto-rollback(?::|\s*$)/im.test(m), (err) => (log.warn({ app: app.name, err: String(err) }, "commit message unreadable"), true));
  /** An app's quality checks from its last probe, samples included (app_status, for a caller who may read the app). */
  const qualityFor = (a: App): Quality => quality.get(a.name) ?? { state: "unknown", why: "not probed yet" };
  /** Every probed app's checks without samples (the board's detector raises the failing ones; samples never leave here). */
  const qualityOf = () => apps().filter((a) => a.health.url).map((a) => ({ name: a.name, ...withoutSamples(qualityFor(a)) }));
  return { healthFailure, noAutoRollback, sign, checkNow, qualityOf, qualityFor, syncEdge, warehouse, render, lookup, auditView, auditApi, resolveApi, sendApi, runPlan, store, engine, probe, apps, find, status, cached, refresh, errors, listing, raise, notifyPending, cfg, commit };
}
export type Platform = ReturnType<typeof createPlatform>;
