// The code-review module's state service, read by the board's Reviews page (its client: reviews-client.ts) (web/src/Reviews.tsx; docs/design/code-review.md).
// The module owns the runs, the PR state and every GitHub write; the board only reads them, starts one-off and trial runs,
// and files the owner's change to settings.code_review through the normal settings change. Types mirror the module's API.
import { z } from "zod";

export type Severity = "important" | "nit" | "pre_existing";
export interface Finding {
  id: string;
  severity: Severity;
  path: string;
  line: number;
  end_line?: number;
  title: string;
  why: string;
  evidence: string;
  fix_brief: string;
  /** The posted inline comment, once the poster filed it. */
  url?: string;
}
export interface Review {
  version: 1;
  repo: string;
  pr: number;
  base: string;
  head: string;
  reviewer: string;
  incremental_from: string | null;
  full: boolean;
  coverage: { reviewed: string[]; excluded: string[]; incomplete: string | null };
  findings: Finding[];
  withheld: { important: number; nit: number; pre_existing: number };
  triage?: { summary: string; risk: "trivial" | "normal" | "high" };
  cost_usd: number;
  stale_guidance: string[];
}
export type RunStatus = "queued" | "running" | "done" | "skipped" | "failed";
export interface Run {
  id: string;
  repo: string;
  number: number;
  head: string;
  reviewer: string;
  kind: "auto" | "command" | "oneoff" | "escalation";
  status: RunStatus;
  /** Why it was skipped or failed: "<reason>: <sentence>" (draft, fork, daily limit, budget, …). */
  why: string | null;
  cost_usd: number;
  important: number;
  nit: number;
  pre_existing: number;
  /** Null while queued. */
  started: string | null;
  ended: string | null;
  check_job: string | null;
  /** False for a trial run ("Try on a recent PR"): it never posts. */
  post?: boolean;
  /** The PR's title (untrusted text: shown as plain text only) and the posted review's link, when the service has them. */
  title?: string;
  review_url?: string;
  /** Threads Aiden resolved on this head because their finding was gone. */
  resolved?: number;
}
/** GET /repos: each watched repo as the service runs it, with this month's spend (UTC) and what running reviews hold. */
export interface RepoRow {
  repo: string;
  month_usd: number;
  month_spent_usd: number;
  month_reserved_usd?: number;
  /** Why the service can't watch it (no read access, …); null when fine. */
  error?: string | null;
  /** Who posts there, when the service knows: the instance's GitHub App, or the owner's sign-in. */
  identity?: "app" | "owner" | null;
}
export interface ReposView {
  repos: RepoRow[];
  month_usd: number;
  month_spent_usd: number;
  errors?: string[];
}
/** GET /reviewers: each profile with its finished runs and their average cost. */
export type ReviewerRow = Profile & { name: string; runs: number; avg_cost_usd: number | null };

