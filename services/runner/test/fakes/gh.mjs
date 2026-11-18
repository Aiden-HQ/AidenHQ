// No GitHub API: every gh call fails (so PRs can't open), as it may on a bad day. Only an edit to
// an open PR's title and description goes through, logged with what it would have written.
// Opt-in (a github-prs.json next to $FAKE_LOG, { "<number>": { branch, files, checks, title?, body?, author?, mergeable? } }): those PRs of
// acme/app read as open (also in the open-PR list), their head the branch's tip on the fake GitHub, and merge (logged; the PR
// reads as merged after). `checks`: SUCCESS, FAILURE or PENDING (still running); `author`: "dependabot" for Dependabot's;
// `mergeable`: CONFLICTING for a conflict with main; `base`: the base branch (main when unset), stacked on another PR's branch.
// `merged: true` reads as GitHub's own merged PR: `mergedAt` and a merge commit (`merge`, else the head's tip). `baseFiles`
// are the paths the base changed after the merge (none: unchanged since). A branch's PRs come from `gh pr list --head`.
// `checks` may also be NONE (no checks on the head yet); `title` and `body` are the PR's own text, as GitHub returns it. Also
// the default branch, a branch's PRs, a retarget, a close, a comment, and an update of a PR's head with its base (a merge commit).
// `red: [<word>…]` (in place of `checks`): the PR's nth head has one Actions check run, `test`, failed with "Error: expected
// <nth word>" in its job log; the word `lost` is a job whose runner died instead (GitHub's annotation, and no step failed).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "edit") {
  log("gh", args);
  process.exit(0);
}
// A new PR that already exists (opt-in, FAKE_PR_EXISTS=1): the branch already has this PR, as gh says it.
if (args[0] === "pr" && args[1] === "create" && process.env.FAKE_PR_EXISTS) {
  log("gh", args);
  console.error("a pull request for branch \"feat/stacked\" into branch \"main\" already exists:\nhttps://github.com/acme/app/pull/99");
  process.exit(1);
}
// A new PR (a publish), opt-in (FAKE_PR_CREATE=1): logged with the base it was asked for, and its URL printed.
if (args[0] === "pr" && args[1] === "create" && process.env.FAKE_PR_CREATE) {
  log("gh", args);
  console.log("https://github.com/acme/app/pull/99");
  process.exit(0);
}
const dir = dirname(process.env.FAKE_LOG);
// A race (opt-in, once: a move-branch.json { repo, branch, slug? } next to $FAKE_LOG): while the runner reads a PR's state
// on its way to publishing, a commit lands on that workspace branch (and, with `slug`, the workspace spells the repository
// differently from then on).
const move = join(dir, "move-branch.json");
if (args[0] === "pr" && args[1] === "view" && existsSync(move)) {
  const { repo, branch, slug } = JSON.parse(readFileSync(move, "utf8"));
  rmSync(move);
  const w = (a, input) => execFileSync("git", ["-C", repo, ...a], { input, stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
  if (slug) w(["config", "aidenhq.slug", slug]);
  const was = w(["rev-parse", `refs/heads/${branch}`]);
  const blob = w(["hash-object", "-w", "--stdin"], "moved\n");
  const tree = w(["mktree"], `${w(["ls-tree", was])}\n100644 blob ${blob}\tmoved.txt\n`);
  w(["update-ref", `refs/heads/${branch}`, w(["commit-tree", tree, "-p", was, "-m", "chore: moved"]), was]);
  log("moved", { branch });
}
const fixture = join(dir, "github-prs.json");
// A branch's PRs (`gh pr list --head <branch> --state all`): the fixture's PRs whose `branch` is that head.
if (args[0] === "pr" && args[1] === "list" && args.includes("--head") && existsSync(fixture)) {
  const head = args[args.indexOf("--head") + 1];
  const found = Object.entries(JSON.parse(readFileSync(fixture, "utf8")))
    .filter(([, q]) => q.branch === head)
    .map(([number, q]) => ({ number: Number(number), state: q.merged ? "MERGED" : q.closed ? "CLOSED" : "OPEN" }));
  console.log(JSON.stringify(found));
  process.exit(0);
}
// The live state a run and `aidenhq status` read (`gh pr view <url> --json state,…`): those PRs read as open, with their checks.
if (args[0] === "pr" && args[1] === "view" && args[4] === "state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup" && existsSync(fixture)) {
  const p = JSON.parse(readFileSync(fixture, "utf8"))[/\/pull\/(\d+)$/.exec(args[2])?.[1]];
  if (!p) process.exit(1);
  const checks = p.checks === "NONE" ? [] : [{ name: "test", status: p.checks === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: p.checks === "PENDING" ? null : p.checks }];
  console.log(JSON.stringify({ state: p.merged ? "MERGED" : "OPEN", isDraft: false, reviewDecision: "", mergeStateStatus: "CLEAN", statusCheckRollup: checks }));
  process.exit(0);
}
// A PR's state and head branch, as the runner reads it before it acts on a stored PR number (gh pr view, not the API). A
// transient read failure (opt-in, counted down: a pr-view-failures.json { "n": 1, "number": 32 } next to $FAKE_LOG) fails that
// many reads of that PR, and no other PR's.
if (args[0] === "pr" && args[1] === "view" && args[4] === "state,number,headRefOid,headRefName" && existsSync(fixture)) {
  const blip = join(dir, "pr-view-failures.json");
  const want = existsSync(blip) ? JSON.parse(readFileSync(blip, "utf8")) : { n: 0 };
  if (want.n > 0 && String(want.number) === /\/pull\/(\d+)$/.exec(args[2])?.[1]) {
    writeFileSync(blip, JSON.stringify({ ...want, n: want.n - 1 }));
    console.error("fetch failed");
    process.exit(1);
  }
  const p = JSON.parse(readFileSync(fixture, "utf8"))[/\/pull\/(\d+)$/.exec(args[2])?.[1]];
  if (!p) process.exit(1);
  // The head branch is the fixture's; its tip only when the branch is on this fake GitHub (a PR of a branch not pushed here
  // still reads, as GitHub reads a PR whose branch exists).
  let head = "0".repeat(40);
  try {
    head = execFileSync("git", ["--git-dir", join(dir, "github/acme/app.git"), "rev-parse", p.branch], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {}
  console.log(JSON.stringify({ state: p.merged ? "MERGED" : p.closed ? "CLOSED" : "OPEN", number: Number(/\/pull\/(\d+)$/.exec(args[2])[1]), headRefOid: head, headRefName: p.branch }));
  process.exit(0);
}
if (args[0] !== "api" || !existsSync(fixture)) process.exit(1);
const prs = JSON.parse(readFileSync(fixture, "utf8"));
const field = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const tip = (branch) => {
  try {
    return execFileSync("git", ["--git-dir", join(dir, "github/acme/app.git"), "rev-parse", branch], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "0".repeat(40); // not on GitHub yet
  }
};
// The commit statuses the runner itself wrote on a head (a design review's pending wait), alongside the fake's checks.
const written = (p) => (p.statuses ?? []).map((s) => ({ __typename: "StatusContext", context: s.context, state: s.state.toUpperCase(), description: s.description }));
const rollup = (state, statuses = []) => {
  const nodes = state === "NONE" ? [] : [{ __typename: "CheckRun", name: "test", status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: state === "PENDING" ? null : state }];
  const all = [...nodes, ...statuses];
  // No rollup at all only when there is nothing on the head: a written status is something.
  if (state === "NONE" && !statuses.length) return null;
  const worst = all.some((n) => n.conclusion === "FAILURE" || n.state === "FAILURE") ? "FAILURE" : all.some((n) => n.state === "PENDING" || n.status === "IN_PROGRESS") ? "PENDING" : "SUCCESS";
  return { state: worst, contexts: { nodes: all } };
};
// `red`: each head the PR has had, in order (kept in the fixture), and the check run on it. Its id says which head and word.
const redRun = (p, head) => {
  if (!(p.heads ??= []).includes(head)) {
    p.heads.push(head);
    writeFileSync(fixture, JSON.stringify(prs));
  }
  const i = p.heads.indexOf(head);
  return { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", databaseId: 7000 + i, checkSuite: { workflowRun: { databaseId: 8000 + i } } };
};
const redWord = (id) => Object.values(prs).find((p) => p.red)?.red[id % 1000];
const commits = (p) => ({ nodes: [{ commit: { parents: { nodes: [] }, signature: null, statusCheckRollup: p.red ? { state: "FAILURE", contexts: { nodes: [redRun(p, tip(p.branch))] } } : rollup(p.checks, written(p)) } }] });

if (field("query")?.includes("pullRequests(states: OPEN")) {
  const nodes = Object.entries(prs)
    .filter(([, p]) => !p.merged && !p.closed)
    .map(([number, p]) => ({
      number: Number(number), url: `https://github.com/acme/app/pull/${number}`, isDraft: false, mergeable: p.mergeable ?? "MERGEABLE", isCrossRepository: false,
      headRefName: p.branch, headRefOid: tip(p.branch), author: p.author === "dependabot" ? { __typename: "Bot", login: "dependabot" } : { __typename: "User", login: "test" }, commits: commits(p),
    }));
  console.log(JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: tip("main"), statusCheckRollup: rollup("SUCCESS") } }, pullRequests: { nodes } } } }));
  process.exit(0);
}
// `red`: a head's failed check runs, a workflow run's jobs, a check run's failure annotations and a job's log.
const apiPath = args.find((a) => a.startsWith("repos/acme/app/")) ?? "";
const redRoute = (re) => re.exec(apiPath);
let m;
if ((m = redRoute(/^repos\/acme\/app\/commits\/([0-9a-f]{40})\/check-runs/))) {
  const p = Object.values(prs).find((q) => q.red && q.heads?.includes(m[1]));
  const r = p && redRun(p, m[1]);
  console.log(JSON.stringify(r ? [{ id: r.databaseId, name: r.name, title: null, summary: null }] : []));
  process.exit(0);
}
if ((m = redRoute(/^repos\/acme\/app\/actions\/runs\/(\d+)\/jobs/))) {
  const id = Number(m[1]) - 1000;
  console.log(JSON.stringify({ id, name: "test", check_run_url: `https://api.github.com/repos/acme/app/check-runs/${id}`, steps: [{ name: "test", conclusion: redWord(id) === "lost" ? "success" : "failure" }] }));
  process.exit(0);
}
if ((m = redRoute(/^repos\/acme\/app\/check-runs\/(\d+)\/annotations$/))) {
  const notes = redWord(Number(m[1])) === "lost" ? [{ annotation_level: "failure", message: "The self-hosted runner: box-1 lost communication with the server." }] : [];
  console.log(JSON.stringify(args.includes("--jq") ? notes.map((a) => a.message) : notes));
  process.exit(0);
}
if ((m = redRoute(/^repos\/acme\/app\/actions\/jobs\/(\d+)\/logs$/))) {
  console.log(`Error: expected ${redWord(Number(m[1]))}\nnot ok - ${redWord(Number(m[1]))}`);
  process.exit(0);
}
const bare = (...a) => execFileSync("git", ["--git-dir", join(dir, "github/acme/app.git"), ...a], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const parents = (oid) => {
  try {
    return bare("rev-list", "--parents", "-n", "1", oid).split(" ").slice(1).map((o) => ({ oid: o }));
  } catch {
    return [];
  }
};
// The repository: its default branch (unreadable while a default-branch-down file sits next to $FAKE_LOG).
if (args.includes("repos/acme/app") && args.includes(".default_branch")) {
  if (existsSync(join(dir, "default-branch-down"))) process.exit(1);
  console.log("main");
  process.exit(0);
}
// A branch (merges.mjs BASE_QUERY): its tip, the PRs with it as their head, and the open PRs based on it.
if (field("query")?.includes("stacked: pullRequests")) {
  const base = field("base");
  const tipOf = tip(base);
  const heads = Object.values(prs).filter((p) => p.branch === base).map((p) => ({ state: p.merged ? "MERGED" : "OPEN", headRefOid: tip(p.branch), isCrossRepository: false }));
  const stacked = Object.values(prs).filter((p) => !p.merged && p.base === base).length;
  console.log(JSON.stringify({ data: { repository: { ref: /^0+$/.test(tipOf) ? null : { target: { oid: tipOf } }, heads: { pageInfo: { hasNextPage: false }, nodes: heads }, stacked: { totalCount: stacked } } } }));
  process.exit(0);
}
// The base's files changed since a merge commit (siblings.ts BASE_FILES_QUERY): main's tip, and the fixture's `baseFiles`
// changed since the merge (none when the base still sits at it), so a sibling reads as unchanged or named.
if (field("query")?.includes("qualifiedName: $base") && field("query")?.includes("compare(headRef")) {
  const base = (field("base") ?? "refs/heads/main").replace(/^refs\/heads\//, "");
  const files = Object.values(prs).flatMap((q) => q.baseFiles ?? []);
  console.log(JSON.stringify({ data: { repository: { ref: { target: { oid: tip(base) } }, object: { compare: { files: { pageInfo: { hasNextPage: false }, nodes: files.map((path) => ({ path })) } } } } } }));
  process.exit(0);
}
// A commit's checks (merges.mjs COMMIT_QUERY): green.
if (field("query")?.includes("object(oid")) {
  console.log(JSON.stringify({ data: { repository: { object: { committedDate: new Date().toISOString(), statusCheckRollup: rollup("SUCCESS") } } } }));
  process.exit(0);
}
// A commit status the runner wrote (the design review's wait): recorded on the PR whose head it is, and logged.
const statusRoute = /^repos\/acme\/app\/statuses\/([0-9a-f]{7,40})$/.exec(args.find((a) => a.startsWith("repos/acme/app/statuses/")) ?? "");
if (statusRoute) {
  const sha = statusRoute[1];
  const entry = Object.entries(prs).find(([, q]) => q.branch && sha.startsWith(tip(q.branch))) ?? Object.entries(prs).find(([, q]) => q.branch);
  if (!entry) process.exit(1);
  const [num, q] = entry;
  q.statuses = [...(q.statuses ?? []), { context: field("context"), state: field("state"), description: field("description"), sha }];
  log("status", { number: Number(num), sha, status: q.statuses.at(-1) });
  writeFileSync(fixture, JSON.stringify(prs));
  console.log("{}");
  process.exit(0);
}
// A comment on a PR's conversation: logged.
if (args.includes("POST") && args.some((a) => /^repos\/acme\/app\/issues\/\d+\/comments$/.test(a))) {
  log("gh", args);
  console.log("{}");
  process.exit(0);
}
const route = args.find((a) => a.startsWith("repos/acme/app/pulls/"));
const number = route ? route.split("/")[4] : field("number");
const p = prs[number];
if (!p) process.exit(1);

if (args.includes("PATCH") && field("state") === "closed") {
  // A close: logged, and the PR leaves the open list.
  log("gh", args);
  p.closed = true;
  writeFileSync(fixture, JSON.stringify(prs));
  console.log("{}");
} else if (args.includes("PATCH") && field("base")) {
  // A retarget: the PR's base branch changes.
  log("gh", args);
  p.base = field("base");
  writeFileSync(fixture, JSON.stringify(prs));
  console.log("{}");
} else if (args.includes("PUT") && route?.endsWith("/update-branch")) {
  // GitHub's update: the base branch merged into the PR's head (refused on a conflict).
  const [head, base] = [tip(p.branch), tip(p.base ?? "main")];
  const tree = bare("merge-tree", "--write-tree", head, base);
  const commit = execFileSync("git", ["--git-dir", join(dir, "github/acme/app.git"), "commit-tree", tree, "-p", head, "-p", base, "-m", "Merge main"], { env: { ...process.env, GIT_AUTHOR_NAME: "GitHub", GIT_AUTHOR_EMAIL: "noreply@github.com", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" } }).toString().trim();
  bare("update-ref", `refs/heads/${p.branch}`, commit, head);
  log("gh", args); // once the head moved
  console.log("{}");
} else if (args.includes("PUT") && route?.endsWith("/merge")) {
  log("gh", args);
  p.merged = true;
  writeFileSync(fixture, JSON.stringify(prs));
  console.log(JSON.stringify({ sha: "f".repeat(40), merged: true }));
} else if (route?.includes("/files")) {
  console.log(p.files.join("\n"));
} else if (route) {
  console.log(p.files.length);
} else if (field("query")?.includes("pullRequest(number")) {
  // A transient read failure (opt-in, counted down: a pr-read-failures.json { "n": 2, "number": 30 } next to $FAKE_LOG fails
  // that many reads of PR 30 with "fetch failed", as a network blip or a restarting API does). Only that PR's reads count it
  // down: the runner's background reads of other PRs (an earlier card's checks) never take the blip meant for this one.
  const blip = join(dir, "pr-read-failures.json");
  const want = existsSync(blip) ? JSON.parse(readFileSync(blip, "utf8")) : { n: 0 };
  if (want.n > 0 && Number(want.number) === Number(number)) {
    writeFileSync(blip, JSON.stringify({ ...want, n: want.n - 1 }));
    console.error("fetch failed");
    process.exit(1);
  }
  const pullRequest = {
    id: `PR_${number}`, number: Number(number), title: p.title ?? `PR ${number}`, body: p.body ?? "", url: `https://github.com/acme/app/pull/${number}`, state: p.merged ? "MERGED" : "OPEN", isDraft: false, reviewDecision: null,
    mergedAt: p.merged ? (p.mergedAt ?? "2026-11-01T10:00:00Z") : null, mergeCommit: p.merged ? { oid: p.merge ?? tip(p.branch) } : null,
    files: { pageInfo: { hasNextPage: false }, nodes: (p.files ?? []).map((path) => ({ path })) },
    mergeStateStatus: p.mergeable === "CONFLICTING" ? "DIRTY" : "CLEAN", headRefOid: tip(p.branch), headRefName: p.branch, isCrossRepository: false, baseRefName: p.base ?? "main", latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [{ commit: { ...commits(p).nodes[0].commit, parents: { nodes: parents(tip(p.branch)) } } }] },
    baseRef: { target: { oid: tip(p.base ?? "main"), statusCheckRollup: rollup("SUCCESS") } },
  };
  console.log(JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, pullRequest } } }));
} else process.exit(1);
