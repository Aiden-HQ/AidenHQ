// The standing session box: one container that holds many sessions' leases at once (a long-lived opencode session per task),
// where a job box (launcher.ts /job) is one container per job. A session ends by stopping its own process group in the box
// (images/session/session-stop), never by restarting the box, which every other session shares. Kept free of the launcher's
// globals so it can be tested with a fake Docker: launcher.ts wires it.
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { compatKey, tokenHash } from "./lib.ts";
import type { Box, Jobs, LeaseEnv } from "./lib.ts";

export type Docker = (args: string[], opts?: { timeoutMs?: number }) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

/** The image's own script (images/session/session-stop): ends one lease's processes, exits 0 when nothing is left. */
export const SESSION_STOP = "/opt/aidenhq/bin/session-stop";
/** The standing box's own agent name (its label and record): sessions of different agents share it, each lease keeps its agent. */
export const STANDING_AGENT = "sessions";
const fail = (status: number, msg: string) => Object.assign(new Error(msg), { status });

/** Every lease's out folder is a child of this one folder (the box's /aidenhq-out); a lease's env file is beside it, outside the box's reach. */
export const standingOut = (envDir: string) => path.join(envDir, "standing");
export const leaseEnvFile = (envDir: string, container: string, lease: string) => path.join(envDir, `${container}.${lease}.env`);

/** The files a standing box and its leases left on the host once Docker has removed the box. */
export function dropStandingFiles(envDir: string, container: string, leases: { lease: string }[]) {
  for (const l of leases) rmSync(leaseEnvFile(envDir, container, l.lease), { force: true });
  for (const l of leases) rmSync(path.join(standingOut(envDir), l.lease), { recursive: true, force: true });
}

export interface StandingDeps {
  jobs: Jobs;
  boxes: Map<string, Box>;
  docker: Docker;
  /** Saves the launcher's job records (jobs.json). */
  save: () => void;
  log: (...a: unknown[]) => void;
  /** The launcher's folder for job env files (and, under standing/, the leases' out folders). */
  envDir: string;
  newName: () => string;
  jobState: (name: string) => Promise<string>;
  /** The box goes: retired first (no lease picks it) then removed; false when Docker didn't remove it. */
  retire: (name: string, why: string) => Promise<boolean>;
  /** The box is removed (retire's second half): for a start that failed. */
  destroy: (name: string, why: string) => Promise<boolean>;
  draining: () => boolean;
}

/** What a /job {standing:true} asks for, after the launcher has checked its folders and image. */
export interface LeaseRequest {
  agentId: string; job?: string; issueId: string; identifier: string; workspace: string; token: string; roles: string[];
  /** The box's `docker run` line (image by ID, limits, mounts); its compatKey decides whether a running box still fits. */
  runArgs: (name: string) => string[];
  /** The in-box state folder of this agent on this task (engine-state), and the lease's env file text. */
  stateIn: string;
  env: (lease: LeaseEnv) => string;
}

