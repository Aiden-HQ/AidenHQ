// Shared wiring: registry, engine, health probe, status rows, incident webhook.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dropPreviewDatabase, provisionDatabase, WAREHOUSE } from "./database.js";
import { createEngine, type Engine, type ProbeOutcome } from "./deploy.js";
import { apiTarget, SEND_SCRIPT, targetContainer, TIMEOUT_MS, type ApiRequest, type Resolve, type Send } from "./api.js";
import { AGENT_TIMEOUT_MS, CHECK_SCRIPT, CHECK_TIMEOUT_MS, agentProbeScope, identityProbeArgs, identityDoors, mergeScans, noHttpSurface, processUids, identityPorts, identityProbes, unprobedServices, judgeAgent, judgePage, plan, probeResult, type Declared, type Kind, type PageFacts, type PortAnswers, type ProbeResult } from "./checks.js";
import { MANIFEST_FILE, parseManifest } from "./manifest.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { BROWSER_IMAGE, CANARY_NETWORK, RENDER_TIMEOUT_MS, renderArgs, VIEW_SCRIPT, type Lookup, type Render, type ViewResult } from "./view.js";
import { checkout, checkoutPr, commitMessage, diffForDeploy, resolveCommit, show, type GitEnv } from "./git.js";
import { loadRegistry, type App } from "./registry.js";
import { pickService, scriptCommand } from "./run.js";
import { posix } from "node:path";
import { openStore, type Store } from "./store.js";
import { EDGE_CONTAINER, edgeTarget, exposes, tailnetNode, writeServeConfig, type EdgeTarget } from "./tailnet.js";
import { agentSigner, forgedIdentity, IDENTITY_HEADER, memberScope } from "./identity.js";
import { readonlyPool, type WarehouseDeps } from "./sources.js";
import { parseChecks, probeFailure, PROBE, withoutSamples, type Quality } from "./quality.js";
import { previewApp } from "./previews.js";
import { certificates, doorHost, doorIp, doorUrl, NO_DOOR, WAITING_FOR_NODE, NOT_SERVED, readDoor, tlsCheck, WAITING_FOR_CERTIFICATE, type TlsCheck } from "./doors.js";

const run = promisify(execFile);

/** Writes a file other services read, when it changed; atomic (a reader never sees half of it). */
function writeAtomic(file: string, text: string): void {
  try {
    if (readFileSync(file, "utf8") === text) return;
  } catch {}
  writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
  renameSync(`${file}.tmp`, file);
}

export interface PlatformConfig {
  registryPath: string;
  modulesRegistryPath: string;
  appsData: string;
  secretsDir: string;
  hostSecretsDir: string;
  identityKeyFile: string; // apps-mcp's Ed25519 key (vault identity/apps.pem): agents' identity at apps (identity.ts)
  identityKeysHostFile: string; // the public keys.json as the Docker daemon sees it: mounted into every app
  dbPath: string;
  urlBase: string; // https://aidenhq-apps.<tailnet>.ts.net: the apps' own tailnet node, never the board's host; "" on no tailnet (loopback)
  edgeDir: string; // the apps node's serve config dir (tailnet.ts)
  healthImage: string; // apps-mcp's own image (self-image.ts): helper containers run in it
  git: GitEnv;
  webhookDir?: string; // holds apps_incident_webhook_url and _secret
  gateFile?: string; // the gate's compiled config (config/gate.json): its `previews` turns on shared apps' previews
  appsNodeFile?: string; // config/apps-node (compile): `tailnet` when the apps' tailnet node is the instance's door (tailnet.ts tailnetNode)
  previewsFile?: string; // which shared apps' previews run, for the gate (scripts/edge.ts PREVIEWS_FILE)
  doorsFile?: string; // which apps the gate's doors serve, on which loopback port (doors.ts), beside the previews file
  /** Tells the owner one thing needs them (a `decision` notice, de-duplicated by `key`): the kernel's /v1/notify. */
  notify?: (text: string, key: string) => Promise<void>;
  /** The apps node's `tailscale status --json` (tests stub it). */
  nodeStatus?: () => Promise<{ BackendState?: string; AuthURL?: string }>;
  tlsCheck?: TlsCheck; // a public door's certificate check (doors.ts); tests stub it
}

