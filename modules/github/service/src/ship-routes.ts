// What the ship module's watch loop (modules/ship/service/src/loop.ts) reads and does on GitHub, through this service with
// ship's own module token (the kernel vouches for it, GET /v1/whoami): the owner's sign-in stays here. Every route is ship's alone:
//   POST /internal/ship/gh       {method, path, body?, deadline?} -> {status, body} | {thrown: {message, cause}}: one GitHub call,
//                                background, from a fixed list (the loop's reads, check re-runs, update-branch, closing an abandoned
//                                PR and deleting its branch, its comment), on a repo the fleet merges in. No merge. Each write goes as
//                                the actor its row's op picks (client.ts actorFor: the App where installed and permitted, else the
//                                owner); its REST reads as the App where the App can read the repo (client.ts readerFor), and a head's
//                                check-run list (filter=latest) from the change feed's snapshot while it is fresh (feed.ts checkRuns)
//                                and holds every check run the request's `covers` names (the PR's rollup, which ship read live).
//                                POST /graphql is OPEN_PRS_QUERY with ship's {owner, repo, after}, never a query of ship's, read as the
//                                repo's merge actor (its merge and repair decisions read mergeStateStatus and code-owner reviewers as
//                                GitHub shows them to the identity that merges).
//   POST /internal/ship/verdict  {repo, number, head} -> code review's verdict for that head (review-gate.ts; null: not gated)
//   POST /internal/ship/decision {repo, number, head, pr?, main?} -> a PR's round decision (merges.ts decision: decide with ship's
//                                context); `pr` and `main` are the list read's node and default branch (OPEN_PRS_QUERY), so the
//                                PR isn't read again; `stackedOn`: the open PR whose branch is its base
//   GET  /internal/ship/openers  -> pr-tasks.json: which task opened each PR
import type { IncomingMessage, ServerResponse } from "node:http";
import { withBranch } from "./branch-lock.ts";
import { readPrTasks } from "./pr-tasks.ts";
import { commentsAsk, type CommentsAsk } from "./member-comments.ts";
import type { ReviewGate } from "./review-gate.ts";
import type { Op } from "../../connections/github-mcp/src/client.ts";

