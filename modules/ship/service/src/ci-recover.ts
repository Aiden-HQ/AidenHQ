// CI recoveries for any open same-repo PR (moved from the watch loop): red checks whose Actions jobs never started (GitHub refused
// them: billing, no runner) are re-run once at the head, never woken for; a check run left not completed while its Actions job
// finished is re-run at its job, once per head and check, so GitHub reposts it. What each asked is kept in the loop's state per
// repo. The answer tells the round: `envRed` (the head's red checks are the environment's, being re-run: no fix wake), and
// `wedgedDue` (a check run still pending 20 minutes after its re-run was asked: no push fixes it, its owner is told).
import { CODE_REVIEW_STATUS, DESIGN_REVIEW_CHECK, GATE_CHECK } from "./aidenhq-sdk/checks.ts";

type Json = any;
/** GitHub through github's /internal/ship/gh; `deadline` bounds a rate-limit wait; `covers`: the check runs (node ids) a check-run
 * list must hold for the change feed's snapshot to answer it instead of GitHub (ship-routes.ts). */
type Gh = (method: string, path: string, body?: unknown, o?: { deadline?: number; covers?: string[] }) => Promise<{ status: number; body: any }>;
/** A GitHub status the credential can never get past (no permission, the resource is gone): retrying cannot help. */
const permanentRefusal = (status: number) => [401, 403, 404].includes(status);
const rollupOf = (pr: Json) => pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
/** A check run left not completed while its Actions job finished is re-run only once the job's completion is this old: a fresh
 * job's check run can lag by seconds, and a spurious re-run wastes a whole run. */
const WEDGED_GRACE_MS = 3 * 60_000;
/** How long after a re-run was asked a check run still not completed is reported to its owner. */
export const WEDGED_REPORT_MS = 20 * 60_000;
/** Actions job reads one PR may spend per pass, serially, so one busy head never holds the others. */
const PROBES_PER_PASS = 10;
/** How long one probe may wait out the owner's rate limit before it is deferred to the next pass. */
const PROBE_DEADLINE_MS = 5_000;
/** A write must see a whole attempt through (the client's 30 s attempt timeout) plus the wait this pass tolerates. */
const RECOVERY_WRITE_DEADLINE_MS = PROBE_DEADLINE_MS + 30_000;
/** A head's checks and jobs are not probed again within this long unless its rollup state changed: the loop reads a busy repo every
 * minute, and a runner outage over many PRs would otherwise spend the owner's REST quota on the same unfinished jobs. */
const PROBE_EVERY_MS = 5 * 60_000;
/** Probe reads of a PR's budget kept free for the never-started path. */
const NEVER_STARTED_RESERVE = 2;

/** `wedgedDue`: a check run on the head still pending 20 minutes after its re-run was asked: "accepted" (GitHub took the re-run),
 * "refused" (it refused it), or false. */
export type Recovery = { envRed: boolean | "unknown"; wedgedDue: "accepted" | "refused" | false; again?: true };

