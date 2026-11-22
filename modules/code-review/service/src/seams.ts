// The code-review service's three seams, each a small interface the engine is written against: where PRs and their comments come
// from (github-mcp's internal read, as this module), what runs a review (the kernel's credential-free check job, lane E's recipe)
// and what posts it (the github module's poster, lane P's). main.ts wires the real ones; the tests use fakes.
/** A run's engine, model and effort. */
export type ComboRef = { engine: string; model: string; effort: string };

/** The review recipe's output and the poster's input (the shared contract, version 1). */
export type Finding = {
  id: string; severity: "important" | "nit" | "pre_existing"; path: string; line: number; end_line?: number;
  title: string; why: string; evidence: string; fix_brief: string;
};
export type Review = {
  version: 1; repo: string; pr: number; base: string; head: string; engine: string; model: string; effort: string;
  incremental_from: string | null; full: boolean;
  coverage: { reviewed: string[]; excluded: string[]; incomplete: string | null };
  findings: Finding[];
  withheld: { important: number; nit: number; pre_existing: number };
  cost_usd: number; stale_guidance: string[];
  /** The run's model token's tokens, stamped by the kernel from the gateway's ledger (the result as read back; never posted). */
  tokens?: { input: number; cached: number; output: number };
  /** Earlier findings (the PR's open ones, by id) a recheck found gone at this head: their threads are resolved. */
  fixed?: string[];
  /** Findings closed by an answer (fixed, disputed, …) whose fix or reason the recheck found unsafe or malicious: open again. */
  unsafe?: string[];
};

/** An open (or just closed) pull request as the watcher needs it. `base` is the base branch's commit the PR is against. */
export type PullRequest = {
  repo: string; number: number; head: string; base: string; base_ref: string; draft: boolean;
  /** Its head is in another repository (a fork). */
  fork: boolean; author: string; open: boolean; url: string;
  /** A closed PR that was merged. */
  merged?: boolean;
  /** A stranger's words: shown as plain text, never in a task title; title and body reach a review only fenced as data (intent). */
  title?: string; body?: string;
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
  /** GitHub's compare of two commits: their merge base, and whether `head` is ahead of `base` (base is then its ancestor). */
  compare(repo: string, base: string, head: string): Promise<{ merge_base: string; status: "ahead" | "behind" | "identical" | "diverged" }>;
  /** A fingerprint of the PR's own change at `head` (GitHub's diff of `base`...`head`: each file's status, name and patch,
   * hunk headers included), or null when GitHub can't show all of it (a file without a patch, 300 files or more). Two heads with
   * the same fingerprint over their own merge bases make the same change: a bare rebase. */
  patchId(repo: string, base: string, head: string): Promise<{ id: string | null }>;
  /** The PR's merge base with `head` (what the PR changes), open or merged: never the PR's recorded base sha, which goes stale. */
  mergeBase(repo: string, number: number, head: string): Promise<{ merge_base: string }>;
  /** Who a review on the repo would post as: the owner's sign-in once GitHub is connected; null: nobody. */
  postable(repo: string): Promise<{ identity: "owner" | null; org: string }>;
  /** Repos the instance's GitHub identity can read whose name holds `q` (the board's repo picker). */
  repos(q: string): Promise<{ repo: string; private: boolean; url?: string }[]>;
  /** The PR's review threads: the finding its marker names, its first comment's id and the replies (strangers' text). Whether a
   * thread is Aiden's own is the service's record (its comments table), never this. */
  threads(repo: string, number: number): Promise<Thread[]>;
}
export type Thread = { finding: string | null; comment: number; replies: { id: number; author: string; body: string }[] };

