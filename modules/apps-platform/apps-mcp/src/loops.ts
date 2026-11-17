import { failed, summary } from "./checks.js";
import { NOTE, type Result } from "./deploy.js";
import { remoteHead } from "./git.js";
import type { Platform } from "./platform.js";
import type { App } from "./registry.js";
import type { Deploy } from "./store.js";

type Log = { warn: (o: object, m: string) => void };

/**
 * Probes every deployed app; opens (coalesced) or closes incidents; caches each app's status. Skips probing apps mid-deploy or
 * inside their grace period. `now` is the clock (tests).
 */
export async function healthTick(p: Platform, log: Log, now: () => number = Date.now): Promise<void> {
  await p.notifyPending();
  for (const app of p.apps()) {
    const last = p.store.lastDeploy(app.name);
    try {
      // A deploy that got nothing running (a failed first deploy, or one whose build never ran and had nothing to fall back
      // on) was stopped, so there is nothing to probe; anything with a good deploy behind it is probed.
      if (last && ((last.status !== "failed" && last.status !== "build_failed") || p.store.goodDeploys(app.name).length) && !p.engine.locked(app) && now() - last.at >= app.health.grace_sec * 1000) {
        if (await p.probe(app)) {
          streaks.delete(app.name);
          p.store.closeIncident(app.name, ["unhealthy", "exited"]); // healthy again; a deploy_failed or rolled_back incident waits for a fixed deploy
        } else {
          // The webhook and incident carry only short text generated here, never app output (logs stay behind app_logs).
          // App-side evidence: a container down (exited, restarting), or its health answering an HTTP error. A probe that got
          // no answer (a timeout, a slow upstream, load from outside) is an outage but never a reason to roll back.
          const evidence = (await p.engine.exitedContainer(app)) ?? p.healthFailure(app);
          const why = evidence ?? "health check failing (no answer)";
          const s = streaks.get(app.name);
          const deploy = `${last.id}@${last.at}`;
          const streak = evidence ? (s?.deploy === deploy ? { ...s, count: s.count + 1, why } : { deploy, first: now(), count: 1, why }) : undefined;
          if (streak) streaks.set(app.name, streak);
          else streaks.delete(app.name);
          if (!(streak && (await watchRollback(p, app, last, streak, now, log)))) {
            p.store.closeIncident(app.name, ["rolled_back"]); // a new outage after a watch rollback is its own incident
            await p.raise(app.name, evidence?.startsWith("container") ? "exited" : "unhealthy", why);
          }
        }
      }
      await p.refresh(app);
    } catch (err) {
      log.warn({ app: app.name, err: String(err) }, "health tick failed");
    }
  }
}

/** The post-deploy watch (watchRollback): its window after a healthy auto-deploy, and how much failing it takes. */
export const WATCH_MS = 30 * 60_000;
export const WATCH_FAILS = 3;
export const WATCH_SPAN_MS = 5 * 60_000;
type Streak = { deploy: string; first: number; count: number; why: string };
const streaks = new Map<string, Streak>(); // each app's consecutive failed probes with app-side evidence, at one deploy

/**
 * The post-deploy watch: a healthy auto-deploy that starts failing within WATCH_MS, with app-side evidence on WATCH_FAILS
 * consecutive probes over at least WATCH_SPAN_MS, is rolled back to the previous good deploy, marked rolled_back (so no later
 * rollback picks it) and raised as a `rolled_back` incident, which stays open until a healthy deploy (the fix) closes it. Once
 * per deploy: the rollback's own record is then the last deploy. A rollback target that is unhealthy too is raised as the
 * outage, never retried. Stateful apps keep the owner's approval, and a commit whose message carries a `No-Auto-Rollback:`
 * trailer (a security fix) is only raised. The rolled-back commit stays deployable: the next commit on the branch deploys
 * as usual, and app_deploy redeploys this one. Returns whether it handled the failure.
 */
async function watchRollback(p: Platform, app: App, last: Deploy, s: Streak, now: () => number, log: Log): Promise<boolean> {
  if (app.stateful || last.by !== "auto-deploy" || last.status !== "healthy" || s.first - last.at > WATCH_MS) return false;
  if (s.count < WATCH_FAILS || now() - s.first < WATCH_SPAN_MS) return false;
  if (await p.noAutoRollback(app, last.sha)) return false;
  let r: Result;
  try {
    r = await p.engine.rollback(app, { by: "watch-rollback" });
  } catch (err) {
    log.warn({ app: app.name, err: String(err) }, "watch rollback refused"); // e.g. no earlier good deploy: the plain incident
    return false;
  }
  streaks.delete(app.name);
  const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000));
  const what = `${last.sha.slice(0, 8)}: ${s.why} on ${s.count} probes over ${mins(now() - s.first)} min, from ${mins(s.first - last.at)} min after its auto-deploy`;
  p.store.markRolledBack(last.id, `${s.why} on ${s.count} probes; rolled back by the post-deploy watch to ${r.sha.slice(0, 8)}`);
  p.store.closeIncident(app.name, ["unhealthy", "exited"]); // the outage incident its first failures opened: this one says more
  if (r.status !== "healthy") await p.raise(app.name, "unhealthy", `${what}; rollback to ${r.sha.slice(0, 8)} also unhealthy`);
  else await p.raise(app.name, "rolled_back", `${what}; rolled back to ${r.sha.slice(0, 8)} (app_deploy redeploys it); ${NOTE}`);
  return true;
}

const paged = new Set<string>(); // app@sha already paged for a failure before anything started

/** The most attempts at one commit while every one of them fails to build (one per poll, then it counts as deployed). */
export const BUILD_ATTEMPTS = 3;

/**
 * Whether these (all of one app's attempts at one commit, newest first) settle it. A deploy that never got running (its `up`
 * failed: a build error, a missing docker plugin) says nothing about the commit, so it is tried again; a deploy that ran,
 * healthy or not, settles it at once.
 */
const settled = (tries: Deploy[]): boolean => tries.some((d) => d.status !== "build_failed") || tries.length >= BUILD_ATTEMPTS;

/**
 * Makes the registry true. Declared apps never deployed get deployed (stateful ones wait for the owner's approval); apps whose
 * origin/<branch> moved auto-deploy (polled; no inbound webhook), a bad commit is rolled back and raised once; a commit whose
 * deploy never built is retried a bounded number of times; apps running but no longer declared are stopped (volumes kept);
 * the apps' tailnet node serves exactly the exposed apps.
 */
export async function reconcileTick(p: Platform, log: Log): Promise<void> {
  if (p.engine.draining()) return; // shutting down: no new deploys
  const all = p.apps();
  for (const app of all) {
    const last = p.store.lastDeploy(app.name);
    if (p.engine.locked(app) || (!last && app.stateful) || (last && !app.auto_deploy)) continue;
    let head = "";
    try {
      head = await remoteHead(p.cfg.git, app);
      if (settled(p.store.deploysOf(app.name, head))) continue;
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
