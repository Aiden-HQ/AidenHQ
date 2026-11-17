import { createHash, randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { RUNNER_MARKER, hasMarker, crewNames, personaFor, pickerFor, engineLabel, engineOf, resolveEngine } from "../agents.mjs";
import { engineState, followJob, jobcapServers, jobcapsFor, launcher, modelToken, observes, releaseBox, viaGateway } from "../engines.mjs";
import { gcpSession } from "../gcp.ts";
import { outputs, shareOutputs, syncFiles } from "../files.ts";
import { identityEnv, jobGhToken } from "../../../../modules/codehost-github/src/github-app.ts";
import { withParent } from "../intake.ts";
import { retryTransient, shouldRetryTurn } from "../retry.ts";
import { branchesFooter, slackSources, firstPrompt, followUpPrompt, runOutcome } from "../prompt.ts";
import { staleRef } from "../progress.ts";
import { readDocument } from "../primer.ts";
import { dirtyCheckouts, workspaceRepos, UserError, safeWorkspace } from "../../../../modules/codehost-github/src/workspace.ts";
import { REPLY_MARKER } from "../thread.ts";
import { jobUsage } from "../usage.ts";
import { app, appFor, botIdentity, cfg, detach, jobsApi, log, logsDir, metrics, pc, running, state } from "./context.ts";
import { CLOSED } from "./poll.ts";
import { reportActivity, reportProgress, reportUsage } from "./activity.ts";
import { conversation, dispatch, drainQueue, repoCandidates, setMainRepo, syncPicker } from "./dispatch.ts";
import { remember } from "./merge.ts";
import { mayClose } from "./grading.ts";
import { readGrants, showFleetDiff } from "./apply-path.ts";
import { crewContext, crewParent, runCommand } from "./commands.ts";
import { publishToPrimer, reportToParent } from "./report.ts";
import { RESUME_KEY, branchRows, branchTips, leaveFinishedPrs, logTail, missingRepo, prepareWorkspace, rememberRepos, repoHelper, repoInfo, reportError, retryTurn, stopping, tidyBranches } from "./unsplit.ts";

/** The card's branch or head moved before review: the card is stale, not rejected, and costs no review slot. */
class MovedHead extends UserError {}

/**
 * One turn of the Engineer's conversation on a task (docs/design/conversational-engineers.md): the
 * user's new comments (or their own task's description) go to the agent with the whole task in context;
 * its reply goes on the task. The agent decides what to do; its GitHub writes go through its tools.
 */
async function startJob({ issue, instructions }: any) {
  const controller = new AbortController();
  let gcp: any;
  running.set(issue.id, { controller, identifier: issue.identifier, startedAt: new Date().toISOString(), request: instructions, agent: issue.assigneeAgentId });
  reportActivity();
  let jobId;
  let tools: any; // the run's `aidenhq` context: what it asked for after the run (merges, engine, reset, cleanup)
  let launched; // the run, once the agent is going: its turn ends in finishTurn
  let box; // a box job's box (POST /job): released before anything inspects the workspace
  let handedOver = false; // started just as the runner stops: the next runner follows it
  try {
    // Recorded before any setup can fail: a job that died while preparing its workspace still counts as having run
    // (its delegator's follow-up is only read on a task with history).
    remember(issue.id, instructions);
    const full = await pc.issue(issue.id);
    // Queued, then closed before a slot freed: the job no longer has a task to do (a cancelled TEST task opened a PR).
    if (["cancelled", "done"].includes(full.status)) {
      log("queued job dropped: task closed", { issue: issue.identifier, status: full.status });
      return;
    }
    // Every repository the request, the task and the task it is part of name joins the workspace
    //; the first leads. None named: the workspace starts empty, and the agent clones what it needs.
    const parent = await crewParent(full).catch(() => undefined);
    const named = await repoCandidates(`${instructions}\n${full.title}\n${withParent(full.description, parent)}`);
    // A name in the text that isn't a repository on GitHub (a path such as `org/apps`, a new app's repo not created yet)
    // never joins the workspace, and is never created: the agent is told.
    const missing: any = [];
    for (const c of named) if (await missingRepo(c)) missing.push(c);
    const candidates = named.filter((c) => !missing.includes(c));
    if (missing.length) {
      log("named repos missing", { issue: issue.identifier, repos: missing });
      instructions = `(Runner note: ${missing.map((m: any) => `\`${m}\``).join(", ")} ${missing.length === 1 ? "is" : "are"} named here but ${missing.length === 1 ? "doesn't" : "don't"} exist on GitHub, so ${missing.length === 1 ? "it isn't" : "they aren't"} in the workspace. Naming a repository never creates it. Only when this task asks you to build a new app in a new repository, \`aidenhq create-repo <org/name>\` asks for it on an approval card.)\n\n${instructions}`;
    }
    let task = state.task(issue.id);
    if (!task.repo && candidates.length) task = await setMainRepo(issue, candidates[0]);
    rememberRepos(issue.id, candidates.filter((c) => c.toLowerCase() !== String(task.repo).toLowerCase()));
    task = await syncPicker(issue, full, task);
    const engine = task.engine ?? resolveEngine({}, cfg);

    const workspace = await prepareWorkspace(issue, state.task(issue.id), { copy: Boolean(engine.box) });
    // The folder a job gets read-write: inside the work dir, no symlink on the way (bwrap would bind its target).
    safeWorkspace(cfg.workDir, workspace);
    // PRs merged or closed since the last run: never keep working on them.
    const prNotes = await leaveFinishedPrs(issue, workspace);
    if (prNotes.length) instructions = `(Runner note: ${prNotes.join(" ")} Build on what is there now.)\n\n${instructions}`;
    const repos = await repoInfo(workspace, { naming: issue });
    // A brief naming a commit or branch that isn't there is the delegator's to fix: the job never starts on it.
    const stale = await staleRef(`${instructions}\n${full.description ?? ""}`, repos.map((r) => r.path));
    if (stale) throw new UserError(`Not started: ${stale}. Fix the brief and send it again.`);
    state.updateTask(issue.id, { engine });
    // Grafana and Google Cloud reads for an Engineer with private reads: a one-hour gcloud token of the job's own.
    gcp = observes(engine) && !engine.box
      ? await gcpSession({ credentialsFile: cfg.gcp.credentialsFile, dir: join(cfg.stateDir, "gcloud", issue.identifier), project: cfg.gcp.projects[0], log: (m, f) => log(m, { issue: issue.identifier, ...f }) })
      : undefined;
    if (gcp && gcp.state !== "ok" && gcp.state !== "missing") log("gcp unavailable for the job", { issue: issue.identifier, state: gcp.state, detail: gcp.detail });

    // The job's log is the kernel's (its path comes back when the job starts).
    let logPath = "";
    jobId = state.startJob(issue.id, engineLabel(engine), "");
    Object.assign(running.get(issue.id), { jobId, info: { engine: engineLabel(engine), mode: "working", repo: repos.map((r) => r.slug).join(", ").slice(0, 200) } });
    reportActivity();
    // A saved session can only be continued by the engine that created it (engines' sessions are not
    // interchangeable). After a switch the new engine starts fresh, with the
    // whole conversation on the task and the work already on its branches as context.
    const resumed = Boolean(state.task(issue.id).session_id && state.get(`session_engine:${issue.id}`) === engine.kind);
    // The board shows the Engineer at work; the reply is the next comment.
    await pc.startWork(issue.id, "");
    log("job started", { issue: issue.identifier, repos: repos.map((r) => r.slug), engine: engine.kind, resumed });

    const branches = state.branches(issue.id);
    const files = await syncFiles(pc, full, workspace, log, new Set(Object.values(sharedOutputs(issue.id)).map((f: any) => f.id)));
    const primer = primerRecord(issue.id);
    // The task this is part of and what the others on it found: on the first run, then again when it changed.
    const crewCtx = await crewContext(full).catch((err) => (log("crew context unavailable", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) }), undefined));
    const crewKey = `crew:${issue.id}`;
    const crewHash = crewCtx ? createHash("sha256").update(JSON.stringify(crewCtx)).digest("hex") : "";
    const crew = crewCtx && (!resumed || state.get(crewKey) !== crewHash) ? crewCtx : undefined;
    if (crewHash) state.set(crewKey, crewHash);
    const engineers = await pc.engineerAgents().catch(() => []);
    // A specialised Engineer (Platform Engineer) brings its own handbook; the others share one persona per engine.
    const assigned = engineers.find((a) => a.id === full.assigneeAgentId);
    const brief = typeof assigned?.metadata?.brief === "string" ? assigned.metadata.brief : "";
    const build = typeof assigned?.metadata?.build === "string" ? assigned.metadata.build : "";
    const persona = brief ? undefined : personaFor(engine.kind, engineers, assigned);
    // Billed to the Engineer (a label-only task: the first one on its engine, else on a gateway engine).
    const agentId = assigned?.id ?? (engineers.find((a) => a.metadata?.box !== true && engineOf(a) === engine.kind) ?? engineers.find((a) => a.metadata?.box !== true && viaGateway(cfg, engineOf(a))))?.id ?? null;
    // The agent's jobcaps (grants table): its reads of connections, through the gateway with the job token. A box job reaches
    // its connections through the launcher instead.
    const jobcaps = engine.box ? [] : jobcapsFor(cfg, engine, readGrants()?.agents?.[agentId]?.jobcaps ?? []);
    const reading = new Set(jobcapServers(cfg, jobcaps).map((s) => s.name));
    // Private reads for an Engineer with them, and the Slack messages the task came from.
    const observe = observes(engine) && !engine.box
      ? {
          grafana: reading.has("grafana"),
          slack: reading.has("slack"),
          glean: reading.has("glean"),
          clickhouse: reading.has("clickhouse"),
          sources: slackSources(`${full.description ?? ""}\n${parent?.description ?? ""}\n${instructions}`),
          gcp: { state: gcp.state, detail: gcp.detail, projects: cfg.gcp.projects },
        }
      : undefined;
    // Comments while it works reach an engine that takes them (live_input).
    const channel: any = {};
    Object.assign(running.get(issue.id), { channel, who: persona?.name });
    // The conversation (all of it for a new session, what's new for a resumed one) and where the work stands.
    const { thread, stand } = await conversation(issue, workspace, { instructions, resumed, persona });
    // A box job works in /workspace: the prompt names the paths it sees.
    const seen = engine.box ? { workspace: "/workspace", repos: repos.map((r) => ({ ...r, path: r.path.replace(workspace, "/workspace") })) } : { workspace, repos };
    const prompt = resumed
      ? followUpPrompt({ user: cfg.selfName, instructions, ...seen, branches, files, primer, crew, observe, thread, stand, brief })
      : firstPrompt({ user: cfg.selfName, task: full, ...seen, branches, instructions, files, primer, persona, crew, observe, thread, stand, team: crewNames(engineers), brief, build });
    const tipsBefore = await branchTips(workspace);
    const identity = await botIdentity();
    const ghToken = await jobGhToken(app, repos.map((r) => r.slug), appFor).catch((err) => (log("no gh token for the job", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) }), undefined));
    // A box job: its box first (the task's last one confirmed gone), bound to this task and to the helper token it will use.
    const helperToken = randomBytes(24).toString("hex");
    if (engine.box) box = await startBox({ issue, agentId, workspace, helperToken, identity, engine });
    if (stopping) return; // the runner is restarting: the job resumes after it (RESUME_KEY)
    tools = { issue, workspace, instructions, brief: Boolean(brief), kind: engine.kind, reads: observes(engine), who: persona?.name, signal: controller.signal, jobId, box, agentId };
    const helper = repoHelper.register(tools, helperToken);
    const sessionId = resumed ? state.task(issue.id).session_id : undefined;
    // The kernel starts the job (its sandbox, limits and adoption are the kernel's). A restart waits for this answer
    // (`starting`), so the job is either recorded here for the next runner or never started.
    running.get(issue.id).starting = true;
    let started: any;
    try {
      started = await jobsApi.start({
        agent: agentId, task: issue.id, label: issue.identifier, workspace: { module: "engineering", id: basename(workspace) }, prompt,
        ...(sessionId ? { session: sessionId } : {}), engine: { kind: engine.kind, model: engine.model ?? "", effort: engine.effort ?? "" },
        env: { ...helper.env, ...identityEnv(identity), ...(ghToken ? { GH_TOKEN: ghToken, AIDENHQ_GH_AUTH: ghToken } : {}) },
        ...(gcp ? { cloud: { root: gcp.root, env: gcp.env } } : {}), ...(box ? { box } : {}),
      });
    } finally {
      running.get(issue.id).starting = false;
    }
    logPath = started.log;
    state.setJobLog(jobId, logPath);
    // What the next runner needs to follow the job and finish its turn after a restart. The job's gateway credential comes from
    // its agent, task, jobcaps and start time: `aidenhq advise` mints the same one (advise.ts).
    tools.run = { kernelJob: started.id, pid: started.pid, token: helper.token, startedAt: started.at, sessionId, workspace, engine, tipsBefore, instructions, brief: Boolean(brief), who: persona?.name, agentId, jobcaps: started.jobcaps, observing: started.observing, repos: running.get(issue.id).info.repo, ...(box ? { box } : {}) };
    state.saveRun(jobId, tools.run);
    Object.assign(running.get(issue.id), { pid: started.pid, logPath });
    if (started.live_input) channel.send = (text: any) => jobsApi.input(started.id, text);
    if (stopping) return void (handedOver = true); // the next runner follows it (state.runningJobs): its box and session stay
    const watch = followJob(jobsApi, started.id, { signal: controller.signal, detach: detach.signal, onProgress: progressOf(issue.id), log });
    launched = { issue, full, workspace, engine, jobId, logPath, tipsBefore, tools, gcp, helper, watch, box, keep: box && keepBox(issue, box, helper) };
  } catch (err) {
    if (stopping) return;
    if (jobId) state.finishJob(jobId, "failed", String(err).slice(0, 500));
    // A turn that failed before its run started (its workspace couldn't be prepared) is still this task's latest job:
    // recorded, it reads as failed, never as the run before it ("Done, nothing changed", on a task that did nothing).
    else {
      try {
        const id = state.startJob(issue.id, "", join(logsDir, `${issue.identifier}-${Date.now()}.log`));
        state.finishJob(id, "failed", `setup: ${String(err).slice(0, 480)}`);
      } catch (e: any) {
        log("couldn't record the failed setup", { issue: issue.identifier, err: String(e.message ?? e).slice(0, 200) });
      }
    }
    await reportError(issue, err);
  } finally {
    if (!launched && !handedOver) {
      // A box that never got its run (a failed start, a restart): destroyed, never left holding the task.
      if (box) await stopBox(issue, box).catch((err) => log("box release failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 300) }));
      gcp?.done();
      await endTurn(issue, tools);
    }
  }
  if (launched) await finishTurn(launched);
}

const progressOf = (issueId: any) => (p: any) => (Object.assign(running.get(issueId) ?? {}, { progress: p }), reportProgress());

// ------------------------------------------------------------------ box jobs (an Engineer with a computer)

const boxCall = launcher(cfg);
const boxKey = (issueId: any) => `box:${issueId}`;
const helperPort = () => Number(new URL(repoHelper.url()).port);

/**
 * A box for this turn of a box job: the task's last box released first (confirmed gone: two executions never share a
 * workspace), its engine's state folder and HOME ready, then POST /job; the task → box link is saved before anything runs in it.
 */
async function startBox({ issue, agentId, workspace, helperToken, identity, engine }: any) {
  const before = state.get(boxKey(issue.id));
  if (before) await stopBox(issue, { container: before });
  const box: any = await boxCall("/job", { agentId, issueId: issue.id, identifier: issue.identifier, workspace, engine: engine.kind, state: engineState(cfg, engine.kind, issue.id), helperPort: helperPort(), helperToken, identity: { name: identity.name, email: identity.email } });
  state.set(boxKey(issue.id), box.container);
  log("box job started", { issue: issue.identifier, container: box.container });
  return { container: box.container, envFile: box.envFile, outDir: box.outDir };
}

/** The lease, renewed while this runner follows the job (every 5 minutes; it lapses after 15). Returns the stop function. */
function keepBox(issue: any, box: any, helper: any) {
  const renew = () => boxCall("/job/renew", { container: box.container, issueId: issue.id, helperPort: helperPort(), helperToken: helper.token }).catch((err) => log("box renewal failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) }));
  const t = setInterval(renew, 5 * 60_000);
  t.unref();
  return () => clearInterval(t);
}

/** Destroy the task's box and wait until it is gone; only then may anything inspect, sign or clean its workspace. */
async function stopBox(issue: any, box: any) {
  await releaseBox(boxCall, box.container);
  if (state.get(boxKey(issue.id)) === box.container) state.set(boxKey(issue.id), "");
  log("box job released", { issue: issue.identifier, container: box.container });
}

/** The agent's tools changed what its turn does after the run (reset, engine, cleanup): kept for the runner that adopts it. */
function saveTools(ctx: any) {
  if (ctx.run) state.saveRun(ctx.jobId, { ...ctx.run, reset: ctx.reset, switchTo: ctx.engine, cleanup: ctx.cleanup, advised: ctx.advised?.advisor ?? ctx.run.advised });
}

/** A turn is over (finished, failed, or cut off before its run started): what the agent asked for, then the next job. */
async function endTurn(issue: any, tools: any) {
  const started = Date.parse(running.get(issue.id)?.startedAt ?? "");
  if (started) metrics.jobEnded((Date.now() - started) / 1000);
  running.delete(issue.id);
  // While the runner restarts nothing more starts or reports: the job resumes after it.
  if (stopping) return;
  await afterTurn(issue, tools).catch((err) => reportError(issue, err));
  drainQueue();
  reportActivity();
  void retryTransient(() => reportToParent(issue)).catch((err) => log("parent summary failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 300) }));
}

/**
 * The end of an Engineer's turn: its reply, branches and outputs on the task. The same for a run this
 * runner started and for one it adopted after a restart (`full` unknown until now).
 */
async function finishTurn({ issue, full, workspace, engine, jobId, logPath, tipsBefore, tools, gcp, helper, watch, box, keep }: any) {
  let result;
  let reporting = false;
  try {
    result = await watch;
    keep?.();
    // The runner is restarting: the job goes on in the kernel (its box too, on its lease), and the next runner finishes this turn.
    if (result.detached) return;
    Object.assign(running.get(issue.id) ?? {}, { finishing: true });
    helper.done();
    // The job died while no kernel followed it (a reboot): resumed in the same workspace and session, like a cut-off turn.
    if (result.lost) {
      if (box) await stopBox(issue, box);
      state.finishJob(jobId, "interrupted", "lost");
      state.set(RESUME_KEY, JSON.stringify([...JSON.parse(state.get(RESUME_KEY) || "[]"), { issueId: issue.id, instructions: tools?.instructions ?? "" }]));
      return void log("job lost: resuming", { issue: issue.identifier });
    }
    // A box job's process may outlive its `docker exec` client (a cancel, a timeout): the box goes, confirmed, before
    // anything below reads, signs or cleans the workspace. If it can't be confirmed, nothing below runs.
    if (box) await stopBox(issue, box);
    if (result.sessionId) {
      state.updateTask(issue.id, { session_id: result.sessionId });
      state.set(`session_engine:${issue.id}`, engine.kind);
    }
    // Closed while it ran: the task stays closed. A status or a reply here would reopen it (and send it to the grader).
    const closed = running.get(issue.id)?.closed ?? [(await retryTransient(() => pc.issue(issue.id)).catch(() => undefined))?.status].find((s) => CLOSED.includes(s));
    if (closed) {
      state.finishJob(jobId, "cancelled", `task ${closed}`);
      log("job stopped: its task was closed", { issue: issue.identifier, status: closed });
      return;
    }
    // Adopted: the task as it is now (its tools' context holds the same issue object).
    if (!full) Object.assign(issue, (full = await retryTransient(() => pc.issue(issue.id))));

    if (result.cancelled) {
      state.finishJob(jobId, "cancelled");
      await retryTransient(() => pc.setStatus(issue.id, "in_review", "Stopped on request. Whatever the run had changed is still in the workspace."));
      return;
    }

    reporting = true; // from here a transient failure may run the turn again (retryTurn); a stop or a closed task never gets here
    const after = await workspaceRepos(workspace);
    // Agents commit as they go: the run changed something if any branch moved or appeared.
    const committedNow = (await branchTips(workspace)) !== tipsBefore;
    // A failed or timed-out run says what it left behind (uncommitted changes, or commits), never "Nothing was changed" when it did.
    const dirtyNow = (await dirtyCheckouts(after)).length > 0;
    const outcome = runOutcome({ ...result, timeoutMinutes: cfg.timeout_minutes ?? 60, dirty: dirtyNow, committed: committedNow });
    // Put every commit on a properly named branch and sign the agent's commits. What's left
    // uncommitted stays as it is: the agent commits what it means to keep.
    const tidyNotes = await tidyBranches(issue, workspace);
    const rows = await branchRows(issue, workspace);
    // The heads this run ended on, for the parent's run-end receipt: the exact commits a pending pr/merge card would cover.
    state.set(`heads:${issue.id}`, JSON.stringify(rows.filter((r) => !r.merged && !r.readOnly && (r.unpublished.length || !r.prUrl) && r.head).map(({ repo, branch, head }) => ({ repo, branch, sha: head }))));
    const stillDirty = (await dirtyCheckouts(after)).length > 0;
    const primerNote = outcome.finished ? await publishToPrimer(issue, full, workspace, tools?.agentId ?? null) : "";
    const sharedNote = outcome.finished ? await shareWork(issue, full, workspace) : "";
    const footer = [
      committedNow || tidyNotes.length ? branchesFooter(rows) : "",
      ...tidyNotes.map((n) => `_${n}_`),
      stillDirty ? "_The workspace has uncommitted changes._" : "",
      outcome.finished && tools?.brief ? await showFleetDiff(issue, workspace) : "",
    ].filter(Boolean);
    // The turn's outcome is recorded before its reply goes out: the reply is what the board and a test see first, and a job
    // still reading "running" beside a finished turn makes a report wait on a row that only the rest of this function sets.
    state.finishJob(jobId, result.timedOut ? "timeout" : result.code ? "failed" : outcome.finished ? "done" : "incomplete", rows.some((r) => r.unpublished.length) ? "committed" : undefined);
    if (outcome.finished) {
      // The agent's reply, in its own words. None: a comment that needed no answer ("thanks").
      const reply = [outcome.silent ? "" : String(result.lastMessage ?? "").trim(), primerNote, sharedNote, ...(footer.length ? ["---", ...footer] : [])].filter(Boolean).join("\n\n");
      await retryTransient(() => pc.finishStatus(issue.id, "in_review", reply.trim() ? `${REPLY_MARKER}${reply}` : undefined));
      // A graded deliverable's turn ended: the grader looks at it (a task without a rubric passes untouched).
      await mayClose(issue.id, "finish_turn");
    } else {
      // Failures also go to review (Paperclip refuses "blocked" without a blocker); the runner says what failed.
      const report = String(result.lastMessage ?? "").trim();
      const failure = [
        outcome.headline,
        `Last lines of the log:\n\`\`\`\n${logTail(logPath)}\n\`\`\``,
        report ? `The agent's last message:\n\n> ${report.slice(0, 1500).replace(/\n/g, "\n> ")}` : "",
        ...(footer.length ? ["---", ...footer] : []),
        `_${engineLabel(engine)} · log: \`${logPath}\`_`,
      ].filter(Boolean).join("\n\n");
      await retryTransient(() => pc.finishStatus(issue.id, "in_review", failure));
    }
    state.set(`endretry:${issue.id}`, "0");
    log("job finished", { issue: issue.identifier, code: result.code, timedOut: result.timedOut, finished: outcome.finished, branches: rows.length });
  } catch (err) {
    state.finishJob(jobId, "failed", String(err).slice(0, 500));
    // Still unreachable after the retries: the task would sit in progress with no job. The poll runs the turn again
    // (same session and workspace) once Paperclip answers, and the agent reports it.
    if (shouldRetryTurn({ reporting, cancelled: Boolean(result?.cancelled), err, retries: Number(state.get(`endretry:${issue.id}`) || 0) })) retryTurn(issue, "its last run ended, but the runner couldn't report it (the network failed)");
    else await reportError(issue, err);
  } finally {
    if (!result?.detached) {
      // Gateway engines' jobs are billed by the model gateway; only the other engines' tokens are self-reported (usage events).
      if (logPath && !viaGateway(cfg, engine.kind)) reportUsage(jobUsage(logPath, engine, result?.usage));
      gcp?.done();
      await endTurn(issue, tools);
    }
  }
}

/**
 * What the agent asked for with its tools that has to wait for the run to end: a fresh session, an
 * engine switch (then the same request again on the new engine), merges, or removing the workspace.
 */
async function afterTurn(issue: any, tools: any) {
  if (!tools) return;
  if (tools.reset || tools.engine) state.updateTask(issue.id, { session_id: null });
  if (tools.engine) {
    const engineers = await pc.engineerAgents();
    const fields = pickerFor(tools.engine, engineers);
    if (fields) await pc.setPicker(issue.id, fields);
    state.updateTask(issue.id, { engine: tools.engine });
    state.set(`picker:${issue.id}`, new Date().toISOString());
    log("engine switched by the agent", { issue: issue.identifier, engine: tools.engine.kind, model: tools.engine.model });
    return dispatch({ issue, instructions: tools.instructions });
  }
  if (tools.cleanup) await runCommand(issue, state.task(issue.id), "cleanup");
}

// ------------------------------------------------------------------ Primer

const sharedOutputs = (issueId: any) => (state.get(`shared:${issueId}`) ? JSON.parse(state.get(`shared:${issueId}`)) : {});

/**
 * After a finished run: attach what the Engineer made for others (its Primer document, `.aidenhq/out/`)
 * to its task, so the user, the board and the other agents can read it. Resolves with a line for
 * the reply ("" when nothing changed).
 */
async function shareWork(issue: any, full: any, workspace: any) {
  const res = await shareOutputs(pc, issue, outputs(workspace, readDocument(workspace, full.title)), sharedOutputs(issue.id), log);
  if (!res.attached.length) return "";
  state.set(`shared:${issue.id}`, JSON.stringify(res.shared));
  log("outputs attached", { issue: issue.identifier, files: res.attached.length });
  return `_Attached to the task: ${res.attached.map((n) => `\`${n}\``).join(", ")}._`;
}

const primerRecord = (issueId: any) => (state.get(`primer:${issueId}`) ? JSON.parse(state.get(`primer:${issueId}`)) : undefined);
const savePrimer = (issueId: any, record: any) => state.set(`primer:${issueId}`, JSON.stringify(record));

/** The kernel's backplane (POST /v1/writes, GET /v1/writes/:id) as the task's Engineer, with a token naming only primer.publish. */
async function kernelWrites(method: any, path: any, { issue, agentId }: any, body?: any) {
  const token = modelToken(cfg, { kind: "agent", agentId, issueId: issue.id, component: "runner-primer", ttlMs: 120_000, writes: ["primer.publish"] });
  const res = await fetch(`${cfg.kernelUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(String(j?.error?.message ?? `the kernel answered ${res.status}`).slice(0, 300)), { status: res.status });
  return j;
}

/** The owner's own comment on the task names this exact Primer link and asks for it to be updated or published to. */
async function ownerAskedToUpdate(issue: any, url: any) {
  if (!url) return false;
  const comments = await pc.comments(issue.id).catch(() => []);
  return comments.some((c: any) => c.authorType === "user" && !hasMarker(c.body, RUNNER_MARKER) && String(c.body ?? "").includes(url) && UPDATE_WORDS.test(String(c.body)));
}
const UPDATE_WORDS = /\b(publish|update|revise|new version|add (?:a )?version|overwrite|replace|edit|put (?:it|this|the \w+) (?:on|in|into))\b/i;

export { MovedHead, boxCall, finishTurn, helperPort, keepBox, kernelWrites, ownerAskedToUpdate, primerRecord, progressOf, savePrimer, saveTools, startJob, stopBox };
