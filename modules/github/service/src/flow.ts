// Flow facts from the code host (docs/design/flow.md, module.yaml `facts:`): PRs, CI per head, merge-queue waits and merges, and
// the churn of merged code. Facts go to the kernel through the one fact emitter and never block or fail the action they describe;
// a fact's id is type, subject and version, so a re-send, a restart or the owner's backfill never records one twice.
//
// Subjects: pr:<repo>#<n>, CI per head pr:<repo>#<n>@<head>, issue:<repo>#<n> (repos in lower case). `task` is the task that opened
// the PR, from pr-tasks.json (pr-watch.ts notePrTask). Every `at` is UTC with a Z.
//
// Authors: `author_kind` is "agent" for an object in AidenHQ's records (the kernel's /v1/objects), or (records pruned, a crash,
// a restore) one whose text carries the AidenHQ footer or whose head commit carries the AidenHQ trailer: the fleet acts as the
// owner's login, so the login alone tells nothing. The markers are forgeable, which is fine: attribution carries no authority.
// "owner" for the signed-in owner's login without them, GitHub's author_association OWNER, MEMBER or COLLABORATOR, or anyone with
// write on the repo (GitHub shows a private org member as CONTRIBUTOR), "outside" for anyone else. A push (`pr.pushed`, version = the new head) is a head change after the PR opened.
//
// The churn pass (every 15 minutes on the change feed's scheduler, feed.ts; a cursor per repo in the data dir) reads each repo's
// merged commits from its cache clone, never the GitHub API. The first pass also runs the GitHub backfill once (no route, no
// button): the managed repos' history through the API within the owner's rate budget. It stops when GitHub says little is left and
// the next pass goes on; done is recorded in the data dir.
//
// Live PR and issue facts come from the change feed's events (feed.ts's in-process hook, `observe` below), with the ids the
// backfill uses, so a repeat records once.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { churnFromGit, DEFAULT_CHURN_EXCLUDE } from "./aidenhq-sdk/churn.ts";
import { factEmitter, kernelClient, type FactIn, type KernelError } from "./aidenhq-sdk/kernel-client.ts";
import { hasFooter, hasTrailer } from "./aidenhq-sdk/attribution.ts";
import type { Hook } from "./feed.ts";

