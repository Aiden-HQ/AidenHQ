import { ACTIVITY_QUERY, activityComment, activitySearches, formatRepo, staleRoutineRuns } from "../recurring.ts";
import { board, boardApi, cfg, execFileP, log, pc, queue, running, state } from "./context.ts";
import { activeMerges, findRealGh, mergeQueue, runnerKey } from "./unsplit.ts";

/** A routine run that ended blocked stays open forever; once a later run of that routine succeeds, it's moot: cancel it. */
async function closeStaleRoutineRuns() {
  const blocked = await pc.routineRuns("blocked");
  const routines = [...new Set(blocked.filter((b: any) => b.originKind === "routine_execution" && b.originId).map((b: any) => b.originId))];
  const done = (await Promise.all(routines.map((id: any) => pc.routineRuns("done", id, 5)))).flat();
  for (const { issue, by } of staleRoutineRuns(blocked, done)) {
    await pc.setStatus(issue.id, "cancelled", `Closed: a later run of this routine (${by.identifier}) succeeded.`);
    log("stale routine run cancelled", { issue: issue.identifier, by: by.identifier });
  }
}

// ------------------------------------------------------------------ model usage for the board's Costs tab

/** One usage record to the board (Paperclip doesn't see the runner's model calls). Best effort: a lost record only skews the estimate. */
function reportUsage(record: any) {
  if (!boardApi || !record) return;
  boardApi.post("/internal/usage", record, runnerKey()).catch((err: any) => log("usage report failed", { err: String(err.message ?? err).slice(0, 200) }));
}

// ------------------------------------------------------------------ activity for the board's Agents view

let activityError = "";
/** Tell the board what is running, queued and recently finished: every 30 seconds and on every job start and end. */
function reportActivity() {
  if (!boardApi) return;
  const merging = activeMerges()
    .map((issueId: any) => [issueId, mergeQueue(issueId)])
    .filter(([issueId, q]: any) => q?.state === "running" && !running.has(issueId))
    .map(([issueId, q]: any) => ({ issueId, identifier: q.identifier, startedAt: q.startedAt, engine: q.engine, mode: "merging PRs", repo: [...new Set(q.prs.map((p: any) => p.repo))].join(", ").slice(0, 200) }));
  const body = {
    running: [...[...running.entries()].map(([issueId, r]) => ({ issueId, identifier: r.identifier, startedAt: r.startedAt, ...(r.info ?? {}), ...(r.progress ?? {}) })), ...merging].slice(0, 50),
    queued: queue.filter((j: any) => !running.has(j.issue.id)).map((j: any) => ({ issueId: j.issue.id, identifier: j.issue.identifier })),
    recent: state.recentJobs(15).map((j) => ({ issueId: j.issue_id, identifier: j.identifier, engine: j.engine ?? undefined, status: j.status, startedAt: j.started_at, finishedAt: j.finished_at })),
    latest: state.latestJobs(200).map((j) => ({ identifier: j.identifier, status: j.status })),
  };
  boardApi.post("/internal/runner/activity", body).then(
    () => (activityError = ""),
    (err: any) => {
      const msg = String(err.message ?? err).slice(0, 200);
      if (msg !== activityError) log("activity report failed", { err: msg });
      activityError = msg;
    },
  );
}

let progressReport;
/** A running agent's words or task list changed: report it, at most every 5 seconds. */
function reportProgress() {
  progressReport ??= setTimeout(() => {
    progressReport = undefined;
    reportActivity();
  }, 5_000);
}

/**
 * The board creates the user's task for each due run (top of Today) and hands it here: add the
 * period's GitHub activity for the definition's repositories, then start the Researcher on it.
 */
async function startRecurringRuns() {
  for (const run of await board.claim()) {
    try {
      const digestKey = `recurring_digest:${run.outputId}`;
      if (run.repos.length && !state.get(digestKey)) {
        await pc.comment(run.outputId, await githubActivity(run));
        state.set(digestKey, new Date().toISOString());
      }
      await pc.runRoutine(cfg.recurring?.routine ?? "Run recurring task", {
        definition: run.definition,
        task: run.output,
        since: run.sinceLocal,
        until: run.untilLocal,
        timezone: run.timezone,
        previous: run.previous ?? "none (first run)",
      });
      await board.runState(run, "started");
      log("recurring run started", { definition: run.definition, output: run.output, occurrence: run.occurrence, repos: run.repos.length, attempt: run.attempt });
    } catch (err: any) {
      log("recurring run failed to start", { output: run.output, attempt: run.attempt, err: String(err.message ?? err).slice(0, 300) });
      // Left claimed: the board hands it out again in a few minutes, and says so on the task if it never starts.
    }
  }
}

/** The period's activity in each repository: fixed read-only GraphQL with your gh login. */
async function githubActivity(run: any) {
  const gh = await findRealGh();
  const sections = [];
  for (const repo of run.repos) {
    const [owner, name] = repo.split("/");
    const q = activitySearches(repo, run.since, run.until);
    try {
      const args = ["api", "graphql", "-f", `query=${ACTIVITY_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `since=${run.since}`, "-f", `until=${run.until}`];
      for (const [k, v] of Object.entries(q)) args.push("-f", `${k}=${v}`);
      const { stdout } = await execFileP(gh, args, { maxBuffer: 16 * 1024 * 1024 });
      sections.push(formatRepo(repo, JSON.parse(stdout).data, run.since, run.until));
    } catch (err: any) {
      sections.push(formatRepo(repo, undefined, run.since, run.until, String(err.stderr || err.message || err).split("\n")[0]));
    }
  }
  return activityComment(run, sections);
}

export { closeStaleRoutineRuns, reportActivity, reportProgress, reportUsage, startRecurringRuns };