type Gh = (method: string, path: string, body?: unknown, o?: { background?: boolean; deadline?: number }) => Promise<{ status: number; body: any }>;
type Json = any;
const REPO = "([\\w.-]+/[\\w.-]+)";
/** The GitHub calls the loop makes, and nothing else: [method, path, body check, the write's op (client.ts OPS)]. The repo is the path's first group. */
const CALLS: [string, RegExp, ((b: Json) => boolean)?, Op?][] = [
  // `check_name` (ship's generated.ci check) is percent-encoded.
  ["GET", new RegExp(`^/repos/${REPO}/commits/[0-9a-f]{4,40}/check-runs\\?[\\w=&%.-]*$`)],
  ["GET", new RegExp(`^/repos/${REPO}/actions/jobs/\\d+$`)],
  ["POST", new RegExp(`^/repos/${REPO}/actions/jobs/\\d+/rerun$`), undefined, "actions"],
  ["POST", new RegExp(`^/repos/${REPO}/actions/runs/\\d+/rerun-failed-jobs$`), undefined, "actions"],
  ["GET", new RegExp(`^/repos/${REPO}/actions/runs/\\d+/jobs$`)],
  ["GET", new RegExp(`^/repos/${REPO}/pulls/\\d+$`)],
  // A close carries the task it was decided for (expectTask): the route re-reads ownership under the branch lock and skips a PR a
  // successor took over while the cleanup waited (a delete carries it too).
  ["PATCH", new RegExp(`^/repos/${REPO}/pulls/\\d+$`), (b) => b?.state === "closed" && Object.keys(b).every((k) => k === "state" || k === "expectTask") && (b.expectTask === undefined || typeof b.expectTask === "string"), "pr"],
  ["POST", new RegExp(`^/repos/${REPO}/issues/\\d+/comments$`), (b) => typeof b?.body === "string" && Object.keys(b).length === 1, "issue"],
  ["DELETE", new RegExp(`^/repos/${REPO}/git/refs/heads/[\\w./-]+$`), undefined, "push"],
  ["PUT", new RegExp(`^/repos/${REPO}/pulls/\\d+/update-branch$`), undefined, "update_branch"],
  ["GET", new RegExp(`^/repos/${REPO}/compare/[0-9a-f]{4,40}\\.\\.\\.[0-9a-f]{4,40}$`)],
  // The cleanups' own reads before a branch delete: the ref's current tip, and every open PR on the branch (a moved tip or any
  // open PR keeps it; a failed read keeps it too).
  ["GET", new RegExp(`^/repos/${REPO}/git/ref/heads/[\\w./-]+$`)],
  ["GET", new RegExp(`^/repos/${REPO}/pulls\\?state=open&head=[\\w%:./-]+$`)],
  // A PR off the default branch (a release, a former default): its own base's head, for the rebase wake.
  ["GET", new RegExp(`^/repos/${REPO}/branches/[\\w./-]+$`)],
  ["GET", new RegExp(`^/repos/${REPO}/check-runs/\\d+$`)],
  // Hand-offs (handoff.ts, rounds.ts): a trigger's author's role, and the assignees ship adds on a hold and removes on a resume.
  ["GET", new RegExp(`^/repos/${REPO}/collaborators/[\\w-]+/permission$`)],
  ["POST", new RegExp(`^/repos/${REPO}/issues/\\d+/assignees$`), (b) => Array.isArray(b?.assignees) && Object.keys(b).length === 1, "issue"],
  ["DELETE", new RegExp(`^/repos/${REPO}/issues/\\d+/assignees$`), (b) => Array.isArray(b?.assignees) && Object.keys(b).length === 1, "issue"],
  // The repo's own steps and discovery (ship's actions.ts): the base branch's tree and its blobs, a workflow's dispatch (always
  // asking GitHub for the run it started), and that run.
  ["GET", new RegExp(`^/repos/${REPO}/git/trees/[\\w.-]+\\?recursive=1$`)],
  ["GET", new RegExp(`^/repos/${REPO}/git/blobs/[0-9a-f]{40}$`)],
  ["POST", new RegExp(`^/repos/${REPO}/actions/workflows/[\\w.-]+\\.ya?ml/dispatches$`), (b) => typeof b?.ref === "string" && b.return_run_details === true && Object.keys(b).every((k) => k === "ref" || k === "return_run_details" || (k === "inputs" && typeof b.inputs === "object" && !Array.isArray(b.inputs))), "actions"],
  ["GET", new RegExp(`^/repos/${REPO}/actions/runs/\\d+$`)],
];
/** The loop's one GraphQL read: a repo's open PRs (a page of them) with their checks, and its default branch's. Ship names only the
 * variables, so no other query runs on the owner's sign-in. */
const ROLLUP = "statusCheckRollup { state contexts(first: 100) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { id databaseId name status conclusion startedAt completedAt checkSuite { workflowRun { databaseId } } } ... on StatusContext { context state createdAt } } } }";
export const OPEN_PRS_QUERY = `query($owner: String!, $repo: String!, $after: String, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name target { oid ... on Commit { ${ROLLUP} } } }
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number url title createdAt isDraft mergeable mergeStateStatus reviewDecision isInMergeQueue latestOpinionatedReviews(first: 30) { nodes { fullDatabaseId state authorCanPushToRepository author { __typename login } commit { oid } } } reviewRequests(first: 10) { nodes { asCodeOwner requestedReviewer { __typename ... on Team { combinedSlug } ... on User { login } } } } isCrossRepository headRepository { nameWithOwner } headRefName headRefOid baseRefName authorAssociation author { __typename login } maintainerCanModify labels(first: 30) { nodes { name } } assignees(first: 10) { nodes { login } } timelineItems(last: 30, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ISSUE_COMMENT]) { nodes { __typename ... on LabeledEvent { id createdAt actor { __typename login } label { name } } ... on UnlabeledEvent { id createdAt actor { __typename login } label { name } } ... on IssueComment { id createdAt author { __typename login } body } } } commits(last: 1) { nodes { commit { ${ROLLUP} } } } }
    }
  }
}`;

