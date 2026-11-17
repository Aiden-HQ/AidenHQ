import { join } from "node:path";
import { pruneReviewedRefs } from "../../../../modules/codehost-github/src/workspace.ts";
import { board, cfg, log, pc, queue, running, state } from "./context.ts";
import { closeStaleRoutineRuns, startRecurringRuns } from "./activity.ts";
import { REVIEWED_RETENTION_DAYS, closeReviewedTasks, closeSupersededDesignReviews, watchProductPrs } from "./watch.ts";
import { dispatchReplies, drainQueue, handleIssue } from "./dispatch.ts";
import { advanceMerges, mergeCheck, runAutoMerges } from "./merge.ts";
import { runGrades } from "./grading.ts";
import { runReviews } from "./card-review.ts";
import { runApprovals } from "./approvals.ts";
import { runTrialEdits } from "./apply-path.ts";
import { RESUME_KEY, reportError, resumeInterrupted, stopping } from "./unsplit.ts";

// ------------------------------------------------------------------ polling

const CLOSED = ["done", "cancelled"];

/**
 * A run whose task was closed while it ran (the owner cancelled it, or marked it done) is stopped, as a "stop" comment
 * stops it: a closed task drops out of the open-task lists, so nothing else would end the run or free its box.
 */
async function stopClosedRuns() {
  for (const [issueId, r] of running) {
    if (!r.pid || r.finishing || r.closed) continue;
    const status = (await pc.issue(issueId).catch(() => undefined))?.status;
    if (!CLOSED.includes(status)) continue;
    r.closed = status;
    log("task closed while running: stopping the run", { issue: r.identifier, status });
    r.controller.abort();
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].issue.id === issueId) queue.splice(i, 1);
  }
}

/** Issue id → the updatedAt it was last handled at, this process's lifetime (a restart handles each once more). */
const handledAt = new Map();

