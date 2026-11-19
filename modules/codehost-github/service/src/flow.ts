// Flow facts from the code host (docs/design/flow.md, module.yaml `facts:`): PRs, CI per head, merge-queue waits and merges, and
// the churn of merged code. Facts go to the kernel through the one fact emitter and never block or fail the action they describe;
// a fact's id is type, subject and version, so a re-send, a restart or the owner's backfill never records one twice.
//
// Subjects: pr:<repo>#<n>, CI per head pr:<repo>#<n>@<head>, issue:<repo>#<n> (repos in lower case). `task` is the task that opened
// the PR, from pr-tasks.json (pr-watch.ts notePrTask).
//
// The churn pass (every 15 minutes, a cursor per repo in the data dir) reads each repo's merged commits from its cache clone,
// never the GitHub API. The first pass also runs the GitHub backfill once (no route, no button): the managed repos' history through
// the API within the App's rate budget. It stops when GitHub says little is left and the next pass goes on; done is recorded in the data dir.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { churnFromGit, DEFAULT_CHURN_EXCLUDE } from "./aidenhq-sdk/churn.ts";
import { factEmitter, kernelClient, type FactIn } from "./aidenhq-sdk/kernel-client.ts";

type Json = any;
type Gh = (method: string, path: string, token: string, body?: unknown) => Promise<{ status: number; body: any; remaining?: number }>;
const WINDOW_DAYS = 30;
const DAY = 86_400_000;
/** The backfill stops here: the App's hourly budget is 5,000 points and the rest of the service needs some. */
const LOW_REMAINING = 400;
const REPO_READ = { contents: "read", metadata: "read", pull_requests: "read", issues: "read", checks: "read" };
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export const prSubject = (repo: string, n: number | string) => `pr:${repo.toLowerCase()}#${n}`;
const issueSubject = (repo: string, n: number) => `issue:${repo.toLowerCase()}#${n}`;
const readJson = (f: string, empty: Json): Json => { try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : empty; } catch { return empty; } };
/** The wait reason (module.yaml `work.waiting` reasons) of a merge queue's wait key (merge-gate.mjs `why`, or merges.ts's own). */
export const waitReason = (key: string): string => (key === "eval" ? "eval" : key === "retry" || key === "error" ? "retry" : /design review/i.test(key) ? "design_review" : "checks");
/** A reverting PR's target, from its title and body (GitHub's and git's own revert texts): { of_pr?, of_sha? } or undefined. */
export function revertOf(repo: string, title: string, body: string): { of_pr?: string; of_sha?: string } | undefined {
  if (!/^Revert\b/i.test(title)) return undefined;
  const pr = /Reverts\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/i.exec(body);
  const sha = /This reverts commit ([0-9a-f]{40})/i.exec(body)?.[1];
  const r = { ...(pr ? { of_pr: `${(pr[1] ?? repo).toLowerCase()}#${pr[2]}` } : {}), ...(sha ? { of_sha: sha } : {}) };
  return Object.keys(r).length ? r : undefined;
}

export type FlowDeps = {
  kernelUrl: string; key: string; cacheDir: string; log: (msg: string, f?: Record<string, unknown>) => void;
  /** Globs the churn pass ignores (the churn_exclude setting). */
  exclude?: string[];
  now?: () => Date;
  /** The repos the instance manages: the agents org's, the product repo and the instance repo. */
  repos?: () => Promise<string[]>;
  /** A GitHub token narrowed to `repo` with these permissions. */
  token?: (repo: string, perms: Record<string, string>) => Promise<string>;
  gh?: Gh;
  /** The repo's default branch fetched into the cache clone: its git dir and branch tip. */
  fetchDefault?: (repo: string) => Promise<{ dir: string; sha: string }>;
  git?: (dir: string, args: string[]) => Promise<string>;
};

