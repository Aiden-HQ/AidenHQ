// The merge queue: an approved github.merge record becomes a queue here, kept in the service's data dir, and a loop
// polls each of its PRs with the merge gate (merge-gate.ts `decide`) until every one merged or was reported not merged. Its
// outcome is the record's: ok only when every PR it names merged at its bound head.
//
// One queue per repository: a poll merges at most one PR per repository, records in the order they were approved, so two merges
// never race on a base. A PR merges only at the head the record bound (the merge call carries that sha, so GitHub refuses any
// other), once the gate says so and, last, on a repo code review gates, code review's verdict for that head is pass
// (review-gate.ts). A review wait has no time limit: it resumes when the verdict passes, and ends only when the PR moves or
// closes. So does every other wait (running checks, a red base, mergeability, GitHub's errors): waiting is never failing, and a PR fails only on a
// terminal state (closed, head moved, red checks on the head, changes requested).
// A product merge the kernel ran at Tier 0 (eligible: ci-required green and code review's pass on its head, merge-gate.ts
// productMergeEligible) is checked again right before the merge; no longer eligible, it fails and the merge is filed again.
// The UI Reviewer's design review is advisory: it never holds a merge.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESIGN_REVIEW_CHECK, contextStatus, namedChecks, skippedImageScan } from "./aidenhq-sdk/checks.ts";
import { waitReason, type Flow } from "./flow.ts";
import { randomUUID } from "node:crypto";
import { mergeable, trailer } from "./git-auth.ts";
import { PR_QUERY, decide, mergeMethod, mergePath, productMergeEligible, requiredChecks, withGate } from "./merge-gate.ts";
import type { ReviewGate } from "./review-gate.ts";
import type { ShipAdoptions } from "./service.ts";

/** GitHub as the owner, background (git-auth.ts Gh with background set). */
type Gh = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
/** `objects`: what the queue made, for the kernel's records (each merge commit; a merged PR stays whoever's it was). */
type Outcome = { ok: boolean; text: string; objects?: string[] };
type Pr = { repo: string; number: number; head: string; /** The base an adopted PR's merge was filed against (ship): a change fails it. */ base?: string; url: string; status: string; note?: string; sha?: string; /** The merge commit's message and the branches that decide whether it can credit the PR (`base` it merged into, the repository's `defaultBranch`), kept by the poll that found the PR already merged at its bound head: finish() does not read GitHub again, and an already-merged PR the fleet never opened has no pr-tasks.json row, so the identifier in this message is what can credit it. The facts are cached too, so finish() verifies the merge reached the default branch instead of trusting the message alone; a queue written before this shape holds no credit. */ mergeCredit?: { message: string; base: string; defaultBranch: string }; /** The task's own pr/push record named this bound head (pr-tasks.json had no row): kept once answered, so a settle credits the PR. A negative answer is never kept: a record filed after it is asked again each poll. A failed read is not kept either. */ bound?: { head: string }; wait?: { key: string; since: string }; checked?: string; /** A 4xx refusal of a retry while an earlier unanswered call may still have merged: how many polls have looked since, for the same bound head. */ refusal?: { head: string; n: number }; /** Every merge call this poll may be looking at: each call's token (what an unanswered PUT may have made), the method it was made with, and when. Kept until the PR is settled: a retry replaces the pending call but must not forget an earlier one that landed. */ mergeCalls?: { token: string; method: string; at: string }[]; fw?: { reason: string; since: string } };
type Queue = { id: string; state: string; /** Filed by the ship module (a fleet PR's plain merge too): ship's pause or a repo switched off ends it at the call. */ byShip?: boolean; /** An adopted PR's merge (ship, args.generation): ship's readiness, the adoption read again before the merge call, and every other action ends it for ship's next round. */ ship?: { generation: number }; /** The kernel ran the record at Tier 0 (record.tier): a product merge must still be eligible at the merge. */ tier0?: boolean; prs: Pr[]; said: string[]; startedAt: string; finishedAt?: string; outcome?: Outcome; reported?: boolean; /** A queue written before taskIdentifier existed: the record's own identifier has been read (taskIdentifier set, or the kernel settled it as none), so no further read is needed. A failed read is not this; a pending one is not this either. */ recovered?: boolean; /** Which version settled `recovered`: 2 is this one, which reads the kernel's `identifier_pending`. Older queues took a first "none" as final, so one with an absent stamp is read again once (the kernel's upgrade reconcile may have recorded it since); a queue this version settled is never re-read. */ recoveredBy?: number; /** How many times the recovery read has failed since it last succeeded: a transient kernel failure is retried on later polls, never settled over. */ recoverTries?: number; /** The record has no identifier yet and none has been read (the kernel's upgrade reconcile is about to fill it in): a comparison that needs it waits for it instead of concluding from its absence. */ identifierPending?: boolean;  /** The task the record that queued this merge is for (kernel record.task): what an already-merged PR must link to be evidence. */ task?: string; /** The same task's identifier as people read it (record.identifier, WOR-9889): the rows pr-tasks.json keeps are keyed by it, so the two are compared both ways. */ taskIdentifier?: string; /** How many times the task-binding read (prBound) has failed for this queue: only for the log, as the read is retried on every poll until it answers. */ boundTries?: number; /** The reason the kernel acknowledged for the record's card (POST /v1/writes/:id/wait): the whole queue's, so a PR leaving its wait never clears another PR's. `undefined`: no delivery known (never sent, a queue written by an older implementation, or a restart before the kernel answered) — reconciled on the next poll; `null`: the kernel acknowledged a clear. */ waitSent?: string | null };

const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
const KEEP_MS = 7 * 24 * 3600_000;
/** How long a branch's rules (required checks, merge queue) are kept before they are read again. */
const RULES_MS = 10 * 60_000;
/**
 * decide's input from ship's list read (ship-routes.ts OPEN_PRS_QUERY: an open PR's node and its repo's default branch). The node
 * has no compare to the base: GitHub's BEHIND stands in (the merge queue reads the real one before it merges).
 */
function listView(pr: any, main: { name: string; oid?: string; rollup?: any }) {
  return { repository: { defaultBranchRef: { name: main.name }, pullRequest: { ...pr, state: "OPEN",
    baseRef: { compare: { behindBy: pr.mergeStateStatus === "BEHIND" ? 1 : 0 }, target: { oid: main.oid, statusCheckRollup: main.rollup } } } } };
}
/** What a PR's record-level wait says while GitHub is signed out: the reason the card shows for a merge that cannot move yet. */
const CONNECTED_WAIT = "GitHub is signed out: waiting for the owner to reconnect it";
/** The same while the App migration holds merges (migrate.ts): reconnecting GitHub cannot lift it, so it never claims a sign-out. */
export const MIGRATION_WAIT = "GitHub App migration in progress: merges are held until it finishes";
/** The record-level reasons the queue itself sets and clears (never a PR's own wait or a failure's note). */
const HOLD_WAITS = [CONNECTED_WAIT, MIGRATION_WAIT];
/** GitHub's answer for branch rules on a plan that has none (a private repo without Pro): nothing is enforced there. */
const noRulesPlan = (r: { status: number; body?: unknown }) => r.status === 403 && /upgrade to github pro|make this repository public/i.test(JSON.stringify(r.body ?? ""));
const isHoldWait = (note?: string) => note !== undefined && HOLD_WAITS.includes(note);
const says = (e: unknown) => String((e as Error)?.message ?? e).split("\n").pop()!.slice(0, 300);
/** The fixed start of a merge outcome's first line: the PRs merged at their bound head, this queue's or already (finish). */
export const MERGED_LINE = "merged-prs: ";
/** What the kernel keeps of an outcome (kernel/src/records.ts OUTCOME_MAX): the first line and the summary after it must fit. */
export const OUTCOME_MAX = 6_000;
/** GitHub answered that the PR or its repository doesn't exist (a deleted repo, a PR that was never there): a definitive end. */
class Gone extends Error {}