async function poll() {
  const since = state.get("last_poll");
  const now = new Date().toISOString();
  // Turns kept because their end couldn't be reported (retryTurn): run again now (those Paperclip still can't answer for stay kept).
  if (!stopping && JSON.parse(state.get(RESUME_KEY) || "[]").length) await resumeInterrupted();
  // Overlap the window so comments landing during a poll are never missed (handled IDs dedupe).
  const updatedSince = since ? new Date(Date.parse(since) - 120_000).toISOString() : undefined;
  // Writes the user approved first, before anything else the tick reads: an approved card must be claimed and run even
  // when the task list, a merge or a GitHub read fails or is slow this time round. Every poll.
  await runApprovals().catch((err) => log("approvals check failed", { err: String(err.message ?? err).slice(0, 300) }));
  // Tasks labelled "engineer" or assigned to an Engineer agent.
  const byId: any = new Map((await pc.labelledIssues(cfg.label, updatedSince)).map((i: any) => [i.id, i]));
  const engineers = await pc.engineerAgents().catch(() => []);
  if (engineers.length) agentCaps = new Map(engineers.filter((a) => Number.isInteger(a.metadata?.maxParallel)).map((a) => [a.id, a.metadata.maxParallel]));
  for (const a of engineers) for (const i of await pc.assignedIssues(a.id, updatedSince)) byId.set(i.id, i);
  const engineerIds = new Set(engineers.map((a) => a.id));
  // The overlap window lists each update for about seven polls: an issue already handled at this updatedAt (a comment
  // bumps it) is skipped, which saves Paperclip a comments read (and often an issue read) per issue per poll.
  for (const issue of byId.values()) {
    if (issue.updatedAt && handledAt.get(issue.id) === issue.updatedAt) continue;
    try {
      await handleIssue(issue, engineerIds);
      handledAt.set(issue.id, issue.updatedAt);
    } catch (err) {
      await reportError(issue, err);
    }
  }
  await stopClosedRuns().catch((err) => log("closed-task check failed", { err: String(err.message ?? err).slice(0, 300) }));
  // Replies: all of your open tasks (comments don't reliably bump "updated"), at most once a minute.
  if (cfg.replies?.enabled !== false && Date.now() - lastReplyCheck >= 60_000) {
    lastReplyCheck = Date.now();
    await dispatchReplies().catch((err) => log("reply dispatch failed", { err: String(err.message ?? err).slice(0, 300) }));
  }
  // Review requests you already handled on GitHub.
  if (cfg.reviews?.enabled !== false && Date.now() - lastReviewCheck >= (cfg.reviews?.interval_minutes ?? 5) * 60_000) {
    lastReviewCheck = Date.now();
    await closeReviewedTasks().catch((err) => log("review check failed", { err: String(err.stderr || err.message || err).slice(0, 300) }));
  }
  // The product repo's open PRs (product-prs.ts): Dependabot's become the Platform Engineer's tasks, conflicts wake theirs.
  if (Date.now() - lastProductPrCheck >= 60_000) {
    lastProductPrCheck = Date.now();
    await watchProductPrs().catch((err) => log("product PR check failed", { err: String(err.stderr || err.message || err).slice(0, 300) }));
  }
  // Recurring tasks that are due, at most once a minute.
  if (board && Date.now() - lastRecurringCheck >= 60_000) {
    lastRecurringCheck = Date.now();
    await startRecurringRuns().catch((err) => log("recurring check failed", { err: String(err.message ?? err).slice(0, 300) }));
  }
  // Routine runs left blocked after a later run of the same routine succeeded, every 10 minutes.
  if (Date.now() - lastStaleCheck >= 10 * 60_000) {
    lastStaleCheck = Date.now();
    await closeStaleRoutineRuns().catch((err) => log("stale routine check failed", { err: String(err.message ?? err).slice(0, 300) }));
  }
  // Reviewed heads kept for a rejected `pr` card (refs/reviewed/…) past their retention, once a day.
  if (Date.now() - lastReviewedSweep >= 24 * 60 * 60_000) {
    lastReviewedSweep = Date.now();
    await pruneReviewedRefs(join(cfg.workDir, "repos"), { days: REVIEWED_RETENTION_DAYS }).catch((err) => log("reviewed refs not pruned", { err: String(err.message ?? err).slice(0, 200) }));
  }
  // Design-review tasks whose head moved on, or whose verdict is in: closed as superseded, once a minute.
  if (Date.now() - lastDesignReviewSweep >= 60_000) {
    lastDesignReviewSweep = Date.now();
    await closeSupersededDesignReviews().catch((err) => log("superseded design review sweep failed", { err: String(err.message ?? err).slice(0, 300) }));
  }
  // Merges you asked for, at most once a minute; independent agents-org queues (owner, 2026-11-12) every poll.
  const minute = Date.now() - mergeCheck.last >= 60_000;
  if (minute) mergeCheck.last = Date.now();
  await advanceMerges({ minute }).catch((err) => log("merge check failed", { err: String(err.message ?? err).slice(0, 300) }));
  // Agents-org merge requests (owner, 2026-11-12): Tier 0 starts at once, even during the run; cards wait for its end. Every poll.
  await runAutoMerges().catch((err) => log("auto merges failed", { err: String(err.message ?? err).slice(0, 300) }));
  // Tier 1 cards for the AI reviewer, while autonomy is on. Every poll.
  await runReviews().catch((err) => log("reviews check failed", { err: String(err.message ?? err).slice(0, 300) }));
  // Handbook edits to agents in trial: no tap. Every poll.
  await runTrialEdits().catch((err) => log("trial edits failed", { err: String(err.message ?? err).slice(0, 300) }));
  // Graded done: finished deliverables waiting for the grader (grade.ts). Every poll.
  // Not awaited: a grader call or a slow GitHub read never holds up the poll; one pass at a time.
  if (!gradesRunning) {
    gradesRunning = true;
    runGrades()
      .catch((err) => log("grading failed", { err: String(err.message ?? err).slice(0, 300) }))
      .finally(() => (gradesRunning = false));
  }
  state.set("last_poll", now);
  drainQueue();
}

// ------------------------------------------------------------------ stale routine runs

let lastStaleCheck = 0;

// ------------------------------------------------------------------ recurring tasks

let lastRecurringCheck = 0;

// ------------------------------------------------------------------ review requests → GitHub

let lastReviewCheck = 0;

// ------------------------------------------------------------------ the product repo's open PRs

let lastProductPrCheck = 0;

let lastDesignReviewSweep = 0;
let lastReviewedSweep = 0;

let gradesRunning = false;


// ------------------------------------------------------------------ replies → Researcher

/**
 * Your comments on your own open tasks go to the Researcher ("Process task replies"),
 * after a short quiet period so a follow-up comment or closing the task is taken into account.
 * Review tasks (ops-mcp) and engineer tasks (this runner) have their own handlers.
 */
let lastReplyCheck = 0;

/**
 * An agent's own cap on its parallel jobs (`max_parallel` on its definition; setup puts it in the agent's metadata), on
 * top of the host's `max_concurrent`. Without one, only the host's cap applies. Each job has its own task workspace.
 */
let agentCaps = new Map();

export { CLOSED, agentCaps, poll };