export function shipRoutes(o: {
  gh: Gh; decision?: (repo: string, number: number, head: string, view?: { pr: Json; main: { name: string; oid?: string; rollup?: Json }; stackedOn?: number; comments?: CommentsAsk }) => Promise<unknown>; gate: ReviewGate; cacheDir: string;
  /** A head's latest check runs in REST's shape from the change feed's snapshot, or undefined when it has no fresh read of them. */
  checkRuns?: (repo: string, sha: string) => Json[] | undefined;
  /** One write attempt's actor for `op` on `repo` (client.ts actorFor): the App where installed and permitted, else the owner. */
  actorFor: (repo: string, op: Op) => Promise<{ rest: Gh }>;
  /** Whether the fleet works this repo (git-auth.ts mergeable): ship's calls reach no other. */
  allowed: (repo: string) => boolean;
  /** Whether a bearer is the ship module's own token (undefined: the kernel couldn't say now). */
  isShip: (authorization: string) => Promise<boolean | undefined>;
}) {
  // A bearer the kernel vouched for is trusted for five minutes: the loop makes a call per check it reads, each one here.
  const vouched = new Map<string, number>();
  const isShip = async (auth: string) => {
    if ((vouched.get(auth) ?? 0) > Date.now()) return true;
    const ok = await o.isShip(auth);
    if (ok) vouched.set(auth, Date.now() + 5 * 60_000); else vouched.delete(auth);
    return ok;
  };
  const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body ?? null));
  /** The head branch of a PR on a repo the fleet works (a close's lock is keyed by it), or undefined when it can't be read: the call
   *  then runs unlocked, exactly as it did before there was a lock (a failed read must not hold a cleanup that closes nothing). */
  const prBranch = async (repo: string, number: number) => {
    const r = await o.gh("GET", `/repos/${repo}/pulls/${number}`, undefined, { background: true }).catch(() => undefined);
    return r && r.status < 300 ? String(r.body?.head?.ref ?? "") || undefined : undefined;
  };
  /** Serves a /internal/ship/ request; false for any other path. */
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const op = new URL(req.url ?? "/", "http://x").pathname.match(/^\/internal\/ship\/(\w+)$/)?.[1];
    if (!op) return false;
    const ok = await isShip(String(req.headers.authorization ?? ""));
    if (!ok) return send(res, ok === undefined ? 503 : 401, { error: "ship's module token only" }), true;
    try {
      if (op === "openers" && req.method === "GET") return send(res, 200, readPrTasks(o.cacheDir)), true;
      if (req.method !== "POST") return send(res, 405, { error: "POST" }), true;
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > 4_000_000) return send(res, 413, { error: "too large" }), true; }
      const b = JSON.parse(raw || "{}");
      if (op === "gh") {
        const { method, path, deadline } = b;
        const v = b.body?.variables ?? {};
        const read = method === "POST" && path === "/graphql";
        // No `.` or `..` segment (raw or percent-encoded) and no other escape: a path that normalises elsewhere is never sent.
        // The query may carry an encoded slash (a `head=owner:feat/x` filter): it never changes which path GitHub serves.
        const bare = String(path).split("?")[0]!;
        const dotted = bare.split("/").some((seg) => /^(\.|%2e){1,2}$/i.test(seg)) || /%(2e|2f|5c)/i.test(bare) || /%(2e|5c)/i.test(String(path).slice(bare.length));
        const call = dotted ? undefined : CALLS.find(([m, re]) => m === method && re.test(String(path)));
        const repo = read ? `${String(v.owner)}/${String(v.repo)}` : call ? String(path).match(call[1])![1]! : "";
        if ((!call && !read) || (call?.[2] && !call[2](b.body)) || !o.allowed(repo) || (read && ((v.after != null && typeof v.after !== "string") || !Number.isInteger(v.first) || (v.first as number) < 1 || (v.first as number) > 50))) return send(res, 403, { error: `ship may not call ${String(method)} ${String(path).slice(0, 200)}` }), true;
        // A branch is deleted only as an abandoned PR's: one pr-tasks.json names as an opener's head branch on this repo, never the default.
        if (method === "DELETE" && String(path).includes("/git/refs/heads/")) {
          // The path is exactly an opener's branch on this repo, compared whole (never a prefix or a normalised form).
          const branch = Object.entries(readPrTasks(o.cacheDir)).find(([url, t]) => url.startsWith(`https://github.com/${repo.toLowerCase()}/pull/`) && path === `/repos/${repo}/git/refs/heads/${t.branch}`)?.[1].branch;
          const def = branch ? (await o.gh("GET", `/repos/${repo}`, undefined, { background: true })).body?.default_branch : undefined;
          if (!branch || !def || def === branch) return send(res, 403, { error: `ship may delete only an opener's PR branch, never the default branch` }), true;
        }
        // `expectTask` is the route's own re-check of ownership, never GitHub's: it is stripped before the call goes out.
        const { expectTask, ...sent } = read ? {} : (b.body ?? {});
        const body = read ? { query: OPEN_PRS_QUERY, variables: { owner: String(v.owner), repo: String(v.repo), after: v.after ?? null, first: v.first } } : b.body === undefined ? undefined : sent;
        // A close or a branch delete runs under this service's per-branch lock (branch-lock.ts), the one the publish holds around its
        // push and its ownership write. A cleanup in the gap between them would otherwise close or delete what a successor just pushed.
        const branch = String(path).match(/\/git\/refs\/heads\/(.+)$/)?.[1] ?? (method === "PATCH" && b.body?.state === "closed" ? await prBranch(repo, Number(String(path).split("/").at(-1))) : undefined);
        // The check-run list the recovery reads (filter=latest, a full head sha): the feed read the same list, so its snapshot answers.
        // Page one only, answered whole (every run, so the reader asks no second page): a listing never mixes the two sources.
        const listed = method === "GET" ? /^\/repos\/[\w.-]+\/[\w.-]+\/commits\/([0-9a-f]{40})\/check-runs\?filter=latest&per_page=100&page=1$/.exec(String(path)) : null;
        const covers: unknown = b.covers;
        const snap = listed && Array.isArray(covers) && covers.length <= 500 && covers.every((c) => typeof c === "string") ? o.checkRuns?.(repo, listed[1]!) : undefined;
        if (snap && (covers as string[]).every((id) => snap.some((r) => r.node_id === id))) return send(res, 200, { status: 200, body: { total_count: snap.length, check_runs: snap } }), true;
        // A write goes as its row's op's actor; the open-PR read as the repo's merge actor (it decides merges); other reads as the client picks.
        const op: Op | undefined = read ? "merge" : call?.[3];
        const run = async () => (op ? (await o.actorFor(repo, op)).rest : o.gh)(method, path, body, { background: true, ...(typeof deadline === "number" ? { deadline } : {}) });
        if (branch && (method === "DELETE" || (method === "PATCH" && b.body?.state === "closed"))) {
          /** Ownership as pr-tasks.json has it once the lock is ours: a successor that published and was recorded while this cleanup
           *  waited is the PR's task now, and its PR is not the earlier task's to close (the head is unchanged, so no tip read can say so). */
          const moved = (expect: unknown) => {
            if (typeof expect !== "string") return false;
            const rows = Object.entries(readPrTasks(o.cacheDir)).filter(([u, t]) => (method === "DELETE"
              ? u.startsWith(`https://github.com/${repo.toLowerCase()}/pull/`) && t.branch === decodeURIComponent(branch)
              : u === `https://github.com/${repo.toLowerCase()}/pull/${String(path).split("/").at(-1)}`));
            return rows.some(([, t]) => t.task !== expect);
          };
          try {
            return send(res, 200, await withBranch(repo, decodeURIComponent(branch), async () => {
              if (moved(expectTask)) return { status: 409, body: { skipped: "ownership moved: a successor owns this PR now" } };
              return run();
            })), true;
          }
          catch (e) {
            const cause = (e as { need?: { cause?: string } }).need?.cause ?? (e as { cause?: unknown }).cause;
            return send(res, 200, { thrown: { message: String((e as Error).message ?? e).slice(0, 500), ...(typeof cause === "string" ? { cause } : {}) } }), true;
          }
        }
        try { return send(res, 200, await run()), true; }
        catch (e) {
          const cause = (e as { need?: { cause?: string } }).need?.cause ?? (e as { cause?: unknown }).cause;
          return send(res, 200, { thrown: { message: String((e as Error).message ?? e).slice(0, 500), ...(typeof cause === "string" ? { cause } : {}) } }), true;
        }
      }
      if (op === "verdict") return send(res, 200, (await o.gate(String(b.repo), Number(b.number), String(b.head))) ?? null), true;
      if (op === "decision" && o.decision) {
        const repo = String(b.repo);
        if (!o.allowed(repo)) return send(res, 403, { error: `ship may not read ${repo.slice(0, 200)}` }), true;
        const view = b.pr && typeof b.pr === "object" && b.main && typeof b.main === "object" ? { pr: b.pr, main: { name: String(b.main.name), oid: b.main.oid ? String(b.main.oid) : undefined, rollup: b.main.rollup }, ...(Number.isInteger(b.stackedOn) && b.stackedOn > 0 ? { stackedOn: b.stackedOn } : {}), ...(commentsAsk(b.comments) ? { comments: commentsAsk(b.comments)! } : {}) } : undefined;
        return send(res, 200, await o.decision(repo, Number(b.number), String(b.head), view)), true;
      }
      return send(res, 404, { error: "no such operation" }), true;
    } catch (e) {
      return send(res, 500, { error: String((e as Error).message ?? e).slice(0, 300) }), true;
    }
  };
}
