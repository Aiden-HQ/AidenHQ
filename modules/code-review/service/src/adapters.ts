// The real seams (seams.ts), each with this module's own token:
// - PRs and comments: github-mcp's internal read for this module (/internal/code-review/*, opened to the code-review module alone,
//   as the Maintainer's issue read is), as the owner's GitHub sign-in github-mcp holds.
// - Review runs: the kernel's credential-free check job `code-review` (POST /v1/checks; the recipe is lane E's), its Review read
//   from the finished check.
// - Posting: kernel write records (POST /v1/writes) of this module's kind code-review.post (Tier 1, the AI reviewer
//   decides), code-review.notice and .status (Tier 0, fixed words), which this service executes (executor@1) through github-mcp's
//   /internal/review routes.
import type { KernelClient } from "./aidenhq-sdk/kernel-client.ts";
import type { Executor } from "./aidenhq-sdk/executor.ts";
import type { Permission, Posted, Poster, PrComment, PrSource, PullRequest, Review, ReviewRunner, ReviewSpec, RunResult, Status, Thread } from "./seams.ts";

export const RECIPE = "code-review";
/** This module's write kinds (module.yaml writes), executed by this service through github-mcp's review routes. */
export const POST_KIND = "code-review.post";
export const ACK_KIND = "code-review.notice";
export const STATUS_KIND = "code-review.status";
/** The role whose agent (the Reviewer Manager) holds each PR's task, where its posts' approvals land. */
export const ROLE = "reviewer-manager";