export function ciRecover(o: { gh: Gh; log(msg: string, f?: Record<string, unknown>): void }) {
  const log = o.log;
  return async function recover(repo: string, pr: Json, state: Json, save: () => void): Promise<Recovery> {
    if (pr.isCrossRepository !== false) return { envRed: false, wedgedDue: false };
    const gh = o.gh;
    let probes = 0;
    // One stamp per PR: the head and rollup state it was probed at, when, and what the probe answered.
    const stamps: Record<string, { head: string; seen: string; at: number; result: Recovery }> = state.probed ??= {};
    // What the answer rests on: mergeability and every check's state, so a check finishing or a PR turning mergeable is judged at once.
    const seen = `${pr.mergeable}|${rollupOf(pr)?.state}|${(rollupOf(pr)?.contexts?.nodes ?? []).map((n: Json) => `${n.id ?? n.name ?? n.context}:${n.status ?? n.state}:${n.conclusion ?? ""}`).join(",")}`;
    const stamp = stamps[pr.url.toLowerCase()];
    if (stamp && stamp.head === pr.headRefOid && stamp.seen === seen && Date.now() - stamp.at < PROBE_EVERY_MS) return stamp.result;
    let deferred = false, read = false; // a listing failed or the job budget ran out (the next pass resumes: not stamped, `again`); and whether any REST read was made (else nothing to suppress)
    state.reran ??= {}; state.wedged ??= {}; state.wedgedAt ??= {}; state.neverStartedJudged ??= {};
    /** The head's latest check runs from REST, every page: `runs` and whether GitHub's own `total_count` was all read (a
     * partly read list never stands in for the head's). Null when the read itself failed. */
    async function latestRuns(pr: Json): Promise<{ runs: Json[]; complete: boolean } | null | "permanent"> {
      const head = pr.headRefOid;
      // The rollup's check runs: a snapshot the feed read before one of them appeared can't answer for this head (a whole rollup only).
      const rollup = rollupOf(pr);
      const covers = rollup?.contexts?.pageInfo?.hasNextPage ? undefined : (rollup?.contexts?.nodes ?? []).filter((n: Json) => n.__typename === "CheckRun" && n.id).map((n: Json) => String(n.id));
      read = true;
      const runs: Json[] = [];
      let total = 0;
      try {
        for (let page = 1; page <= 5; page++) {
          // The listing is the recovery paths' first read, so it carries the same read deadline as a job probe: waiting out the
          // owner's quota here would hold this serial scan (every later PR's merge) just as a probe would.
          const listed: { status: number; body: any } = await gh("GET", `/repos/${repo}/commits/${head}/check-runs?filter=latest&per_page=100&page=${page}`, undefined, { deadline: Date.now() + PROBE_DEADLINE_MS, ...(covers ? { covers } : {}) });
          // A permanent refusal (no Checks permission, the head is gone) can never clear: not this rule's, so the red-head rules
          // decide. A transient refusal (a 5xx, a quota) is unjudged: the next tick reads it again.
          if (permanentRefusal(listed.status)) return "permanent";
          if (listed.status >= 300 || !Array.isArray(listed.body?.check_runs)) return null;
          runs.push(...listed.body.check_runs);
          total = Number(listed.body.total_count ?? 0);
          if (runs.length >= total || listed.body.check_runs.length < 100) break;
        }
      } catch (e) {
        // The client answers a refused listing (a 404 for a head it cannot see, a 403 without Checks read) as a typed need, not a
        // status, so a permanent one is "not this rule's" here too rather than an unread head deferred on every tick.
        const cause = (e as { need?: { cause?: string } }).need?.cause ?? (e as { cause?: string }).cause;
        // A `scope` refusal (the credential is not granted Checks read) is as permanent as a 404: the red-head rules report the
        // failure rather than the head deferring on every tick.
        return cause === "unreachable" || cause === "scope" ? "permanent" : null;
      }
      return { runs, complete: !total || runs.length >= total };
    }
    /** The REST check run a rollup node names: REST's `node_id` is the rollup's `id`, its numeric `id` the rollup's `databaseId`. */
    const runOf = (runs: Json[], n: Json) => runs.find((c: Json) => (n.id ? c.node_id === n.id : Number(c.id) === Number(n.databaseId)));
    /** The full Actions job id a check run's `details_url` names: the rollup's 32-bit `databaseId` no longer holds one. */
    const jobIdOf = (run: Json) => String(run.details_url ?? "").match(/\/job\/(\d+)(?:[?#].*)?$/)?.[1];
    /** One Actions job read, charged to this PR's budget: undefined once it is spent, so the rest of this PR's checks (and
     * every later PR's merge) are not held behind a head with many unfinished jobs. The next tick asks the rest. `reserve`
     * keeps that many reads free for the other recovery path, so a head of still-running jobs cannot use the whole budget
     * and leave a failed job that never started unjudged (and so woken as if it had run). */
    async function probeJob(id: string, reserve = 0): Promise<{ status: number; body: any } | undefined> {
      if (probes >= PROBES_PER_PASS - reserve) return undefined;
      probes++;
      // A quota wait is bounded to this read: a recovery probe is never worth stalling the pass (and every later PR's merge) on
      // the owner's rate limit, so one that cannot run promptly is deferred like a read the budget could not cover.
      try { return await gh("GET", `/repos/${repo}/actions/jobs/${id}`, undefined, { deadline: Date.now() + PROBE_DEADLINE_MS }); }
      catch (e) {
        const cause = (e as { need?: { cause?: string } }).need?.cause ?? (e as { cause?: string }).cause;
        if (cause === "rate_limited") return undefined;
        // The client answers a 404 on `/repos/...` as a typed "unreachable" need, not as a status: the job (or the repo) is gone
        // for good, so it is reported as that 404 rather than rethrown (a rethrow would defer this head on every tick forever).
        if (cause === "unreachable") return { status: 404, body: {} };
        // A credential that is not granted Actions read (`scope`) can never read these either: the same permanent refusal. The
        // red-head rules report the failure instead of the head deferring on every tick.
        if (cause === "scope") return { status: 403, body: {} };
        throw e;
      }
    }
    /** Re-run the failed jobs of red checks whose jobs never started, once per head. True when the red checks are all of that kind
     * (or when the pass could not read them yet: the next tick asks again), false when a step ran so the failure is the code's,
     * and `"unknown"` when the head could not be judged at all (the listing failed): the red-head rules then wait a tick rather
     * than wake a task to fix a failure CI never ran. */
    async function neverStarted(pr: Json): Promise<boolean | "unknown"> {
      const rollup = rollupOf(pr);
      const red = (rollup?.contexts?.nodes ?? []).filter((n: Json) => n.__typename === "CheckRun" ? n.status === "COMPLETED" && n.conclusion === "FAILURE" && n.name !== DESIGN_REVIEW_CHECK : ["FAILURE", "ERROR"].includes(n.state) && n.context !== CODE_REVIEW_STATUS);
      if (!red.length || rollup?.contexts?.pageInfo?.hasNextPage) return false;
      const own = red.filter((n: Json) => n.name !== GATE_CHECK); // the aggregate only rolls the others up
      const listed = await latestRuns(pr);
      if (listed === "permanent") return false; // the credential can never list them: not this rule's, so the red-head rules report
      if (!listed || !listed.complete) return "unknown"; // an unread list cannot say a job never started: the next tick judges it
      const unstarted: Json[] = [];
      const checks = own.length ? own : red;
      // Every one of the head's checks must be judged before a re-run is asked (a partly judged head would re-run a job whose
      // sibling did run). What one pass judged is kept for the next, so the budget reads a slice of them, never the same slice.
      const memoKey = `${pr.url.toLowerCase()}:${pr.headRefOid}`;
      const judged: Record<string, { state: "unstarted" | "started"; run?: number }> = state.neverStartedJudged[memoKey] ?? (state.neverStartedJudged[memoKey] = {});
      let spentAll = true;
      for (const n of checks) {
        if (n.__typename !== "CheckRun") return false;
        const id = String(n.id ?? `${n.name}:${n.databaseId ?? ""}`);
        if (judged[id]?.state === "started") return false; // a step ran: it judged the commit
        if (judged[id]?.state === "unstarted") { unstarted.push(n); continue; }
        const run = runOf(listed.runs, n);
        const jobId = run && jobIdOf(run);
        if (!jobId) return false; // no Actions job in REST's own answer: not this rule's
        // One read that times out or is refused must not abort the repo's other PRs (the scan's per-repo catch would skip
        // them all): the check is left unjudged and the next tick reads it. The wedged path wraps its own read the same way.
        let job: { status: number; body: any } | undefined;
        try { job = await probeJob(jobId); }
        catch (e) {
          log("never-started check's job read failed", { pr: pr.url, head: pr.headRefOid, job: jobId, err: String((e as Error).message).slice(0, 200) });
          spentAll = false;
          continue;
        }
        if (!job) { spentAll = false; continue; } // the budget is spent: this check is judged on the next tick
        // A permanent refusal (404: the run was deleted; 401/403: the credential cannot read Actions) can never clear, so it is
        // not this rule's and the red-head rules report the failure; a transient read (a 5xx, a body without steps) cannot say
        // a step ran: unjudged for the next tick, never read as "the code failed" and woken on.
        if ([401, 403, 404].includes(job.status)) return false;
        if (job.status >= 300 || !Array.isArray(job.body?.steps)) { spentAll = false; continue; }
        if (job.body.steps.length) return false; // a step ran: it judged the commit
        if (job.body.head_sha !== pr.headRefOid || !String(job.body.check_run_url ?? "").endsWith(`/check-runs/${run.id}`)) return false;
        // The job's own REST `run_id` is the full workflow-run id the re-run needs: the rollup's `workflowRun.databaseId` is a
        // 32-bit Int, null or truncated past 2^31-1, so it is never what the request is built from.
        const restRun = Number(job.body.run_id);
        if (!Number.isFinite(restRun)) { log("never-started check's job names no run", { pr: pr.url, head: pr.headRefOid, job: jobId }); spentAll = false; continue; }
        judged[id] = { state: "unstarted", run: restRun };
        unstarted.push(n);
      }
      save();
      // Not every check judged yet: the next tick reads the rest, and the red-head rules wait rather than mistake an unprobed
      // job for one that ran.
      if (!spentAll) return true;
      const key = `${pr.url.toLowerCase()}:${pr.headRefOid}`;
      const prior = state.reran[key];
      // Re-ran at this head, or a refusal still backing off: either way nothing is asked this tick.
      if (prior && (!prior.startsWith("retry:") || Date.parse(prior.slice(6)) > Date.now())) return true;
      // Each unstarted check's run, from the job's own REST `run_id` (kept with what was judged, so a check judged on an
      // earlier pass still carries it). A check with no run id asks nothing: a re-run needs the run, not a truncated rollup id.
      const runOfCheck = (n: Json) => judged[String(n.id ?? `${n.name}:${n.databaseId ?? ""}`)]?.run;
      const runs = new Set(unstarted.map(runOfCheck).filter((v): v is number => typeof v === "number" && Number.isFinite(v)));
      if (!runs.size) return false;
      let refused = false, permanent = false, accepted = false;
      // Per-run memory: a run GitHub already took a re-run for is never asked again at this head, so a later pass that still
      // sees another run's refusal does not re-post the one that succeeded.
      const took = state.reranRuns ??= {};
      for (const run of runs) {
        if (took[`${repo.toLowerCase()}:${pr.headRefOid}:${run}`]) { accepted = true; continue; }
        // A re-run that cannot be sent (a timeout, a quota refusal) is this head's problem: backing off and asking again is
        // the fix, never aborting the repo's scan and skipping a later PR's merge for the tick.
        let r: { status: number };
        try { r = await gh("POST", `/repos/${repo}/actions/runs/${run}/rerun-failed-jobs`, {}, { deadline: Date.now() + RECOVERY_WRITE_DEADLINE_MS }); }
        catch (e) {
          // A credential that may not write Actions (`scope`) can never take this re-run: retrying it is pointless, so the head
          // goes to the red-head rules, which tell the task the recovery needs a person. Anything else backs off and retries.
          const cause = (e as { need?: { cause?: string } }).need?.cause ?? (e as { cause?: string }).cause;
          log("never-started re-run failed to send", { pr: pr.url, head: pr.headRefOid, run, cause, err: String((e as Error).message).slice(0, 200) });
          if (cause === "scope" || cause === "unreachable") { permanent = true; continue; }
          refused = true;
          continue;
        }
        log(r.status < 300 ? "checks re-run" : "check re-run refused", { pr: pr.url, head: pr.headRefOid, run, status: r.status });
        if (r.status < 300) { took[`${repo.toLowerCase()}:${pr.headRefOid}:${run}`] = new Date().toISOString(); accepted = true; continue; }
        if (permanentRefusal(r.status)) { permanent = true; continue; } // 401/403/404: never clears, the red-head rules report it
        if (r.status >= 300) refused = true;
      }
      // A re-run GitHub can never accept is not this rule's any more: the red-head rules must report the head, not the scan
      // retry a refused write forever.
      if (permanent && !refused && !accepted) return false;
      if (accepted && !refused) { state.reran[key] = new Date().toISOString(); save(); return true; }
      // Only a re-run GitHub took is recorded as done: one it refused would otherwise leave the head marked as handled with its
      // jobs still never started, so it backs off and is asked again instead of being lost.
      state.reran[key] = refused ? `retry:${new Date(Date.now() + 5 * 60_000).toISOString()}` : new Date().toISOString();
      save();
      return true;
    }
    /**
     * A check run that is not COMPLETED while its Actions job has finished: re-run that job, so GitHub reposts the check run
     * and the merge gate is no longer held by it. Once per head per check, with the refusal backoff `neverStarted` uses (a
     * refused or unanswered re-run is asked again after five minutes, never counted as handled). Not on a cross-repository PR.
     *
     * The check runs come from REST's own list of the head's latest ones (its `details_url` carries the full Actions job id,
     * which the rollup's 32-bit `databaseId` does not), and a job counts only when its own `head_sha` and `check_run_url` name
     * that check run. A re-run gives its job a new id, so what was asked is kept by the repository, head, suite and check name:
     * the replacement of a re-run GitHub took is not re-run again, and a second PR at the same head sees the ask.
     *
     * Returns the checks GitHub has asked about at this head with the check run's own node id, when their re-run was first asked
     * and whether it took it, for the report: a check still wedged after the interval is no longer waited on silently.
     */
    async function wedgedAfterJob(pr: Json): Promise<{ at: number; accepted: boolean; name: string; nodeId: string | undefined; key: string }[]> {
      if (pr.isCrossRepository !== false) return [];
      const url = pr.url.toLowerCase(), head = pr.headRefOid;
      // A head whose rollup is wholly finished costs no request: there is nothing to recover. Only when every context is here.
      const rollup = rollupOf(pr);
      if (!rollup?.contexts?.pageInfo?.hasNextPage && (rollup?.contexts?.nodes ?? []).every((n: Json) => n.__typename !== "CheckRun" || n.status === "COMPLETED")) return [];
      const listed = await latestRuns(pr);
      if (!listed || listed === "permanent") { log("wedged check runs' read failed", { pr: pr.url, head }); deferred = !listed; return []; }
      const { runs } = listed;
      if (!listed.complete) log("wedged check runs only partly read", { pr: pr.url, head, got: runs.length });
      const out: { at: number; accepted: boolean; name: string; nodeId: string | undefined; key: string }[] = [];
      // Only GitHub Actions' own unfinished checks have a job to re-run; another app's is not ours to fix. And only one the
      // head's rollup still shows: REST can list a check run the rollup has replaced (a newer run of the same job), and
      // re-running that old job would spend a run on a check the merge gate no longer reads. A truncated rollup cannot say,
      // so the REST list stands in (the gate refuses a truncated head anyway).
      const onHead = rollup?.contexts?.pageInfo?.hasNextPage ? undefined : new Set((rollup?.contexts?.nodes ?? []).filter((n: Json) => n.__typename === "CheckRun").map((n: Json) => String(n.id ?? n.databaseId)));
      const candidates = runs.filter((c: Json) => c.app?.slug === "github-actions" && c.status !== "completed" && (!onHead || onHead.has(String(c.node_id ?? c.id))));
      // Where the last pass's budget ran out, so the checks it never reached are the first probed this pass instead of the
      // head's first few spending every pass and the rest never being re-run or reported.
      const cursorKey = `${repo.toLowerCase()}:${head}`;
      const start = candidates.length ? Number(state.wedgedAt[cursorKey] ?? 0) % candidates.length : 0;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[(start + i) % candidates.length];
        const name = `${repo.toLowerCase()}:${head}:${String(c.check_suite?.id)}:${String(c.name ?? "")}`;
        const asked: { at: string; accepted: boolean; job: number; run?: number; attempt?: number } | undefined = state.wedged[name];
        const jobId = jobIdOf(c);
        if (!jobId) { log("wedged check run without an Actions job", { pr: pr.url, head, check: String(c.name ?? "").slice(0, 100) }); continue; }
        // A refused or unanswered read backs off before anything else, so an Actions outage is not hit on every tick. Nothing
        // is reported while it backs off either: a report needs the job read that shows it finished, which the tick past the
        // backoff makes.
        const prior: string | undefined = state.reran[`${repo.toLowerCase()}:${head}:${jobId}`];
        if (prior?.startsWith("retry:") && Date.parse(prior.slice(6)) > Date.now()) continue;
        // The Actions calls are this rule's alone: a timeout here must not stop the scan's other PRs (their merges and wakes).
        let job: { status: number; body: any } | undefined;
        // The failed-check path keeps a read of its own: a head of still-running jobs must not spend the budget and leave a
        // job that never started unjudged.
        try { job = await probeJob(jobId, NEVER_STARTED_RESERVE); }
        catch (e) {
          log("wedged check run's job read failed", { pr: pr.url, head, job: jobId, err: String((e as Error).message).slice(0, 200) });
          // A sibling PR at this head may already have had the re-run taken: a failed read never undoes that.
          if (!prior || prior.startsWith("retry:")) state.reran[`${repo.toLowerCase()}:${head}:${jobId}`] = `retry:${new Date(Date.now() + 5 * 60_000).toISOString()}`;
          save();
          continue;
        }
        if (!job) { state.wedgedAt[cursorKey] = (start + i) % candidates.length; save(); deferred = true; break; } // budget spent: resume here
        // Only a job that itself finished, on this head, for this very check run can leave it wedged: one still queued or
        // running is not stuck, and a details URL never points another head's or check's job here.
        // A rate limit or an outage on the read backs off like an unanswered one: GitHub is not asked again on every tick.
        if (job.status === 429 || job.status >= 500) {
          if (!prior || prior.startsWith("retry:")) state.reran[`${repo.toLowerCase()}:${head}:${jobId}`] = `retry:${new Date(Date.now() + 5 * 60_000).toISOString()}`;
          save();
          continue;
        }
        if (job.status >= 300 || job.body?.status !== "completed" || job.body?.head_sha !== head || !String(job.body?.check_run_url ?? "").endsWith(`/check-runs/${c.id}`)) continue;
        const completedAt = Date.parse(job.body?.completed_at ?? "");
        if (!Number.isFinite(completedAt) || Date.now() - completedAt < WEDGED_GRACE_MS) continue; // a fresh job's check run can lag
        const nodeId = c.node_id ? String(c.node_id) : undefined;
        // A re-run this head took for this very job, or for the job it replaced (a later attempt), or a re-run a sibling PR
        // at this head asked for, is not asked again. A job of another attempt-1 lineage that merely shares the display name
        // is a check of its own and gets its own ask.
        // A later attempt of *this* workflow run is the re-run's replacement. Two different jobs in one suite that share a
        // display name are different runs: their attempt numbers say nothing about the ask, so the run id must match too.
        // And it must be an attempt *later* than the one that was re-run: a sibling matrix job of the same run and display name
        // on that same attempt is a different job, not the re-run's replacement.
        const replaced = !!asked?.accepted && !!asked.run && !!job.body && Number(job.body.run_id) === Number(asked.run)
          && Number(job.body.run_attempt ?? 1) > Math.max(1, Number(asked.attempt ?? 1));
        if ((asked?.accepted && (Number(asked.job) === Number(jobId) || replaced)) || (prior && !prior.startsWith("retry:"))) {
          const at = prior && !prior.startsWith("retry:") ? Date.parse(prior) : Date.parse(asked?.at ?? "");
          out.push({ at, accepted: true, name: String(c.name ?? ""), nodeId, key: name });
          continue;
        }
        const tell = () => {
          const now = { at: Date.parse(state.wedged[name].at), accepted: state.wedged[name].accepted, name: String(c.name ?? ""), nodeId, key: name };
          const i = out.findIndex((o) => o.key === now.key);
          if (i >= 0) out[i] = now; else out.push(now);
        };
        if (asked) tell();
        // The first ask starts the report's clock and is not moved by a refusal.
        state.wedged[name] ??= { at: new Date().toISOString(), accepted: false, job: Number(jobId), run: Number(job.body?.run_id) || undefined };
        let r: { status: number };
        try { r = await gh("POST", `/repos/${repo}/actions/jobs/${jobId}/rerun`, {}, { deadline: Date.now() + RECOVERY_WRITE_DEADLINE_MS }); }
        catch (e) {
          log("wedged check run's re-run failed to send", { pr: pr.url, head, job: jobId, err: String((e as Error).message).slice(0, 200) });
          state.reran[`${repo.toLowerCase()}:${head}:${jobId}`] = `retry:${new Date(Date.now() + 5 * 60_000).toISOString()}`;
          save();
          continue;
        }
        log(r.status < 300 ? "wedged check run's job re-run" : "wedged check run's re-run refused", { pr: pr.url, head, job: jobId, status: r.status });
        // A re-run GitHub takes is the one the report's interval counts from: an earlier refusal never ran a re-run.
        // The ask is now this job of this run, not the one it was first made for: a later sibling that shares the display name
        // matches neither, so its own replacement is not mistaken for this ask's.
        if (r.status < 300) { state.wedged[name].accepted = true; state.wedged[name].at = new Date().toISOString(); state.wedged[name].job = Number(jobId); state.wedged[name].run = Number(job.body?.run_id) || undefined; state.wedged[name].attempt = Number(job.body?.run_attempt ?? 1); }
        // Only a re-run GitHub took is recorded as done: a refusal backs off and is asked again instead of leaving the head
        // marked as handled with its check run still wedged.
        state.reran[`${repo.toLowerCase()}:${head}:${jobId}`] = r.status < 300 ? new Date().toISOString() : `retry:${new Date(Date.now() + 5 * 60_000).toISOString()}`;
        save();
        tell(); // this tick's answer, not the one before it
      }
      return out;
    }
    const wedged = await wedgedAfterJob(pr);
    const runs = (rollupOf(pr)?.contexts?.nodes ?? []).filter((n: Json) => n.__typename === "CheckRun");
    const pendingIds = new Set(runs.filter((n: Json) => n.status !== "COMPLETED" && n.name && n.name !== DESIGN_REVIEW_CHECK && n.name !== CODE_REVIEW_STATUS).map((n: Json) => String(n.id)));
    const due = wedged.filter((w) => Date.now() - w.at >= WEDGED_REPORT_MS && !!w.nodeId && pendingIds.has(w.nodeId));
    const wedgedDue = !due.length ? false : due.every((w) => w.accepted) ? "accepted" as const : "refused" as const;
    const envRed = pr.mergeable === "MERGEABLE" ? await neverStarted(pr) : false;
    const result: Recovery = { envRed, wedgedDue, ...(deferred ? { again: true as const } : {}) };
    // Only a quiet answer is stamped (nothing to re-run, report or retry): an answer with work in flight is asked again at the next pass.
    const retrying = Object.entries<string>(state.reran).some(([k, v]) => v.startsWith("retry:") && Date.parse(v.slice(6)) > Date.now() && k.split(":").includes(pr.headRefOid));
    if (envRed === false && wedgedDue === false && read && !retrying && !deferred && !wedged.length) { stamps[pr.url.toLowerCase()] = { head: pr.headRefOid, seen, at: Date.now(), result }; save(); }
    else delete stamps[pr.url.toLowerCase()];
    return result;
  };
}
