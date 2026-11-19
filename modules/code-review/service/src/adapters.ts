// The real seams (seams.ts), each with this module's own token:
// - PRs and comments: github-mcp's internal read for this module (/internal/code-review/*, opened to the code-review module alone,
//   as the Maintainer's issue read is), with whichever GitHub identity github-mcp holds: the App where installed, else the owner's
//   sign-in.
// - Review runs: the kernel's credential-free check job `code-review` (POST /v1/checks; the recipe is lane E's), its Review read
//   from the finished check.
// - Posting: kernel write records (POST /v1/writes) of the github module's review kinds, each one the AI reviewer decides.
import type { KernelClient } from "./aidenhq-sdk/kernel-client.ts";
import type { Ack, Permission, Poster, PrComment, PrSource, PullRequest, Review, ReviewRunner, ReviewSpec, RunResult } from "./seams.ts";

export const RECIPE = "code-review";
/** The github module's write kinds for a review and for the acknowledgement (lane P's names). */
export const POST_KIND = "github.code_review";
export const ACK_KIND = "github.code_review_ack";

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

export function kernelPoster(kernel: KernelClient): Poster {
  return {
    async post(p) {
      const r = (await kernel.call("POST", "/v1/writes", { kind: POST_KIND, args: p })) as { id: string; state: string };
      return ["rejected", "refused", "failed", "expired"].includes(r.state) ? { state: "refused", why: `write ${r.id} ${r.state}` } : { state: r.state === "done" ? "posted" : "pending" };
    },
    async ack(a: Ack) {
      await kernel.call("POST", "/v1/writes", { kind: ACK_KIND, args: a });
    },
  };
}
