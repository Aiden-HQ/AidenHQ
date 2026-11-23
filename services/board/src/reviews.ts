// The code-review module's state service, read by the board's Reviews page (its client: reviews-client.ts) (web/src/Reviews.tsx; docs/design/code-review.md).
// The module owns the runs, the PR state and every GitHub write; the board only reads them, starts one-off runs,
// and files the owner's change to settings.code_review through the normal settings change. Types mirror the module's API.
import { z } from "zod";
import type { Accepts } from "./model-catalog.js";

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
  engine: Engine;
  model: string;
  effort: string;
  incremental_from: string | null;
  full: boolean;
  coverage: { reviewed: string[]; excluded: string[]; incomplete: string | null };
  findings: Finding[];
  withheld: { important: number; nit: number; pre_existing: number };
  cost_usd: number;
  stale_guidance: string[];
}
/** What became of a posted finding, once known. */
export type Outcome = "fixed" | "dismissed" | "open_at_merge" | "open_at_close";
/** On a repo code review gates (a mandatory combo): the PR's merge verdict at its current head and its open gating findings. */
export interface Gate {
  verdict: "pass" | "wait";
  reasons: { code: string; text: string; unblock?: string }[];
  head: string;
  open: { id: string; path: string; line: number; title: string }[];
}
export interface FindingRow {
  id: string;
  severity: Severity;
  path: string;
  line: number;
  title: string;
  outcome: Outcome | null;
}
export type RunStatus = "queued" | "running" | "done" | "skipped" | "failed";
export interface Run {
  id: string;
  repo: string;
  number: number;
  head: string;
  engine: Engine;
  model: string;
  effort: string;
  kind: "auto" | "command" | "oneoff";
  status: RunStatus;
  /** Why it was skipped or failed: "<reason>: <sentence>" (draft, fork, …). */
  why: string | null;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number | null;
  important: number;
  nit: number;
  pre_existing: number;
  /** Null while queued. */
  started: string | null;
  ended: string | null;
  full: boolean;
  incremental_from: string | null;
  posted: boolean;
  url?: string;
  /** A repo review's option run (target tree): `number` is 0 and `url` the reviewed commit; `batch` its review. */
  target?: "pr" | "tree";
  batch?: string | null;
  /** The PR's title (untrusted text: shown as plain text only) and the posted review's link, when the service has them. */
  title?: string;
  review_url?: string;
  /** Threads Aiden resolved on this head because their finding was gone. */
  resolved?: number;
}
/** GET /repos: each watched repo as the service runs it, with today's real spend (UTC), running reviews' so far included. */
export interface RepoRow {
  repo: string;
  on_open: Combo[];
  on_push: Combo[];
  day_spent_usd: number;
  /** Why the service can't watch it (no read access, …); null when fine. */
  error?: string | null;
  /** Who posts there, when the service knows: the owner's sign-in, or the owner's GitHub App installed on the repo. */
  identity?: "owner" | "app" | null;
}
export interface ReposView {
  repos: RepoRow[];
  day_spent_usd: number;
  errors?: string[];
}
/** GET /engines: the catalog the pickers offer (the module's ENGINES). */
export type Engine = "codex" | "claude-code" | "codegenie" | "codex-native";
export type EngineCatalog = Record<Engine, { label: string; efforts: string[]; models: string[]; accepts: Accepts }>;
/** One review run's reviewer: its engine, model and effort. */
export interface Combo {
  engine: Engine;
  model: string;
  effort: string;
  /** Its review gates the repo's merges (a gated repo has one at both moments). */
  mandatory?: boolean;
}
/** The four lenses a repo review looks through, in the order the form lists them. */
export const LENSES = ["correctness", "security", "maintainability", "performance"] as const;
export type Lens = (typeof LENSES)[number];
/** GET /catalog?repo=&commit=: what a repo review can run at that commit; `recommended` options come pre-ticked. */
export interface CatalogOption {
  id: string;
  lens: Lens;
  kind: "tool" | "skill" | "engine";
  recommended: boolean;
  runs_code: boolean;
  cost: "free" | "low" | "high";
  source: { repo: string; version: string; licence: string };
}
export interface Catalog {
  sha: string;
  options: CatalogOption[];
}
/** A whole-repo (tree) review batch as GET /reviews lists it, next to the PR runs. */
export type Verdict = "blocked" | "concerns" | "incomplete" | "clean";
export interface TreeBatch {
  id: string;
  repo: string;
  sha: string;
  sha7: string;
  verdict: Verdict | null;
  cost_usd: number;
  status: RunStatus;
  why?: string | null;
  started: string | null;
  ended: string | null;
  /** The report the service serves (GET /reviews/:batch/report) and, when published, its Primer document. */
  report_url?: string;
  primer_url?: string;
  /** The report's Primer outcome is in (a link or a refusal). */
  published?: boolean;
  /** Each option's run, whose page lists its findings (the report may leave some out to fit Primer). */
  runs?: { id: string; option: string; status: RunStatus; important: number; nit: number; pre_existing: number }[];
}
export const TreeRequestSchema = z
  .object({
    target: z.object({ tree: z.literal(true), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a repo is owner/name"), commit: z.string().regex(/^[0-9a-f]{40}$/i, "a commit is a full 40-character SHA").optional() }).strict(),
    options: z.array(z.string().regex(/^[\w.-]{1,64}$/)).min(1, "tick at least one option").max(60),
    combo: z.object({ model: z.string().regex(/^~?[\w.-]+\/[\w.:~-]+$/, "a model is an OpenRouter id"), effort: z.string().regex(/^[a-z]{3,8}$/) }).strict(),
  })
  .strict();
export type TreeRequest = z.infer<typeof TreeRequestSchema>;
/** The most combos one moment (or one ask) runs. */
export const MAX_COMBOS = 4;

/* ---------------------------------------------------------------------------- settings.code_review (the page's check) */
const PLAIN = (max: number) => z.string().max(max).regex(/^[^\x00-\x1f\x7f$]*$/, "no control characters or $");
/** The engines and their efforts (the module's ENGINES, service/src/config.ts): the pickers' labels and models come from GET /engines. */
const EFFORTS: Record<Engine, readonly string[]> = {
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codegenie: ["low", "medium", "high", "xhigh", "max"],
  "codex-native": ["minimal", "low", "medium", "high", "xhigh"],
};
export const ComboSchema = z
  .object({
    engine: z.enum(["codex", "claude-code", "codegenie", "codex-native"]),
    model: z.string().regex(/^~?[\w.-]+\/[\w.:~-]+$/, "a model is an OpenRouter id, like ~deepseek/deepseek-flash-latest"),
    effort: z.string(),
    mandatory: z.boolean().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!EFFORTS[c.engine].includes(c.effort)) ctx.addIssue({ code: "custom", path: ["effort"], message: `effort for ${c.engine} is one of ${EFFORTS[c.engine].join(", ")}` });
  });
export const CombosSchema = z.array(ComboSchema).max(MAX_COMBOS);
export const RepoSchema = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "a repo is owner/name"),
    on_open: CombosSchema,
    on_push: CombosSchema,
    push_rounds: z.number().int().min(0).max(100).nullable().optional(),
    drafts: z.boolean().optional(),
    forks: z.enum(["manual", "auto"]).optional(),
    ignore: z.array(PLAIN(200).min(1)).max(50).optional(),
    max_nits: z.number().int().min(0).max(50).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.on_push.some((c) => c.mandatory) && !r.on_open.some((c) => c.mandatory)) ctx.addIssue({ code: "custom", path: ["on_open"], message: "a mandatory reviewer on each push needs one when a PR opens" });
  });