export function createFlow(d: FlowDeps) {
  const now = d.now ?? (() => new Date());
  const client = kernelClient(d.kernelUrl, d.key);
  const emitter = factEmitter(client, d.log);
  const prTasks = () => readJson(join(d.cacheDir, "pr-tasks.json"), {});
  /** The task that opened `repo#n`, when this service opened it. */
  const taskOf = (repo: string, n: number | string) => (prTasks()[`https://github.com/${repo}/pull/${n}`.toLowerCase()]?.task as string | undefined) ?? null;
  // The owner's backfill sends its facts straight to the kernel in batches (it stops and says so on a failure); every other fact queues.
  const emit = (x: FactIn) => (x.source === "backfill" ? backfillSend(x) : emitter.emit(x));

  const f = {
    emit, flush: emitter.flush, stop: emitter.stop, taskOf,
    opened: (repo: string, n: number, head: string, branch: string, at = now().toISOString(), task = taskOf(repo, n), source?: "backfill") =>
      emit({ type: "pr.opened", subject: prSubject(repo, n), version: "1", at, task, data: { repo, number: n, head, branch }, ...(source ? { source } : {}) }),
    checksStarted: (repo: string, n: number, head: string, at = now().toISOString(), task = taskOf(repo, n), source?: "backfill") =>
      emit({ type: "pr.checks_started", subject: `${prSubject(repo, n)}@${head}`, version: `${head}:1`, at, task, data: { head }, ...(source ? { source } : {}) }),
    checksCompleted: (repo: string, n: number, head: string, failed: string[], at = now().toISOString(), task = taskOf(repo, n), source?: "backfill") =>
      emit({ type: "pr.checks_completed", subject: `${prSubject(repo, n)}@${head}`, version: `${head}:1`, at, task, data: { head, conclusion: failed.length ? "failure" : "success", failed }, ...(source ? { source } : {}) }),
    merged: (repo: string, n: number, head: string, sha: string, at = now().toISOString(), title = "", body = "", task = taskOf(repo, n), source?: "backfill") => {
      emit({ type: "pr.merged", subject: prSubject(repo, n), version: head, at, task, data: { sha, head }, ...(source ? { source } : {}) });
      const rv = revertOf(repo, title, body);
      if (rv) emit({ type: "pr.reverted", subject: prSubject(repo, n), version: head, at, task, data: rv, ...(source ? { source } : {}) });
    },
    waiting: (repo: string, n: number, reason: string, since: string) => emit({ type: "work.waiting", subject: prSubject(repo, n), version: since, at: since, task: taskOf(repo, n), data: { reason } }),
    resumed: (repo: string, n: number, reason: string, since: string, at = now().toISOString()) => emit({ type: "work.resumed", subject: prSubject(repo, n), version: since, at, task: taskOf(repo, n), data: { reason } }),
  };

  // ---- churn ----
  const cursorFile = join(d.cacheDir, "churn.json");
  const exclude = d.exclude?.length ? d.exclude : DEFAULT_CHURN_EXCLUDE;
  /**
   * One repo's churn from its default branch's merged commits (a squash or merge commit whose subject names its PR): everything
   * on a first pass, later the last window before the cursor, so lines added shortly before it keep their owner. Facts only for PRs
   * merged after the cursor; with `all` every one (the backfill). Returns the facts emitted.
   */
  async function churnRepo(repo: string, { all = false, source }: { all?: boolean; source?: "backfill" } = {}): Promise<number> {
    if (!d.fetchDefault || !d.git) return 0;
    const state = readJson(cursorFile, {});
    const cursor = all ? "" : String(state[repo.toLowerCase()] ?? "");
    const { dir, sha } = await d.fetchDefault(repo);
    const slug = repo.toLowerCase();
    const num = (pr: string) => Number(pr.slice(pr.lastIndexOf("#") + 1));
    const out = await churnFromGit((args) => d.git!(dir, args), {
      rev: sha, cursor: cursor || undefined, windowDays: WINDOW_DAYS, exclude,
      prOf: (subject) => { const n = /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? /^Merge pull request #(\d+)/.exec(subject)?.[1]; return n ? `${slug}#${n}` : undefined; },
      onError: (commit, e) => d.log("churn: a commit's diff couldn't be read", { repo, commit, err: String((e as Error)?.message ?? e).slice(0, 200) }),
    });
    let emitted = 0;
    const put = (x: FactIn) => { emit({ ...x, ...(source ? { source } : {}) }); emitted++; };
    for (const [pr, lines] of Object.entries(out.added)) {
      const at = out.mergedAt.get(pr)!;
      if (lines && out.fresh(at)) put({ type: "code.added", subject: prSubject(repo, num(pr)), version: "1", at, task: taskOf(repo, num(pr)), data: { pr, lines } });
    }
    for (const r of out.rewritten) {
      const at = out.mergedAt.get(r.by_pr)!;
      if (out.fresh(at)) put({ type: "code.rewritten", subject: prSubject(repo, num(r.pr)), version: r.by_pr, at, task: taskOf(repo, num(r.pr)), data: r });
    }
    if (out.last) writeFileSync(cursorFile, JSON.stringify({ ...readJson(cursorFile, {}), [slug]: out.last }));
    return emitted;
  }
  let churning = false;
  async function churnPass() {
    if (churning || !d.repos) return;
    churning = true;
    try {
      await backfill();
      for (const repo of await d.repos()) await churnRepo(repo).catch((e) => d.log("churn pass failed", { repo, err: String(e?.message ?? e).slice(0, 300) }));
    } finally { churning = false; }
  }

  // ---- backfill ----
  type Status = { state: "idle" | "running" | "paused" | "done" | "failed"; repo?: string; emitted: number; message?: string };
  const progressFile = join(d.cacheDir, "backfill.json");
  let status: Status = readJson(progressFile, { state: "idle", emitted: 0 }).status ?? { state: "idle", emitted: 0 };
  if (status.state === "running") status = { ...status, state: "paused", message: "the service restarted: press the button to go on" };
  let buffer: FactIn[] = [];
  async function backfillFlush() {
    while (buffer.length) {
      const batch = buffer.slice(0, 500);
      await client.call("POST", "/v1/facts", { facts: batch });
      buffer = buffer.slice(batch.length);
    }
  }
  function backfillSend(x: FactIn) { buffer.push({ ...x, source: "backfill" }); status.emitted++; }
  class Paused extends Error {}
  let lowBudget = "";
  async function gh(repo: string, path: string): Promise<Json> {
    const r = await d.gh!("GET", path, await d.token!(repo, REPO_READ));
    if (r.status === 403 && /rate limit/i.test(String(r.body?.message))) throw new Paused("GitHub's rate limit");
    if (r.status >= 300) throw new Error(`GitHub GET ${path.split("?")[0]}: ${r.status} ${r.body?.message ?? ""}`.trim());
    if (r.remaining !== undefined && r.remaining < LOW_REMAINING) lowBudget = `GitHub's rate limit is nearly used (${r.remaining} left)`;
    return r;
  }
  /** Every page of a list (100 a page), `each` per item; stops with Paused when the budget is low. */
  async function pages(repo: string, path: string, each: (item: Json) => Promise<void> | void) {
    for (let page = 1; ; page++) {
      const r = await gh(repo, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const items = Array.isArray(r.body) ? r.body : (r.body?.check_runs ?? []);
      for (const it of items) await each(it);
      await backfillFlush();
      if (lowBudget) throw new Paused(lowBudget);
      if (items.length < 100) return;
    }
  }
  async function backfillRepo(repo: string, done: Record<string, number>) {
    status.repo = repo;
    await pages(repo, `/repos/${repo}/issues?state=all&sort=created&direction=asc`, (i) => {
      if (i.pull_request) return;
      backfillSend({ type: "issue.opened", subject: issueSubject(repo, i.number), version: "1", at: i.created_at, task: null, data: { repo, number: i.number, labels: (i.labels ?? []).map((l: Json) => String(l.name ?? l)), state: i.state } });
    });
    await pages(repo, `/repos/${repo}/issues/events`, (e) => {
      if (e.event !== "labeled" || !e.issue || e.issue.pull_request) return;
      backfillSend({ type: "issue.labeled", subject: issueSubject(repo, e.issue.number), version: String(e.id), at: e.created_at, task: null, data: { label: String(e.label?.name ?? "") } });
    });
    const key = repo.toLowerCase();
    await pages(repo, `/repos/${repo}/pulls?state=all&sort=created&direction=asc`, async (p) => {
      if (p.number <= (done[key] ?? 0)) return;
      const head = String(p.head?.sha ?? ""), task = taskOf(repo, p.number);
      f.opened(repo, p.number, head, String(p.head?.ref ?? ""), p.created_at, task, "backfill");
      // Check runs of the head GitHub still has: CI started when its first run did and ended with its last.
      const runs = (await gh(repo, `/repos/${repo}/commits/${head}/check-runs?per_page=100`)).body?.check_runs ?? [];
      const starts = runs.map((r: Json) => Date.parse(r.started_at)).filter(Number.isFinite);
      if (starts.length) {
        f.checksStarted(repo, p.number, head, new Date(Math.min(...starts)).toISOString(), task, "backfill");
        const ends = runs.map((r: Json) => Date.parse(r.completed_at));
        if (ends.every(Number.isFinite)) f.checksCompleted(repo, p.number, head, runs.filter((r: Json) => FAILED.has(String(r.conclusion))).map((r: Json) => String(r.name)).slice(0, 20), new Date(Math.max(...ends)).toISOString(), task, "backfill");
      }
      if (p.merged_at) f.merged(repo, p.number, head, String(p.merge_commit_sha ?? ""), p.merged_at, String(p.title ?? ""), String(p.body ?? ""), task, "backfill");
      done[key] = p.number;
    });
    delete done[key];
    await churnRepo(repo, { all: true, source: "backfill" }).then(backfillFlush);
  }
  let running: Promise<void> | undefined;
  /** The GitHub backfill, once: on the first pass (nothing recorded as done in the data dir). Idempotent, resumable after a pause, one at a time. */
  function backfill(): Promise<void> {
    if (running) return running;
    if (status.state === "done" || !d.repos || !d.token || !d.gh) return Promise.resolve();
    status = { state: "running", emitted: 0 };
    lowBudget = "";
    const progress = readJson(progressFile, {}).done ?? {};
    running = (async () => {
      try {
        for (const repo of await d.repos!()) await backfillRepo(repo, progress);
        status = { ...status, state: "done", repo: undefined, message: undefined };
      } catch (e) {
        status = e instanceof Paused ? { ...status, state: "paused", message: `${e.message}: press the button again later to go on` } : { ...status, state: "failed", message: String((e as Error).message).slice(0, 300) };
        d.log("backfill stopped", { ...status });
      } finally {
        writeFileSync(progressFile, JSON.stringify({ done: status.state === "done" ? {} : progress, status }));
        running = undefined;
      }
    })();
    return running;
  }
  return Object.assign(f, {
    churnPass, churnRepo, backfill,
    /** The churn loop: a first pass shortly after start, then every 15 minutes. */
    startChurn() {
      const t = setInterval(() => void churnPass(), 15 * 60_000);
      t.unref?.();
      setTimeout(() => void churnPass(), 60_000).unref?.();
      return () => clearInterval(t);
    },
  });
}
export type Flow = ReturnType<typeof createFlow>;
