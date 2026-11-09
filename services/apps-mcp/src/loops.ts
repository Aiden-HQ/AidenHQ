import { NOTE } from "./deploy.js";
import { remoteHead } from "./git.js";
import type { Platform } from "./platform.js";

type Log = { warn: (o: object, m: string) => void };

/** Probes every deployed app; opens (coalesced) or closes incidents; caches each app's status. Skips probing apps mid-deploy or inside their grace period. */
export async function healthTick(p: Platform, log: Log): Promise<void> {
  await p.notifyPending();
  for (const app of p.apps()) {
    const last = p.store.lastDeploy(app.name);
    try {
      // A failed first deploy was stopped, so there is nothing to probe; anything with a good deploy behind it is probed.
      if (last && (last.status !== "failed" || p.store.goodDeploys(app.name).length) && !p.engine.locked(app) && Date.now() - last.at >= app.health.grace_sec * 1000) {
        if (await p.probe(app)) p.store.closeIncident(app.name, ["unhealthy", "exited", "deploy_failed"]); // healthy again (e.g. after a rollback)
        else {
          // The webhook and incident carry only short text generated here, never app output (logs stay behind app_logs).
          const exited = await p.engine.exitedContainer(app);
          await p.raise(app.name, exited ? "exited" : "unhealthy", exited ?? "health check failing");
        }
      }
      await p.refresh(app);
    } catch (err) {
      log.warn({ app: app.name, err: String(err) }, "health tick failed");
    }
  }
}

const paged = new Set<string>(); // app@sha already paged for a failure before anything started

/**
 * Makes the registry true. Declared apps never deployed get deployed (stateful ones wait for the owner's approval); apps whose
 * origin/<branch> moved auto-deploy (polled; no inbound webhook), a bad commit is rolled back and raised once; apps running
 * but no longer declared are stopped (volumes kept); the apps' tailnet node serves exactly the exposed apps.
 */
export async function reconcileTick(p: Platform, log: Log): Promise<void> {
  const all = p.apps();
  for (const app of all) {
    const last = p.store.lastDeploy(app.name);
    if (p.engine.locked(app) || (!last && app.stateful) || (last && !app.auto_deploy)) continue;
    let head = "";
    try {
      head = await remoteHead(p.cfg.git, app);
      if (p.store.seen(app.name, head)) continue;
      const r = await p.engine.deploy(app, { sha: head, by: last ? "auto-deploy" : "reconcile" });
      p.errors.delete(app.name);
      if (r.status !== "healthy") await p.raise(app.name, "deploy_failed", `deploy of ${head.slice(0, 8)} ${r.status}${r.previous ? `, rolled back to ${r.previous.slice(0, 8)}` : ""}; ${NOTE}`);
    } catch (err) {
      // Nothing started (fetch, checkout, policy, secrets): retried next tick, not recorded as a deploy, paged once per commit.
      p.errors.set(app.name, String((err as Error).message ?? err).slice(0, 300));
      log.warn({ app: app.name, err: String(err) }, "reconcile failed");
      if (head && !paged.has(`${app.name}@${head}`)) {
        paged.add(`${app.name}@${head}`);
        await p.raise(app.name, "deploy_failed", `deploy of ${head.slice(0, 8)} refused or failed before starting (run app_deploy to see why)`);
      }
    }
  }
  // First: the apps node leaves removed apps' networks, which reap's `compose down` removes.
  await p.syncEdge().catch((err) => log.warn({ err: String(err) }, "apps node sync failed"));
  try {
    await p.engine.reap(new Set(all.map((a) => a.name)));
  } catch (err) {
    log.warn({ err: String(err) }, "reap failed");
  }
}

/** The two loops share one tick: a caller that wants it now (app_create, app_remove) awaits the one in flight, then a fresh one. */
export function startLoops(p: Platform, log: Log, everyMs = 120_000): () => Promise<void> {
  const tick = async () => {
    await reconcileTick(p, log).catch((err) => log.warn({ err: String(err) }, "reconcile loop failed"));
    await healthTick(p, log).catch((err) => log.warn({ err: String(err) }, "health loop failed"));
  };
  let inflight: Promise<void> | undefined;
  const run = () => (inflight ??= tick().finally(() => (inflight = undefined)));
  void run();
  setInterval(run, everyMs).unref();
  return async () => {
    if (inflight) await inflight; // it may have read the registry before the edit
    await run();
  };
}
