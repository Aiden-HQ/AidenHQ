// No GitHub API: every gh call fails (so PRs can't open), as it may on a bad day. Only an edit to
// an open PR's title and description goes through, logged with what it would have written.
// Opt-in (a github-prs.json next to $FAKE_LOG, { "<number>": { branch, files, checks, author?, mergeable? } }): those PRs of
// acme/app read as open (also in the open-PR list), their head the branch's tip on the fake GitHub, and merge (logged; the PR
// reads as merged after). `checks`: SUCCESS, FAILURE or PENDING (still running); `author`: "dependabot" for Dependabot's;
// `mergeable`: CONFLICTING for a conflict with main.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "edit") {
  log("gh", args);
  process.exit(0);
}
const dir = dirname(process.env.FAKE_LOG);
const fixture = join(dir, "github-prs.json");
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
const rollup = (state) =>
  state === "PENDING"
    ? { state, contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }] } }
    : { state, contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: state }] } };
const commits = (p) => ({ nodes: [{ commit: { parents: { nodes: [] }, signature: null, statusCheckRollup: rollup(p.checks) } }] });

if (field("query")?.includes("pullRequests(states: OPEN")) {
  const nodes = Object.entries(prs)
    .filter(([, p]) => !p.merged)
    .map(([number, p]) => ({
      number: Number(number), url: `https://github.com/acme/app/pull/${number}`, isDraft: false, mergeable: p.mergeable ?? "MERGEABLE", isCrossRepository: false,
      headRefName: p.branch, headRefOid: tip(p.branch), author: p.author === "dependabot" ? { __typename: "Bot", login: "dependabot" } : { __typename: "User", login: "test" }, commits: commits(p),
    }));
  console.log(JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: tip("main"), statusCheckRollup: rollup("SUCCESS") } }, pullRequests: { nodes } } } }));
  process.exit(0);
}
const route = args.find((a) => a.startsWith("repos/acme/app/pulls/"));
const number = route ? route.split("/")[4] : field("number");
const p = prs[number];
if (!p) process.exit(1);

if (args.includes("PUT") && route?.endsWith("/merge")) {
  log("gh", args);
  p.merged = true;
  writeFileSync(fixture, JSON.stringify(prs));
  console.log(JSON.stringify({ sha: "f".repeat(40), merged: true }));
} else if (route?.includes("/files")) {
  console.log(p.files.join("\n"));
} else if (route) {
  console.log(p.files.length);
} else if (field("query")?.includes("pullRequest(number")) {
  const pullRequest = {
    id: `PR_${number}`, number: Number(number), url: `https://github.com/acme/app/pull/${number}`, state: p.merged ? "MERGED" : "OPEN", isDraft: false, reviewDecision: null,
    mergeStateStatus: p.mergeable === "CONFLICTING" ? "DIRTY" : "CLEAN", headRefOid: tip(p.branch), headRefName: p.branch, isCrossRepository: false, baseRefName: "main", latestOpinionatedReviews: { nodes: [] },
    commits: commits(p),
  };
  console.log(JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, pullRequest } } }));
} else process.exit(1);