export type RepoConfig = z.infer<typeof RepoSchema>;
export const CodeReviewSchema = z
  .object({
    repos: z.array(RepoSchema).max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.repos.map((r) => r.repo.toLowerCase())).size !== v.repos.length) ctx.addIssue({ code: "custom", message: "each repo once" });
  });
export type CodeReview = z.infer<typeof CodeReviewSchema>;
/** A repo's defaults when the owner watches it (the module's REPO_DEFAULTS). */
export const REPO_DEFAULTS = {
  on_open: [{ engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "medium" }] as Combo[],
  on_push: [{ engine: "codex-native", model: "openai/gpt-6.2-sol", effort: "low" }] as Combo[],
  push_rounds: 1 as number | null,
  drafts: false,
  forks: "manual" as "manual" | "auto",
  max_nits: 5,
};
/**
 * An instance's setting saved in the old shape (a `reviewers` map, named on_open/on_push, on_risk) read for editing: the repos
 * with their moments at REPO_DEFAULTS combos and the old keys dropped, so one Save writes the new shape. Null when it isn't a map.
 */
export function upgradeConfig(raw: unknown): CodeReview | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const repos: RepoConfig[] = [];
  for (const r of Array.isArray(v.repos) ? v.repos : []) {
    if (typeof r !== "object" || r === null || typeof (r as { repo?: unknown }).repo !== "string") continue;
    const { reviewers: _a, on_risk: _b, on_open, on_push, ...rest } = r as Record<string, unknown>;
    const ok = RepoSchema.safeParse({ ...rest, on_open: Array.isArray(on_open) ? on_open : REPO_DEFAULTS.on_open, on_push: Array.isArray(on_push) ? on_push : REPO_DEFAULTS.on_push });
    const fallback = RepoSchema.safeParse({ repo: (r as { repo: string }).repo, on_open: REPO_DEFAULTS.on_open, on_push: REPO_DEFAULTS.on_push });
    const use = ok.success ? ok : fallback;
    if (use.success && !repos.some((x) => x.repo.toLowerCase() === use.data.repo.toLowerCase())) repos.push(use.data);
  }
  return { repos };
}
/** A combo's short label: "Codex · deepseek-flash-latest · medium". */
export const comboLabel = (c: Pick<Combo, "engine" | "model" | "effort">, catalog?: EngineCatalog) =>
  `${catalog?.[c.engine]?.label ?? c.engine} · ${c.model.replace(/^~/, "").split("/").pop()} · ${c.effort}`;

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
  const inside = runs.filter((r) => at(r) && Date.parse(at(r)) >= since);
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