/**
 * Whether an incident webhook reached the DevOps Engineer: only a routine run with a task (made, or coalesced into an open one).
 * Paperclip answers 202 even when it made none (a failed run, e.g. "Agent is not invokable in its current state"; an ignored
 * delivery) and 409 while the routine is paused; each is fired again on the next tick until a task carries it.
 */
export const fireReached = (status: number, run: unknown): boolean => {
  const r = run as { status?: string; linkedIssueId?: string | null } | undefined;
  return status === 202 && !!r?.linkedIssueId && r.status !== "failed";
};

export function createPlatform(cfg: PlatformConfig, log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void }) {
  const sign = agentSigner(cfg.identityKeyFile);
  const store = openStore(cfg.dbPath);
  const apps = (): App[] => loadRegistry(cfg.registryPath, cfg.modulesRegistryPath);
  const find = (name: string): App => apps().find((a) => a.name === name) ?? (() => { throw new Error(`unknown app ${name}`); })();
  const healthy = new Map<string, boolean>();
  // Each app's quality checks from its last probe (quality.ts): findings only, never part of `healthy`.
  const quality = new Map<string, Quality>();
  // Why each app's last failed health probe failed (a class, or `health answered HTTP <status>`), and whether the app itself
  // answered: the only failure the post-deploy watch rolls back on (loops.ts).
  const failures = new Map<string, { why: string; appSide: boolean }>();
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

  // Over the Docker socket as the warehouse superuser (local socket auth inside the container): no network path or password.
  const superSql = (q: string) => exec(["exec", "-i", WAREHOUSE.container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "warehouse", "-d", WAREHOUSE.db], { input: q }).then(() => undefined);
  const dropPreviewDb = (name: string) => superSql(dropPreviewDatabase(name));

  /**
   * One health probe: healthy or not, and how long it took. A failed probe always records why, as a class from the closed set
   * (quality.ts probeFailure): a refused connection, a DNS failure, a helper that never started and a timeout no longer read
   * as the same silent non-answer. Exit 2 keeps `health answered HTTP <status>`, the app's own answer.
   */
  const probe = async (app: App): Promise<ProbeOutcome> => {
    const started = Date.now();
    let ok: boolean;
    try {
      if (app.health.url) {
        const out = await exec(["run", "--rm", "--pull", "never", "--network", `app-${app.name}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "64m", cfg.healthImage, "node", "-e", PROBE, app.health.url]).then(
          (o) => (failures.delete(app.name), o),
          (e: any) => {
            // The probe's own exit 2 with `HTTP <status>`: the app answered with an error (never app text: a status code only).
            const status = e.code === 2 ? /^HTTP ([45]\d\d)$/.exec(String(e.stdout).trim())?.[1] : undefined;
            if (status) failures.set(app.name, { why: `health answered HTTP ${status}`, appSide: true });
            else failures.set(app.name, { why: probeFailure({ stdout: e.stdout, exit: e.code, killed: e.killed }), appSide: false });
            return undefined;
          },
        );
        ok = out !== undefined;
        // Down: its checks weren't evaluated (unknown keeps their findings open; the outage is the availability incident's).
        quality.set(app.name, out !== undefined ? parseChecks(out) : { state: "unknown", why: "the health check failed" });
      } else {
        failures.delete(app.name); // a class recorded for an earlier url isn't this app's reason
        ok = await engine.containersHealthy(app);
      }
    } catch (err) {
      // The probe couldn't run at all (docker failed before it printed): a platform fault, still a class.
      if (app.health.url) failures.set(app.name, { why: probeFailure({}), appSide: false });
      log.warn({ app: app.name, err: String(err) }, "health probe failed");
      ok = false;
    }
    healthy.set(app.name, ok);
    return { ok, ms: Date.now() - started };
  };

  /** Is the apps' tailnet node this instance's door now: configured (tailnet.ts tailnetNode) and logged in? Re-read on use. */
  const node = (): boolean => nodeConfigured() && nodeUp;
  const engine: Engine = createEngine({
    exec,
    store,
    appsData: cfg.appsData,
    secretsDir: cfg.secretsDir,
    hostSecretsDir: cfg.hostSecretsDir,
    identityKeysHostFile: cfg.identityKeysHostFile,
    tailnetNode: () => node(),
    checkout: (app, sha) => (app.preview ? checkoutPr(cfg.git, app, sha!) : checkout(cfg.git, app, sha)), // a preview: its PR head (previews.ts)
    probe: (app) => probe(app),
    probeFailure: (app) => healthFailure(app),
    check: (app, declared) => checkApp(app, declared),
    identity: (app) => identityCheck(app),
    expose: () => syncEdge().catch((err) => log.warn({ err: String(err) }, "apps node sync failed")),
    provisionDb: (app) => provisionDatabase(app, { secretsDir: cfg.secretsDir, sql: superSql }),
  });

  /**
   * The apps' tailnet node (tailnet.ts): serves exactly the exposed, once-healthy local apps, joins each one's own network
   * and leaves the networks of the rest (before reap's `compose down`, which can't remove a network the node is on).
   */
  async function syncEdge(): Promise<void> {
    const want = new Map<string, EdgeTarget>();
    const all = apps();
    await refreshNode(all.some((a) => exposes(a) && a.host === "local" && store.publishable(a.name))).catch((err) => log.warn({ err: String(err) }, "apps node login check failed"));
    // Healthy previews of served apps too (previews.ts), at their own ports.
    const previews = store.previews().flatMap((r) => {
      const parent = all.find((a) => a.name === r.app);
      return r.status === "healthy" && parent ? [previewApp(parent, r.pr, r.port)] : [];
    });
    // The gate's doors (doors.ts) first: the same apps the node would serve, at their registry port on the host's loopback.
    // Written before any app's generated Compose file is read, so a withheld app's door closes even when a Compose file
    // elsewhere is unreadable (a throw below must not leave a withdrawn route up).
    try {
      if (cfg.doorsFile) writeAtomic(cfg.doorsFile, `${JSON.stringify(Object.fromEntries(all.filter((a) => exposes(a) && a.host === "local" && store.publishable(a.name)).map((a) => [a.name, a.port])), null, 1)}\n`);
    } catch (err) {
      log.warn({ err: String(err) }, "doors file not written");
    }
    // Each app's own target, read one at a time: one unreadable Compose file must not keep the others from being served.
    for (const app of [...all, ...previews]) {
      if (!exposes(app) || app.host !== "local" || !store.publishable(app.name)) continue;
      let t: EdgeTarget | undefined;
      try {
        t = engine.deployed(app) ? edgeTarget(app, engine.compose(app)) : undefined;
      } catch (err) {
        log.warn({ app: app.name, err: String(err) }, "apps node target skipped");
      }
      if (t) want.set(`app-${app.name}`, t);
    }
    writeServeConfig(cfg.edgeDir, [...want.values()]);
    // The gate's view: shared apps' healthy previews and their loopback ports (it checks each against its own config).
    try {
      if (cfg.previewsFile) writeAtomic(cfg.previewsFile, `${JSON.stringify(Object.fromEntries(previews.filter((p) => p.share?.host).map((p) => [p.name, p.port])), null, 1)}\n`);
    } catch (err) {
      log.warn({ err: String(err) }, "previews file not written");
    }
    if (!node()) return; // no apps node container without Tailscale (compose profile off)
    const joined = Object.keys(JSON.parse(await exec(["inspect", EDGE_CONTAINER, "--format", "{{json .NetworkSettings.Networks}}"])) ?? {}).filter((n) => n.startsWith("app-"));
    const changes = [
      ...joined.filter((n) => !want.has(n)).map((n) => ["disconnect", n]),
      ...[...want.keys()].filter((n) => !joined.includes(n)).map((n) => ["connect", n]),
    ];
    for (const [op, net] of changes) await exec(["network", op!, net!, EDGE_CONTAINER]).catch((err) => log.warn({ net, err: String(err) }, `apps node network ${op} failed`));
  }

  /**
   * The apps' tailnet node is a door only once it is logged in (`tailscale status` BackendState Running): until then apps
   * require a signed identity, as without a node. A node with no join key signs in once: when an app is served and it says
   * NeedsLogin, the owner gets a generic decision, and its login link (a bearer secret: whoever opens it can put the node on
   * their own tailnet) is shown only on the board's Apps page, behind the owner's sign-in (/internal/apps-node).
   */
  let nodeUp = false;
  let nodeLogin: string | undefined;
  let askedLogin = false;
  const nodeConfigured = (): boolean => tailnetNode(cfg.appsNodeFile, cfg.urlBase);
  const nodeStatus = cfg.nodeStatus ?? (async () => JSON.parse(await exec(["exec", EDGE_CONTAINER, "tailscale", "--socket=/tmp/tailscaled.sock", "status", "--json"])) as { BackendState?: string; AuthURL?: string });
  async function refreshNode(needed: boolean): Promise<void> {
    if (!nodeConfigured()) {
      nodeUp = false;
      nodeLogin = undefined;
      return;
    }
    let st = await nodeStatus().catch(() => ({}) as { BackendState?: string; AuthURL?: string });
    if (needed && st.BackendState === "NeedsLogin" && !st.AuthURL) {
      await exec(["exec", EDGE_CONTAINER, "tailscale", "--socket=/tmp/tailscaled.sock", "up", "--timeout=5s", `--hostname=${process.env.APPS_TS_HOSTNAME || "aidenhq-apps"}`]).catch(() => {});
      st = await nodeStatus().catch(() => st);
    }
    nodeUp = st.BackendState === "Running";
    nodeLogin = st.BackendState === "NeedsLogin" ? st.AuthURL : undefined;
    if (nodeUp) askedLogin = false;
    if (nodeLogin && needed && cfg.notify && !askedLogin) {
      await cfg.notify("Agent-built apps need one Tailscale sign-in: open the board's Apps page to approve it.", "apps-edge:login");
      askedLogin = true;
    }
  }

  // An unshared app opens on the apps' tailnet node. Without one there is no door a browser can use: the app requires a signed
  // identity (tailnet.ts anonymousCallers) and only the gate mints one for people, so a loopback link would only be refused;
  // the status row says `unpublished` instead (the board explains it).
  const nodeUrl = (app: App): string | undefined => (exposes(app) && node() ? `${cfg.urlBase}:${app.port}` : undefined);
  const certOk = certificates(cfg.tlsCheck ?? tlsCheck);
  /**
   * The gate's door for an exposed app without the node (doors.ts): its URL once it opens, else why not. Local: once the
   * app is served (in the doors file). Public: once its certificate verifies too. Never a link that would only be refused.
   */
  const door = (app: App): { url?: string; unpublished?: string } => {
    if (nodeConfigured() && !nodeUp) return { unpublished: WAITING_FOR_NODE };
    const d = readDoor(cfg.gateFile);
    if (!d) return { unpublished: NO_DOOR };
    if (!(app.host === "local" && store.publishable(app.name))) return { unpublished: NOT_SERVED };
    const ip = doorIp(d.base);
    if (d.scheme === "https" && !(ip && certOk(doorHost(d, app.name), ip))) return { unpublished: WAITING_FOR_CERTIFICATE };
    return { url: doorUrl(d, app.name) };
  };
  const url = (app: App): string | undefined => (app.share?.host ? `https://${app.share.host}` : (nodeUrl(app) ?? (exposes(app) ? door(app).url : undefined)));
  /** Does the gate serve previews (settings.edge.previews)? Re-read on use, as apply rewrites it. */
  const gatePreviews = (): boolean => {
    try {
      return !!cfg.gateFile && !!JSON.parse(readFileSync(cfg.gateFile, "utf8")).previews;
    } catch {
      return false;
    }
  };
  /** A preview's URL (previews.ts): its gate host when the gate serves previews, else the apps' tailnet node (none without one). */
  const previewUrl = (app: App): string | undefined => (app.share?.host ? (gatePreviews() ? `https://${app.share.host}` : undefined) : nodeUrl(app));

  async function status(app: App) {
    const last = store.lastDeploy(app.name);
    const inc = store.openIncident(app.name);
    // A deploy that got nothing running reads as failed: a failed first deploy, or one whose build never ran and had nothing to fall back on.
    const state = !last ? "not deployed" : last.status === "failed" || (last.status === "build_failed" && !store.goodDeploys(app.name).length) ? "failed" : (healthy.get(app.name) ?? (await engine.containersHealthy(app).catch(() => false))) ? "healthy" : "unhealthy";
    const stats = last && last.status !== "failed" ? await engine.stats(app).catch(() => undefined) : undefined;
    return {
      name: app.name, repo: app.repo, healthy: state === "healthy", state, sha: last?.sha, deployed_at: last?.at, deployed_by: last?.by, auto_deploy: app.auto_deploy, owner: app.owner, url: url(app), ...(exposes(app) && !node() && door(app).unpublished ? { unpublished: door(app).unpublished } : {}), panel: app.panel,
      // Recent deploys (newest first): who deployed which commit and how it ended, so a reader can check a merged commit was
      // deployed by the platform's own auto-deploy rather than by hand. Deep enough that a graded commit hasn't scrolled out.
      deploys: store.recentDeploys(app.name, 20).map(({ sha, at, by, status }) => ({ sha, at, by, status })),
      // Its open PRs' previews (previews.ts): reviewers may open them; nothing depends on them.
      previews: store.previews().filter((r) => r.app === app.name).map((r) => ({ pr: r.pr, sha: r.sha, state: r.status, url: previewUrl(previewApp(app, r.pr, r.port)), ...(r.reason ? { reason: r.reason } : {}) })),
      ...(inc ? { incident: { opened_at: inc.opened_at, kind: inc.kind, detail: inc.detail } } : {}),
      ...(stats ? { stats } : {}),
    };
  }

  // Before the first health tick the row is still identified (repo and auto_deploy), so a reader can match it to its app.
  const cached = (app: App) => cache.get(app.name) ?? { name: app.name, repo: app.repo, auto_deploy: app.auto_deploy, healthy: false, state: "unknown" };
  // The cache feeds /internal/status, which has no per-caller app check: a PR's failure text stays out of it.
  const refresh = async (app: App) => {
    const row = await status(app);
    cache.set(app.name, { ...row, previews: row.previews.map(({ reason: _reason, ...p }) => p) });
  };

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
    const run = res?.status === 202 ? await res.json().catch(() => undefined) : undefined;
    const ok = !!res && fireReached(res.status, run);
    if (res && !ok) log.warn({ status: res.status, run: (run as { failureReason?: string } | undefined)?.failureReason }, "incident webhook failed");
    return ok;
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
    return { ...c, ...(await diffForDeploy(cfg.git, app, store.running(app.name) ?? store.goodDeploys(app.name)[0]?.sha, c.sha).catch(() => ({ diff: "", truncated: true }))) };
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
  const sendRaw = async (req: ApiRequest, container: string): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    if (!/^[0-9a-f]{64}$/.test(container)) throw new Error("bad container id");
    const out = await exec(["run", "--rm", "-i", "--pull", "never", "--network", `container:${container}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", cfg.healthImage, "node", "-e", SEND_SCRIPT], { input: JSON.stringify(req), timeout: (req.timeout ?? TIMEOUT_MS) + 15_000 });
    return JSON.parse(out) as { status: number; headers: Record<string, string>; body: string };
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

  // app_view / web_view: at most two renders at once, in the browser image the apply builds on this host (never pulled).
  let renders = 0;
  const queue: (() => void)[] = [];
  const haveImage = () => exec(["image", "inspect", BROWSER_IMAGE]).then(() => true, () => false);
  const NO_IMAGE = `the browser image (${BROWSER_IMAGE}) isn't built on this host yet: ops/computer-images.sh builds it on every apply`;
  /** One run of a renderer script (view.ts's image and hardening) on a docker network: its stdout. */
  const renderWith = async (network: string, script: string, input: object, timeout: number, before?: () => Promise<object>): Promise<string> => {
    if (!(await haveImage())) throw new Error(NO_IMAGE);
    if (renders >= 2) await new Promise<void>((ok) => queue.push(ok)); // a finishing render hands its slot over
    else renders++;
    const name = `aidenhq-view-${randomBytes(6).toString("hex")}`;
    try {
      // `before` runs once the slot is this render's, so a one-time code (the canary's handoff) is minted as the browser
      // starts rather than when it joined the queue.
      const full = before ? { ...input, ...(await before()) } : input;
      const args = renderArgs(network, BROWSER_IMAGE, script);
      args.splice(1, 0, "--name", name);
      return await exec(args, { input: JSON.stringify(full), timeout });
    } catch (e) {
      await exec(["rm", "-f", name]).catch(() => undefined); // a killed `docker run` leaves its container running
      throw e;
    } finally {
      const next = queue.shift();
      if (next) next();
      else renders--;
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
    // Without the browser image (built by the apply), the render probes are skipped with a warning, never failed.
    const browser = p.render.length ? await haveImage() : false;
    if (p.render.length && !browser) out.push(...p.render.map((x) => probeResult("render", x.path, [{ hard: false, what: `not checked: ${NO_IMAGE}` }])));
    if (p.render.length && browser) {
      const secret = sign(app.name, "deploy-check", memberScope());
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
      const r = await sendRaw(req, container).catch(() => ({ status: -1, headers: {}, body: "" }));
      out.push(probeResult("agent", x.path, r.status < 0 ? [{ hard: false, what: "not checked: the probe container didn't run" }] : judgeAgent(r, x.declared)));
    }
    return out;
  }

  /**
   * The identity gate (checks.ts identityProbes) on every container of a deployed app: every TCP socket it listens on or
   * exposes, probed from inside its own network namespace (IDENTITY_SCRIPT) on the address it is bound to, whatever the
   * registry and compose say. A compose service that could take connections but isn't running fails it, as does anything
   * that keeps a probe from running (deploy.ts). The probe runs in apps-mcp's own image (healthImage, apps-mcp's own, never
   * pulled).
   */
  async function identityCheck(app: App): Promise<ProbeResult> {
    if (app.host !== "local") throw new Error(`${app.name} runs on docker context ${app.host}, where apps-mcp can't probe it`);
    const compose = engine.compose(app);
    const required = identityDoors(app, compose);
    const ids = (await exec(["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=app-${app.name}`])).split("\n").map((x) => x.trim()).filter(Boolean);
    const all = await Promise.all(ids.map(async (id) => (JSON.parse(await exec(["inspect", id])) as any[])[0]));
    const containers = all.filter((c) => c?.State?.Running);
    const idle = unprobedServices(compose, all, await engine.hashes(app));
    if (idle.length) throw new Error(`${idle.join(", ")} ${idle.length === 1 ? "has" : "have"} no running container (only a port-less one-shot job of this deploy that exited 0 may stop): the gate can't probe it`);
    const forged = forgedIdentity(app.name, sign);
    const health = app.health.url ? new URL(app.health.url).pathname : undefined;
    const probes = identityProbes(app, node(), health);
    const noHttp = noHttpSurface(app);
    const ports: PortAnswers[] = [], denied: string[] = [];
    for (const c of containers) {
      if (!/^[0-9a-f]{64}$/.test(c?.Id ?? "")) throw new Error(`${app.name}: a container has no id`);
      const service = String(c.Config?.Labels?.["com.docker.compose.service"] ?? "");
      const exposed = Object.keys(c.Config?.ExposedPorts ?? {}).filter((k) => k.endsWith("/tcp")).map((k) => parseInt(k, 10));
      const ips = Object.values<any>(c.NetworkSettings?.Networks ?? {}).flatMap((n) => [n.IPAddress, n.GlobalIPv6Address]).filter(Boolean);
      // `tls`: every socket that answered no HTTP gets a ClientHello, so a TLS listener is hard on any app shape, never skipped.
      const input = { ports: [...exposed, ...required.filter((d) => d.service === service).map((d) => Number(d.port))], ips, tls: true, probes: probes.map((p) => ({ method: p.method, path: p.path, headers: p.forged ? { [IDENTITY_HEADER]: forged } : {} })) };
      const scans = [];
      for (const uid of processUids(await exec(["top", c.Id, "-eo", "uid,pid"]))) scans.push(JSON.parse(await exec(identityProbeArgs(cfg.healthImage, c.Id, uid), { input: JSON.stringify(input), timeout: 300_000 })));
      const scan = mergeScans(scans);
      denied.push(...scan.denied.map((p) => `${service}:${p}`));
      for (const k of scan.sockets)
        ports.push({ service, port: k.port, host: k.host, listening: k.listening, ...(k.raw ? { raw: k.raw } : {}), ...(k.tls ? { tls: k.tls } : {}), answers: k.statuses.map((status, i) => ({ probe: probes[i]!, status })) });
    }
    return identityPorts(ports, required, denied, noHttp);
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
  /** Why the app's last health probe failed (a class, or `health answered HTTP <status>`), else undefined. */
  const healthFailure = (app: App): string | undefined => failures.get(app.name)?.why;
  /** Whether the app itself answered (an HTTP error): the post-deploy watch's only rollback evidence. */
  const appAnswered = (app: App): boolean => failures.get(app.name)?.appSide ?? false;
  /** A deployed commit whose message carries a `No-Auto-Rollback:` trailer (a security fix): the watch only raises it. Unreadable counts as marked. */
  const noAutoRollback = async (app: App, sha: string): Promise<boolean> =>
    commitMessage(cfg.git, app, sha).then((m) => /^no-auto-rollback(?::|\s*$)/im.test(m), (err) => (log.warn({ app: app.name, err: String(err) }, "commit message unreadable"), true));
  /** An app's quality checks from its last probe, samples included (app_status, for a caller who may read the app). */
  const qualityFor = (a: App): Quality => quality.get(a.name) ?? { state: "unknown", why: "not probed yet" };
  /** Every probed app's checks without samples (the board's detector raises the failing ones; samples never leave here). */
  const qualityOf = () => apps().filter((a) => a.health.url).map((a) => ({ name: a.name, ...withoutSamples(qualityFor(a)) }));
  // The test-user canary's one-shot browser (canary.ts): the same image and hardening as a view, on the canary network.
  // ops/vm/canary-net.sh gives that bridge its isolation table (inter-container traffic off, everything but the test
  // listener dropped). The unit is host-side, so this cannot read it; what it can prove is that the bridge is the one the
  // script left: its name, its own subnet and gateway, and inter-container traffic off. Anything else (an ordinary bridge
  // merely carrying the name, a re-created one the rules do not match) refuses the launch rather than running a signed-in
  // browser on a network the firewall may not guard.
  const canaryRun = async (network: string, script: string, input: object, timeout: number, before?: () => Promise<object>) => {
    if (network === CANARY_NETWORK) {
      const got = (await exec(["network", "inspect", "--format", '{{index .Options "com.docker.network.bridge.name"}}|{{index .Options "com.docker.network.bridge.enable_icc"}}|{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}}{{end}}', network], { timeout: 15_000 }).catch(() => "")).trim();
      if (got !== "ahq-canary|false|10.231.6.0/24|10.231.6.1") throw new Error(`the canary network isn't the guarded one (want ahq-canary|false|10.231.6.0/24|10.231.6.1, found ${got || "nothing"}): run ops/vm/canary-net.sh on the host, then retry`);
      // A network of the right shape proves nothing about its rules: a reboot restores the bridge before the isolation unit
      // runs, and a firewall reload can drop the rule under it. So the launch checks the isolation itself from a helper on the
      // canary network: the test listener must answer (the bridge is up and the rule admits its one port), and the host's other
      // services and the Internet must not (the rule is loaded). One external address would not do, because a host or upstream
      // that blocks it looks the same as the rule; the other destinations are this host's own listeners on its other bridges.
      const probe = [
        'const net=require("net");',
        'const one=(h,p)=>new Promise(ok=>{const s=net.connect({host:h,port:p});const t=setTimeout(()=>{s.destroy();ok("timeout")},3000);',
        's.on("connect",()=>{clearTimeout(t);s.destroy();ok("open")});s.on("error",()=>{clearTimeout(t);ok("blocked")})});',
        '(async()=>{const listener=await one("10.231.6.1",3132);const open=[];',
        'for(const [h,p] of [["10.231.0.1",3130],["10.231.2.1",8200],["1.1.1.1",443]]) if(await one(h,p)!=="blocked") open.push(h+":"+p);',
        'console.log("RESULT "+JSON.stringify({listener,open}))})();',
      ].join("");
      const out = await exec(["run", "--rm", "--network", network, cfg.healthImage, "node", "-e", probe], { timeout: 90_000, both: true }).catch((e: Error) => e.message);
      const line = String(out).split("\n").reverse().find((x) => x.includes("RESULT "));
      const v = (() => { try { return JSON.parse(line!.slice(line!.indexOf("RESULT ") + 7)); } catch { return null; } })() as { listener?: string; open?: string[] } | null;
      if (!v || v.listener !== "open") throw new Error(`the canary bridge ${network} can't reach its test listener, so its isolation rule is not in place: run ops/vm/canary-net.sh on the host, then retry`);
      if (v.open?.length) throw new Error(`the canary bridge ${network} isn't isolated (${v.open.join(", ")} answered): run ops/vm/canary-net.sh on the host, then retry`);
    }
    return renderWith(network, script, input, timeout, before);
  };
  return { previewUrl, dropPreviewDb, healthFailure, appAnswered, noAutoRollback, sign, checkNow, qualityOf, qualityFor, syncEdge, node, nodeState: () => ({ up: nodeUp, ...(nodeLogin ? { login_url: nodeLogin } : {}) }), warehouse, render, canaryRun, lookup, auditView, auditApi, resolveApi, sendApi, runPlan, store, engine, probe, apps, find, status, cached, refresh, errors, listing, raise, notifyPending, cfg, commit };
}
export type Platform = ReturnType<typeof createPlatform>;
