// Hand-graduating a distro pre-release (github_release_graduate, the Maintainer's): the one move for a graduation that stalled
// on something other than the candidate (owner, 2026-11-23: "a stall is settled by hand-graduating under a code check, never by
// the owner"). The distro's graduate.yml tests the OLDEST pending pre-release against the current latest; a failure before the
// candidate's own stage (the baseline, the runner, a bootstrap the old baseline can't do) holds every later release back. Code
// checks, on GitHub's own records and never on the caller's words, that:
//   1. the tag is a published pre-release, not marked rejected, and the one graduation would test next: the oldest pending
//      pre-release newer than the latest release (so latest only ever moves forward, in order);
//   2. the candidate's release run passed: the tag run its notes name (`Tested: {"ci_run": …}`) is this repo's release.yml run
//      on this tag at the tag's current commit, concluded success, its `publish` job a success;
//   3. the latest completed graduation run (graduate.yml, on the default branch, started after the candidate was published)
//      failed before the candidate stage, and it was this candidate's run: no other release's notes name that run (a run that
//      judged an older cut marks that one), and either its `select` job failed (a baseline that can't prepare the
//      candidate), or its `reject` job ran to success, opened its "Graduation of <tag> didn't finish" issue for this tag naming
//      that run (`Run: <url>`), and
//      marked the candidate neither `graduation: failed` (its own checks failed) nor `graduation: incomplete <that run>` (it
//      reached the candidate and never finished). That is graduate.mjs onFailure's own verdict that the failure wasn't the
//      candidate's.
// Then the release is made a full release and latest, with one line in its notes naming the failed run. The checks run again
// at execution: the tool runs only once its write record is approved.
import { GitHubRefused } from "./github.js";

type Rest = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
const NAME = /^\d{4}\.\d{1,2}(\.\d+){0,2}$/;
const REJECTED = /^graduation: failed\b/m;
const compare = (a: string, b: string) => {
  const [x, y] = [a, b].map((s) => s.split(".").map(Number));
  for (let i = 0; i < 4; i++) { const d = (x![i] ?? 0) - (y![i] ?? 0); if (d) return Math.sign(d); }
  return 0;
};

async function get(rest: Rest, path: string) {
  const r = await rest("GET", path);
  if (r.status !== 200) throw new Error(`GitHub answered ${r.status} for ${path.split("?")[0]}`);
  return r.body;
}