export function createMerges(d: {
  dir: string;
  gh: Gh;
  /** Whether GitHub is connected: while it isn't, every pending PR waits (work.waiting reason github) and nothing is called. */
  connected?: () => boolean;
  /**
   * Whether merges are held although GitHub is connected (the App migration, migrate.ts): the hold is a decision, never a
   * message, so a blank reason can never lift it.
   */
  hold?: () => boolean;
  /** What the hold says on the record (own reason, never the reconnect's: reconnecting cannot lift a migration hold). Blank: the default. */
  holdReason?: () => string | null | undefined;
  fleetOrg: string; productRepo?: string;
  /** Ship's adoptions (service.ts ShipAdoptions): an adopted PR's merge is still its adoption's (not on hold, not paused) at the call. */
  ship?: ShipAdoptions;
  /** The reviewer App on a repo (service.ts Options.reviewer): its approval of a head counts in ship's decision. */
  reviewer?: (repo: string) => Promise<{ login: string } | undefined>;
  /** maintainer_repos ("owner/name"): merged here as in the agents org, read when each PR is polled. */
  maintained?: string[];
  /** Code review's verdict for a PR head (undefined: may merge; wait: why not yet). */
  reviewGate: ReviewGate;
  /** Flow facts (flow.ts): CI done on a head, merges, and each wait with its reason. */
  flow?: Flow;
  /** The task that opened a PR (pr-tasks.json, pr-tasks.ts notePrTask): an already-merged PR is evidence for grading only when it links to the task its merge is for. */
  taskOf?: (repo: string, n: number) => string | null;
  /** A task's id from its identifier (WOR-12), as the kernel's work read resolves it (by its jobs): a module's record (ship's)
   * names its task by id only, and pr-tasks.json keys a PR's owner by the identifier. */
  taskIdOf?: (identifier: string) => Promise<string | undefined>;
  /**
   * A record's task identifier as the kernel has it (GET /v1/work?record=), read once for a queue persisted before the queue kept
   * it. `pending`: the record has none yet and the kernel has not answered for its task (a claimed record its upgrade reconcile
   * is about to fill in), so the absence is not final. `undefined`: no such record any more.
   */
  identifierOf?: (record: string) => Promise<{ identifier?: string; pending: boolean } | undefined>;
  /** A task's status (GET /v1/work?task=): a merge ship filed on a task that has since ended is never called. */
  taskStatus?: (task: string) => Promise<string | null | undefined>;
  /**
   * The status of the task a merge is for (GET /v1/work?task=). A cancelled task's approved merge never lands: cancellation leaves
   * its PR for a successor, so sending the merge would destroy the handoff. Undefined: the read failed, which holds the merge.
   */
  statusOf?: (task: string) => Promise<string | undefined>;
  /** Delivers a record's outcome to the kernel (POST /v1/writes/:id/outcome). */
  report(id: string, o: Outcome): Promise<void>;
  /** Tells the kernel why a claimed record is still running (POST /v1/writes/:id/wait), so its task hears the reason. */
  waiting?(id: string, reason: string | null): Promise<void>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  now?: () => Date;
  everyMs?: number;
}) {
  const log = d.log ?? (() => {});
  const now = d.now ?? (() => new Date());
  const platform = [d.productRepo].filter(Boolean) as string[];
  mkdirSync(d.dir, { recursive: true });
  const file = join(d.dir, "merges.json");
  const s: { queues: Record<string, Queue> } = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { queues: {} };
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify({ queues: s.queues })); renameSync(`${file}.tmp`, file); };
  const waiters = new Map<string, { promise: Promise<Outcome>; resolve: (o: Outcome) => void }>();
  const delivering = new Set<string>();

  /**
   * Whether the repository is really gone, or only invisible to this token: GitHub answers `repository: null` / a NOT_FOUND
   * error both for a deleted repo and for a private one an installation lost access to, and ending an approved merge on the
   * second is the failure the header promises never happens. A repo read is GitHub's own answer on the same token: a 404 is
   * the repo absent, any other answer (a 200, a 403, a 5xx) means the merge waits and the next tick asks again.
   */
  async function repoAbsent(repo: string): Promise<boolean> {
    try {
      const r = await d.gh("GET", `/repos/${repo}`);
      return r.status === 404;
    } catch {
      return false;
    }
  }
  /**
   * Whether the pull request itself is really gone, the same way `repoAbsent` asks about the repository: GitHub answers a
   * NOT_FOUND naming the pull request both for a PR that never existed and for a private one this token lost access to, and
   * ending an approved merge on the second is the failure this header promises never happens. Reading that PR directly is
   * GitHub's own answer on the same token: a 404 is the PR absent, any other answer (a 200, a 403, a 5xx) means the merge
   * waits and the next tick asks again. It is a read, never a write.
   */
  async function prAbsent(repo: string, number: number): Promise<boolean> {
    try {
      const r = await d.gh("GET", `/repos/${repo}/pulls/${number}`);
      return r.status === 404;
    } catch {
      return false;
    }
  }
  async function readPr(repo: string, number: number) {
    const [owner, name] = repo.split("/");
    const r = await d.gh("POST", "/graphql", { query: PR_QUERY, variables: { owner, repo: name, number, pullRef: `refs/pull/${number}/head` } });
    const errors: any[] = Array.isArray(r.body?.errors) ? r.body.errors : [];
    const data = r.body?.data;
    const node = data && typeof data === "object" ? data.repository : undefined;
    const pr = node?.pullRequest;
    // The same answer on both shapes: a NOT_FOUND about the repository (never a nested field) with no PR node, or a null
    // repository node; and a NOT_FOUND naming the pull request itself. Each is confirmed by a direct read on the same token
    // before it ends the record — the repo, and for a PR-named NOT_FOUND the PR — so a token that lost access only makes the
    // merge wait. Every other answer (an empty body, a partial answer, a nested NOT_FOUND, a 5xx) throws, so the poll's catch
    // logs it and the next tick asks again rather than ending an approved merge on an answer it can't act on.
    const notFound = errors.length > 0 && errors.every((e) => e?.type === "NOT_FOUND");
    const repoGone = notFound && errors.every((e) => /repository/i.test(String(e?.message ?? "")));
    // A NOT_FOUND that names the pull request (not the repository): GitHub never resolved that PR on this query, and nothing
    // will make a queued merge find it later — but the same answer is what a token that lost access to a private PR gets, so
    // the PR read decides. A repo read is not asked for it: the answer already says the repository itself resolved.
    const prGone = notFound && !repoGone && errors.some((e) => /pull request|pullrequest/i.test(String(e?.message ?? "")));
    if (r.status >= 300 || errors.length) {
      if (!pr && (repoGone || node === null) && (await repoAbsent(repo))) throw new Gone();
      if (!pr && prGone && (await prAbsent(repo, number))) throw new Gone();
      throw new Error(`GitHub GraphQL: ${errors.map((e) => e.message).join("; ") || `HTTP ${r.status}`}`);
    }
    if (!data || typeof data !== "object") throw new Error("GitHub GraphQL: no answer");
    if (node === null) {
      if (await repoAbsent(repo)) throw new Gone();
      throw new Error("GitHub GraphQL: the repository answered null (deleted, or this token can no longer see it)");
    }
    if (!node || typeof node !== "object") throw new Error("GitHub GraphQL: the answer omitted the repository");
    if (!pr) {
      // The requested repository fields decide whether the PR was looked up at all: a node that answered none of them is a
      // partial answer, not a repository whose PR is gone.
      const answered = ["defaultBranchRef", "squashMergeAllowed", "mergeCommitAllowed", "rebaseMergeAllowed"].some((k) => k in node);
      if (!answered) throw new Error("GitHub GraphQL: the answer omitted the requested fields");
      throw new Gone();
    }
    // The gate reads these per field. An omitted key is a partial answer that proves nothing about the PR, so the queue asks
    // again; an explicit null is GitHub's answer that the field is empty, which the gate reads and ends or waits on with its
    // own reason rather than waiting for an answer that is already here.
    if (["state", "headRefOid", "baseRefName"].some((k) => !(k in pr))) throw new Error("GitHub GraphQL: the answer omitted the pull request's fields");
    return withGate(data);
  }
  /** Every check on a head, every page (REST check runs and statuses): ship's readiness past the query's first 100. */
  async function allChecks(repo: string, sha: string) {
    const out: { name: string; ok: boolean; pending: boolean; status?: true }[] = [];
    for (const [path, key] of [["check-runs", "check_runs"], ["statuses", "statuses"]] as const) {
      for (let page = 1; page <= 20; page++) {
        const r = await d.gh("GET", `/repos/${repo}/commits/${sha}/${path}?per_page=100&page=${page}`);
        if (r.status >= 300) throw new Error(`GitHub GET ${path}: ${r.status}`);
        const items: any[] = Array.isArray(r.body) ? r.body : r.body?.[key] ?? [];
        for (const x of items) out.push(key === "check_runs"
          ? { name: String(x.name ?? ""), pending: x.status !== "completed", ok: x.status === "completed" && ["success", "skipped", "neutral"].includes(x.conclusion) }
          : { name: String(x.context ?? ""), pending: x.state === "pending", ok: x.state === "success", status: true });
        if (items.length < 100) break;
      }
    }
    // Every entry is kept: a check run and a status may share a name, and the red one must hold the PR. A status context that
    // reported again on every update keeps only its newest (first listed) state.
    return out.filter((c, i) => !c.status || out.findIndex((x) => x.status && x.name === c.name) === i);
  }
  /**
   * The checks the branch requires (its rulesets and classic protection; merge-gate.ts requiredChecks): none is a confirmed answer.
   * undefined when classic protection can't be read (403: the sign-in isn't a repo admin): every check on the head is then judged.
   */
  async function requiredOf(repo: string, branch: string) {
    return (await rulesOf(repo, branch)).required;
  }
  /** The branch's required checks (undefined: classic protection unreadable) and whether it merges through a merge queue, kept
   * RULES_MS per repo and branch: ship asks for every open PR on every pass, and branch rules rarely change. */
  const rulesCache = new Map<string, { at: number; v: { required: string[] | undefined; queue: boolean; /** The plan has no branch rules to read: none is enforced, but ship still judges every check (its fallback). */ noPlan?: boolean } }>();
  async function rulesOf(repo: string, branch: string) {
    const k = `${repo.toLowerCase()}@${branch}`;
    const hit = rulesCache.get(k);
    if (hit && Date.now() - hit.at < RULES_MS) return hit.v;
    const rules = await d.gh("GET", `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`);
    // A private repo on a plan without branch rules answers 403 "Upgrade to GitHub Pro": GitHub enforces none there, so none is required.
    if (noRulesPlan(rules)) {
      const v = { required: undefined, queue: false, noPlan: true };
      rulesCache.set(k, { at: Date.now(), v });
      return v;
    }
    if (rules.status >= 300) throw new Error(`GitHub GET rules: ${rules.status}`);
    const queue = mergePath(rules.body) === "queue";
    const classic = await d.gh("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`);
    if (classic.status >= 300 && ![403, 404].includes(classic.status)) throw new Error(`GitHub GET required_status_checks: ${classic.status}`);
    const v = { required: classic.status === 403 ? undefined : requiredChecks(rules.body, classic.status === 404 ? undefined : classic.body), queue };
    rulesCache.set(k, { at: Date.now(), v });
    return v;
  }
  /** Whether the repo has no CI at all: GitHub lists no workflow (a definitive answer; anything else, an error included, is "has CI").
   * Only "has CI" is kept briefly: "none" is asked again on every poll, so a first workflow added later is seen before any waiver. */
  const ciCache = new Map<string, { at: number; none: boolean }>();
  async function noCi(repo: string) {
    const k = repo.toLowerCase();
    const hit = ciCache.get(k);
    if (hit && Date.now() - hit.at < RULES_MS) return hit.none;
    const r = await d.gh("GET", `/repos/${repo}/actions/workflows?per_page=1`);
    const none = r.status === 200 && (r.body as { total_count?: number } | undefined)?.total_count === 0;
    if (!none) ciCache.set(k, { at: Date.now(), none });
    return none;
  }
  /** The required checks red on the PR's latest merge_group run (GitHub's `gh-readonly-queue/<base>/pr-<n>-…` branch). */
  async function groupFailing(repo: string, number: number, base: string, required: string[]) {
    const r = await d.gh("GET", `/repos/${repo}/actions/runs?event=merge_group&per_page=50`);
    if (r.status >= 300) throw new Error(`GitHub GET merge_group runs: ${r.status}`);
    const run = (r.body?.workflow_runs ?? []).find((x: any) => String(x.head_branch ?? "").startsWith(`gh-readonly-queue/${base}/pr-${number}-`));
    if (!run) return [];
    const checks = await allChecks(repo, String(run.head_sha));
    return [...new Set(checks.filter((c) => required.includes(c.name) && !c.ok && !c.pending).map((c) => c.name))];
  }
  /** Rules unreadable (requiredOf undefined: no admin read of classic protection): every check on the head counts but the
   * advisory design review; with none of those reported yet (the design review alone included) the caller waits. */
  const fallbackRequired = (checks: { name: string }[]) => [...new Set(checks.map((c) => c.name).filter((n) => n !== DESIGN_REVIEW_CHECK))];
  async function mergePut(repo: string, number: number, sha: string, method: string, body: string, token: string): Promise<string> {
    // A squash or merge commit is the owner's, signed by the queue that made it (the rebase method keeps the PR's own commits).
    // The trailer goes on whatever the body says (withTrailer would keep a body's own AidenHQ trailer and drop ours), and it
    // carries this call's nonce (mergedBy).
    const message = method === "rebase" ? {} : { commit_message: [body.trim(), trailer(`merge queue ${token}`)].filter(Boolean).join("\n\n") };
    const r = await d.gh("PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha, ...message });
    if (r.status >= 300) throw Object.assign(new Error(`HTTP ${r.status}: ${String(r.body?.message ?? "").slice(0, 300)}`), { status: r.status });
    return r.body?.sha;
  }
  /**
   * What this poll proves about who merged the PR: its sha only when the merge commit is the one this queue's own merge call made.
   * A rebase merge makes no commit of its own (the PR's commits land as they are), so nothing tells this queue's merge from anyone
   * else's and it is never counted as ours. A squash or merge commit carries the trailer this call put in its `commit_message`,
   * naming this record's id: an owner's or auto-merge, or a commit that merely carries an AidenHQ trailer from the PR's own
   * commits, does not. The nonce, not the whole message, is what is checked, because GitHub normalises a squash message
   * (co-author lines, whitespace, a `(#N)` suffix) and an exact match would drop a merge the queue really made. It is a random
   * id made for this one call and kept only here, never in the PR's title or body, so a PR author cannot plant it in their text
   * and have another writer's merge credited: `calls` (PUTs that went unanswered) are the only source of it.
   *
   * Every unanswered attempt is kept, not just the last: when a PUT merges but its answer is lost, a later poll may still read the PR
   * open (GitHub's read lags) and send another PUT, which replaces the pending call. If the first PUT's merge is what lands, its nonce
   * is the one in the merge commit, so any attempt's token counts (each was made by this record, at this bound head).
   */
  function mergedBy(mergeCommit: { oid?: string; message?: string } | null | undefined, sha: string, calls: { token: string; method: string }[] | undefined): string | undefined {
    if (!calls?.length) return undefined;
    const message = String(mergeCommit?.message ?? "");
    // The method each PUT was made with, not the repo's config read now: a repo whose allowed methods changed since would otherwise
    // judge (or skip) a merge that one of these calls made. A rebase merge makes no commit of its own, so it is never claimed.
    return calls.some((call) => call.method !== "rebase" && Boolean(call.token) && message.includes(call.token)) ? sha : undefined;
  }

  /**
   * The token this record's merge commit carries in its trailer (`merge queue <token>`, mergePut's commit_message): a random id
   * made for this one call, so it is unguessable from the record, the PR's title or its body, and short enough to survive
   * GitHub's normalisation of a squash message.
   */
  const mergeToken = () => `queue-${randomUUID()}`;

  /** One poll of one PR, then its wait as facts: a wait and its end (a new reason, a merge, a failure) are work.waiting and work.resumed. */
  async function pollAndTime(id: string, q: Queue, p: Pr, merged: Set<string>) {
    await poll(id, q, p, merged);
    timeWait(p, p.status === "pending" && p.wait ? waitReason(p.wait.key) : undefined);
  }
  function timeWait(p: Pr, reason: string | undefined) {
    if (p.fw?.reason === reason) return;
    const at = now().toISOString();
    if (p.fw) d.flow?.resumed(p.repo, p.number, p.fw.reason, p.fw.since, at);
    p.fw = reason ? { reason, since: at } : undefined;
    if (p.fw) d.flow?.waiting(p.repo, p.number, p.fw.reason, p.fw.since);
  }
  /** One poll of one PR; `merged` holds the repositories that merged a PR this poll. */
  /**
   * The record's identifier is still owed: the queue has the record's task id but not the identifier its pr-tasks.json rows are
   * keyed by, and neither this version's read nor the kernel's answer has settled it. A queue written by a version that kept no
   * identifier needs one read; this version's read that failed or answered "pending" is not an answer; only a read that answered
   * (with one, or with a settled none) ends it. The same condition decides settlement and the ownership check, so a read that
   * failed never lets a queue settle without evidence or refuse a PR as another task's.
   */
  const identifierOwed = (q: Queue) => Boolean(q.task && !q.taskIdentifier && d.identifierOf && (!q.recovered || q.recoveredBy !== 2 || q.identifierPending));
  async function poll(id: string, q: Queue, p: Pr, merged: Set<string>) {
    const fail = (why: string) => {
      Object.assign(p, { status: "failed", note: why });
      delete p.wait;
      delete p.mergeCalls;
      q.said.push(`**Not merged:** ${p.url}: ${why}.`);
    };
    const wait = (key: string) => {
      if (p.wait?.key !== key) p.wait = { key, since: now().toISOString() };
    };
    // Outside the fleet org, the product repo and maintainer_repos the code host is PR-only: it merges nothing there (a repo taken
    // off the list after its record was approved included).
    if (!mergeable(p.repo, d.fleetOrg, platform, d.maintained ?? [])) return fail(`\`${p.repo}\` is outside the fleet org, the product repo and maintainer_repos, where the code host only opens PRs: merge it there`);
    // A review reason belongs to the poll that found the PR still waiting on code review: an earlier gate taking the PR over (checks
    // rerun, a design wait, a refusal) means the review is no longer what holds it, so the reason goes before this poll decides.
    if (p.note !== undefined && !isHoldWait(p.note)) delete p.note;
    try {
      const data = await readPr(p.repo, p.number);
      // An adopted PR's merge (ship) is decided by the same rule with ship's context: only the required checks (every page), its
      // bound base unchanged; anything but a merge, a wait or its end goes back to ship, whose next round files a new attempt.
      const open = q.ship && data.repository.pullRequest?.state === "OPEN";
      // Merged or open, the PR must still be on the base it was filed against: a retarget-and-merge elsewhere is no merge of this one.
      if (q.ship && p.base && data.repository.pullRequest && data.repository.pullRequest.baseRefName !== p.base) return fail(`its base changed to \`${data.repository.pullRequest.baseRefName}\` since the merge was filed`);
      // On a repo code review gates, an approval on the head is needed before the merge (the gate answers undefined elsewhere).
      const checks = open ? await allChecks(p.repo, p.head) : [];
      // Only the checks the rules require are judged, and none required counts as green (a merge outside ship needs a check on
      // the head); when the rules can't be read (403), every check on the head is judged instead.
      const rr = open ? await rulesOf(p.repo, String(data.repository.defaultBranchRef?.name ?? "")) : undefined;
      const rules = open ? rr?.required : [];
      const required = rules ?? fallbackRequired(checks);
      // Unreadable rules (an error, or a 403 that is not the plan's) wait for a check to judge; a plan with no rules has none to read.
      if (open && !rules && !required.length && !rr?.noPlan) return wait("no checks have reported on its head yet, and the branch's rules can't be read");
      // Code review's verdict is read below, once decide says merge (its wait is the record's reason there).
      const ship = open ? { queue: false, approve: false, required, checks } : undefined;
      // A repo with no CI at all (GitHub lists no workflow) never reports a check: with none on the head and GitHub calling the PR
      // CLEAN, decide goes on without them. A repo that has workflows always waits for their checks.
      const pr0 = data.repository.pullRequest;
      const noChecksOk = !q.ship && pr0?.state === "OPEN" && pr0.mergeStateStatus === "CLEAN" && !namedChecks(pr0.commits?.nodes?.[0]?.commit?.statusCheckRollup).length && await noCi(p.repo);
      const v = decide(data, p.head, ship, noChecksOk);
      if (q.ship && !["merge", "done", "wait", "fail"].includes(v.do)) return fail(`not ready to merge (${v.do}): ${v.why}`);
      const pull = data.repository.pullRequest;
      // The PR's state is read: a merge call that got no answer did not merge it unless this poll finds it merged. Every unanswered
      // call is kept across a wait (checks, review, mergeability) while the PR is still open at the bound head: a PUT that merged it
      // may only be seen as merged a few polls later, and its nonce is what proves that merge this queue's. The attempts are dropped
      // when the PR is settled (a fail clears them, a done read uses them) or GitHub answers a retry, so an owner's merge is never
      // credited.
      // CI on this head is over once every named check has finished: seen here, at the first poll that finds it so.
      const named = namedChecks(pull?.commits?.nodes?.[0]?.commit?.statusCheckRollup);
      if (p.checked !== p.head && pull?.headRefOid === p.head && named.length && named.every((c) => !c.pending)) {
        p.checked = p.head;
        d.flow?.checksCompleted(p.repo, p.number, p.head, named.filter((c) => !c.ok).map((c) => c.name).slice(0, 20));
      }
      if (v.do === "done") {
        // Merged at the bound head. It is this queue's merge only when an unanswered merge call of ours is still pending and the
        // merge commit is exactly that call's (mergedBy): an owner's or GitHub auto-merge is never ours. Either way the merge
        // commit at the bound head is evidence; finish() emits it for grading when the PR links to the task the record is for.
        const sha = String(pull?.mergeCommit?.oid ?? "");
        const ours = sha ? mergedBy(pull?.mergeCommit, sha, p.mergeCalls) : undefined;
        if (sha && !ours && p.mergeCalls?.length) log("merge call unanswered, but the merge commit isn't this queue's: another writer merged it", { pr: p.url });
        // The branches travel with the message: finish() decides from them whether the merge could credit the task, rather than
        // trusting a cached message whose destination it cannot see.
        const base = String(pull?.baseRefName ?? "");
        const defaultBranch = String(data.repository.defaultBranchRef?.name ?? "");
        if (ours) Object.assign(p, { status: "merged", sha: ours, mergedAt: pull.mergedAt ?? now().toISOString() });
        else Object.assign(p, { status: "skipped", note: v.why, ...(sha ? { sha, ...(base && defaultBranch ? { mergeCredit: { message: String(pull?.mergeCommit?.message ?? ""), base, defaultBranch } } : {}) } : {}) });
        delete p.mergeCalls;
        delete p.refusal;
        delete p.wait;
        if (sha) d.flow?.merged(p.repo, p.number, p.head, sha, pull.mergedAt ?? undefined, String(pull.title ?? ""), String(pull.body ?? ""));
        if (ours) merged.add(p.repo.toLowerCase());
        return void q.said.push(ours ? `Merged ${p.url}.` : `${p.url} was ${v.why}.`);
      }
      if (v.do === "fail") return fail(v.why ?? "");
      if (v.do === "wait") return wait(v.why ?? "");
      if (v.do !== "merge") return;
      // The live base branch and author association go along: a risk tier computed from other ones is stale (code review: pending).
      const review = await d.reviewGate(p.repo, p.number, p.head, { base: String(data.repository.pullRequest?.baseRefName ?? ""), association: String(data.repository.pullRequest?.authorAssociation ?? "") });
      // A Tier 0 product merge rests on its eligibility at this head now, by the same rule the plan used.
      if (q.tier0 && d.productRepo && same(p.repo, d.productRepo) && !productMergeEligible({ repo: p.repo, head: p.head, checks: named, verdict: review, productRepo: d.productRepo })) return fail("eligibility lost at merge: file the merge again");
      if (review && "wait" in review) {
        // Why this PR still waits: the record's own reason is built from every PR still waiting after the poll (publishWait), so
        // one PR leaving its wait never clears another's.
        if (p.note !== review.wait) log("merge waits for code review", { pr: p.url, why: review.wait.slice(0, 500) });
        p.note = review.wait;
        return wait("review");
      }
      // Code review passed on this head: this PR no longer waits on it (the queue publishes whatever the others still wait on).
      delete p.note;
      const method = mergeMethod(data.repository);
      if (!method) return fail(`\`${p.repo}\` allows no merge method I can use`);
      // An adoption's merge is still that adoption's right before the call: a hand-back, a stop or a pause since ends it.
      // The same call asks ship's final tier check (the tier's merge, no App approval of another policy standing), with the live head, base and author.
      const at = q.ship || (q.byShip && d.ship) ? await d.ship?.generation(p.repo, p.number, { do: "merge", head: p.head, base: String(pull?.baseRefName ?? ""), association: String(pull?.authorAssociation ?? "") }) : undefined;
      if (q.ship && at?.generation !== q.ship.generation) return fail("its adoption ended or moved on (handed back, stopped or paused): ship files a new merge when it resumes");
      if (at?.refused) return fail(`${at.retry ? "ship-tier-pending: " : ""}ship's tier check refused the merge: ${at.refused}`);
      // Any merge ship filed (a fleet PR's plain one too) stops with ship: paused, or the repo switched off (one call to ship).
      if (q.byShip && !q.ship && d.ship && at?.generation === null) return fail("ship is paused, or this repo is switched off in ship: not merged");
      // The kernel files a module's write on any task: a fleet PR's merge ship filed stops when its task is cancelled.
      if (q.byShip && !q.ship && q.task && d.taskStatus) {
        const status = await d.taskStatus(q.task);
        // Only a cancelled task: a merge in flight may finish after its task is done (ship files none on a done task).
        if (status === "cancelled") return fail("its task is cancelled: not merged");
      }
      // Cancellation is not authority to land work either: the PR is left for a successor (ship's loop, keepForSuccessor), and a
      // merge this queue was approved for before the cancellation would take that handoff from it. A read that fails holds the
      // merge (waiting is never failing): only an answer that the task is live lets it go.
      if (q.task && d.statusOf) {
        const status = await d.statusOf(q.task).catch((e: Error) => {
          log("merge queue: task status not read (retrying)", { pr: p.url, task: q.task, err: says(e).slice(0, 300) });
          return undefined;
        });
        if (status === undefined) return wait("task-status");
        if (status === "cancelled") return fail(`${q.task}, the task this merge was for, is cancelled: its PR is left open for a successor task, and this merge does not land`);
        // The PR itself may have changed owners since the card was filed (a done task handed it to a successor): pr-tasks.json's
        // current row is the authority, and a row naming another task ends this card rather than merging the successor's PR.
        const now = d.taskOf?.(p.repo, p.number);
        // A record a module filed (ship's) names its task by id: the row's identifier is resolved to its task's id once, and kept.
        if (now && now !== q.task && !q.taskIdentifier && d.taskIdOf) {
          const id = await d.taskIdOf(now).catch((e: Error) => { log("merge queue: task id not read (retrying)", { pr: p.url, task: now, err: says(e).slice(0, 300) }); return null; });
          if (id === null) return wait("task-status");
          if (id === q.task) { q.taskIdentifier = now; save(); }
        }
        // The record's identifier is still owed (a read that failed, or one that answered "pending" because the kernel's
        // upgrade reconcile has not filled it in yet): a row naming it is not proof this is another task's PR, and a fail here
        // could never be undone (a later poll only reads a pending PR), so the merge waits for the identifier instead of
        // refusing on a comparison the missing identifier makes incomplete.
        if (now && now !== q.task && identifierOwed(q)) return wait("task-identifier");
        if (now && now !== q.task && now !== q.taskIdentifier) return fail(`${p.url} now belongs to ${now}, not ${q.taskIdentifier ?? q.task}: this merge was approved for the earlier owner, so it does not land`);
      }
      // The token this record's merge commit will carry (mergePut's commit_message), kept before the call: a PUT that times out
      // may have merged, and the next poll tells this record's commit from anyone else's by it (mergedBy). It joins the attempts
      // (earlier unanswered calls too), so a merge the first attempt made before a retry went out is still this queue's.
      const body = String(pull?.body ?? "");
      const token = mergeToken();
      const attempt = { token, method, at: now().toISOString() };
      p.mergeCalls = [...(p.mergeCalls ?? []), attempt];
      // Persisted before the call: a restart mid-PUT must still hold the nonce that proves whether that PUT merged the PR.
      save();
      try {
        p.sha = await mergePut(p.repo, p.number, p.head, method, body, token);
      } catch (e) {
        // Another merge to the same base a moment ago: GitHub asks to try again, which the next poll does. This answer rules out
        // this attempt's commit only; an earlier PUT that went unanswered may still have landed, so its token is kept.
        if (/try the merge again|base branch was modified/i.test(says(e))) {
          p.mergeCalls = (p.mergeCalls ?? []).filter((c) => c !== attempt);
          return wait("retry");
        }
        // Only a 4xx is GitHub's answer. A timeout or a 5xx may have merged: the next poll reads the PR and sees which.
        const status = (e as { status?: number }).status ?? 0;
        if (status >= 400 && status < 500) {
          // A 4xx answers this attempt: GitHub did not merge with it. An earlier PUT that went unanswered may still have merged,
          // though, and this poll's read can lag. Drop only this attempt, read once more, and credit a commit carrying any earlier
          // call's nonce. When that read still lags, keep those nonces and look again next poll instead of failing the PR and
          // losing a merge that landed; a second refusal with still nothing to show is the end.
          const earlier = (p.mergeCalls ?? []).filter((c) => c !== attempt);
          if (earlier.length) p.mergeCalls = earlier;
          else delete p.mergeCalls;
          if (earlier.length) {
            const again = await readPr(p.repo, p.number).catch(() => undefined);
            const pr = again?.repository?.pullRequest;
            const mergedSha = String(pr?.mergeCommit?.oid ?? "");
            const ours = mergedSha && pr?.headRefOid === p.head ? mergedBy(pr.mergeCommit, mergedSha, earlier) : undefined;
            if (ours) {
              Object.assign(p, { status: "merged", sha: ours, mergedAt: pr?.mergedAt ?? now().toISOString() });
              delete p.mergeCalls;
              delete p.refusal;
              delete p.wait;
              d.flow?.merged(p.repo, p.number, p.head, ours, pr?.mergedAt ?? undefined, String(pr?.title ?? ""), String(pr?.body ?? ""));
              merged.add(p.repo.toLowerCase());
              return void q.said.push(`Merged ${p.url}.`);
            }
            const n = p.refusal?.head === p.head ? p.refusal.n + 1 : 1;
            if (n < 2) {
              p.refusal = { head: p.head, n };
              return wait("retry");
            }
          }
          return fail(`GitHub refused the merge: ${says(e)}`);
        }
        log("merge call unanswered", { pr: p.url, err: says(e) });
        return wait("put");
      }
      const mergedAt = now().toISOString();
      Object.assign(p, { status: "merged", mergedAt });
      delete p.mergeCalls;
      delete p.refusal;
      d.flow?.merged(p.repo, p.number, p.head, String(p.sha ?? ""), mergedAt, String(pull?.title ?? ""), String(pull?.body ?? ""));
      delete p.wait;
      merged.add(p.repo.toLowerCase());
      q.said.push(`Merged ${p.url}.`);
    } catch (e) {
      // A repository or PR that no longer exists is finished with a reason, never waited on: nothing will bring it back.
      if (e instanceof Gone) return fail("the repository or PR no longer exists (or this token can no longer see it)");
      log("merge poll failed", { repo: p.repo, number: p.number, err: says(e) });
      wait("error");
    }
  }

  /**
   * Whether the merge commit that landed a PR names the record's task identifier as a whole token: the credit main's message path
   * gives an already-merged PR, shared with `step` so a PR it already credits is not read from the kernel for the record binding.
   */
  function creditsByMessage(p: Pr, q: Queue): boolean {
    const c = p.mergeCredit;
    if (!q.taskIdentifier || !c || c.base !== c.defaultBranch) return false;
    const token = q.taskIdentifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w-])${token}(?![\\w-])`).test(c.message);
  }
  /**
   * ok only when every PR the record named merged (or was merged already). The text's first line is MERGED_LINE and the PRs that
   * merged at their bound head, as JSON ({ repo, number, head, sha }, an empty list when none): this queue's own merges and the
   * ones already merged when it polled them (a merge commit at the bound head, its sha), what readers of the record (the grading
   * module) take as merged, never the record's args. An already-merged PR is evidence only when it links to the task this merge is
   * for: a pr-tasks.json row naming it, the task's own pr/push record naming the repo and this exact head commit (`bound`, from
   * prBound), or the merge commit's message naming it (namesTask) — a matching head and merge commit alone prove what GitHub
   * merged, not that it delivered this task. `objects`
   * names only the merge commits this queue made. Then what the queue said, last word last.
   */
  function finish(id: string, q: Queue) {
    const settled = (p: Pr) => p.status === "merged" || p.status === "skipped";
    const ok = q.prs.every(settled);
    const n = q.prs.filter(settled).length;
    const headline = ok ? `**Done:** ${n} merged.` : `**Merges finished:** ${n} merged, ${q.prs.length - n} not.`;
    // pr-tasks.json names the task's identifier (pr-tasks.ts notePrTask: the job's workspace), the record its id: a match on
    // either is this task, and neither is another task's PR. A row naming another task is a veto. Only when there is no row is
    // the task's own record the proof (`bound`, read by `step` from prBound): the commit its own plan named.
    const linked = (p: Pr) => {
      const row = d.taskOf?.(p.repo, p.number);
      if (row) return Boolean((q.task && row === q.task) || (q.taskIdentifier && row === q.taskIdentifier));
      return Boolean(d.prBound) && p.bound?.head === p.head;
    };
    // A PR the fleet never opened has no row to link, so the merge commit that landed on the default branch is what can credit
    // it: its message names the task this merge is for. The facts that make that true are checked here, not taken on trust: the
    // merge must have landed on the default branch, and a cached row without both branches (an older queue) credits nothing. The
    // message is not independent of the PR: a squash merge builds it from the PR's title and body, so the attribution is whatever
    // the PR's author supplied. It is accepted because it is the merge that actually reached the default branch and it is refused
    // when another task's row already claims the PR; a title or a body alone is never read. Whole-token only: a longer identifier
    // sharing the prefix (WOR-99381 for WOR-9938) names another task, and an unknown identifier or an absent message keeps
    // today's answer (not evidence).
    const namesTask = (p: Pr) => creditsByMessage(p, q);
    // A row that names another task is an answer, not an absence: a message that mentions this task in passing never overrides it.
    const linkedElsewhere = (p: Pr) => {
      const row = d.taskOf?.(p.repo, p.number);
      return Boolean(row) && !((q.task && row === q.task) || (q.taskIdentifier && row === q.taskIdentifier));
    };
    const evidence = (p: Pr) => settled(p) && typeof p.sha === "string" && (p.status === "merged" || linked(p) || (!linkedElsewhere(p) && namesTask(p)));
    // The queue's own merges first, then the ones already merged at their bound head, each in the record's order.
    const merged = q.prs.filter(evidence).sort((a, b) => Number(b.status === "merged") - Number(a.status === "merged"))
      .map((p) => ({ repo: p.repo, number: p.number, head: p.head, sha: p.sha! }));
    const objects = q.prs.filter((p) => p.status === "merged" && typeof p.sha === "string").map((p) => `github:${p.repo.toLowerCase()}@${p.sha}`);
    // The first line is machine-readable and whole (the grading module reads it): the kernel keeps the outcome to OUTCOME_MAX
    // characters, cutting only the end, so the human summary after the first line is what is capped here — sized to the room the
    // kernel leaves it, never by a constant of its own that could push the line's end past the cut.
    const line = `${MERGED_LINE}${JSON.stringify(merged)}`;
    const room = OUTCOME_MAX - line.length - 2;
    // No room (a line longer than the cap on its own): keep the whole evidence line and no summary. slice(-0) is slice(0), which
    // would keep every word and push the cut back into the evidence.
    const human = room > 0 ? [...q.said, headline].join("\n\n").slice(-room) : "";
    q.outcome = { ok, text: `${line}\n\n${human}`, ...(objects.length ? { objects } : {}) };
    Object.assign(q, { state: ok ? "done" : "stopped", finishedAt: now().toISOString() });
    log("merges finished", { record: id, ok });
    deliver(id, q);
  }
  /**
   * The outcome to the kernel, durably: the executor's waiter (if this process ran execute) is told, and the outcome is also
   * posted here, marked reported only once the kernel took it (a repeat answers 409, which counts). Until then every poll
   * delivers it again, across restarts.
   */
  function deliver(id: string, q: Queue) {
    const w = waiters.get(id);
    if (w) {
      waiters.delete(id);
      w.resolve(q.outcome!);
    }
    delivering.add(id);
    void d.report(id, q.outcome!).then(() => { q.reported = true; save(); }, (e) => log("merge outcome not delivered", { record: id, err: says(e) })).finally(() => delivering.delete(id));
  }

  /**
   * The record's wait for the whole queue: the reasons of every PR still waiting after the poll, in the record's order, published
   * once per distinct text (never once per poll) and cleared when nothing waits. The record is one card for every PR the merge
   * names, so a reason belongs to it, not to whichever PR was polled last.
   */
  async function publishWait(id: string, q: Queue) {
    const reasons = [...new Set(q.prs.filter((p) => p.status === "pending" && p.note).map((p) => p.note!))];
    const reason = reasons.length === 0 ? null : reasons.length === 1 ? reasons[0]! : q.prs.filter((p) => p.status === "pending" && p.note).map((p) => `${p.url}: ${p.note}`).join("\n");
    // `undefined` is "we don't know what the record has" and is never equal to a target, so a queue written by an older
    // implementation (no `waitSent`) or one that restarted before the kernel answered republishes on its first poll instead of
    // trusting a reason that may never have arrived. `null` is a clear the kernel took.
    if (q.waitSent !== undefined && q.waitSent === reason) return;
    try {
      await d.waiting?.(id, reason);
      q.waitSent = reason;
      // Persisted only after the kernel took it: a restart between the call and the write republishes, never assuming delivery.
      save();
    } catch (e) {
      // The kernel didn't take it (a restart): leave the delivery unknown so the next poll sends the same text again.
      q.waitSent = undefined;
      log("merge wait not delivered", { record: id, err: says(e).slice(0, 300) });
    }
  }

  let busy = false;
  /** One poll: every pending PR of every running queue, at most one merge per repository. */
  async function step() {
    if (busy) return;
    busy = true;
    try {
      // Held (signed out, or the App migration): every pending PR waits (reason github; its other wait starts over) and GitHub
      // isn't called. The two are told apart: only a sign-out can be lifted by reconnecting, so the migration has its own reason.
      // The hold decides first and its text second (`hold()` true with a blank reason still holds: the reason only says why).
      const held = d.hold?.() ? (d.holdReason?.() ?? "").trim() || MIGRATION_WAIT : (d.connected && !d.connected()) ? CONNECTED_WAIT : undefined;
      if (held) {
        for (const [id, q] of Object.entries(s.queues)) {
          if (q.state !== "running" || q.outcome) continue;
          for (const p of q.prs) if (p.status === "pending") {
            // The record's card shows why it cannot move: the hold's reason, once, and only while it stays held.
            p.note = held;
            delete p.wait;
            timeWait(p, "github");
          }
          await publishWait(id, q);
        }
        return;
      }
      const merged = new Set<string>();
      for (const [id, q] of Object.entries(s.queues)) {
        if (q.state !== "running" || q.outcome) continue;
        // Not held any more: the hold's reason ends here, and this poll's own reasons replace it (publishWait, below).
        for (const p of q.prs) if (isHoldWait(p.note)) delete p.note;
        // A queue written before this process kept the task's identifier has only the record's task id, and a running queue is
        // never handed `execute` again: read the identifier from the record so an already-merged PR is still found to be this
        // task's. A read that failed (kernel briefly unavailable) is not a record without an identifier: only keep `recovered`
        // once the read answered, and until it has, hold the queue rather than settle it without the evidence.
        //
        // It is read here when the queue was written before it kept one, and once more when an older version settled it with
        // none (it took a first "none" as final, and the kernel's upgrade reconcile may have recorded one since). The kernel
        // distinguishes a record that has none yet and none read (`identifier_pending`: its reconcile is about to fill it in)
        // from a settled none (the control plane answered: the task is gone or has no identifier), so the queue holds only for
        // the former and never guesses from a poll count.
        if (q.task && !q.taskIdentifier && d.identifierOf && (!q.recovered || q.recoveredBy !== 2)) {
          const r = await d.identifierOf(id).then((v) => ({ v }), (e: Error) => {
            log("merge queue: task identifier not read (retrying)", { record: id, tries: (q.recoverTries ?? 0) + 1, err: says(e) });
            return undefined;
          });
          if (r) {
            delete q.recoverTries;
            const v = r.v;
            // No record by that id any more: nothing to read again, settled as before.
            // Pending: none yet and none read, so the absence is not the task's answer; the queue holds and reads again.
            // Settled: one, or none the control plane answered: that is the answer, cached and never re-read by this version.
            q.identifierPending = Boolean(v?.pending && !v.identifier);
            if (!v || !v.pending) { q.recovered = true; q.recoveredBy = 2; if (v?.identifier) q.taskIdentifier = v.identifier; }
            save();
          } else q.recoverTries = (q.recoverTries ?? 0) + 1;
        }
        // The identifier an already-merged PR must be proven against is still owed (a read that failed, or a record that has none
        // yet and none read): the PRs may be read, but the queue is not finished, so a poll that comes back after the kernel does
        // can still credit the evidence. The same condition waits the ownership check, so a failed read can neither settle the
        // queue without evidence nor refuse an open PR as another task's.
        const unrecovered = identifierOwed(q);
        for (const p of q.prs) if (p.status === "pending" && !merged.has(p.repo.toLowerCase())) await pollAndTime(id, q, p, merged);
        // The second link for an already-merged PR the queue did not merge itself: with no pr-tasks.json row (a push refused
        // before the PR write could note it), the task's own pr/push record must name this repo and bound head. Read after the
        // poll confirmed the merge, so a record the task files while the PR is open is seen at the settle. Only a positive answer
        // is kept (a negative one is asked again each poll): a record filed after an earlier miss must still be credited. A read
        // that failed is not "no binding": the queue is not finished this poll, and the next poll asks again.
        let unbound = false;
        for (const p of q.prs) {
          // Only an externally merged PR with a merge commit, and only with nothing else naming it: the queue's own merges, a
          // linked PR and one its merge commit already names need no binding, so a failed read never holds them.
          if (p.status !== "skipped" || typeof p.sha !== "string" || !q.task || !d.prBound || d.taskOf?.(p.repo, p.number)) continue;
          if (p.bound?.head === p.head) continue;
          if (creditsByMessage(p, q)) continue;
          const r = await d.prBound(q.task, { repo: p.repo, number: p.number, head: p.head }).then((v) => ({ v }), (e: Error) => {
            log("merge queue: task binding not read (retrying)", { pr: p.url, tries: (q.boundTries ?? 0) + 1, err: says(e) });
            return undefined;
          });
          if (!r) { q.boundTries = (q.boundTries ?? 0) + 1; unbound = true; continue; }
          delete q.boundTries;
          if (r.v) { p.bound = { head: p.head }; save(); }
        }
        // The record's reason now: every PR still waiting, or nothing (a finished queue clears it before its outcome lands).
        await publishWait(id, q);
        if (!q.prs.some((p) => p.status === "pending") && !unrecovered && !unbound) finish(id, q);
      }
    } finally {
      for (const [id, q] of Object.entries(s.queues)) if (q.outcome && !q.reported && !delivering.has(id)) deliver(id, q);
      for (const [id, q] of Object.entries(s.queues)) if (q.outcome && q.reported && Date.now() - Date.parse(String(q.finishedAt ?? q.startedAt)) > KEEP_MS) delete s.queues[id];
      try { save(); } finally { busy = false; }
    }
  }

  // A queue finished whose outcome never reached the kernel (a restart): delivered again.
  for (const [id, q] of Object.entries(s.queues)) if (q.outcome && !q.reported) deliver(id, q);

  return {
    /**
     * Ship's round decision for an adopted PR at `head` (its watch loop asks through /internal/ship/decision): decide with ship's
     * context, as an adoption's merge is judged here, and the required checks red on the head. On a merge queue branch (mergePath)
     * a ready PR is `enqueue`, with the required checks red on its latest merge_group run (a removal's cause). `approval`: the PR
     * waits only on an approval of its head (decide would answer `approve` if ship may approve), so ship judges its evidence.
     * `view`: the PR as ship's list read already has it (ship-routes.ts OPEN_PRS_QUERY) with its default branch: no PR read, and
     * the checks from its rollup unless that is cut at 100. Code review's verdict is read once and decided on (`findingsKey`
     * names its findings, so new findings at one head are a new fix_review).
     */
    async decision(repo: string, number: number, head: string, view?: { pr: any; main: { name: string; oid?: string; rollup?: any }; stackedOn?: number }) {
      // A skipped image scan is judged on the PR's files, which only the full read has.
      const listed = view && !skippedImageScan(view.pr);
      const data = listed ? listView(view.pr, view.main) : await readPr(repo, number);
      // The live base branch and author association go along: a risk tier computed from other ones is stale (code review: pending).
      const g = await d.reviewGate(repo, number, head, { base: String(data.repository.pullRequest?.baseRefName ?? ""), association: String(data.repository.pullRequest?.authorAssociation ?? "") });
      const rollup = data.repository.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      // Every context by name, advisory ones included (a branch may require them), as the REST read gives them.
      const fromRollup = () => (rollup?.contexts?.nodes ?? []).map((n: any) => ({ name: String(n.name ?? n.context ?? ""), status: contextStatus(n) })).filter((c: { name: string }) => c.name)
        .map((c: { name: string; status: string | null | undefined }) => ({ name: c.name, ok: ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(c.status)), pending: ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS"].includes(String(c.status)) || c.status == null }));
      const checks = listed && !rollup?.contexts?.pageInfo?.hasNextPage ? fromRollup() : await allChecks(repo, head);
      const { required: rules, queue } = await rulesOf(repo, String(data.repository.defaultBranchRef?.name ?? ""));
      const required = rules ?? fallbackRequired(checks);
      if (!rules && !required.length) return { do: "wait" as const, why: "no checks have reported on its head yet, and the branch's rules can't be read", failing: [] as string[], dirty: false, queue };
      // The reviewer App's login as GraphQL names its Bot (no `[bot]`); unreadable, no bot's approval counts.
      const app = (await d.reviewer?.(repo).catch(() => undefined))?.login.replace(/\[bot\]$/, "");
      const ctx = { queue, verdict: g, required, checks, ...(app ? { app } : {}), ...(view?.stackedOn ? { stackedOn: view.stackedOn } : {}) };
      const v = decide(data, head, { ...ctx, approve: false });
      const approval = v.do === "wait" && decide(data, head, { ...ctx, approve: true }).do === "approve";
      const failing = [...new Set(checks.filter((c) => required.includes(c.name) && !c.ok && !c.pending).map((c) => c.name))];
      return { ...v, failing, dirty: data.repository.pullRequest?.mergeStateStatus === "DIRTY", queue, ...(approval ? { approval } : {}), ...(v.do === "fix_review" && g && "findingsKey" in g && g.findingsKey ? { findingsKey: g.findingsKey } : {}), ...(v.do === "enqueue" ? { groupFailing: await groupFailing(repo, number, String(data.repository.pullRequest?.baseRefName ?? ""), required) } : {}) };
    },
    /** The approved record's queue (once per id): resolves with its outcome when the queue ends. */
    enqueue(id: string, args: { prs: { repo: string; number: number; head: string; base?: string }[]; generation?: number }, task?: string, identifier?: string, tier?: number, byShip?: boolean): Promise<Outcome> {
      const had = s.queues[id];
      if (had?.outcome) return Promise.resolve(had.outcome);
      if (!had) {
        const prs = args.prs.map((p) => ({ repo: p.repo, number: p.number, head: p.head, ...(p.base ? { base: p.base } : {}), url: `https://github.com/${p.repo}/pull/${p.number}`, status: "pending" }));
        // A record this queue just took has no wait from it yet: `waitSent: null` is that known clear. A queue read from disk
        // without the field is unknown (`undefined`) and reconciles on its first poll instead.
        s.queues[id] = { id, state: "running", startedAt: now().toISOString(), prs, said: [], waitSent: null, ...(args.generation !== undefined ? { ship: { generation: args.generation } } : {}), ...(byShip ? { byShip: true } : {}), ...(tier === 0 ? { tier0: true } : {}), ...(task ? { task } : {}), ...(identifier ? { taskIdentifier: identifier } : {}) };
        save();
        log("merges queued", { record: id, prs: prs.length });
      }
      // The record's task (a kernel restart carries it again): the linkage an already-merged PR must show to be evidence.
      else if ((task && had.task !== task) || (identifier && had.taskIdentifier !== identifier)) {
        if (task) had.task = task;
        if (identifier) had.taskIdentifier = identifier;
        save();
      }
      // A repeat enqueue on a running queue shares the first caller's promise.
      let w = waiters.get(id);
      if (!w) {
        let resolve!: (o: Outcome) => void;
        w = { promise: new Promise<Outcome>((ok) => (resolve = ok)), resolve };
        waiters.set(id, w);
      }
      return w.promise;
    },
    /** The record's state for the kernel (executor@1 status), or undefined when it isn't a queue here. */
    status(id: string): { state: string; text?: string; objects?: string[] } | undefined {
      const q = s.queues[id];
      if (!q) return undefined;
      return q.outcome ? { state: q.outcome.ok ? "done" : "failed", text: q.outcome.text, ...(q.outcome.objects ? { objects: q.outcome.objects } : {}) } : { state: "running" };
    },
    step,
    /** The loop: one poll now and every `everyMs` (30 s). */
    start() {
      const t = setInterval(() => void step(), d.everyMs ?? 30_000);
      t.unref?.();
      void step();
      return () => clearInterval(t);
    },
  };
}
export type Merges = ReturnType<typeof createMerges>;