/* ---------------------------------------------------------------------------- settings.code_review (the page's check) */
const NAME = z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/, "a name is lowercase letters, digits, - or _");
/** A trigger: a reviewer's name, or "off". */
export const OFF = "off";
const MODEL = z.string().regex(/^[A-Za-z0-9~][\w./~:@-]{0,119}$/, "a model is its id, like ~deepseek/deepseek-flash-latest");
const PLAIN = (max: number) => z.string().max(max).regex(/^[^\x00-\x1f\x7f$]*$/, "no control characters or $");
export const ENGINES = ["codex", "claude-code", "codegenie"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const ProfileSchema = z
  .object({
    engine: z.enum(ENGINES),
    model: MODEL,
    effort: z.enum(EFFORTS),
    finders: z.number().int().min(1).max(8),
    verify: z.boolean(),
    verifier: MODEL.optional(),
    context: z.array(PLAIN(200).min(1)).max(20).optional(),
    focus: PLAIN(500).optional(),
    label: PLAIN(60).optional(),
    run_usd: z.number().min(0.01).max(100).optional(),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;
export const RepoSchema = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a repo is owner/name"),
    on_open: NAME.optional(),
    on_push: NAME.optional(),
    on_risk: NAME.optional(),
    drafts: z.boolean().optional(),
    forks: z.enum(["manual", "auto"]).optional(),
    month_usd: z.number().positive().max(10_000).optional(),
    ignore: z.array(PLAIN(200).min(1)).max(50).optional(),
    max_nits: z.number().int().min(0).max(50).optional(),
    per_author_day: z.number().int().min(0).max(1000).optional(),
    per_repo_day: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export type RepoConfig = z.infer<typeof RepoSchema>;
export const CodeReviewSchema = z
  .object({
    // A default reviewer set to null is switched off (the module's defaults are merged under these).
    reviewers: z.record(NAME, ProfileSchema.nullable()),
    repos: z.array(RepoSchema).max(100),
    month_usd: z.number().positive().max(100_000),
  })
  .strict()
  .superRefine((v, ctx) => {
    const names = new Set([...Object.keys(DEFAULT_REVIEWERS), ...Object.keys(v.reviewers)].filter((n) => v.reviewers[n] !== null));
    if (new Set(v.repos.map((r) => r.repo.toLowerCase())).size !== v.repos.length) ctx.addIssue({ code: "custom", message: "each repo once" });
    for (const [i, r] of v.repos.entries())
      for (const k of ["on_open", "on_push", "on_risk"] as const) if (r[k] && r[k] !== OFF && !names.has(r[k]!)) ctx.addIssue({ code: "custom", path: ["repos", i, k], message: `there is no reviewer ${r[k]}` });
    for (const [n, p] of Object.entries(v.reviewers)) if (p?.verifier && !p.verify) ctx.addIssue({ code: "custom", path: ["reviewers", n, "verifier"], message: "a verifier model needs verify on" });
  });
export type CodeReview = z.infer<typeof CodeReviewSchema>;
/** The module's shipped reviewers (modules/code-review service/src/config.ts DEFAULT_REVIEWERS): merged under the setting's own. */
export const DEFAULT_REVIEWERS: Record<string, Profile> = {
  quick: { engine: "codex", model: "~openai/gpt-luna-latest", effort: "low", finders: 1, verify: false },
  standard: { engine: "codex", model: "~openai/gpt-luna-latest", effort: "high", finders: 2, verify: true },
  deep: { engine: "codex", model: "~openai/gpt-luna-latest", effort: "high", finders: 4, verify: true, verifier: "~openai/gpt-luna-latest" },
  triage: { engine: "codex", model: "~openai/gpt-luna-latest", effort: "low", finders: 1, verify: false, focus: "triage" },
};
/** A repo's defaults when the owner watches it (the spec's UX: Standard on open, Quick on push, drafts off, forks on request). */
export const REPO_DEFAULTS = { on_open: "standard", on_push: "quick", on_risk: "deep", drafts: false, forks: "manual", month_usd: 50, max_nits: 5, per_author_day: 10, per_repo_day: 60 } as const;
/** The reviewers in force: the module's defaults under the setting's, a null switching one off. */
export const reviewersOf = (c: CodeReview): Record<string, Profile> =>
  Object.fromEntries(Object.entries({ ...DEFAULT_REVIEWERS, ...c.reviewers }).filter((e): e is [string, Profile] => e[1] !== null));
/** The problems with a code_review value, in the owner's words (empty: fine). */
export function configProblems(value: unknown): string[] {
  const r = CodeReviewSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
}

/* ---------------------------------------------------------------------------- insights (the runs the review.* facts record) */
export interface ReviewInsights {
  days: { day: string; reviews: number; cost: number }[];
  by_repo: { repo: string; reviews: number; cost: number; prs: number }[];
  severity: { important: number; nit: number; pre_existing: number };
  /** Of the findings later runs looked at again, the share Aiden resolved because they were fixed; null with none. */
  resolved_rate: number | null;
  skips: { why: string; n: number }[];
  total: { reviews: number; cost: number; prs: number; failed: number };
}
/** The period's numbers from the runs: one row per run, as the review.started/ended facts carry them. */
export function insightsOf(runs: Run[], days: number, now = Date.now()): ReviewInsights {
  const since = now - days * 86_400_000;
  // A skip never starts: it counts on the day it ended.
  const at = (r: Run) => r.started ?? r.ended ?? "";
  const inside = runs.filter((r) => at(r) && Date.parse(at(r)) >= since && r.post !== false);
  const done = inside.filter((r) => r.status === "done");
  const byDay = new Map<string, { reviews: number; cost: number }>();
  for (let i = days - 1; i >= 0; i--) byDay.set(new Date(now - i * 86_400_000).toISOString().slice(0, 10), { reviews: 0, cost: 0 });
  for (const r of inside) {
    const d = byDay.get(at(r).slice(0, 10));
    if (d) (d.cost += r.cost_usd), r.status === "done" && d.reviews++;
  }
  const repos = new Map<string, { reviews: number; cost: number; prs: Set<number> }>();
  for (const r of inside) {
    const x = repos.get(r.repo) ?? { reviews: 0, cost: 0, prs: new Set<number>() };
    x.cost += r.cost_usd;
    if (r.status === "done") x.reviews++;
    x.prs.add(r.number);
    repos.set(r.repo, x);
  }
  const skips = new Map<string, number>();
  const reason = (why: string | null) => (why ?? "unknown").split(":")[0]!.trim();
  for (const r of inside) if (r.status === "skipped") skips.set(reason(r.why), (skips.get(reason(r.why)) ?? 0) + 1);
  const found = done.reduce((s, r) => s + r.important + r.nit, 0);
  const resolved = done.reduce((s, r) => s + (r.resolved ?? 0), 0);
  return {
    days: [...byDay].map(([day, v]) => ({ day, ...v })),
    by_repo: [...repos].map(([repo, v]) => ({ repo, reviews: v.reviews, cost: v.cost, prs: v.prs.size })).sort((a, b) => b.cost - a.cost),
    severity: { important: done.reduce((s, r) => s + r.important, 0), nit: done.reduce((s, r) => s + r.nit, 0), pre_existing: done.reduce((s, r) => s + r.pre_existing, 0) },
    resolved_rate: found && done.some((r) => r.resolved !== undefined) ? Math.min(1, resolved / found) : null,
    skips: [...skips].map(([why, n]) => ({ why, n })).sort((a, b) => b.n - a.n),
    total: { reviews: done.length, cost: inside.reduce((s, r) => s + r.cost_usd, 0), prs: new Set(inside.map((r) => `${r.repo}#${r.number}`)).size, failed: inside.filter((r) => r.status === "failed").length },
  };
}

