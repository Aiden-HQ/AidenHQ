// Deploy engine. Every docker call is `docker [--context <host>] ...`; exec, checkout and the health probe are injected.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { checkSources, sandbox, serializeCompose, withSecrets, type ComposeJson } from "./policy.js";
import { pickService, runArgv } from "./run.js";
import { MANIFEST_FILE, parseManifest } from "./manifest.js";
import { failed, probeResult, summary, type Declared, type ProbeResult } from "./checks.js";
import { PREVIEW_NAME, type App } from "./registry.js";
import type { Deploy, Store } from "./store.js";

export interface Deps {
  /** `both`: stdout and stderr together. A failure throws with `stdout` and `killed` (timed out) attached. */
  exec: (args: string[], opts?: { env?: Record<string, string>; timeout?: number; both?: boolean }) => Promise<string>;
  checkout: (app: App, sha?: string) => Promise<{ sha: string; dir: string }>;
  /** Is the app serving now, and how long the probe took: app_check reports its own, not a deploy's wait. */
  probe: (app: App) => Promise<ProbeOutcome>;
  /** Why the app's last health probe failed (its class), when it did: platform.ts `failures`. */
  probeFailure?: (app: App) => string | undefined;
  /** The light post-deploy probes beyond health (checks.ts: render, agent) on the running app. */
  check?: (app: App, declared: Declared) => Promise<ProbeResult[]>;
  /**
   * The identity gate (checks.ts identityProbes) on the running app: a security gate, so a probe that couldn't run fails it.
   * undefined: the app has no HTTP door to probe.
   */
  identity?: (app: App) => Promise<ProbeResult | undefined>;
  store: Store;
  appsData: string;
  secretsDir: string; // the vault's apps/ dir as this container sees it
  hostSecretsDir: string; // the same dir as the Docker daemon (host) sees it
  identityKeysHostFile: string; // the identity public keys (vault identity/keys.json) as the Docker daemon sees it
  /** Is the apps' tailnet node this instance's door right now (tailnet.ts tailnetNode)? Read at each deploy. */
  tailnetNode: () => boolean;
  /** Exposes the deployed app on the apps' tailnet node (platform.ts syncEdge). */
  expose?: (app: App) => Promise<void>;
  /** database: warehouse — the app's login and its DATABASE_URL secret (database.ts). */
  provisionDb?: (app: App) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
/** A health probe's own result and elapsed milliseconds (platform.ts probe). */
export interface ProbeOutcome { ok: boolean; ms: number }

export interface Result { sha: string; status: "healthy" | "rolled_back" | "failed" | "build_failed"; images: string[]; previous?: string; checks?: ProbeResult[]; stopped?: string }

/** Why a refused deploy left the app stopped: its rollback target answers without the platform's sign-in too. */
export const STOPPED_OPEN = "stopped: answers without the platform's sign-in";
/** A `compose down` that failed: the app may still be serving, so its running revision is not confirmed stopped. */
export const TEARDOWN_FAILED = "teardown failed: it may still be serving";
/** A rollback target whose identity could not be confirmed is stopped: nothing unverified is left serving. */
export const STOPPED_UNCONFIRMED = "stopped: its identity could not be confirmed";

export const NOTE = "code only was redeployed; volumes and data were not restored";

export function createEngine(d: Deps) {
  const now = d.now ?? Date.now;
  /** The health wait's failure text, with the probe's recorded class when there is one: the class names what failed. */
  const notHealthy = (app: App): string => {
    const why = d.probeFailure?.(app);
    return `not healthy within ${app.health.grace_sec}s${why ? `: ${why}` : ""}`;
  };
  const sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const locks = new Set<string>();
  let draining = false;
  const project = (app: App) => `app-${app.name}`;
  const dir = (app: App) => `${d.appsData}/.platform/${app.name}`; // platform-only (see policy.ts)
  const sandboxed = (app: App) => `${dir(app)}/compose.sandboxed.json`;
  type Opts = { timeout?: number; both?: boolean };
  const docker = (app: App, args: string[], o: Opts = {}) => d.exec([...(app.host === "local" ? [] : ["--context", app.host]), ...args], { env: { APPS_DATA: d.appsData }, ...o });
  const compose = (app: App, args: string[], o?: Opts) => docker(app, ["compose", "-p", project(app), "-f", sandboxed(app), ...args], o);

  /** The newest good deploy that may be returned to: one found answering without sign-in is never a target again. */
  const usableGood = (good: Deploy[]): Deploy | undefined => good.find((g) => !g.disqualified);

  /**
   * The previous good deploy a manual rollback returns to. The boundary of the current commit comes first (a commit
   * redeployed repeatedly does not become its own predecessor), then targets found open are skipped, so a disqualified
   * newest row cannot hide every older target.
   */
  const rollbackTarget = (good: Deploy[]): Deploy | undefined => {
    const first = good.findIndex((g) => g.sha !== good[0]?.sha);
    return first < 0 ? undefined : good.slice(first).find((g) => !g.disqualified);
  };

  async function exclusive<T>(app: App, fn: () => Promise<T>): Promise<T> {
    if (draining) throw new Error("apps-mcp is shutting down: not starting new work");
    if (locks.has(app.name)) throw new Error(`deploy in progress for ${app.name}`);
    locks.add(app.name);
    try {
      return await fn();
    } finally {
      locks.delete(app.name);
    }
  }

  /** Checks out sha, resolves and sandboxes its compose file, writes it for deploying. Nothing is running yet. */
  async function prepare(app: App, sha?: string): Promise<{ sha: string; images: string[]; declared: Declared }> {
    if (app.database) await d.provisionDb?.(app);
    // Each declared secret is a file in the vault (apps/<app>/<KEY>), mounted into the app as /run/secrets/<KEY>.
    const missing = app.secrets.filter((k) => !existsSync(`${d.secretsDir}/${app.name}/${k}`));
    if (missing.length) throw new Error(`missing secrets for ${app.name} in the vault (apps/${app.name}/<KEY>): ${missing.join(", ")}`);
    const co = await d.checkout(app, sha);
    const base = `${co.dir}/${app.path}`;
    checkSources(`${base}/${app.compose}`, co.dir, base);
    // The app's manifest (custom roles, default role) is checked before anything starts: an invalid one refuses the deploy.
    const manifestFile = `${base}/${MANIFEST_FILE}`;
    const manifest = parseManifest(existsSync(manifestFile) ? readFileSync(manifestFile, "utf8") : undefined);
    // --env-file /dev/null, so no stray .env in the repo is read and no secret value is interpolated; the process env is
    // clean (see platform.ts exec). Secrets are added as file mounts after the sandbox (withSecrets).
    const out = await docker(app, ["compose", "--project-directory", base, "-f", `${base}/${app.compose}`, "--env-file", "/dev/null", "-p", project(app), "config", "--format", "json"]);
    const sb = withSecrets(sandbox(JSON.parse(out) as ComposeJson, app, { APPS_DATA: d.appsData }).compose, app, d.hostSecretsDir, d.identityKeysHostFile, d.tailnetNode());
    mkdirSync(dir(app), { recursive: true });
    // Already escaped by `docker compose config` (serializeCompose). Holds no secret values (secrets are file mounts).
    writeFileSync(sandboxed(app), serializeCompose(sb), { mode: 0o600 });
    return { sha: co.sha, images: Object.entries<any>(sb.services ?? {}).map(([n, s]) => s.image ?? `${project(app)}-${n}`), declared: manifest.checks ?? {} };
  }

  /** Each container's running state and RestartCount, from docker inspect (empty: none to inspect). */
  async function snapshot(app: App): Promise<Map<string, string>> {
    const ids = (await compose(app, ["ps", "-a", "-q"])).split("\n").filter(Boolean);
    if (!ids.length) return new Map();
    const rows = (await docker(app, ["inspect", "--format", "{{.Id}} {{.State.Running}} {{.RestartCount}}", ...ids])).split("\n").filter(Boolean);
    return new Map(rows.map((r) => { const [id = "", running = "", restarts = ""] = r.trim().split(" "); return [id, `${running} ${restarts}`]; }));
  }

  /**
   * Healthy within the grace period: health.url answers; without one, the containers run (the probe) and stay up through
   * the whole period, each running throughout with its RestartCount unchanged, so a restart loop is unhealthy even when a
   * container is momentarily running.
   */
  async function waitHealthy(app: App): Promise<boolean> {
    const deadline = now() + app.health.grace_sec * 1000;
    const start = app.health.url ? new Map<string, string>() : await snapshot(app).catch(() => new Map<string, string>());
    if (!start.size) {
      for (;;) {
        if ((await d.probe(app).catch(() => ({ ok: false, ms: 0 }))).ok) return true;
        if (now() >= deadline) return false;
        await sleep(3000);
      }
    }
    const steady = (s: Map<string, string>) => s.size === start.size && [...start].every(([id, v]) => v.startsWith("true ") && s.get(id) === v);
    if (!steady(start)) return false;
    while (now() < deadline) {
      await sleep(Math.min(3000, deadline - now()));
      if (!steady(await snapshot(app).catch(() => new Map<string, string>()))) return false;
    }
    return (await d.probe(app).catch(() => ({ ok: false, ms: 0 }))).ok;
  }

  /**
   * The post-deploy checks (checks.ts) after the health wait: health's own result, then render and agent on a healthy app.
   * One attempt each. A probe that couldn't run is a warning, never a failure.
   */
  async function verify(app: App, healthy: boolean, declared: Declared, live?: { ms: number }): Promise<ProbeResult[]> {
    // Never the url's path: a health url can carry a token in its path or query, and this text lands in deploy records.
    const where = app.health.url ? "*" : "containers";
    if (!healthy) {
      // app_check's own probe says how long it took, so a live failure can't read as a deploy's grace wait.
      const why = d.probeFailure?.(app);
      const what = live ? `${why ?? "health probe failed"} (${live.ms}ms)` : notHealthy(app);
      return [probeResult("health", where, [{ hard: true, what }])];
    }
    const id = await identity(app);
    const rest = await (d.check?.(app, declared) ?? Promise.resolve([])).catch((e) => [probeResult("render", "*", [{ hard: false, what: `the checks couldn't run (${String((e as Error).message ?? e).slice(0, 120)})` }])]);
    return [probeResult("health", where, []), ...(id ? [id] : []), ...rest]; // identity before the rest: summary() keeps its sentence
  }

  /** The identity gate, failing closed: an error is a hard finding, never a skipped check. */
  const identity = (app: App): Promise<ProbeResult | undefined> =>
    (d.identity?.(app) ?? Promise.resolve(undefined)).catch((e) => probeResult("identity", "*", [{ hard: true, verdict: "unconfirmed", what: `couldn't confirm the app refuses requests without the platform's sign-in (${String((e as Error).message ?? e).slice(0, 160)})` }]));

  /**
   * Stops every container of the app. The running commit is forgotten only once the stop is confirmed; the outcome is
   * what callers report: undefined when stopped, TEARDOWN_FAILED when `down` failed.
   */
  const halt = async (app: App): Promise<string | undefined> => {
    try {
      await compose(app, ["down", "--remove-orphans"]);
    } catch {
      // Something may still be serving and its identity is not confirmed: withdraw the app's routes until a deploy is
      // recorded healthy. Nothing else proves what is up, whatever the history says. The edge is re-read right here, so no
      // caller has to remember to: until the next reconcile tick a route would otherwise keep serving what `down` missed.
      // A repeated failure on an already-withheld app changes nothing on the edge, so it is not read again.
      if (d.store.withhold(app.name, TEARDOWN_FAILED)) await d.expose?.(app).catch(() => {});
      return TEARDOWN_FAILED;
    }
    d.store.clearRunning(app.name);
    return undefined;
  };

  /** The identity findings' verdicts (checks.ts): no wording matched, so rewording a message changes nothing. */
  const hardIdentity = (id: ProbeResult | undefined) => (id?.findings ?? []).filter((f) => f.hard);
  /** A probe that could not run at all (a timeout, no answer): a platform fault, so it fails this attempt only. */
  const unconfirmedIdentity = (id: ProbeResult | undefined) => hardIdentity(id).length > 0;

  /**
   * Stops a rollback target that must not serve again, and makes sure no later attempt picks it: one found answering without
   * the platform's sign-in (STOPPED_OPEN), or one that answered only with errors (STOPPED_UNCONFIRMED). A confirmed stop
   * goes into the confirmed-stop history; a failed `down` proves nothing about what still runs, so that row stays `healthy`
   * but disqualified. Either way the edge is re-read before returning: `halt()` withdrew the routes when `down` failed, and
   * a confirmed stop leaves nothing to serve (the running row is cleared), so no route may outlive the call on the tick.
   */
  async function stopUnsafeTarget(app: App, id: ProbeResult | undefined, good: Deploy[], sha: string, note: string): Promise<string | undefined> {
    const v = new Set(hardIdentity(id).map((f) => f.verdict));
    // Only these two say something about the app itself, and neither may serve again. No finding at all is a pass; any
    // other hard finding (a failure that carries no verdict, e.g. identityPorts could not read a required port) proves
    // nothing either way, so it is left to `unconfirmedIdentity`: the attempt fails and the target is probed again.
    const why = v.has("open") ? STOPPED_OPEN : v.has("errored") ? STOPPED_UNCONFIRMED : undefined;
    if (!why) return undefined;
    const left = await halt(app);
    for (const g of good) if (g.sha === sha) left ? d.store.disqualify(g.id, `${why}; ${left}`) : d.store.markRolledBack(g.id, `${why}${note}`);
    if (!left) await d.expose?.(app).catch(() => {});
    return left ? `${why}; ${left}` : why;
  }

  const up = (app: App) => compose(app, ["up", "-d", "--build", "--remove-orphans"]);
  const record = async (app: App, r: Result, by: string, detail = ""): Promise<void> => {
    // The no-HTTP verdict belongs to the sha this deploy's own identity probe looked at: only a healthy record whose check
    // proved it carries it. A deploy that never ran the probe (an older row, a build that never came up) leaves it absent.
    const proven = r.status === "healthy" && r.checks?.some((c) => c.probe === "identity" && c.noHttpProven === true);
    d.store.addDeploy({ app: app.name, sha: r.sha, images_json: JSON.stringify(r.images), by, at: now(), status: r.status, detail, ...(proven ? { no_http_proven: 1 } : {}) });
    // A healthy record is the proof that what is up is the commit that was checked: serve it again, and re-read the edge
    // now, so a rollback that lifts an earlier teardown hold reports a URL that works rather than one that waits a tick.
    if (r.status === "healthy" && d.store.unwithhold(app.name)) await d.expose?.(app).catch(() => {});
  };

  /**
   * prepare + up + health. A failed `up` (a build or host error) resolves `ok: false` with `built: false`; prepare errors
   * propagate (nothing changed).
   */
  async function apply(app: App, sha?: string): Promise<{ sha: string; images: string[]; declared: Declared; ok: boolean; err?: string; built: boolean }> {
    const p = await prepare(app, sha);
    try {
      await up(app);
    } catch (e) {
      return { ...p, ok: false, err: String((e as Error).message).slice(0, 300), built: false };
    }
    d.store.setRunning(app.name, p.sha); // its containers are up now, healthy or not
    const ok = await waitHealthy(app);
    return { ...p, ok, ...(ok ? {} : { err: notHealthy(app) }), built: true };
  }

  async function deploy(app: App, o: { sha?: string; by: string; allowStateful?: boolean }): Promise<Result> {
    if (app.stateful && !o.allowStateful) throw new Error(`${app.name} is stateful: deploy needs the owner's approval ("deploy ${app.name}" in chat)`);
    return exclusive(app, async () => {
      const prev = usableGood(d.store.goodDeploys(app.name));
      const next = await apply(app, o.sha);
      // Healthy is not enough: the light checks (a page that renders styled, an agent API that answers) must pass too. A
      // deploy that ran but wasn't healthy carries the health finding too, so its caller sees the class, not only the status.
      const checks = next.built ? await verify(app, next.ok, next.declared) : undefined;
      if (next.ok && checks && failed(checks).length) Object.assign(next, { ok: false, err: summary(checks) });
      if (next.ok) {
        const r: Result = { sha: next.sha, status: "healthy", images: next.images, checks };
        await record(app, r, o.by, summary(checks!));
        // Redeploying the commit a failed deploy rolled back to is not the fix: that incident waits for another commit.
        if (!(next.sha === prev?.sha && d.store.openIncident(app.name)?.kind === "deploy_failed")) d.store.closeIncident(app.name);
        await d.expose?.(app);
        return r;
      }
      if (!prev) {
        // First deploy: nothing to roll back to. Stop it, don't loop.
        const left = await halt(app);
        const r: Result = { sha: next.sha, status: next.built ? "failed" : "build_failed", images: next.images, ...(checks ? { checks } : {}), ...(left ? { stopped: left } : {}) };
        await record(app, r, o.by, `${next.err ?? `health check failed within ${app.health.grace_sec}s`}; ${left ?? "stopped (no previous good deploy)"}`);
        return r;
      }
      const back = await apply(app, prev.sha).catch((e) => new Error(String((e as Error)?.message ?? e)));
      if (back instanceof Error || !back.built) {
        // The rollback target can't even start (a missing secret, a policy it no longer passes): stop the failed commit, don't leave it serving.
        // A failed `up` may have replaced only some containers, so nothing running is known to be the previous commit: stop it all. No `previous`: nothing was rolled back to.
        const left = await halt(app);
        const r: Result = { sha: next.sha, status: next.built ? "failed" : "build_failed", images: next.images, ...(checks ? { checks } : {}), ...(left ? { stopped: left } : {}) };
        await record(app, r, o.by, `${next.err ?? "health check failed"}; rollback to ${prev.sha.slice(0, 8)} could not start: ${(back instanceof Error ? back.message : back.err ?? "").slice(0, 200)}; ${left ?? "stopped"}`);
        return r;
      }
      // The rollback target was healthy before: health alone decides it (its pages may predate a newer check), but it is
      // probed too before it is called rolled back: one deployed before the gate may answer without sign-in as well. A
      // target that answered without sign-in, or only with errors, is stopped and never a rollback target again. A probe
      // that could not run at all proves nothing about the target, so nothing that passed health is torn down for it: the
      // attempt fails, the target stays up, and the next attempt probes it again.
      const open = back.ok ? await identity(app) : undefined;
      const unconfirmed = unconfirmedIdentity(open);
      const foundOpen = await stopUnsafeTarget(app, open, d.store.goodDeploys(app.name), prev.sha, ` (found when ${next.sha.slice(0, 8)} was refused)`);
      const stopped = foundOpen;
      const accepted = back.ok && !stopped && !unconfirmed;
      // A commit whose `up` failed never got running: `build_failed` says the build or host failed, so the loop tries it again.
      // Anything that ran and then failed is the commit's own, and is never retried.
      const r: Result = { sha: next.sha, status: !next.built ? "build_failed" : accepted ? "rolled_back" : "failed", images: next.images, ...(accepted || foundOpen ? { previous: prev.sha } : {}), ...(checks ? { checks } : {}), ...(stopped ? { stopped } : {}) };
      const after = foundOpen ? `${foundOpen} (as does the rollback target ${prev.sha.slice(0, 8)})` : unconfirmed ? `rollback target ${prev.sha.slice(0, 8)} could not confirm its identity; left running, the next attempt probes it again` : back.ok ? `rolled back to ${prev.sha.slice(0, 8)}` : `rollback to ${prev.sha.slice(0, 8)} also unhealthy`;
      await record(app, r, o.by, stopped ? `${after}; ${next.err ?? ""}` : `${next.err ?? "health check failed"}; ${after}; ${NOTE}`);
      if (accepted) await record(app, { sha: back.sha, status: "healthy", images: back.images }, "auto-rollback");
      return r;
    });
  }

  /** Redeploys the previous good commit (code only). */
  async function rollback(app: App, o: { by: string }): Promise<Result> {
    if (app.stateful) throw new Error(`${app.name} is stateful: rollback needs the owner's approval`);
    return exclusive(app, async () => {
      const good = d.store.goodDeploys(app.name);
      const prev = rollbackTarget(good);
      if (!prev) throw new Error(`no previous good deploy of ${app.name} to roll back to`);
      const back = await apply(app, prev.sha);
      // A failed `up` may have replaced only some containers: stop it all, as the deploy path does.
      if (!back.built) {
        const left = await halt(app);
        // A partial rollback whose down failed leaves nothing provably running: no running revision and no `previous`.
        if (left) d.store.clearRunning(app.name);
        const r: Result = left
          ? { sha: back.sha, status: "build_failed", images: back.images, stopped: left }
          : { sha: back.sha, status: "build_failed", images: back.images, previous: good[0]!.sha, stopped: "stopped" };
        await record(app, r, o.by, `rollback could not start: ${back.err ?? ""}; ${r.stopped}`);
        return r;
      }
      // Health sets its status, as for the auto-rollback, except after an answer without sign-in: that target is stopped and
      // never a rollback target again. The checks' findings are reported with it.
      const checks = await verify(app, back.ok, back.declared);
      const id = checks.find((c) => c.probe === "identity");
      const foundOpen = back.ok ? await stopUnsafeTarget(app, id, good, prev.sha, "") : undefined;
      // As for the auto-rollback: a probe that could not run fails this attempt only, and the next one probes the target
      // again; nothing that passed health is torn down for it.
      const unconfirmed = back.ok && unconfirmedIdentity(id);
      const stopped = foundOpen;
      const r: Result = { sha: back.sha, status: back.ok && !stopped && !unconfirmed ? "healthy" : "failed", images: back.images, previous: good[0]!.sha, checks, ...(stopped ? { stopped } : {}) };
      await record(app, r, o.by, `rollback; ${[summary(checks), ...(stopped ? [stopped] : []), NOTE].filter(Boolean).join("; ")}`);
      return r;
    });
  }

  async function restart(app: App): Promise<{ healthy: boolean }> {
    await compose(app, ["restart"]);
    return { healthy: await waitHealthy(app) };
  }

  const deployed = (app: App) => existsSync(sandboxed(app)) && !!d.store.lastDeploy(app.name);
  const composeOf = (app: App): ComposeJson => JSON.parse(readFileSync(sandboxed(app), "utf8")) as ComposeJson;

  async function logs(app: App, o: { tail?: number; service?: string }): Promise<string> {
    if (!deployed(app)) throw new Error(`${app.name} is not deployed`);
    return (await compose(app, ["logs", "--no-color", "--tail", String(o.tail ?? 200), ...(o.service ? [o.service] : [])])).slice(-20_000);
  }

  async function stats(app: App): Promise<{ cpu_pct: number; mem_bytes: number; mem_limit_bytes: number } | undefined> {
    if (!deployed(app)) return undefined;
    const ids = (await compose(app, ["ps", "-q"])).split("\n").filter(Boolean);
    if (!ids.length) return undefined;
    const rows = (await docker(app, ["stats", "--no-stream", "--format", "{{json .}}", ...ids])).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const bytes = (s: string) => parseFloat(s) * ({ B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, kB: 1e3, MB: 1e6, GB: 1e9 } as Record<string, number>)[/[A-Za-z]+$/.exec(s.trim())?.[0] ?? "B"]!;
    const sum = (f: (r: any) => number) => rows.reduce((t, r) => t + f(r), 0);
    return { cpu_pct: sum((r) => parseFloat(r.CPUPerc)), mem_bytes: sum((r) => bytes(r.MemUsage.split("/")[0]!)), mem_limit_bytes: sum((r) => bytes(r.MemUsage.split("/")[1]!)) };
  }

  async function containers(app: App): Promise<any[]> {
    return (await compose(app, ["ps", "-a", "--format", "json"])).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  /** Container-level health of the running project, for the probe when the app has no health url. */
  async function containersHealthy(app: App): Promise<boolean> {
    const rows = await containers(app);
    return rows.length > 0 && rows.every((r) => r.State === "running" && (!r.Health || r.Health === "healthy"));
  }

  /** A short description generated here (never app output) of a container that isn't running, if any. */
  async function exitedContainer(app: App): Promise<string | undefined> {
    const r = (await containers(app).catch(() => [])).find((c) => c.State !== "running");
    return r && `container ${String(r.Service).replace(/[^\w.-]/g, "").slice(0, 30)} ${String(r.State).replace(/\W/g, "").slice(0, 15)} code ${Number(r.ExitCode) || 0}`;
  }

  /** Stops running app-<name> projects no longer in the registry (volumes kept). Previews are previews.ts's to remove. */
  async function reap(registered: Set<string>): Promise<void> {
    for (const row of JSON.parse((await d.exec(["compose", "ls", "--format", "json"])) || "[]") as { Name: string }[]) {
      const name = /^app-(.+)$/.exec(row.Name)?.[1];
      const file = name && `${dir({ name } as App)}/compose.sandboxed.json`;
      if (name && file && !registered.has(name) && !PREVIEW_NAME.test(name) && existsSync(file)) await d.exec(["compose", "-p", row.Name, "-f", file, "down", "--remove-orphans"]);
    }
  }

  /**
   * A pull request's preview (previews.ts) at `sha`: prepare + up + health + the identity gate, recorded under the preview's
   * own name. No rollback, incident or other checks: nothing waits on a preview. One that doesn't come up healthy is stopped (its volumes kept
   * until remove).
   */
  async function preview(app: App, sha: string): Promise<{ sha: string; ok: boolean; why?: string; stopped?: string }> {
    if (!app.preview) throw new Error(`${app.name} is not a preview`);
    return exclusive(app, async () => {
      const next = await apply(app, sha);
      // A preview is served too (the gate, the apps node): it passes the identity gate like a deploy.
      const id = next.ok ? await identity(app) : undefined;
      if (id && !id.ok) Object.assign(next, { ok: false, err: summary([id]) });
      const why = next.ok ? undefined : id && !id.ok ? id.findings[0]!.what : !next.built ? "it didn't build or start" : next.err ?? "it wasn't healthy";
      const left = next.ok ? undefined : await halt(app);
      await record(app, { sha: next.sha, status: next.ok ? "healthy" : "failed", images: next.images }, `preview of #${app.preview!.pr}`, [next.err, left].filter(Boolean).join("; "));
      return { sha: next.sha, ok: next.ok, ...(why || left ? { why: [why, left].filter(Boolean).join("; ") } : {}), ...(left ? { stopped: left } : {}) };
    });
  }

  /** Removes a preview entirely: containers, volumes, the images it built, and its platform dir (checkout, compose). */
  async function remove(app: App): Promise<void> {
    if (!PREVIEW_NAME.test(app.name)) throw new Error(`${app.name} is not a preview`);
    return exclusive(app, async () => {
      if (existsSync(sandboxed(app))) await compose(app, ["down", "--volumes", "--rmi", "local", "--remove-orphans"]);
      rmSync(dir(app), { recursive: true, force: true });
      d.store.clearRunning(app.name);
    });
  }

  /** The running app's compose services. */
  const services = (app: App): string[] => {
    if (!deployed(app)) throw new Error(`${app.name} is not deployed`);
    return Object.keys(composeOf(app).services ?? {});
  };

  /** `npm run <script>` once in the running service (an approved app_run), never alongside a deploy. Output is untrusted. */
  async function run(app: App, o: { script: string; service: string; sha: string; timeoutMs: number }): Promise<{ ok: boolean; timed_out: boolean; output: string }> {
    return exclusive(app, async () => {
      const running = d.store.running(app.name);
      if (running !== o.sha) throw new Error(`${app.name} now runs ${running?.slice(0, 8) ?? "nothing"}, not the approved ${o.sha.slice(0, 8)}: ask for the run again`);
      const service = pickService(services(app), o.service);
      try {
        return { ok: true, timed_out: false, output: (await compose(app, runArgv(service, o.script, o.timeoutMs), { timeout: o.timeoutMs + 30_000, both: true })).slice(-8000) };
      } catch (e: any) {
        return { ok: false, timed_out: Boolean(e.killed), output: `${e.stdout ?? ""}\n${e.message}`.slice(-8000) };
      }
    });
  }

  /**
   * app_check: a live probe now, then the same checks on the running app, with the running commit's declared paths. The health
   * result carries `probe_ms` (this probe's duration) and `live: true`, so it can't be read as a deploy's stored grace wait.
   */
  async function check(app: App, declared: Declared): Promise<ProbeResult[]> {
    if (!deployed(app)) throw new Error(`${app.name} is not deployed`);
    if (locks.has(app.name)) throw new Error(`deploy in progress for ${app.name}`);
    const live = await d.probe(app).catch(() => ({ ok: false, ms: 0 }));
    const out = await verify(app, live.ok, declared, live);
    return out.map((r) => (r.probe === "health" ? { ...r, probe_ms: live.ms, live: true } : r));
  }

  /** Shutdown: takes no new deploys, rollbacks, previews or runs, and resolves once the ones in flight are done (or after maxMs). */
  async function drain(maxMs: number): Promise<number> {
    draining = true;
    const deadline = now() + maxMs;
    while (locks.size && now() < deadline) await sleep(1000);
    return locks.size;
  }

  /** Each service's config hash in the deployed compose (what compose stamps on its containers as com.docker.compose.config-hash). */
  const hashes = async (app: App): Promise<Record<string, string>> =>
    Object.fromEntries((await compose(app, ["config", "--hash", "*"])).split("\n").map((l) => l.trim().split(/\s+/)).filter((x) => x.length === 2));

  return { drain, draining: () => draining, preview, hashes, remove, check, run, services, deployed, compose: composeOf, deploy, rollback, reap, restart, logs, stats, containersHealthy, exitedContainer, locked: (app: App) => locks.has(app.name) };
}
export type Engine = ReturnType<typeof createEngine>;