export function githubSource(base: string, token: () => string, fetcher: typeof fetch = fetch): PrSource {
  const get = async (path: string, q: Record<string, string | number>) => {
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
    const r = await fetcher(`${base.replace(/\/+$/, "")}/internal/code-review/${path}?${qs}`, { headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(30_000) });
    // The status rides on the error: a 4xx (bar 408 and 429) is an answer, never retried; anything else is transient.
    if (!r.ok) throw Object.assign(new Error(`github-mcp ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
    return r.json();
  };
  return {
    open: async (repo) => ((await get("prs", { repo })) as { prs: PullRequest[] }).prs,
    get: async (repo, number) => ((await get("pr", { repo, number })) as { pr: PullRequest }).pr,
    comments: async (repo, since) => (await get("comments", { repo, since })) as { comments: PrComment[]; cursor: string },
    permission: async (repo, login) => ((await get("permission", { repo, login })) as { permission: Permission }).permission,
    compare: async (repo, base, head) => (await get("compare", { repo, base, head })) as { merge_base: string; status: "ahead" },
    mergeBase: async (repo, number, head) => (await get("merge-base", { repo, number, head })) as { merge_base: string },
    postable: async (repo) => (await get("postable", { repo })) as { identity: "owner" | null; org: string },
    repos: async (q) => ((await get("repos", { q })) as { repos: { repo: string; private: boolean; url?: string }[] }).repos,
    threads: async (repo, number) => {
      const r = await fetcher(`${base.replace(/\/+$/, "")}/internal/review/threads`, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify({ repo, number }), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw Object.assign(new Error(`github-mcp threads: ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
      return ((await r.json()) as { threads: Thread[] }).threads;
    },
  };
}

/**
 * The check job's spec (module.yaml check_jobs.code-review; every field a string of its kind): base is the merge base, and a full
 * review's incremental_from is that base too; the repo's ignore globs and max_nits ride in the combo; the previous findings are
 * those the recipe rechecks (and the finders take as already reported), full reviews included.
 */
export function checkSpec(s: ReviewSpec): Record<string, string> {
  return {
    base: s.merge_base, incremental_from: s.incremental_from ?? s.merge_base, pr: String(s.number),
    combo: JSON.stringify({ ...s.combo, ignore: s.ignore, max_nits: s.max_nits, mandatory: s.mandatory }), focus: s.focus ?? "",
    previous: JSON.stringify({ findings: s.previous }),
  };
}

export function kernelRunner(kernel: KernelClient): ReviewRunner {
  return {
    async start(s) {
      const v = await kernel.call("POST", "/v1/checks", { repo: s.repo, head: s.head, run: RECIPE, spec: checkSpec(s) });
      return { check: String(v.id) };
    },
    async result(check): Promise<RunResult> {
      // billed_usd: the kernel's own billing of the check job's model token (so far, while it runs); the box's Review says what it spent too, never trusted.
      const v = (await kernel.call("GET", `/v1/checks/${check}`)) as { state: string; receipt: { verdict: string; summary: string } | null; error: string | null; result?: Review; billed_usd?: number; waiting?: boolean; box_at?: string | null };
      const billed = { ...(typeof v.billed_usd === "number" ? { billed_usd: v.billed_usd } : {}), ...(v.box_at ? { box_at: v.box_at } : {}) };
      if (v.state === "running") return { state: "running", ...billed, ...(v.waiting ? { waiting: true } : {}) };
      if (v.state === "done" && v.receipt?.verdict === "pass" && v.result?.version === 1) return { state: "done", review: v.result, ...billed };
      // A check that failed before it got a box (its snapshot couldn't be read, a restart) ran nothing, so spent nothing.
      return { state: "failed", why: (v.error ?? v.receipt?.summary ?? `the check ended ${v.state}`).slice(0, 300), ...billed, ...(!v.box_at && billed.billed_usd === undefined ? { billed_usd: 0 } : {}) };
    },
  };
}

/** A skip's reason as the notice's fixed words name it (seams' `why` starts with its key). */
export function reasonOf(why: string | undefined): string | undefined {
  const w = String(why ?? "");
  const key = w.split(":")[0]!;
  return ["draft", "fork", "superseded", "stopped"].includes(key) ? key : undefined;
}

/**
 * Posting as kernel write records of this module's own kinds (module.yaml writes): `code-review.post` (Tier 1: the AI reviewer
 * decides, so it is filed on the PR's task, one per PR for the Reviewer Manager) and `code-review.notice` (Tier 0, fixed words).
 * The target (repo, pr, head) is always the run's, never the review body's.
 */
/** A write record's state as a post's: done with an ok outcome is posted; failed, rejected, stale or cancelled is refused. */
function settled(r: { id: string; state: string; outcome?: { ok: boolean; text: string } | null }): Posted {
  if (r.state === "done") {
    if (r.outcome && !r.outcome.ok) return { state: "refused", why: `write ${r.id}: ${r.outcome.text.slice(0, 200)}`, retry: true };
    // The executor's outcome (github-mcp review-post.ts): the review's link, the threads it resolved, the identity it posted as.
    let o: { review?: unknown; resolved?: unknown; identity?: unknown; comments?: unknown; ack_id?: unknown } = {};
    try { o = JSON.parse(r.outcome?.text ?? "{}"); } catch {}
    return { state: "posted", ...(typeof o.review === "string" && /^https:\/\/github\.com\//.test(o.review) ? { url: o.review } : {}), ...(typeof o.resolved === "number" ? { resolved: o.resolved } : {}), ...(o.identity === "owner" ? { identity: o.identity } : {}), ...(Number.isInteger(o.ack_id) && (o.ack_id as number) > 0 ? { ack: o.ack_id as number } : {}), ...(Array.isArray(o.comments) ? { comments: o.comments.filter((c): c is number => Number.isInteger(c) && (c as number) > 0).slice(0, 200) } : {}) };
  }
  // Failed or stale (what it acted on changed, e.g. a restart between its approval and its run) may post when filed again; a
  // rejection is the AI reviewer's or the owner's answer, and a cancel is someone's decision.
  if (["failed", "rejected", "stale", "cancelled", "unknown"].includes(r.state)) return { state: "refused", why: `write ${r.id} ${r.state}${r.outcome?.text ? `: ${r.outcome.text.slice(0, 200)}` : ""}`, ...(["failed", "stale", "unknown"].includes(r.state) ? { retry: true } : {}) };
  return { state: "pending" };
}

/** The review's fields `code-review.post` accepts (schemas/post.json `review`). */
const REVIEW_FIELDS = ["version", "repo", "pr", "base", "head", "engine", "model", "effort", "incremental_from", "full", "coverage", "findings", "withheld", "cost_usd", "stale_guidance"] as const satisfies readonly (keyof Review)[];

export function kernelPoster(kernel: KernelClient, log: (m: string, f?: Record<string, unknown>) => void = () => {}): Poster {
  const tasks = new Map<string, string>();
  // One task per PR on a watched repo (closed with the PR); a one-off elsewhere gets its own (`run`), closed once its post settles.
  const taskOf = async (repo: string, n: number, run?: string) => {
    const key = `${repo}#${n}${run ? `:${run}` : ""}`;
    if (!tasks.has(key)) {
      // Fixed text naming only the repo and number: the PR's own title and body are a stranger's words.
      // Quiet: it only holds the posts' approval records, so it wakes nobody; closed with the PR (close below).
      const t = await kernel.call("POST", "/v1/tasks", { title: `Code review: ${key}`, description: `${key}\n\nCode review's posts on this pull request are approved here; its reviews and findings are on the board's Reviews page.`, role: ROLE, source: `code-review:${key}`, quiet: true });
      tasks.set(key, String(t.id));
    }
    return tasks.get(key)!;
  };
  return {
    async post(p) {
      const t = p.target;
      // Threads to resolve: earlier findings the recipe's recheck found fixed (github-mcp resolves only Aiden's own, still unreported).
      // The review is the post kind's fields only (schemas/post.json is strict): the recipe's result also carries its own notes
      // (`addressed`, `guidance`) that no post renders, so what is sent is picked, never what is left after stripping.
      const { fixed } = p.review;
      const review = { ...Object.fromEntries(REVIEW_FIELDS.filter((k) => k in p.review).map((k) => [k, p.review[k]])), repo: t.repo, pr: t.number, head: t.head };
      const args = { repo: t.repo, pr: t.number, head: t.head, run: p.run, review, resolve: (fixed ?? []).filter((id) => typeof id === "string").slice(0, 100), gated: !!p.gated, own: (p.own ?? []).slice(0, 1000) };
      const r = (await kernel.call("POST", "/v1/writes", { kind: POST_KIND, args, task: await taskOf(t.repo, t.number, t.once ? p.run : undefined) })) as { id: string; state: string };
      return { ...settled(r), write: r.id };
    },
    async status(s: Status) {
      const r = (await kernel.call("POST", "/v1/writes", { kind: STATUS_KIND, args: { repo: s.repo, pr: s.number, head: s.head, reason: s.reason, important: s.important, running: s.running.slice(0, 8), ...(s.partial ? { partial: true } : {}) } })) as { id: string; state: string; outcome?: { ok: boolean; text: string } | null };
      return { ...settled(r), write: r.id };
    },
    async outcome(write) {
      return settled((await kernel.call("GET", `/v1/writes/${write}`)) as { id: string; state: string; outcome?: { ok: boolean; text: string } | null });
    },
    async ack(a) {
      // The notice speaks only in its fixed words: a phase (with a reason), or a command's answer (help, always, focus).
      const reason = reasonOf(a.why);
      if (a.state === "skipped" && !reason) return undefined;
      const r = (await kernel.call("POST", "/v1/writes", { kind: ACK_KIND, args: { ...(a.ack ? { ack: a.ack } : {}), repo: a.repo, pr: a.number, head: a.head, phase: a.state, ...(a.state === "answered" ? { answer: a.answer ?? "help" } : {}), ...(reason ? { reason } : {}), ...(a.combo ? { engine: a.combo.engine, model: a.combo.model, effort: a.combo.effort } : {}), ...(a.run ? { run: a.run } : {}), ...(a.review ? { review: a.review } : {}), ...(a.counts ?? {}) } })) as { id: string; state: string; outcome?: { ok: boolean; text: string } | null };
      return { ...settled(r), write: r.id };
    },
    async close(repo, n, why, run) {
      // The engine closes only a PR that had a post, so its task exists: filing the same source again finds it after a restart.
      const id = await taskOf(repo, n, run);
      await kernel.call("POST", `/v1/tasks/${id}/close`, { status: "done", body: why });
      tasks.delete(`${repo}#${n}${run ? `:${run}` : ""}`);
    },
  };
}

/**
 * executor@1 for this module's kinds: plan and execute go to github-mcp's internal review routes (as this module). Plan refuses a
 * record that isn't this service's own (requested by the code-review module, naming a run whose repo, PR and head it repeats), so
 * no other requester can post a review through these kinds.
 */
export function reviewExecutor(github: (op: "preview" | "execute", body: unknown) => Promise<any>, runOf: (id: string) => { repo: string; number: number; head: string } | undefined): Executor {
  const kindOf = (k: string) => (k === POST_KIND ? "post" : k === ACK_KIND ? "notice" : k === STATUS_KIND ? "status" : undefined);
  return {
    async plan(req) {
      const kind = kindOf(req.kind);
      const a = (req.args ?? {}) as { repo?: string; pr?: number; head?: string; run?: string };
      if (!kind) throw new Error(`not a code-review kind: ${req.kind}`);
      if (req.requester?.kind !== "module" || req.requester.module !== "code-review") throw new Error("only the code-review service files these");
      const run = a.run ? runOf(a.run) : undefined;
      if (kind !== "notice" && kind !== "status" && (!run || run.repo !== String(a.repo).toLowerCase() || run.number !== a.pr || run.head !== a.head)) throw new Error(`the ${kind} doesn't match its run`);
      const v = (await github("preview", { kind, args: req.args })) as { facts?: Record<string, unknown>; targets?: Record<string, unknown> };
      return { args: req.args, ...(v.facts ? { facts: v.facts } : {}), ...(v.targets ? { targets: v.targets } : {}) };
    },
    async execute(rec) {
      const kind = kindOf(rec.kind);
      if (!kind) return { ok: false, text: `not a code-review kind: ${rec.kind}` };
      // Aiden's own threads are told apart by their marker and author (github-mcp review-post.ts), never by the kernel's records,
      // which keep only a code host's objects.
      const v = (await github("execute", { kind, args: rec.args })) as { ok?: boolean; text?: string };
      return { ok: v.ok === true, text: String(v.text ?? "") };
    },
  };
}

/** github-mcp's internal review routes, as this module. */
export function githubReview(base: string, token: () => string, fetcher: typeof fetch = fetch) {
  return async (op: "preview" | "execute", body: unknown) => {
    // An execute answers when the post is done, however long github-mcp's write queue and GitHub's rate limits take: it sends a
    // blank every 30 s meanwhile, so a stall (no bytes for fetch's body timeout) fails it, never a duration. A failure after the
    // headers is the body's `error`. Only the preview, which makes no GitHub write, gets a short timeout.
    const r = await fetcher(`${base.replace(/\/+$/, "")}/internal/review/${op}`, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify(body), ...(op === "preview" ? { signal: AbortSignal.timeout(120_000) } : {}) });
    // A body that can't be read (the connection dropped after the headers) rejects here: the outcome is unknown, never an empty one.
    const text = await r.text();
    const j = (() => { try { return JSON.parse(text); } catch { if (r.ok) throw new Error(`github-mcp review ${op}: an unreadable answer (${text.slice(0, 100)})`); return {}; } })();
    if (!r.ok || (j as { error?: string }).error) throw new Error(`github-mcp review ${op}: ${r.status} ${String((j as { detail?: string }).detail ?? "").slice(0, 300)}`);
    return j;
  };
}
