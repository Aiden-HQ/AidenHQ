import { failed, summary } from "./checks.js";
import { NOTE, type Result } from "./deploy.js";
import { remoteHead } from "./git.js";
import type { Platform } from "./platform.js";
import type { App } from "./registry.js";
import type { Deploy } from "./store.js";

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
          const why = exited ?? "health check failing";
          if (!(await watchRollback(p, app, last, why, log))) {
            p.store.closeIncident(app.name, ["rolled_back"]); // a new outage after a watch rollback is its own incident
            await p.raise(app.name, exited ? "exited" : "unhealthy", why);
          }
        }
      }
      await p.refresh(app);
    } catch (err) {
      log.warn({ app: app.name, err: String(err) }, "health tick failed");
    }
  }
}

/** How long after a healthy auto-deploy a failed health check rolls it back by itself (watchRollback). */
export const WATCH_MS = 30 * 60_000;

/**
 * The post-deploy watch: a healthy auto-deploy whose health check fails within WATCH_MS is rolled back to the previous good
 * deploy, marked rolled_back (so no later rollback picks it) and raised as a `rolled_back` incident, which stays open until a
 * healthy deploy (the fix) closes it. Once per deploy: the rollback's own record is then the last deploy. A rollback target
 * that is unhealthy too is raised as the outage, never retried. Stateful apps keep the owner's approval. Whether it handled it.
 */
async function watchRollback(p: Platform, app: App, last: Deploy, why: string, log: Log): Promise<boolean> {
  if (app.stateful || last.by !== "auto-deploy" || last.status !== "healthy" || Date.now() - last.at > WATCH_MS) return false;
  let r: Result;
  try {
    r = await p.engine.rollback(app, { by: "watch-rollback" });
  } catch (err) {
    log.warn({ app: app.name, err: String(err) }, "watch rollback refused"); // e.g. no earlier good deploy: the plain incident
    return false;
  }
  const what = `${last.sha.slice(0, 8)}: ${why} ${Math.max(1, Math.round((Date.now() - last.at) / 60_000))} min after its auto-deploy`;
  p.store.markRolledBack(last.id, `${why}; rolled back by the post-deploy watch to ${r.sha.slice(0, 8)}`);
  if (r.status !== "healthy") await p.raise(app.name, "unhealthy", `${what}; rollback to ${r.sha.slice(0, 8)} also unhealthy`);
  else {
    p.store.closeIncident(app.name, ["unhealthy", "exited"]); // an earlier tick's outage incident (a refused rollback): this one says more
    await p.raise(app.name, "rolled_back", `${what}; rolled back to ${r.sha.slice(0, 8)}; ${NOTE}`);
  }
  return true;
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
      // The failed checks' generated reasons (never page text): the maintainer sees why it rolled back.
      const why = r.checks && failed(r.checks).length ? `: ${summary(r.checks)}` : "";
      if (r.status !== "healthy") await p.raise(app.name, "deploy_failed", `deploy of ${head.slice(0, 8)} ${r.status}${r.previous ? `, rolled back to ${r.previous.slice(0, 8)}` : ""}${why}; ${NOTE}`);
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
