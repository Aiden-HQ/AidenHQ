#!/usr/bin/env node
// The `code-review` check's mode: what changed since this PR's last green code review, so a push or a rebase of a big PR
// isn't reviewed whole again. Trusts only GitHub's own records of this workflow (a successful code-review job on an
// earlier head, and the state status that same run set on it), never a PR comment.
//   full:  review the whole PR (no trusted green review, a merge-base that moved, the deep-review label, or the guard)
//   delta: the old head is an ancestor and the merge-base is the same: review only old..new
//   reuse: the patch is the same as the last green head's (a stacked rebase onto a base that only moved forward, a rewrite,
//          or the same branch reopened as a new PR): pass on the old verdict, no model calls. Only when that run's PR
//          targeted the same base ref, from this repo (no forks), and its merge-base is an ancestor of this one's.
//          The patch is the full diff with 3 lines of context, hunk headings (not line numbers), modes and paths, lockfiles
//          included, so the same lines in a different place, or any changed line (whitespace too), is never reused.
// Splitting guard: after MAX_STEPS deltas or MAX_LINES delta lines (added plus deleted; package-lock.json excluded) since
// the last full review, review it whole again.
//   node codegenie-prior.mjs  ->  "<mode> <from sha or -> <deltas since full> <delta lines since full> <merge-base>"
// Env: GITHUB_TOKEN (actions: read), GITHUB_REPOSITORY, HEAD_REF, BASE_REF, BASE_SHA, HEAD_SHA, DEFAULT_BRANCH,
// PR_LABELS, GITHUB_API_URL. No dependencies; Node 22+.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const STATE = "code-review/state"; // the commit status this workflow sets on a head whose code-review passed
const MAX_STEPS = 3;
const MAX_LINES = 2000;
// package-lock.json is not counted as changed lines: npm-age.mjs validates what it changes. It stays in the patch. Nor are an
// agent's screenshots under .aidenhq/out/ (the workflow's image types; its json and txt reports count), and a binary file counts 20 (the workflow's rule).
export const NOLOCK = [":(exclude,glob)**/package-lock.json", ...["png", "jpg", "jpeg", "webp", "gif"].map((t) => `:(exclude,glob).aidenhq/out/**/*.${t}`)];
const FULL = { mode: "full", from: "", n: 0, lines: 0 };
const CI_FILES = [".github/workflows/ci.yml", ".github/codegenie-gate.mjs", ".github/codegenie-prior.mjs", ".github/code-review.mjs", ".github/review-tools.mjs", ".github/code-review-rules.md"];
// Files that shape the review but an app may not have: the same on both sides, absent included.
const OPTIONAL_FILES = [".github/code-review-critical", ".github/code-review-checklist.json", ".github/review-checklist.mjs"];

/** The PR's last green head before `head`, with the state its run recorded: { sha, n, lines, mb }, or undefined. */
async function lastGreen(api, { repo, headRef, baseRef, head }) {
  const { workflow_runs: runs = [] } = await api(`/repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&branch=${encodeURIComponent(headRef)}&per_page=50`);
  const red = new Set(); // heads whose latest code review failed: an older green run on the same head no longer counts
  for (const run of runs) { // newest first
    // Any PR of this repo's branch counts, not only this PR number, so a reopened branch isn't reviewed again from
    // scratch; but only one that targeted the same base ref, and never a fork's run of the same branch name.
    if (run.head_sha === head || red.has(run.head_sha) || run.head_branch !== headRef || run.head_repository?.full_name !== repo
      || !run.pull_requests?.some((p) => p.base?.ref === baseRef)) continue;
    const { jobs = [] } = await api(`/repos/${repo}/actions/runs/${run.id}/jobs`);
    const conclusion = jobs.find((j) => j.name === "code-review")?.conclusion;
    if (conclusion === "failure" || conclusion === "timed_out") red.add(run.head_sha);
    if (conclusion !== "success") continue;
    const statuses = await api(`/repos/${repo}/commits/${run.head_sha}/statuses?per_page=100`);
    // The newest state status on that head, set by this workflow's token while that run was running (a status is
    // mutable; one set outside the run's time isn't its own).
    const s = statuses.find((x) => x.context === STATE);
    const t = Date.parse(s?.created_at);
    const own = s?.state === "success" && s.creator?.login === "github-actions[bot]" && s.target_url?.endsWith(`/actions/runs/${run.id}`)
      && t >= Date.parse(run.run_started_at) && t <= Date.parse(run.updated_at);
    const m = own && s.description?.match(/^(full|delta|reuse) n=(\d+) lines=(\d+) mb=([0-9a-f]{40})$/);
    return m ? { sha: run.head_sha, n: Number(m[2]), lines: Number(m[3]), mb: m[4] } : undefined; // no state (yet): full
  }
}