/** What one review run reviews: the check job's spec (lane E's recipe takes exactly these). */
export type ReviewSpec = {
  repo: string; number: number; base: string; head: string; combo: ComboRef;
  /** The merge base of the PR's base and head: what a full review diffs against. */
  merge_base: string;
  focus: string | null; incremental_from: string | null; full: boolean;
  /** The PR's title and description (its author's words, fenced as data in the brief): what it states as intended. "" for a fork's. */
  intent: string;
  /** The PR's still-open findings, rechecked at this head and given to the finders as already reported (the batch's first
   * mandatory run, else its first). `gating`: an important one a mandatory run found, rechecked whatever the change touched;
   * `claim`: one closed by an answer on its thread, rechecked only for a fix or reason that is unsafe. */
  previous: { id: string; severity: string; path: string; line: number; title: string; why?: string; evidence?: string; gating?: boolean; claim?: string }[];
  /** Its combo is mandatory (a new important finding of it may restate only a gating one). */
  mandatory: boolean;
  /** The most the run may spend (its run_usd): the cap on its box's model token. */
  budget_usd: number; ignore: string[]; max_nits: number;
};
/** `box_at`: when its check job got its box (ISO; queueing before it is not the run's work), once it has one. `billed_usd`: what the kernel billed the run's check job (its gateway calls), never anything the box wrote. Absent: unknown, and
 * the run is charged its whole run_usd. `waiting`: its check job has no computer yet. A running one's is its spend so far (what the day budget counts). */
export type RunResult =
  | { state: "running"; billed_usd?: number; waiting?: boolean; box_at?: string }
  | { state: "done"; review: Review; billed_usd?: number; box_at?: string }
  | { state: "failed"; why: string; billed_usd?: number; box_at?: string };
export interface ReviewRunner {
  /** Starts the run; returns its check job's id. */
  start(spec: ReviewSpec): Promise<{ check: string }>;
  /** Where it is now (never waits long). */
  result(check: string): Promise<RunResult>;
}

/** The one acknowledgement per PR, updated in place. */
export type Ack = {
  repo: string; number: number; head: string;
  state: "queued" | "running" | "done" | "skipped" | "failed" | "answered";
  /** An answered command's fixed words (review-render.ts ANSWERS). */
  answer?: "help" | "always" | "focus" | "focus_cleared" | "no_review";
  run?: string; combo?: ComboRef; why?: string;
  /** The run's findings and cost (a done run's notice, a status). */
  counts?: { important: number; nit: number; pre_existing: number; cost_usd: number };
  /** The posted review's link (a done notice after its post settles). */
  review?: string;
};
/** What the commit status mirrors: the verdict's first reason (its code; "pass" when there is none). */
export type Status = { repo: string; number: number; head: string; reason: string; important: number; running: { model: string; effort: string }[]; partial?: true };
/** A posted review's outcome: posted, waiting on the AI reviewer's decision (a Tier 1 write), or refused. */
export type Posted = {
  state: "posted" | "pending" | "refused"; why?: string; /** its kernel write record */ write?: string;
  /** A refusal that wasn't the AI reviewer's (stale after a restart, a failed GitHub call): filing it again may post it. */
  retry?: boolean;
  /** Once posted (the executor's outcome): the review's link, the threads it resolved, and who posted it. */
  url?: string; resolved?: number; identity?: "owner";
  /** The comment ids it opened (its threads' first comments): what makes a thread Aiden's own. */
  comments?: number[];
  /** The acknowledgement comment it wrote. */
  ack?: number;
};
export interface Poster {
  /** One GitHub review for the run's head: a thread per finding, the summary with the severity line and commands;
   * `target`: where it goes, from the run itself (the poster never takes its target from the review body); `previous`: the last
   * review posted on this PR (its threads are the ones Aiden may resolve). */
  post(p: { run: string; target: { repo: string; number: number; head: string; once?: boolean }; review: Review; previous: Review | null; gated: boolean; own?: number[]; ack?: number }): Promise<Posted>;
  /** The commit status aidenhq/review on a gated repo's PR head: its merge verdict's reason, the open important findings and the
   * mandatory reviewers still queued or running (a Tier 0 write: fixed words). */
  status(s: Status): Promise<Posted>;
  /** The one acknowledgement (a Tier 0 write; `ack`: the comment the service recorded, edited in place). Undefined: nothing filed. */
  ack(a: Ack & { ack?: number }): Promise<Posted | undefined>;
  /** A filed post's outcome now (pending until the AI reviewer and the executor are done). */
  outcome(write: string): Promise<Posted>;
  /** Closes the PR's review task (it only holds its posts' approvals) once the PR is closed or a one-off's post is settled. */
  close(repo: string, number: number, why: string, run?: string): Promise<void>;
}
