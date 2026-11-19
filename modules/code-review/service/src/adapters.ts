// The real seams (seams.ts), each with this module's own token:
// - PRs and comments: github-mcp's internal read for this module (/internal/code-review/*, opened to the code-review module alone,
//   as the Maintainer's issue read is), with whichever GitHub identity github-mcp holds: the App where installed, else the owner's
//   sign-in.
// - Review runs: the kernel's credential-free check job `code-review` (POST /v1/checks; the recipe is lane E's), its Review read
//   from the finished check.
// - Posting: kernel write records (POST /v1/writes) of this module's kinds code-review.post (Tier 1, the AI reviewer decides) and
//   code-review.notice (Tier 0), which this service executes (executor@1) through github-mcp's /internal/review routes.
import type { KernelClient } from "./aidenhq-sdk/kernel-client.ts";
import type { Executor } from "./aidenhq-sdk/executor.ts";
import type { Ack, Permission, Poster, PrComment, PrSource, PullRequest, Review, ReviewRunner, ReviewSpec, RunResult } from "./seams.ts";

export const RECIPE = "code-review";
/** This module's write kinds (module.yaml writes), executed by this service through github-mcp's review routes. */
export const POST_KIND = "code-review.post";
export const ACK_KIND = "code-review.notice";
/** The role whose agent (the Reviewer Manager) holds each PR's task, where its posts' approvals land. */
export const ROLE = "reviewer-manager";

