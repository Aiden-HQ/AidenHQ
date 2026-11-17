import { join } from "node:path";
import { engineLabel } from "../agents.mjs";
import { followJob, observes } from "../engines.mjs";
import { runAlive } from "../../../../kernel/src/jobs.ts";
import { gcpSession } from "../gcp.ts";
import { isTransient } from "../retry.ts";
import { writeMetrics } from "../metrics.ts";
import { cfg, detach, jobsApi, log, metrics, pc, queue, running, state } from "./context.ts";
import { poll } from "./poll.ts";
import { drainQueue } from "./dispatch.ts";
import { activeMerges, mergeQueue } from "./merge.ts";
import { boxCall, finishTurn, helperPort, keepBox, progressOf, stopBox } from "./jobs.ts";
import { repoHelper } from "./github.ts";

let stopping = false;
// Jobs a restart cut off before their run started (or waiting), and runs that died while no runner
// followed them: resumed in the same workspace and session when the runner starts again.
const RESUME_KEY = "resume_after_restart";

/**
 * Jobs the previous runner process was following (a restart): the kernel still runs them, so they are followed to their end and
 * reported exactly as if this runner had started them, including those that ended while no runner was up. A run from before
 * jobs moved into the kernel (no kernel job: the cutover) is stopped if it still runs, and resumed in its workspace and session.
 */
