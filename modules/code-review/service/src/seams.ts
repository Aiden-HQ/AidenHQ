// The code-review service's three seams, each a small interface the engine is written against: where PRs and their comments come
// from (github-mcp's internal read, as this module), what runs a review (the kernel's credential-free check job, lane E's recipe)
// and what posts it (the github module's poster, lane P's). main.ts wires the real ones; the tests use fakes.
/** A run's engine, model and effort. */
export type ComboRef = { engine: string; model: string; effort: string; /** a skill option's, from the catalog */ harness?: string; skill?: string };

/** The review recipe's output and the poster's input (the shared contract, version 1). */
export type Finding = {
  id: string; severity: "important" | "nit" | "pre_existing"; path: string; line: number; end_line?: number;
  title: string; why: string; evidence: string; fix_brief: string;
  /** The catalog option that found it and its lens (a lens-option run's findings; a combo's have none). */
  option?: string; lens?: string;
};
export type Review = {
  version: 1; repo: string; pr: number; base: string; head: string; engine: string; model: string; effort: string;
  incremental_from: string | null; full: boolean;
  coverage: { reviewed: string[]; excluded: string[]; incomplete: string | null; /** a tree run's eligible files and how many it confirmed reading */ counts?: { eligible: number; reviewed: number }; /** tools that failed in a tools run */ failed?: { id: string; why: string }[]; /** the tools that ran in a tools run */ options?: string[] };
  findings: Finding[];
  withheld: { important: number; nit: number; pre_existing: number };
  cost_usd: number; stale_guidance: string[];
  /** The run's model token's tokens, stamped by the kernel from the gateway's ledger (the result as read back; never posted). */
  tokens?: { input: number; cached: number; output: number };
  /** Earlier findings (the PR's open ones, by id) a recheck found gone at this head: their threads are resolved. */
  fixed?: string[];
  /** Findings closed by an answer (fixed, disputed, …) whose fix or reason the recheck found unsafe or malicious: open again.
   * Each names the part of the answer that is unsafe and the defect still there at the head (`line`: where it is now). */
  unsafe?: Unsafe[];
  /** deepsec's set-up files when it set the repo up this run (path → content, `.deepsec/` only): filed as a setup PR. */
  setup?: Record<string, string>;
  /** A tree review's target (a whole repo at a commit); a PR review's is the PR. */
  target?: "tree" | "pr";
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
  /** What it reviews: a PR's change, or a whole tree at `head` (number 0, no merge base). */
  target: "pr" | "tree";
  /** The check job: `code-review` (one model option or combo, metered) or `code-review-tools` (the selected tool options, token-free). */
  profile: "code-review" | "code-review-tools";
  /** A repo review run's id: part of its check's spec, so two reviews of one commit are two checks. */
  run?: string;
  /** The tools run's selected tool options, as the recipe runs them (catalog.ts toolSpec). */
  tools?: Record<string, unknown>;
  /** A model option's catalog id and lens (stamped on its findings); none for a combo. */
  option?: string; lens?: string;
  /** A pending deepsec setup branch's files (path → text): deepsec scans with them instead of setting up. */
  setup_files?: Record<string, string>;
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
  ignore: string[]; max_nits: number;
};
/** `box_at`: when its check job got its box (ISO; queueing before it is not the run's work), once it has one. `billed_usd`: what the kernel billed the run's check job (its gateway calls), never anything the box wrote. Absent: unknown, and
 * the run is charged nothing. `waiting`: its check job has no computer yet. A running one's is its spend so far. */
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
/** A typed need an infrastructure refusal carried (github-mcp's review route, needs_owner): the cause and what fixes it. */
export type PostNeed = { cause: string; org?: string; url?: string; scope?: string };
/** An answered finding the recheck found unsafe: why the answer is unsafe and the defect still there at the head. */
export type Unsafe = { id: string; why: string; line?: number };

/** A posted review's outcome: posted, waiting on the AI reviewer's decision (a Tier 1 write), or refused. */
export type Posted = {
  state: "posted" | "pending" | "refused"; why?: string; /** its kernel write record */ write?: string;
  /** A refusal that wasn't the AI reviewer's (stale after a restart, a failed GitHub call): filing it again may post it. */
  retry?: boolean;
  /** Once posted (the executor's outcome): the review's link, the threads it resolved, and who posted it. */
  url?: string; resolved?: number; identity?: "owner" | "app";
  /** The comment ids it opened (its threads' first comments): what makes a thread Aiden's own. */
  comments?: number[];
  /** The acknowledgement comment it wrote. */
  ack?: number;
  /** A refusal only the owner can fix (restricted, expired, sso, scope): the one action that unblocks the next post. */
  need?: PostNeed;
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
  /** An agent's answer to a finding, replied on its thread (`comment`: the thread's first comment; a Tier 1 write). */
  reply(p: { repo: string; number: number; head: string; comment: number; body: string }): Promise<Posted>;
  /** A filed post's outcome now (pending until the AI reviewer and the executor are done). */
  outcome(write: string): Promise<Posted>;
  /** Closes the PR's review task (it only holds its posts' approvals) once the PR is closed or a one-off's post is settled. */
  close(repo: string, number: number, why: string, run?: string): Promise<void>;
  /** One message to whoever asked for a one-off batch: a notice on their task when an agent asked from one (it wakes it), else
   * the owner. "closed": the task was already closed, so the caller has to reach the owner instead. */
  notify(n: { task?: string; text: string; dedupe_key: string }): Promise<"sent" | "closed">;
}

/** The code host through the kernel (/v1/codehost/:op, this module's grant). */
export interface CodeHost {
  /** A repo at a ref (snapshot): the commit it resolved (`HEAD`: the default branch's head) and the tree's file paths; `onCommit` hears the commit as soon as it is known, before the listing is read. */
  tree(repo: string, ref: string, onCommit?: (sha: string) => void): Promise<{ sha: string; paths: string[] }>;
  /** The files of a deepsec setup PR's branch (the one `setup` answered); undefined when that branch is gone. */
  setupBranch(repo: string, branch: string): Promise<{ tip: string; files: Record<string, string> } | undefined>;
  /** Asks for the deepsec setup PR (codehost.setup): github files its own Tier 1 write, on a new branch off the default branch's head, and closes an earlier setup PR. */
  setup(b: { repo: string; files: Record<string, string> }): Promise<unknown>;
}
/** A report to Primer (a `primer.publish` write record): a new private document; filed, then its outcome. */
export type ReportIn = { repo: string; title: string; content: string; versionNote: string };
export type ReportOut = { state: "pending" | "done" | "refused"; write: string; documentId?: string; url?: string; version?: number; why?: string };
export interface Publisher {
  file(r: ReportIn): Promise<ReportOut>;
  outcome(write: string): Promise<ReportOut>;
}