/** Why `tag` can't be hand-graduated now, or the release and the failed graduation run that allow it. */
export async function graduationCheck(rest: Rest, repo: string, tag: string): Promise<{ release: { id: number; body: string }; run: string }> {
  if (!NAME.test(tag)) throw new GitHubRefused(`${tag} isn't a release name (YYYY.MM.DD[.N])`);
  const releases: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await get(rest, `/repos/${repo}/releases?per_page=100&page=${page}`);
    releases.push(...rows);
    if (rows.length < 100) break;
  }
  const latest = await get(rest, `/repos/${repo}/releases/latest`);
  const pending = releases.filter((r) => !r.draft && r.prerelease === true && NAME.test(r.tag_name) && compare(r.tag_name, latest.tag_name) > 0 && !REJECTED.test(String(r.body ?? ""))).sort((a, b) => compare(a.tag_name, b.tag_name));
  const rel = releases.find((r) => r.tag_name === tag);
  if (!rel || rel.draft || rel.prerelease !== true) throw new GitHubRefused(`${tag} isn't a published pre-release`);
  if (REJECTED.test(String(rel.body ?? ""))) throw new GitHubRefused(`${tag} is marked rejected: its own checks failed graduation`);
  if (pending[0]?.tag_name !== tag) throw new GitHubRefused(`${tag} isn't the next release graduation tests (${pending[0]?.tag_name ?? "none pending"}, after latest ${latest.tag_name})`);
  // 2. Its release run: the tag run its notes name.
  const ci = /"ci_run"\s*:\s*"https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)"/.exec(String(rel.body ?? ""));
  if (!ci || ci[1]!.toLowerCase() !== repo.toLowerCase()) throw new GitHubRefused(`${tag}'s notes name no release run of ${repo}`);
  const tagRun = await get(rest, `/repos/${repo}/actions/runs/${ci[2]}`);
  if (tagRun.path !== ".github/workflows/release.yml" || tagRun.head_branch !== tag || tagRun.status !== "completed" || tagRun.conclusion !== "success") throw new GitHubRefused(`${tag}'s release run ${ci[2]} isn't a passed release.yml run on the tag`);
  // The tag as it is now (an annotated tag followed to its commit) is what that run tested.
  let obj = (await get(rest, `/repos/${repo}/git/ref/tags/${tag}`)).object;
  for (let i = 0; obj?.type === "tag" && i < 5; i++) obj = (await get(rest, `/repos/${repo}/git/tags/${obj.sha}`)).object;
  if (obj?.type !== "commit" || obj.sha !== tagRun.head_sha) throw new GitHubRefused(`${tag} no longer points at the commit its release run tested`);
  const tagJobs: any[] = (await get(rest, `/repos/${repo}/actions/runs/${ci[2]}/jobs?per_page=100`)).jobs ?? [];
  if (tagJobs.find((j) => j.name === "publish")?.conclusion !== "success") throw new GitHubRefused(`${tag}'s release run didn't publish`);
  // 3. The latest completed graduation run, on the default branch, after the candidate was published.
  const def = (await get(rest, `/repos/${repo}`)).default_branch;
  const runs: any[] = (await get(rest, `/repos/${repo}/actions/workflows/graduate.yml/runs?branch=${encodeURIComponent(def)}&status=completed&per_page=1`)).workflow_runs ?? [];
  const run = runs[0];
  if (!run || run.conclusion !== "failure") throw new GitHubRefused("the latest graduation run didn't fail: there is no stall to settle");
  if (Date.parse(run.created_at) < Date.parse(rel.published_at ?? rel.created_at)) throw new GitHubRefused(`the latest graduation run started before ${tag} was published: it never tested it`);
  const jobs: any[] = (await get(rest, `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)).jobs ?? [];
  const job = (n: string) => jobs.find((j) => j.name === n);
  // The run's own link, whole: run 900 is never run 9001.
  const names = (text: unknown) => new RegExp(`${run.html_url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w/])`).test(String(text ?? ""));
  if (releases.some((r) => r.id !== rel.id && names(r.body))) throw new GitHubRefused(`graduation run ${run.id} judged another release, not ${tag}`);
  if (String(rel.body ?? "").split("\n").some((l) => l.startsWith("graduation: incomplete ") && names(l))) throw new GitHubRefused(`graduation run ${run.id} reached ${tag}'s own stage and never finished: that is the candidate's, so it gets a fix (or is tested again)`);
  const bootstrap = job("select")?.conclusion === "failure";
  if (!bootstrap) {
    if (job("reject")?.conclusion !== "success") throw new GitHubRefused(`graduation run ${run.id} recorded no verdict (its reject job didn't run to success): ${tag} stays a pre-release`);
    const issues: any[] = await get(rest, `/repos/${repo}/issues?state=all&creator=${encodeURIComponent("github-actions[bot]")}&per_page=100`);
    const mine = issues.filter((i) => !i.pull_request && i.title === `Graduation of ${tag} didn't finish`);
    if (!mine.some((i) => String(i.body ?? "").split("\n").some((l) => l.trim() === `Run: ${run.html_url}`))) throw new GitHubRefused(mine.length
      ? `the "Graduation of ${tag} didn't finish" issue names an earlier run, not ${run.id}: close it, and the next graduation run opens a new one naming itself`
      : `graduation run ${run.id} opened no "Graduation of ${tag} didn't finish" issue: it isn't shown to have failed before ${tag}'s stage`);
  }
  return { release: { id: rel.id, body: String(rel.body ?? "") }, run: run.html_url };
}

/** Graduates `tag` on `repo` once graduationCheck passes: a full release, and latest. */
export async function graduate(rest: Rest, repo: string, tag: string) {
  const { release, run } = await graduationCheck(rest, repo, tag);
  const body = `${release.body.trimEnd()}\n\ngraduated by hand: ${run} failed before the candidate stage\n`;
  const r = await rest("PATCH", `/repos/${repo}/releases/${release.id}`, { prerelease: false, make_latest: "true", body });
  if (r.status !== 200) throw new Error(`GitHub answered ${r.status} graduating ${tag}`);
  return { graduated: tag, repo, because: run };
}