function adoptRuns() {
  const lost = [];
  for (const job of state.runningJobs()) {
    const run = job.run;
    if (!run?.kernelJob) {
      if (run?.pid && job.log_path && runAlive(run.pid, job.log_path)) {
        try { process.kill(-run.pid, "SIGTERM"); } catch {}
        log("stopped a job from before the kernel ran jobs: resuming it", { issue: state.task(job.issue_id)?.identifier, pid: run.pid });
      }
      state.finishJob(job.id, "interrupted", "restart");
      if (run) lost.push({ issueId: job.issue_id, instructions: run.instructions });
      continue;
    }
    const issue = { id: job.issue_id, identifier: state.task(job.issue_id)?.identifier };
    const controller = new AbortController();
    const channel: any = {};
    // Its tools keep working: the same helper port, its own token, what it already asked for.
    const tools = { issue, workspace: run.workspace, instructions: run.instructions, brief: run.brief, kind: run.engine.kind, reads: observes(run.engine), who: run.who, signal: controller.signal, jobId: job.id, run, reset: run.reset, engine: run.switchTo, cleanup: run.cleanup, box: run.box, agentId: run.agentId ?? null };
    const helper = repoHelper.register(tools, run.token);
    channel.send = (text: any) => jobsApi.input(run.kernelJob, text);
    running.set(issue.id, { controller, jobId: job.id, identifier: issue.identifier, startedAt: job.started_at, request: run.instructions, pid: run.pid, logPath: job.log_path, channel, who: run.who, info: { engine: engineLabel(run.engine), mode: "working", repo: run.repos } });
    log("following a running job again", { issue: issue.identifier, job: run.kernelJob });
    void (async () => {
      const gcp = observes(run.engine)
        ? await gcpSession({ credentialsFile: cfg.gcp.credentialsFile, dir: join(cfg.stateDir, "gcloud", issue.identifier), project: cfg.gcp.projects[0], log: (m, f) => log(m, { issue: issue.identifier, ...f }) }).catch(() => undefined)
        : undefined;
      // A box job: its lease renewed and its helper binding re-registered, the launcher's record checked against ours. A box
      // gone (its lease lapsed while no runner followed it) means a dead run: the job is stopped and the task resumes from its
      // session in a new box, once this one is confirmed gone.
      if (run.box) {
        const live = await boxCall("/job/renew", { container: run.box.container, issueId: issue.id, helperPort: helperPort(), helperToken: run.token }).then(
          (r: any) => r.issueId === issue.id && r.workspace === run.workspace,
          (err) => err.status !== 404, // the launcher not answering yet is not a gone box: the renewals go on trying
        );
        const now: any = live ? undefined : await jobsApi.get(run.kernelJob).catch(() => undefined);
        if (!live && !(now && now.state === "done")) {
          await jobsApi.stop(run.kernelJob).catch(() => {});
          helper.done();
          await stopBox(issue, run.box).catch((err) => log("box release failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 300) }));
          state.finishJob(job.id, "interrupted", "box gone");
          running.delete(issue.id);
          log("followed box job's box is gone: resuming", { issue: issue.identifier, container: run.box.container });
          state.set(RESUME_KEY, JSON.stringify([...JSON.parse(state.get(RESUME_KEY) || "[]"), { issueId: issue.id, instructions: run.instructions }]));
          return resumeInterrupted();
        }
      }
      const watch = followJob(jobsApi, run.kernelJob, { signal: controller.signal, detach: detach.signal, onProgress: progressOf(issue.id), log });
      await finishTurn({ issue, workspace: run.workspace, engine: run.engine, jobId: job.id, logPath: job.log_path, tipsBefore: run.tipsBefore, tools, gcp, helper, watch, box: run.box, keep: run.box && keepBox(issue, run.box, helper) });
    })();
  }
  if (lost.length) state.set(RESUME_KEY, JSON.stringify([...JSON.parse(state.get(RESUME_KEY) || "[]"), ...lost]));
}

/** A turn whose end couldn't be reported: kept (it survives a restart) for the next poll to run again. */
function retryTurn(issue: any, why: any) {
  state.set(`endretry:${issue.id}`, String(Number(state.get(`endretry:${issue.id}`) || 0) + 1));
  log("turn kept to run again", { issue: issue.identifier, why });
  state.set(RESUME_KEY, JSON.stringify([...JSON.parse(state.get(RESUME_KEY) || "[]"), { issueId: issue.id, instructions: running.get(issue.id)?.request ?? "", why }]));
}

async function resumeInterrupted() {
  const jobs = JSON.parse(state.get(RESUME_KEY) || "[]");
  state.set(RESUME_KEY, "[]");
  for (const { issueId, instructions, why = "your last run on this was cut off by a runner restart" } of jobs) {
    const issue = await pc.issue(issueId).catch((err) => (isTransient(err) ? null : undefined));
    if (issue === null) {
      state.set(RESUME_KEY, JSON.stringify([...JSON.parse(state.get(RESUME_KEY) || "[]"), { issueId, instructions, why }]));
      continue;
    }
    if (!issue?.identifier || ["done", "cancelled"].includes(issue.status)) continue;
    // A kept turn is dropped if the task's latest job isn't the failed one: the owner stopped it, or newer work ran since.
    if (why.includes("couldn't report") && state.lastJob(issueId)?.status !== "failed") continue;
    const waiting = queue.find((j: any) => j.issue.id === issueId);
    if (waiting) {
      waiting.instructions = `${waiting.instructions}\n\n${instructions}`;
      continue;
    }
    queue.push({ issue, instructions: `(Runner note: ${why}. Carry on from where it stopped; whatever it changed is still in the workspace.)\n\n${instructions}` });
    await pc.comment(issueId, why.includes("restart") ? "Resumed after a runner restart." : "Resumed: the last run's report didn't get through.").catch(() => {});
    log("resumed after a restart", { issue: issue.identifier });
  }
  drainQueue();
}

async function loop() {
  await resumeInterrupted().catch((err) => log("resume failed", { err: String(err.message ?? err).slice(0, 300) }));
  while (!stopping) {
    try {
      await poll();
    } catch (err: any) {
      log("poll failed", { err: String(err.message ?? err).slice(0, 300) });
    }
    await new Promise((r) => setTimeout(r, (cfg.poll_seconds ?? 20) * 1000));
  }
}

/**
 * A restart (deploys, apply-config): take nothing new, hand the agents' runs to the next runner (they
 * keep running; it adopts them), record jobs not yet started and waiting for it to resume, and exit as
 * soon as nothing is half done: a turn being reported, a publish or an apply, an agent's command.
 */
async function shutdown(code: any, waitMs: any) {
  if (stopping) return;
  stopping = true;
  detach.abort();
  // A job the kernel is starting (`starting`) is waited for below: it is either recorded for the next runner or never started.
  const cut = [...running].filter(([, r]) => r.request !== undefined && !r.pid && !r.starting);
  const jobs = cut.map(([issueId, r]) => ({ issueId, instructions: r.request }));
  for (const j of queue) jobs.push({ issueId: j.issue.id, instructions: j.instructions });
  state.set(RESUME_KEY, JSON.stringify(jobs));
  for (const [, r] of cut) {
    if (r.jobId) state.finishJob(r.jobId, "interrupted", "restart");
    r.controller.abort();
  }
  const halfDone = () => repoHelper.busy() > 0 || [...running.values()].some((r) => r.request === undefined || r.finishing || r.starting);
  log("stopping for a restart", { resume: jobs.length, handed_over: [...running.values()].filter((r) => r.pid && !r.finishing).length });
  for (const end = Date.now() + waitMs; halfDone() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  process.exit(code);
}
// The monitoring module's metrics (metrics.ts): a textfile node-exporter serves; nothing while the module is off.
const saveMetrics = () => {
  try {
    const merges = activeMerges().map((id: any) => mergeQueue(id)).filter(Boolean);
    writeMetrics(cfg.metricsFile, metrics.text({ queued: queue.length, running: [...running.values()], merges }));
  } catch (err: any) {
    log("metrics write failed", { err: String(err.message ?? err).slice(0, 200) });
  }
};

export { RESUME_KEY, adoptRuns, loop, resumeInterrupted, retryTurn, saveMetrics, shutdown, stopping };