/**
 * { mode, from, n, lines, mb }: mb is the head's merge-base with the PR's base, recorded so a delta or a reuse needs the
 * same one (a retargeted PR's merge-base moves). git(...args, { input }?) returns trimmed stdout and throws on a non-zero
 * exit.
 */
export async function decide({ api, git, repo, headRef, baseRef, base, head, defaultRef, labels = "", fetchCommit = () => {} }) {
  const mergeBase = (sha) => git("merge-base", base, sha);
  const mb = mergeBase(head);
  const full = { ...FULL, mb };
  if (`,${labels},`.includes(",deep-review,")) return full;
  const last = await lastGreen(api, { repo, headRef, baseRef, head });
  if (!last) return full;
  const ok = (...a) => { try { git(...a); return true; } catch { return false; } };
  if (!ok("cat-file", "-e", `${last.sha}^{commit}`)) {
    fetchCommit(last.sha);
    if (!ok("cat-file", "-e", `${last.sha}^{commit}`)) return full;
  }
  // The green run ran the PR's own copy of this workflow, so its verdict is trusted only if that copy, the gate and this
  // file were the default branch's, and neither PR diff (old or new) touches .github/: a PR that edits its CI never
  // carries a verdict forward.
  const blob = (ref, f) => { try { return git("rev-parse", `${ref}:${f}`); } catch { return undefined; } };
  if (!CI_FILES.every((f) => blob(last.sha, f) && blob(last.sha, f) === blob(defaultRef, f))) return full;
  if (!OPTIONAL_FILES.every((f) => blob(last.sha, f) === blob(defaultRef, f))) return full;
  if ([last.sha, head].some((sha) => !ok("diff", "--quiet", mergeBase(sha), sha, "--", ".github/"))) return full;
  // The same patch: the full diff against each head's own merge-base with 3 lines of context, so the changed lines and
  // where they sit (context, hunk headings, paths, modes) all match; line numbers are dropped so a rebase that shifts
  // them still matches. Lockfiles are included. A binary change can't be compared: reviewed again.
  const patch = (sha) => {
    const d = git("diff", "-U3", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", mergeBase(sha), sha);
    return /^(Binary files|GIT binary patch)/m.test(d) ? undefined
      : d.split("\n").filter((l) => !l.startsWith("index ")).map((l) => l.replace(/^@@ [^@]* @@/, "@@")).join("\n");
  };
  // Reuse only when the base moved forward (the last head's merge-base is an ancestor of this one's, or the same).
  const was = ok("merge-base", "--is-ancestor", last.mb, mb) ? patch(last.sha) : undefined;
  if (was !== undefined && was === patch(head)) return { mode: "reuse", from: last.sha, n: last.n, lines: last.lines, mb };
  // A delta needs the same merge-base; a rebase that also adds commits is reviewed whole.
  if (last.mb === mb && mergeBase(last.sha) === mb && ok("merge-base", "--is-ancestor", last.sha, head)) {
    const lines = git("diff", "--numstat", `${last.sha}..${head}`, "--", ".", ...NOLOCK).split("\n").filter(Boolean)
      .reduce((n, l) => { const [a, d] = l.split("\t"); return n + (a === "-" ? 20 : Number(a) + Number(d)); }, 0);
    if (last.n >= MAX_STEPS || last.lines + lines > MAX_LINES) return full;
    return { mode: "delta", from: last.sha, n: last.n + 1, lines: last.lines + lines, mb };
  }
  return full;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, HEAD_REF, BASE_REF, BASE_SHA, HEAD_SHA, PR_LABELS } = process.env;
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const api = async (path) => {
    const r = await fetch(`${apiUrl}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
    if (!r.ok) throw new Error(`GitHub GET ${path}: ${r.status}`);
    return r.json();
  };
  const git = (...a) => {
    const opts = typeof a.at(-1) === "object" ? a.pop() : {};
    return execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "ignore"], ...opts }).trim();
  };
  // An old head a force-push left behind is on no branch: fetch it by sha (checkout removed its credentials).
  const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const fetchCommit = (sha) => { try { git("-c", `http.extraHeader=${auth}`, "fetch", "--no-tags", "origin", sha); } catch {} };
  let r = FULL;
  try {
    const { DEFAULT_BRANCH } = process.env;
    git("-c", `http.extraHeader=${auth}`, "fetch", "--no-tags", "origin", `+refs/heads/${DEFAULT_BRANCH}:refs/remotes/origin/${DEFAULT_BRANCH}`);
    r = await decide({ api, git, repo, headRef: HEAD_REF, baseRef: BASE_REF, base: BASE_SHA, head: HEAD_SHA, defaultRef: `origin/${DEFAULT_BRANCH}`, labels: PR_LABELS, fetchCommit });
  } catch (err) {
    console.error(`::warning::Couldn't read this PR's last green code review (${err.message}): reviewing it whole.`);
  }
  console.log(`${r.mode} ${r.from || "-"} ${r.n} ${r.lines} ${r.mb || "-"}`);
}