type Json = any;
/** GitHub as the owner, background (git-auth.ts Gh). */
type Gh = (method: string, path: string, o?: { etag?: string }) => Promise<{ status: number; body: any; headers?: Headers }>;
const WINDOW_DAYS = 30;
const DAY = 86_400_000;
/** The backfill pauses below this share of the hourly budget, before the limiter's 20% reserve holds every background call. */
const LOW_SHARE = 0.25;
/** issue.opened carries the author and title from this version on (the id is type, subject and version, so a re-run records them). */
export const OPENED_VERSION = "2";
/** pr.opened's: v3 classes a private org member with write as the owner. */
export const PR_OPENED_VERSION = "3";
/** The backfill runs again when this changes (v2: authors, titles, pushes, closes, CI per head; v3: owners by write access, merges since v2). */
const BACKFILL_VERSION = 3;
const WRITERS = new Set(["admin", "maintain", "write"]);
const MAX_COMMITS = 60;
/** Any ISO time as UTC with a Z. */
export const utc = (at: string | number | Date): string => new Date(at).toISOString();
/** A GitHub login as bots appear in REST (`slug[bot]`), GraphQL (`slug`) and gh (`app/slug`): one lower-case name. */
const login = (l?: string | null) => String(l ?? "").toLowerCase().replace(/^app\//, "").replace(/\[bot\]$/, "");
export type Kind = "agent" | "owner" | "outside";
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
export const prSubject = (repo: string, n: number | string) => `pr:${repo.toLowerCase()}#${n}`;
const issueSubject = (repo: string, n: number) => `issue:${repo.toLowerCase()}#${n}`;
const readJson = (f: string, empty: Json): Json => { try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : empty; } catch { return empty; } };
/** A state file written whole: tmp then rename, so a crash never leaves half a file. */
const writeJson = (f: string, v: Json) => { writeFileSync(`${f}.tmp`, JSON.stringify(v)); renameSync(`${f}.tmp`, f); };
/** The wait reason (module.yaml `work.waiting` reasons) of a merge queue's wait key (merge-gate.ts `why`, or merges.ts's own). */
export const waitReason = (key: string): string => (key === "review" ? "code_review" : key === "retry" || key === "error" || key === "put" ? "retry" : /design review/i.test(key) ? "design_review" : "checks");
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
  gh?: Gh;
  /** The signed-in owner's login: without AidenHQ's record or marks, what it wrote is the owner's. */
  self?: () => Promise<string | undefined>;
  /** Whether a GitHub object (`github:<repo>#<n>`) is in AidenHQ's records. */
  ours?: (ref: string) => Promise<boolean>;
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
  const emit = (x: FactIn) => { const y = { ...x, at: utc(x.at) }; return y.source === "backfill" ? backfillSend(y) : emitter.emit(y); };
  let selfName: string | undefined;
  const writers = new Map<string, boolean>();
  /** Whether `who` has write on `repo` (one read per repo and author; a failed read is asked again next time). */
  async function canWrite(repo: string, who: string): Promise<boolean> {
    const k = `${repo.toLowerCase()} ${who.toLowerCase()}`;
    if (!writers.has(k)) {
      const r = await d.gh!("GET", `/repos/${repo}/collaborators/${encodeURIComponent(who)}/permission`).catch(() => undefined);
      if (!r || r.status >= 300) return false;
      writers.set(k, WRITERS.has(String(r.body?.permission)));
    }
    return writers.get(k)!;
  }
  /**
   * Who an author is: AidenHQ's (agent) when the object is in our records or carries our marks (`seen`: its number, its text and
   * its head commit's message, where known), else the owner (their login, an OWNER, MEMBER or COLLABORATOR association, or write
   * on `repo`), else outside.
   */
  async function kindOf(who?: string | null, association?: string | null, repo?: string, seen: { number?: number; body?: string; message?: string } = {}): Promise<Kind> {
    if (repo && seen.number && (await d.ours?.(`github:${repo.toLowerCase()}#${seen.number}`).catch(() => false))) return "agent";
    if (hasFooter(String(seen.body ?? "")) || hasTrailer(String(seen.message ?? ""))) return "agent";
    // A failed lookup is retried at the next author.
    if (!selfName) selfName = login(await d.self?.().catch(() => undefined));
    if (login(who) && login(who) === selfName) return "owner";
    if (["OWNER", "MEMBER", "COLLABORATOR"].includes(String(association ?? "").toUpperCase())) return "owner";
    return repo && who && d.gh && (await canWrite(repo, String(who))) ? "owner" : "outside";
  }
  /** `author` and `author_kind` for a fact's data; `association` is GitHub's author_association (REST) or authorAssociation (GraphQL). */
  const authored = async (who?: string | null, association?: string | null, repo?: string, seen?: { number?: number; body?: string; message?: string }) => ({ author: who ? String(who) : "ghost", author_kind: await kindOf(who, association, repo, seen) });

  const f = {
    emit, flush: emitter.flush, stop: emitter.stop, taskOf,
    kindOf, authored,
    opened: (repo: string, n: number, head: string, branch: string, at = now().toISOString(), task = taskOf(repo, n), source?: "backfill", extra: Json = {}) =>
      emit({ type: "pr.opened", subject: prSubject(repo, n), version: PR_OPENED_VERSION, at, task, data: { repo: repo.toLowerCase(), number: n, head, branch, ...extra }, ...(source ? { source } : {}) }),
    /** A head change after the PR opened: version is the new head, so a repeat from another path records once. */
    pushed: (repo: string, n: number, head: string, before: string, forced: boolean, author: string, at = now().toISOString(), task = taskOf(repo, n), source?: "backfill") =>
      emit({ type: "pr.pushed", subject: prSubject(repo, n), version: head, at, task, data: { head, before, forced, author }, ...(source ? { source } : {}) }),
    /** A PR closed without merging. */
    closed: (repo: string, n: number, head: string, at = now().toISOString(), task = taskOf(repo, n), source?: "backfill") =>
      emit({ type: "pr.closed", subject: prSubject(repo, n), version: head, at, task, data: { merged: false }, ...(source ? { source } : {}) }),
    checksStarted: (repo: string, n: number, head: string, at = now().toISOString(), task = taskOf(repo, n), source?: "backfill") =>
      emit({ type: "pr.checks_started", subject: `${prSubject(repo, n)}@${head}`, version: `${head}:1`, at, task, data: { head }, ...(source ? { source } : {}) }),
    checksCompleted: (repo: string, n: number, head: string, failed: string[], at = now().toISOString(), task = taskOf(repo, n), source?: "backfill") =>
      emit({ type: "pr.checks_completed", subject: `${prSubject(repo, n)}@${head}`, version: `${head}:1`, at, task, data: { head, conclusion: failed.length ? "failure" : "success", failed }, ...(source ? { source } : {}) }),
    merged: (repo: string, n: number, head: string, sha: string, at = now().toISOString(), title = "", body = "", task = taskOf(repo, n), source?: "backfill") => {
      emit({ type: "pr.merged", subject: prSubject(repo, n), version: head, at, task, data: { sha, head }, ...(source ? { source } : {}) });
      const rv = revertOf(repo, title, body);
      if (rv) emit({ type: "pr.reverted", subject: prSubject(repo, n), version: head, at, task, data: rv, ...(source ? { source } : {}) });
    },
    issueOpened: (repo: string, i: { number: number; created_at: string; labels: string[]; state: string; author: string; author_kind: Kind }, source?: "backfill") =>
      emit({ type: "issue.opened", subject: issueSubject(repo, i.number), version: OPENED_VERSION, at: i.created_at, task: null, data: { repo: repo.toLowerCase(), number: i.number, labels: i.labels, state: i.state, author: i.author, author_kind: i.author_kind }, ...(source ? { source } : {}) }),
    issueLabeled: (repo: string, n: number, eventId: string | number, label: string, by: string, at: string, source?: "backfill") =>
      emit({ type: "issue.labeled", subject: issueSubject(repo, n), version: `${OPENED_VERSION}:${eventId}`, at, task: null, data: { label, by }, ...(source ? { source } : {}) }),
    /** A merge that went without code review's verdict: code review was unreachable too long (review-gate.ts DOWN_MS). */
    reviewBypassed: (repo: string, n: number, head: string, why: string) => emit({ type: "pr.review_bypassed", subject: prSubject(repo, n), version: head, at: now().toISOString(), task: taskOf(repo, n), data: { head, why: why.slice(0, 300) } }),
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
    // Sent straight to the kernel, and the cursor moves only once it took them (a restart or a refusal must not lose them).
    const facts: FactIn[] = [];
    const put = (x: FactIn) => { const y = { ...x, at: utc(x.at), ...(source ? { source } : {}) }; facts.push(y); if (source) status.emitted++; };
    for (const [pr, lines] of Object.entries(out.added)) {
      const at = out.mergedAt.get(pr)!;
      if (lines && out.fresh(at)) put({ type: "code.added", subject: prSubject(repo, num(pr)), version: "1", at, task: taskOf(repo, num(pr)), data: { pr, lines } });
    }
    for (const r of out.rewritten) {
      const at = out.mergedAt.get(r.by_pr)!;
      if (out.fresh(at)) put({ type: "code.rewritten", subject: prSubject(repo, num(r.pr)), version: r.by_pr, at, task: taskOf(repo, num(r.pr)), data: r });
    }
    await postFacts(facts);
    if (out.last) writeJson(cursorFile, { ...readJson(cursorFile, {}), [slug]: out.last });
    return facts.length;
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
  // A recorded backfill of an older version starts over (its facts are idempotent: the new ones record, the old ones don't repeat).
  const savedProgress = () => { const j = readJson(progressFile, {}); return j.version === BACKFILL_VERSION ? j : {}; };
  let status: Status = savedProgress().status ?? { state: "idle", emitted: 0 };
  if (status.state === "running") status = { ...status, state: "paused", message: "the service restarted: it goes on at the next pass" };
  let buffer: FactIn[] = [];
  /** One batch to the kernel. A refusal (4xx; not a rate limit or timeout) splits the batch to find the fact it won't take, which is dropped and logged, so one bad fact never wedges the rest; anything else throws and the caller retries later. */
  async function postBatch(batch: FactIn[]): Promise<void> {
    try {
      await client.call("POST", "/v1/facts", { facts: batch });
    } catch (e) {
      const status = (e as KernelError).status;
      if (!(status >= 400 && status < 500) || status === 408 || status === 429) throw e;
      if (batch.length > 1) { const mid = batch.length >> 1; await postBatch(batch.slice(0, mid)); return postBatch(batch.slice(mid)); }
      d.log("facts: the kernel refused a fact, dropped", { status, type: batch[0]!.type, subject: batch[0]!.subject, error: String((e as Error).message).slice(0, 200) });
    }
  }
  async function postFacts(facts: FactIn[]) { for (let i = 0; i < facts.length; i += 500) await postBatch(facts.slice(i, i + 500)); }
  async function backfillFlush() {
    while (buffer.length) {
      const batch = buffer.slice(0, 500);
      await postBatch(batch);
      buffer = buffer.slice(batch.length);
    }
  }
  function backfillSend(x: FactIn) { buffer.push({ ...x, source: "backfill" }); status.emitted++; }
  class Paused extends Error {}
  let lowBudget = "";
  async function gh(repo: string, path: string): Promise<Json> {
    const r = await d.gh!("GET", path).catch((e: { need?: { cause?: string } }) => { throw e?.need?.cause === "rate_limited" ? new Paused("GitHub's rate limit") : e; });
    if (r.status >= 300) throw new Error(`GitHub GET ${path.split("?")[0]}: ${r.status} ${r.body?.message ?? ""}`.trim());
    const remaining = Number(r.headers?.get("x-ratelimit-remaining")), limit = Number(r.headers?.get("x-ratelimit-limit"));
    if (limit > 0 && remaining < limit * LOW_SHARE) lowBudget = `GitHub's rate limit is nearly used (${remaining} left)`;
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
  type Head = { sha: string; at: string; forced: boolean; author: string; starts: number[]; ends: number[]; failed: string[] };
  /**
   * A PR's heads, oldest first, from its timeline: each commit GitHub still holds check runs for, each force-push, and the current
   * head. Each carries its CI (a head's check runs: started with its first, ended with its last). A commit pushed in the same push as
   * a later one has no runs of its own and is no head.
   */
  async function headsOf(repo: string, n: number, current: string, currentAt: string): Promise<Head[]> {
    const events: Json[] = [];
    await pages(repo, `/repos/${repo}/issues/${n}/timeline`, (e) => { if (e.event === "committed" || e.event === "head_ref_force_pushed") events.push(e); });
    const by = new Map<string, Head>();
    const add = (sha: string, at: string, forced: boolean, author: string) => { if (sha && !by.has(sha)) by.set(sha, { sha, at, forced, author, starts: [], ends: [], failed: [] }); };
    for (const e of events.filter((x) => x.event === "committed").slice(0, MAX_COMMITS)) add(String(e.sha), String(e.committer?.date ?? e.author?.date ?? ""), false, String(e.author?.name ?? "ghost"));
    for (const e of events.filter((x) => x.event === "head_ref_force_pushed")) { const h = by.get(String(e.commit_id)); if (h) Object.assign(h, { at: e.created_at, forced: true, author: String(e.actor?.login ?? "ghost") }); else add(String(e.commit_id), e.created_at, true, String(e.actor?.login ?? "ghost")); }
    add(current, currentAt, false, "ghost");
    const all = [...by.values()];
    for (const h of all) {
      const runs = (await gh(repo, `/repos/${repo}/commits/${h.sha}/check-runs?per_page=100`)).body?.check_runs ?? [];
      h.starts = runs.map((r: Json) => Date.parse(r.started_at)).filter(Number.isFinite);
      h.ends = runs.map((r: Json) => Date.parse(r.completed_at));
      h.failed = runs.filter((r: Json) => FAILED.has(String(r.conclusion))).map((r: Json) => String(r.name)).slice(0, 20);
    }
    // Heads: a commit with CI, a force-push, the current head; a push's time is when its CI began (a commit's own date predates it).
    const heads = all.filter((h) => h.starts.length || h.forced || h.sha === current);
    for (const h of heads) if (!h.forced && h.starts.length) h.at = utc(Math.min(...h.starts));
    for (const h of heads) h.at = utc(h.at || currentAt);
    return heads.sort((a, b) => a.at.localeCompare(b.at));
  }
  async function backfillRepo(repo: string, done: Record<string, number>) {
    status.repo = repo;
    await pages(repo, `/repos/${repo}/issues?state=all&sort=created&direction=asc`, async (i) => {
      if (i.pull_request) return;
      f.issueOpened(repo, { number: i.number, created_at: i.created_at, labels: (i.labels ?? []).map((l: Json) => String(l.name ?? l)), state: i.state, ...(await authored(i.user?.login, i.author_association, repo, { number: i.number, body: i.body })) }, "backfill");
    });
    await pages(repo, `/repos/${repo}/issues/events`, (e) => {
      if (e.event !== "labeled" || !e.issue || e.issue.pull_request) return;
      f.issueLabeled(repo, e.issue.number, e.id, String(e.label?.name ?? ""), String(e.actor?.login ?? "ghost"), e.created_at, "backfill");
    });
    const key = repo.toLowerCase();
    await pages(repo, `/repos/${repo}/pulls?state=all&sort=created&direction=asc`, async (p) => {
      if (p.number <= (done[key] ?? 0)) return;
      const head = String(p.head?.sha ?? ""), task = taskOf(repo, p.number);
      const heads = await headsOf(repo, p.number, head, p.updated_at ?? p.created_at);
      // The head the PR opened at is the first of its heads; every later one is a push.
      const first = heads[0]?.sha ?? head;
      f.opened(repo, p.number, first, String(p.head?.ref ?? ""), p.created_at, task, "backfill", { title: String(p.title ?? ""), ...(await authored(p.user?.login, p.author_association, repo, { number: p.number, body: p.body })) });
      for (const [i, h] of heads.entries()) {
        if (i) f.pushed(repo, p.number, h.sha, heads[i - 1]!.sha, h.forced, h.author, h.at, task, "backfill");
        if (!h.starts.length) continue;
        f.checksStarted(repo, p.number, h.sha, utc(Math.min(...h.starts)), task, "backfill");
        if (h.ends.every(Number.isFinite)) f.checksCompleted(repo, p.number, h.sha, h.failed, utc(Math.max(...h.ends)), task, "backfill");
      }
      if (p.merged_at) f.merged(repo, p.number, head, String(p.merge_commit_sha ?? ""), p.merged_at, String(p.title ?? ""), String(p.body ?? ""), task, "backfill");
      else if (p.state === "closed") f.closed(repo, p.number, head, p.closed_at ?? p.updated_at, task, "backfill");
      done[key] = p.number;
    });
    delete done[key];
    await churnRepo(repo, { all: true, source: "backfill" }).then(backfillFlush);
  }
  let running: Promise<void> | undefined;
  /** The GitHub backfill, once: on the first pass (nothing recorded as done in the data dir). Idempotent, resumable after a pause, one at a time. */
  function backfill(): Promise<void> {
    if (running) return running;
    if (status.state === "done" || !d.repos || !d.gh) return Promise.resolve();
    status = { state: "running", emitted: 0 };
    lowBudget = "";
    const progress = savedProgress().done ?? {};
    running = (async () => {
      try {
        const repos = await d.repos!();
        for (const repo of repos) await backfillRepo(repo, progress);
        // No repos means GitHub isn't connected yet: stay pending so the first pass after connecting runs it.
        status = { ...status, state: repos.length ? "done" : "idle", repo: undefined, message: undefined };
      } catch (e) {
        status = e instanceof Paused ? { ...status, state: "paused", message: `${e.message}: it goes on at a later pass` } : { ...status, state: "failed", message: String((e as Error).message).slice(0, 300) };
        d.log("backfill stopped", { ...status });
      } finally {
        writeJson(progressFile, { version: BACKFILL_VERSION, done: status.state === "done" ? {} : progress, status });
        running = undefined;
      }
    })();
    return running;
  }
  /**
   * The change feed's events as Flow's facts (feed.ts hooks): issues opened and labelled, PRs opened, pushed, closed or merged,
   * and a PR head's CI started and completed (its check runs, newest per suite and name, as the feed holds them).
   */
  const observe = (feed: { runs(repo: string, sha: string): { name: string; status: string; conclusion: string | null; started: string | null; completed: string | null }[] }): Hook => async (e, ctx) => {
    const repo = e.resource, x = e.data ?? {}, n = Number(x.number), head = String(x.head ?? "");
    const t = now().toISOString();
    if (e.kind === "issues.opened") f.issueOpened(repo, { number: n, created_at: String(x.created_at ?? t), labels: (x.labels as string[]) ?? [], state: "open", author: e.author ?? "ghost", author_kind: x.author_kind as Kind });
    else if (e.kind === "issues.labeled") f.issueLabeled(repo, n, e.id.replace(/^ev:/, ""), String(x.label ?? ""), String(x.actor ?? "ghost"), String(ctx.pr?.created_at ?? t));
    else if (e.kind === "pull_request.opened") f.opened(repo, n, head, String(x.head_ref ?? ""), t, taskOf(repo, n), undefined, { title: String(e.text ?? "").split("\n")[0], author: e.author ?? "ghost", author_kind: x.author_kind });
    else if (e.kind === "pull_request.synchronize") {
      const cmp = d.gh ? await d.gh("GET", `/repos/${repo}/compare/${x.before}...${head}`).catch(() => undefined) : undefined;
      f.pushed(repo, n, head, String(x.before ?? ""), cmp && cmp.status < 300 ? !["ahead", "identical"].includes(String(cmp.body?.status)) : false, e.author ?? "ghost", t);
    } else if (e.kind === "pull_request.closed") {
      const pr = ctx.pr ?? {};
      if (pr.merged_at) f.merged(repo, n, head, String(pr.merge_commit_sha ?? ""), pr.merged_at, String(pr.title ?? ""), String(pr.body ?? ""));
      else f.closed(repo, n, head, pr.closed_at ?? t);
    } else if (e.kind === "check_run.completed") {
      const runs = feed.runs(repo, head);
      const starts = runs.map((r) => Date.parse(r.started ?? "")).filter(Number.isFinite), ends = runs.map((r) => Date.parse(r.completed ?? "")).filter(Number.isFinite);
      for (const pr of (x.prs as number[]) ?? []) {
        if (starts.length) f.checksStarted(repo, pr, head, utc(Math.min(...starts)));
        if (runs.every((r) => r.status === "completed")) f.checksCompleted(repo, pr, head, runs.filter((r) => FAILED.has(String(r.conclusion))).map((r) => r.name).slice(0, 20), ends.length ? utc(Math.max(...ends)) : t);
      }
    }
  };
  return Object.assign(f, { churnPass, churnRepo, backfill, observe });
}
export type Flow = ReturnType<typeof createFlow>;