export class Standing {
  #d: StandingDeps;
  #tail: Promise<unknown> = Promise.resolve();
  #stopping = new Map<string, Promise<boolean>>();
  constructor(deps: StandingDeps) { this.#d = deps; }

  /** One start at a time: two first sessions never start two boxes, and a replace never races a lease. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#tail.then(fn);
    this.#tail = p.then(() => {}, () => {});
    return p;
  }

  /** A lease in the standing box (the box is made on the first, replaced when its run line or a mount's source changed). */
  lease(req: LeaseRequest) { return this.#serial(() => this.#lease(req)); }

  async #lease(req: LeaseRequest) {
    const d = this.#d;
    if (d.draining()) throw fail(503, "the launcher is restarting; ask the next one");
    let box = d.jobs.standingBox();
    // A box going holds the place until Docker has removed it (the kernel asks again).
    if (box?.retired) {
      await d.destroy(box.container, "retired standing box");
      box = d.jobs.standingBox();
      if (box) throw fail(409, `the standing box ${box.container} is still being removed`);
    }
    if (box) {
      const key = (() => { try { return compatKey(req.runArgs(box.container)); } catch { return undefined; } })();
      // A different image, limit or mount source is a different box: its sessions end, and dispatch's retry resumes them in the new one.
      // Only a box that is really gone (or exited or dead) is replaced; a transient state (restarting, paused, an unanswered inspect) never ends every session.
      const state = await d.jobState(box.container);
      if (state === "created" || state === "restarting" || state === "paused" || state === "removing" || state === "unknown") throw fail(503, `the standing box ${box.container} is ${state}; ask again`);
      if (key === undefined || box.compat !== key || state !== "running") {
        for (const l of d.jobs.leases(box.container)) await this.stop(box.container, l.lease);
        if (!(await d.retire(box.container, "the standing box no longer fits"))) throw fail(409, `the standing box ${box.container} is still being removed`);
        box = undefined;
      }
    }
    if (!box) box = await this.#start(req);
    const container = box.container;
    // A task has one session: a lease of an earlier job of it (its box replaced, the kernel restarted) ends first.
    const earlier = d.jobs.leaseOf(req.issueId);
    if (earlier && !(await this.stop(earlier.container, earlier.lease))) throw fail(409, `the task's earlier session ${earlier.lease} is still stopping; ask again`);
    // The launcher may have begun draining while this waited: it commits nothing the next one doesn't know.
    if (d.draining()) throw fail(503, "the launcher is restarting; ask the next one");
    const taken = new Set(d.jobs.leases(container).flatMap((l) => [l.lease, l.ports.serve]));
    let lease = "";
    do lease = `l-${randomBytes(4).toString("hex")}`; while (taken.has(lease));
    let n = 0;
    while (taken.has(20000 + 2 * n)) n++;
    const ports = { serve: 20000 + 2 * n, term: 20001 + 2 * n };
    const secrets = { serve: randomBytes(32).toString("base64url"), term: randomBytes(32).toString("base64url") };
    const outDir = path.join(standingOut(d.envDir), lease);
    mkdirSync(outDir, { mode: 0o700 });
    const envFile = leaseEnvFile(d.envDir, container, lease);
    // The env file first: a lease is only ever committed with a box the kernel can run in.
    writeFileSync(`${envFile}.tmp`, req.env({ workdir: `/sessions/${req.identifier}`, stateIn: req.stateIn, ports, secrets }), { mode: 0o600 });
    renameSync(`${envFile}.tmp`, envFile);
    d.jobs.addLease(container, { lease, agentId: req.agentId, ...(req.job ? { job: req.job } : {}), issueId: req.issueId, identifier: req.identifier, workspace: req.workspace, tokenHash: tokenHash(req.token), roles: req.roles, ports, secrets });
    d.save();
    const b = d.boxes.get(container);
    if (b) b.lastUsed = Date.now();
    d.log("session lease", lease, req.identifier, `ports ${ports.serve}/${ports.term}`);
    return { container, envFile, outDir, gen: 1, lease, boxOut: `/aidenhq-out/${lease}`, workdir: `/sessions/${req.identifier}`, stateIn: req.stateIn };
  }

  async #start(req: LeaseRequest) {
    const d = this.#d;
    const name = d.newName();
    d.boxes.set(name, { agentId: STANDING_AGENT, lastUsed: Date.now(), busy: 1 }); // reserve the slot while starting
    d.jobs.addStanding({ container: name, agentId: STANDING_AGENT }); d.save();
    try {
      const args = req.runArgs(name);
      d.jobs.get(name)!.compat = compatKey(args); d.save();
      const r = await d.docker(args);
      if (r.exitCode !== 0) throw fail(500, `docker run failed: ${r.stderr.trim()}`);
      if (d.draining()) throw fail(503, "the launcher is restarting; ask the next one");
    } catch (e) {
      await d.destroy(name, "standing box failed to start");
      throw e;
    }
    d.boxes.get(name)!.busy = 0;
    d.log("standing box started", name);
    return d.jobs.get(name)!;
  }

  /**
   * The session ends: its token opens nothing at once, its processes are stopped by their process group (never a restart of the
   * shared box), then its lease and out folder go. A failing session-stop is logged and the lease stays revoked for the reaper to retry. Idempotent; true
   * when this call (or the one in flight) ended a lease.
   */
  stop(container: string, lease: string): Promise<boolean> {
    const key = `${container}/${lease}`;
    let p = this.#stopping.get(key);
    if (!p) {
      p = this.#stop(container, lease).finally(() => this.#stopping.delete(key));
      this.#stopping.set(key, p);
    }
    return p;
  }

  async #stop(container: string, lease: string) {
    const d = this.#d;
    if (!d.jobs.revokeLease(container, lease)) return false;
    d.save();
    const r = await d.docker(["exec", container, SESSION_STOP, lease], { timeoutMs: 30_000 });
    // A box Docker confirms gone holds no process: its lease is simply over.
    const gone = r.exitCode !== 0 && (await d.jobState(container)) === "missing";
    // A failed stop stays revoked and lapsed (leaseUntil 0): the reaper tries it again, and its ports stay reserved until it ends.
    if (r.exitCode !== 0 && !gone) { d.log("session-stop failed; the lease stays to be retried", container, lease, r.stderr.trim() || `exit ${r.exitCode}`); return false; }
    d.jobs.releaseLease(container, lease);
    d.save();
    rmSync(leaseEnvFile(d.envDir, container, lease), { force: true });
    await rm(path.join(standingOut(d.envDir), lease), { recursive: true, force: true }).catch(() => {});
    d.log("session lease ended", lease);
    return true;
  }

  /** A lease the kernel stopped following (lib.ts lapsed): stopped like a release. */
  reap(lapsed: { container: string; lease?: string }[]) {
    for (const l of lapsed) if (l.lease) void this.stop(l.container, l.lease);
  }
}
