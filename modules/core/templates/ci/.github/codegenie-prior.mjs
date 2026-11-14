#!/usr/bin/env node
// The `code-review` check's mode: what changed since this PR's last green code review, so a push or a rebase of a big PR
// isn't reviewed whole again. Trusts only GitHub's own records of this workflow (a successful code-review job on an
// earlier head, and the state status that same run set on it), never a PR comment.
//   full:  review the whole PR (no trusted green review, a merge-base that moved, the deep-review label, or the guard)
//   delta: the old head is an ancestor and the merge-base is the same: review only old..new
//   reuse: a rebase whose change is byte-identical (same paths, same old and new blobs): pass on the old verdict
// Splitting guard: after MAX_STEPS deltas or MAX_LINES delta lines since the last full review, review it whole again.
//   node codegenie-prior.mjs  ->  "<mode> <from sha or -> <deltas since full> <delta lines since full> <merge-base>"
// Env: GITHUB_TOKEN (actions: read), GITHUB_REPOSITORY, PR_NUMBER, HEAD_REF, BASE_SHA, HEAD_SHA, DEFAULT_BRANCH,
// PR_LABELS, GITHUB_API_URL. No dependencies; Node 22+.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const STATE = "code-review/state"; // the commit status this workflow sets on a head whose code-review passed
const MAX_STEPS = 3;
const MAX_LINES = 2000;
const FULL = { mode: "full", from: "", n: 0, lines: 0 };
const CI_FILES = [".github/workflows/ci.yml", ".github/codegenie-gate.mjs", ".github/codegenie-prior.mjs"];

/** The PR's last green head before `head`, with the state its run recorded: { sha, n, lines, mb }, or undefined. */
async function lastGreen(api, { repo, pr, headRef, head }) {
  const { workflow_runs: runs = [] } = await api(`/repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&branch=${encodeURIComponent(headRef)}&per_page=50`);
  const red = new Set(); // heads whose latest code review failed: an older green run on the same head no longer counts
  for (const run of runs) { // newest first
    if (run.head_sha === head || red.has(run.head_sha) || !run.pull_requests?.some((p) => p.number === pr)) continue;
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
 * { mode, from, n, lines, mb }: mb is the head's merge-base with the PR's base, recorded so a delta needs the same one
 * (a retargeted PR's merge-base moves). git(...args, { input }?) returns trimmed stdout and throws on a non-zero exit.
 */
export async function decide({ api, git, repo, pr, headRef, base, head, defaultRef, labels = "", fetchCommit = () => {} }) {
  const mergeBase = (sha) => git("merge-base", base, sha);
  const mb = mergeBase(head);
  const full = { ...FULL, mb };
  if (`,${labels},`.includes(",deep-review,")) return full;
  const last = await lastGreen(api, { repo, pr, headRef, head });
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
  if ([last.sha, head].some((sha) => !ok("diff", "--quiet", mergeBase(sha), sha, "--", ".github/"))) return full;
  if (last.mb === mb && mergeBase(last.sha) === mb && ok("merge-base", "--is-ancestor", last.sha, head)) {
    const lines = git("diff", "--numstat", `${last.sha}..${head}`).split("\n").filter(Boolean)
      .reduce((n, l) => { const [a, d] = l.split("\t"); return n + (a === "-" ? 1000 : Number(a) + Number(d)); }, 0);
    if (last.n >= MAX_STEPS || last.lines + lines > MAX_LINES) return full;
    return { mode: "delta", from: last.sha, n: last.n + 1, lines: last.lines + lines, mb };
  }
  // Byte-identical change, not patch-id (which ignores whitespace): every changed path with its old and new blob ids.
  const change = (sha) => git("diff", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", mergeBase(sha), sha);
  if (change(last.sha) === change(head)) return { mode: "reuse", from: last.sha, n: last.n, lines: last.lines, mb };
  return full;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, PR_NUMBER, HEAD_REF, BASE_SHA, HEAD_SHA, PR_LABELS } = process.env;
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
    r = await decide({ api, git, repo, pr: Number(PR_NUMBER), headRef: HEAD_REF, base: BASE_SHA, head: HEAD_SHA, defaultRef: `origin/${DEFAULT_BRANCH}`, labels: PR_LABELS, fetchCommit });
  } catch (err) {
    console.error(`::warning::Couldn't read this PR's last green code review (${err.message}): reviewing it whole.`);
  }
  console.log(`${r.mode} ${r.from || "-"} ${r.n} ${r.lines} ${r.mb || "-"}`);
}
