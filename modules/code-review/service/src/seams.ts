// The code-review service's three seams, each a small interface the engine is written against: where PRs and their comments come
// from (github-mcp's internal read, as this module), what runs a review (the kernel's credential-free check job, lane E's recipe)
// and what posts it (the github module's poster, lane P's). main.ts wires the real ones; the tests use fakes.
import type { Profile } from "./config.ts";

/** The review recipe's output and the poster's input (the shared contract, version 1). */
export type Finding = {
  id: string; severity: "important" | "nit" | "pre_existing"; path: string; line: number; end_line?: number;
  title: string; why: string; evidence: string; fix_brief: string;
};
export type Review = {
  version: 1; repo: string; pr: number; base: string; head: string; reviewer: string;
  incremental_from: string | null; full: boolean;
  coverage: { reviewed: string[]; excluded: string[]; incomplete: string | null };
  findings: Finding[];
  withheld: { important: number; nit: number; pre_existing: number };
  triage?: { summary: string; risk: "trivial" | "normal" | "high" };
  cost_usd: number; stale_guidance: string[];
};

/** An open (or just closed) pull request as the watcher needs it. `base` is the base branch's commit the PR is against. */
export type PullRequest = {
  repo: string; number: number; head: string; base: string; base_ref: string; draft: boolean;
  /** Its head is in another repository (a fork). */
  fork: boolean; author: string; open: boolean; url: string;
};
/** A comment on a PR's conversation. Its body is a stranger's text. */
export type PrComment = { id: string; number: number; author: string; body: string; created_at: string };
export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface PrSource {
  /** The repo's open PRs (all pages). Throws when the repo can't be read. */
  open(repo: string): Promise<PullRequest[]>;
  /** One PR; throws when it can't be read (missing, private to the instance, revoked access). */
  get(repo: string, number: number): Promise<PullRequest>;
  /** PR conversation comments created after `since` (ISO), oldest first, and the cursor to ask from next. */
  comments(repo: string, since: string): Promise<{ comments: PrComment[]; cursor: string }>;
  /** The login's permission on the repo now (never cached: a revoked one counts at once). */
  permission(repo: string, login: string): Promise<Permission>;
}

/** What one review run reviews: the check job's spec (lane E's recipe takes exactly these). */
export type ReviewSpec = {
  repo: string; number: number; base: string; head: string; reviewer: string; profile: Profile;
  focus: string | null; incremental_from: string | null; full: boolean;
  /** The most the run may spend (its reservation): the cap on its box's model token. */
  budget_usd: number; ignore: string[]; max_nits: number;
};
export type RunResult =
  | { state: "running" }
  | { state: "done"; review: Review }
  | { state: "failed"; why: string; cost_usd?: number };
export interface ReviewRunner {
  /** Starts the run; returns its check job's id. */
  start(spec: ReviewSpec): Promise<{ check: string }>;
  /** Where it is now (never waits long). */
  result(check: string): Promise<RunResult>;
}

/** The one acknowledgement per PR, updated in place (and the commit status `aidenhq/review`, where the poster sets one). */
export type Ack = {
  repo: string; number: number; head: string;
  state: "queued" | "running" | "done" | "skipped" | "failed" | "status" | "help";
  run?: string; reviewer?: string; why?: string;
  /** Lines the service wrote itself (the command list, a status): code's text, never a comment's. */
  lines?: string[];
};
/** A posted review's outcome: posted, waiting on the AI reviewer's decision (a Tier 1 write), or refused. */
export type Posted = { state: "posted" | "pending" | "refused"; why?: string; url?: string };
export interface Poster {
  /** One GitHub review for the run's head: inline findings, the summary with the severity line and commands, the commit status;
   * `previous`: the last review posted on this PR (its threads are the ones Aiden may resolve). */
  post(p: { run: string; review: Review; previous: Review | null }): Promise<Posted>;
  ack(a: Ack): Promise<void>;
}