export function githubSource(base: string, token: () => string, fetcher: typeof fetch = fetch): PrSource {
  const get = async (path: string, q: Record<string, string | number>) => {
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
    const r = await fetcher(`${base.replace(/\/+$/, "")}/internal/code-review/${path}?${qs}`, { headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`github-mcp ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  return {
    open: async (repo) => ((await get("prs", { repo })) as { prs: PullRequest[] }).prs,
    get: async (repo, number) => ((await get("pr", { repo, number })) as { pr: PullRequest }).pr,
    comments: async (repo, since) => (await get("comments", { repo, since })) as { comments: PrComment[]; cursor: string },
    permission: async (repo, login) => ((await get("permission", { repo, login })) as { permission: Permission }).permission,
  };
}

/** The check job's spec: every field a string (the kernel's spec kinds), the profile and lists as JSON. */
export function checkSpec(s: ReviewSpec): Record<string, string> {
  return {
    base: s.base, pr: String(s.number), reviewer: s.reviewer, profile: JSON.stringify(s.profile), focus: s.focus ?? "",
    incremental_from: s.incremental_from ?? "", full: String(s.full), budget_usd: s.budget_usd.toFixed(2), ignore: JSON.stringify(s.ignore), max_nits: String(s.max_nits),
  };
}

export function kernelRunner(kernel: KernelClient): ReviewRunner {
  return {
    async start(s) {
      const v = await kernel.call("POST", "/v1/checks", { repo: s.repo, head: s.head, run: RECIPE, spec: checkSpec(s) });
      return { check: String(v.id) };
    },
    async result(check): Promise<RunResult> {
      // billed_usd: the kernel's own billing of the check job's model token; the box's Review says what it spent too, never trusted.
      const v = (await kernel.call("GET", `/v1/checks/${check}`)) as { state: string; receipt: { verdict: string; summary: string } | null; error: string | null; result?: Review; billed_usd?: number };
      if (v.state === "running") return { state: "running" };
      const billed = typeof v.billed_usd === "number" ? { billed_usd: v.billed_usd } : {};
      if (v.state === "done" && v.receipt?.verdict === "pass" && v.result?.version === 1) return { state: "done", review: v.result, ...billed };
      return { state: "failed", why: (v.error ?? v.receipt?.summary ?? `the check ended ${v.state}`).slice(0, 300), ...billed };
    },
  };
}

/** A skip's reason as the notice's fixed words name it (seams' `why` starts with its key). */
export function reasonOf(why: string | undefined): string | undefined {
  const w = String(why ?? "");
  if (w.startsWith("budget: the instance")) return "budget_instance";
  if (w.startsWith("budget")) return "budget_repo";
  if (w.startsWith("daily limit")) return "ignored";
  const key = w.split(":")[0]!;
  return ["draft", "fork", "superseded", "stopped"].includes(key) ? key : undefined;
}

/**
 * Posting as kernel write records of this module's own kinds (module.yaml writes): `code-review.post` (Tier 1: the AI reviewer
 * decides, so it is filed on the PR's task, one per PR for the Reviewer Manager) and `code-review.notice` (Tier 0, fixed words).
 * The target (repo, pr, head) is always the run's, never the review body's.
 */
export function kernelPoster(kernel: KernelClient, log: (m: string, f?: Record<string, unknown>) => void = () => {}): Poster {
  const tasks = new Map<string, string>();
  const taskOf = async (repo: string, n: number) => {
    const key = `${repo}#${n}`;
    if (!tasks.has(key)) {
      // Fixed text naming only the repo and number: the PR's own title and body are a stranger's words.
      const t = await kernel.call("POST", "/v1/tasks", { title: `Code review: ${key}`, description: `${key}\n\nCode review's posts on this pull request are approved here; its reviews and findings are on the board's Reviews page.`, role: ROLE, source: `code-review:${key}` });
      tasks.set(key, String(t.id));
    }
    return tasks.get(key)!;
  };
  return {
    async post(p) {
      const t = p.target;
      const args = { repo: t.repo, pr: t.number, head: t.head, run: p.run, review: { ...p.review, repo: t.repo, pr: t.number, head: t.head }, resolve: [] as string[] };
      const r = (await kernel.call("POST", "/v1/writes", { kind: POST_KIND, args, task: await taskOf(t.repo, t.number) })) as { id: string; state: string };
      return ["rejected", "refused", "failed", "expired"].includes(r.state) ? { state: "refused", why: `write ${r.id} ${r.state}` } : { state: r.state === "done" ? "posted" : "pending" };
    },
    async ack(a: Ack) {
      // The notice speaks only in its fixed phases: status and help answer with where the PR's last run is; always and focus
      // need no notice.
      if (a.state === "status" || a.state === "help") return void log("review status asked", { repo: a.repo, pr: a.number });
      const reason = reasonOf(a.why);
      if (a.state === "skipped" && !reason) return;
      await kernel.call("POST", "/v1/writes", { kind: ACK_KIND, args: { repo: a.repo, pr: a.number, head: a.head, phase: a.state, ...(reason ? { reason } : {}), ...(a.reviewer && a.reviewer !== "try" ? { reviewer: a.reviewer } : {}), ...(a.run ? { run: a.run } : {}) } });
    },
  };
}

/**
 * executor@1 for this module's kinds: plan and execute go to github-mcp's internal review routes (as this module). Plan refuses a
 * record that isn't this service's own (requested by the code-review module, naming a run whose repo, PR and head it repeats), so
 * no other requester can post a review through these kinds.
 */
export function reviewExecutor(github: (op: "preview" | "execute", body: unknown) => Promise<any>, runOf: (id: string) => { repo: string; number: number; head: string } | undefined): Executor {
  const kindOf = (k: string) => (k === POST_KIND ? "post" : k === ACK_KIND ? "notice" : undefined);
  return {
    async plan(req) {
      const kind = kindOf(req.kind);
      const a = (req.args ?? {}) as { repo?: string; pr?: number; head?: string; run?: string };
      if (!kind) throw new Error(`not a code-review kind: ${req.kind}`);
      if (req.requester?.kind !== "module" || req.requester.module !== "code-review") throw new Error("only the code-review service files these");
      const run = a.run ? runOf(a.run) : undefined;
      if (kind === "post" && (!run || run.repo !== String(a.repo).toLowerCase() || run.number !== a.pr || run.head !== a.head)) throw new Error("the post doesn't match its run");
      const v = (await github("preview", { kind, args: req.args })) as { facts?: Record<string, unknown>; targets?: Record<string, unknown> };
      return { args: req.args, ...(v.facts ? { facts: v.facts } : {}), ...(v.targets ? { targets: v.targets } : {}) };
    },
    async execute(rec) {
      const kind = kindOf(rec.kind);
      if (!kind) return { ok: false, text: `not a code-review kind: ${rec.kind}` };
      const v = (await github("execute", { kind, args: rec.args })) as { ok?: boolean; text?: string };
      return { ok: v.ok === true, text: String(v.text ?? "") };
    },
  };
}

/** github-mcp's internal review routes, as this module. */
export function githubReview(base: string, token: () => string, fetcher: typeof fetch = fetch) {
  return async (op: "preview" | "execute", body: unknown) => {
    const r = await fetcher(`${base.replace(/\/+$/, "")}/internal/review/${op}`, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`github-mcp review ${op}: ${r.status} ${String((j as { detail?: string }).detail ?? "").slice(0, 300)}`);
    return j;
  };
}
