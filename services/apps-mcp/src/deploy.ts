// Deploy engine. Every docker call is `docker [--context <host>] ...`; exec, checkout and the health probe are injected.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { checkSources, sandbox, serializeCompose, withSecrets, type ComposeJson } from "./policy.js";
import { pickService, runArgv } from "./run.js";
import { MANIFEST_FILE, parseManifest } from "./manifest.js";
import { failed, probeResult, summary, type Declared, type ProbeResult } from "./checks.js";
import { PREVIEW_NAME, type App } from "./registry.js";
import type { Store } from "./store.js";

export interface Deps {
  /** `both`: stdout and stderr together. A failure throws with `stdout` and `killed` (timed out) attached. */
  exec: (args: string[], opts?: { env?: Record<string, string>; timeout?: number; both?: boolean }) => Promise<string>;
  checkout: (app: App, sha?: string) => Promise<{ sha: string; dir: string }>;
  /** Is the app serving right now? */
  probe: (app: App) => Promise<boolean>;
  /** The light post-deploy probes beyond health (checks.ts: render, agent) on the running app. */
  check?: (app: App, declared: Declared) => Promise<ProbeResult[]>;
  store: Store;
  appsData: string;
  secretsDir: string; // the vault's apps/ dir as this container sees it
  hostSecretsDir: string; // the same dir as the Docker daemon (host) sees it
  identityKeysHostFile: string; // the identity public keys (vault identity/keys.json) as the Docker daemon sees it
  /** Exposes the deployed app on the apps' tailnet node (platform.ts syncEdge). */
  expose?: (app: App) => Promise<void>;
  /** database: warehouse — the app's login and its DATABASE_URL secret (database.ts). */
  provisionDb?: (app: App) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface Result { sha: string; status: "healthy" | "rolled_back" | "failed"; images: string[]; previous?: string; checks?: ProbeResult[] }

export const NOTE = "code only was redeployed; volumes and data were not restored";

export function createEngine(d: Deps) {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const locks = new Set<string>();
  const project = (app: App) => `app-${app.name}`;
  const dir = (app: App) => `${d.appsData}/.platform/${app.name}`; // platform-only (see policy.ts)
  const sandboxed = (app: App) => `${dir(app)}/compose.sandboxed.json`;
  type Opts = { timeout?: number; both?: boolean };
  const docker = (app: App, args: string[], o: Opts = {}) => d.exec([...(app.host === "local" ? [] : ["--context", app.host]), ...args], { env: { APPS_DATA: d.appsData }, ...o });
  const compose = (app: App, args: string[], o?: Opts) => docker(app, ["compose", "-p", project(app), "-f", sandboxed(app), ...args], o);

  async function exclusive<T>(app: App, fn: () => Promise<T>): Promise<T> {
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
    const sb = withSecrets(sandbox(JSON.parse(out) as ComposeJson, app, { APPS_DATA: d.appsData }).compose, app, d.hostSecretsDir, d.identityKeysHostFile);
    mkdirSync(dir(app), { recursive: true });
    // Already escaped by `docker compose config` (serializeCompose). Holds no secret values (secrets are file mounts).
    writeFileSync(sandboxed(app), serializeCompose(sb), { mode: 0o600 });
    return { sha: co.sha, images: Object.entries<any>(sb.services ?? {}).map(([n, s]) => s.image ?? `${project(app)}-${n}`), declared: manifest.checks ?? {} };
  }

  async function waitHealthy(app: App): Promise<boolean> {
    const deadline = now() + app.health.grace_sec * 1000;
    for (;;) {
      if (await d.probe(app).catch(() => false)) return true;
      if (now() >= deadline) return false;
      await sleep(3000);
    }
  }

  /**
   * The post-deploy checks (checks.ts) after the health wait: health's own result, then render and agent on a healthy app.
   * One attempt each. A probe that couldn't run is a warning, never a failure.
   */
  async function verify(app: App, healthy: boolean, declared: Declared): Promise<ProbeResult[]> {
    const where = app.health.url ? new URL(app.health.url).pathname : "containers";
    if (!healthy) return [probeResult("health", where, [{ hard: true, what: `not healthy within ${app.health.grace_sec}s` }])];
    const rest = await (d.check?.(app, declared) ?? Promise.resolve([])).catch((e) => [probeResult("render", "*", [{ hard: false, what: `the checks couldn't run (${String((e as Error).message ?? e).slice(0, 120)})` }])]);
    return [probeResult("health", where, []), ...rest];
  }

  const up = (app: App) => compose(app, ["up", "-d", "--build", "--remove-orphans"]);
  const record = (app: App, r: Result, by: string, detail = "") => d.store.addDeploy({ app: app.name, sha: r.sha, images_json: JSON.stringify(r.images), by, at: now(), status: r.status, detail });

  /** prepare + up + health. Resolves with the outcome (a failed `up`, e.g. a build error, counts as not ok); prepare errors propagate (nothing changed). */
  async function apply(app: App, sha?: string): Promise<{ sha: string; images: string[]; declared: Declared; ok: boolean; err?: string }> {
    const p = await prepare(app, sha);
    try {
      await up(app);
    } catch (e) {
      return { ...p, ok: false, err: String((e as Error).message).slice(0, 300) };
    }
    d.store.setRunning(app.name, p.sha); // its containers are up now, healthy or not
    return { ...p, ok: await waitHealthy(app) };
  }

  async function deploy(app: App, o: { sha?: string; by: string; allowStateful?: boolean }): Promise<Result> {
    if (app.stateful && !o.allowStateful) throw new Error(`${app.name} is stateful: deploy needs the owner's approval ("deploy ${app.name}" in chat)`);
    return exclusive(app, async () => {
      const prev = d.store.goodDeploys(app.name)[0];
      const next = await apply(app, o.sha);
      // Healthy is not enough: the light checks (a page that renders styled, an agent API that answers) must pass too.
      const checks = next.ok ? await verify(app, true, next.declared) : undefined;
      if (checks && failed(checks).length) Object.assign(next, { ok: false, err: summary(checks) });
      if (next.ok) {
        const r: Result = { sha: next.sha, status: "healthy", images: next.images, checks };
        record(app, r, o.by, summary(checks!));
        // Redeploying the commit a failed deploy rolled back to is not the fix: that incident waits for another commit.
        if (!(next.sha === prev?.sha && d.store.openIncident(app.name)?.kind === "deploy_failed")) d.store.closeIncident(app.name);
        await d.expose?.(app);
        return r;
      }
      if (!prev) {
        // First deploy: nothing to roll back to. Stop it, don't loop.
        await compose(app, ["down", "--remove-orphans"]).catch(() => "");
        d.store.clearRunning(app.name);
        const r: Result = { sha: next.sha, status: "failed", images: next.images, ...(checks ? { checks } : {}) };
        record(app, r, o.by, `${next.err ?? `health check failed within ${app.health.grace_sec}s`}; stopped (no previous good deploy)`);
        return r;
      }
      const back = await apply(app, prev.sha);
      // The rollback target was healthy before: health alone decides it (its pages may predate a newer check).
      const r: Result = { sha: next.sha, status: back.ok ? "rolled_back" : "failed", images: next.images, previous: prev.sha, ...(checks ? { checks } : {}) };
      record(app, r, o.by, `${next.err ?? "health check failed"}; ${back.ok ? `rolled back to ${prev.sha.slice(0, 8)}` : `rollback to ${prev.sha.slice(0, 8)} also unhealthy`}; ${NOTE}`);
      if (back.ok) record(app, { sha: back.sha, status: "healthy", images: back.images }, "auto-rollback");
      return r;
    });
  }

  /** Redeploys the previous good commit (code only). */
  async function rollback(app: App, o: { by: string }): Promise<Result> {
    if (app.stateful) throw new Error(`${app.name} is stateful: rollback needs the owner's approval`);
    return exclusive(app, async () => {
      const good = d.store.goodDeploys(app.name);
      const prev = good.find((g) => g.sha !== good[0]?.sha);
      if (!prev) throw new Error(`no previous good deploy of ${app.name} to roll back to`);
      const back = await apply(app, prev.sha);
      // Health alone sets its status, as for the auto-rollback: the previous good commit may predate a newer check. The
      // checks' findings are reported with it.
      const checks = await verify(app, back.ok, back.declared);
      const r: Result = { sha: back.sha, status: back.ok ? "healthy" : "failed", images: back.images, previous: good[0]!.sha, checks };
      record(app, r, o.by, `rollback; ${[summary(checks), NOTE].filter(Boolean).join("; ")}`);
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
   * A pull request's preview (previews.ts) at `sha`: prepare + up + health, recorded under the preview's own name. No
   * rollback, incident or checks: nothing waits on a preview. One that doesn't come up healthy is stopped (its volumes kept
   * until remove).
   */
  async function preview(app: App, sha: string): Promise<{ sha: string; ok: boolean; why?: string }> {
    if (!app.preview) throw new Error(`${app.name} is not a preview`);
    return exclusive(app, async () => {
      const next = await apply(app, sha);
      const why = next.ok ? undefined : next.err ? "it didn't build or start" : `it wasn't healthy within ${app.health.grace_sec}s`;
      if (!next.ok) {
        await compose(app, ["down", "--remove-orphans"]).catch(() => "");
        d.store.clearRunning(app.name);
      }
      record(app, { sha: next.sha, status: next.ok ? "healthy" : "failed", images: next.images }, `preview of #${app.preview!.pr}`, next.err ?? "");
      return { sha: next.sha, ok: next.ok, ...(why ? { why } : {}) };
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
  async function run(app: App, o: { script: string; service: string; timeoutMs: number }): Promise<{ ok: boolean; timed_out: boolean; output: string }> {
    return exclusive(app, async () => {
      const service = pickService(services(app), o.service);
      try {
        return { ok: true, timed_out: false, output: (await compose(app, runArgv(service, o.script), { timeout: o.timeoutMs, both: true })).slice(-8000) };
      } catch (e: any) {
        return { ok: false, timed_out: Boolean(e.killed), output: `${e.stdout ?? ""}\n${e.message}`.slice(-8000) };
      }
    });
  }

  /** app_check: the same probes on the running app now, with the running commit's declared paths. */
  async function check(app: App, declared: Declared): Promise<ProbeResult[]> {
    if (!deployed(app)) throw new Error(`${app.name} is not deployed`);
    if (locks.has(app.name)) throw new Error(`deploy in progress for ${app.name}`);
    return verify(app, await d.probe(app).catch(() => false), declared);
  }

  return { preview, remove, check, run, services, deployed, compose: composeOf, deploy, rollback, reap, restart, logs, stats, containersHealthy, exitedContainer, locked: (app: App) => locks.has(app.name) };
}
export type Engine = ReturnType<typeof createEngine>;
