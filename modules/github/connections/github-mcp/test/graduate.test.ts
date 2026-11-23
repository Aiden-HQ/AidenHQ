import { expect, it } from "vitest";
import { graduate } from "../src/graduate.js";

const REPO = "acme/distro";
const RUN = "https://github.com/acme/distro/actions/runs/900";

/** GitHub as the graduation check reads it: a latest release, a pending candidate, its tag run and the last graduation run. */
function github(o: { candidateBody?: string; gradJobs?: { name: string; conclusion: string }[]; gradConclusion?: string; tagConclusion?: string; older?: boolean; olderRejectedBy?: boolean; moved?: boolean; noIssue?: boolean; oldIssue?: boolean; prefixIssue?: boolean } = {}) {
  const patched: unknown[] = [];
  const releases = [
    { id: 1, tag_name: "2026.11.20", prerelease: false, draft: false, body: "" },
    ...(o.older ? [{ id: 3, tag_name: "2026.11.21", prerelease: true, draft: false, body: "", published_at: "2026-11-21T00:00:00Z" }] : []),
    // An older cut the same run rejected: the run was its, not the candidate's.
    ...(o.olderRejectedBy ? [{ id: 4, tag_name: "2026.11.21", prerelease: true, draft: false, body: `graduation: failed ${RUN}\n`, published_at: "2026-11-21T00:00:00Z" }] : []),
    { id: 2, tag_name: "2026.11.22", prerelease: true, draft: false, published_at: "2026-11-22T00:00:00Z", body: o.candidateBody ?? `Tested: {"ci_run":"https://github.com/acme/distro/actions/runs/500","suites":["product-ci"]}` },
  ];
  const routes: Record<string, unknown> = {
    [`/repos/${REPO}/releases?per_page=100&page=1`]: releases,
    [`/repos/${REPO}/releases/latest`]: releases[0],
    [`/repos/${REPO}/actions/runs/500`]: { path: ".github/workflows/release.yml", head_branch: "2026.11.22", head_sha: "a".repeat(40), status: "completed", conclusion: o.tagConclusion ?? "success" },
    [`/repos/${REPO}/git/ref/tags/2026.11.22`]: { object: { type: "tag", sha: "t".repeat(40) } },
    [`/repos/${REPO}/git/tags/${"t".repeat(40)}`]: { object: { type: "commit", sha: o.moved ? "b".repeat(40) : "a".repeat(40) } },
    [`/repos/${REPO}/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100`]: o.noIssue ? [] : [{ title: "Graduation of 2026.11.22 didn't finish", body: `2026.11.22 wasn't graduated or rejected.\n\nRun: ${o.oldIssue ? "https://github.com/acme/distro/actions/runs/800" : o.prefixIssue ? `${RUN}1` : RUN}` }],
    [`/repos/${REPO}/actions/runs/500/jobs?per_page=100`]: { jobs: [{ name: "publish", conclusion: "success" }] },
    [`/repos/${REPO}`]: { default_branch: "main" },
    [`/repos/${REPO}/actions/workflows/graduate.yml/runs?branch=main&status=completed&per_page=1`]: { workflow_runs: [{ id: 900, html_url: RUN, conclusion: o.gradConclusion ?? "failure", created_at: "2026-11-23T00:00:00Z" }] },
    [`/repos/${REPO}/actions/runs/900/jobs?per_page=100`]: { jobs: o.gradJobs ?? [{ name: "select", conclusion: "success" }, { name: "test", conclusion: "failure" }, { name: "reject", conclusion: "success" }] },
  };
  const rest = async (method: string, path: string, body?: unknown) => {
    if (method === "PATCH") return (patched.push({ path, body }), { status: 200, body: {} });
    return path in routes ? { status: 200, body: routes[path] } : { status: 404, body: {} };
  };
  return { rest, patched };
}

it("graduates the next candidate when its release run passed and graduation failed before the candidate stage", async () => {
  const g = github();
  expect(await graduate(g.rest, REPO, "2026.11.22")).toEqual({ graduated: "2026.11.22", repo: REPO, because: RUN });
  expect(g.patched).toHaveLength(1);
  expect(g.patched[0]).toMatchObject({ path: `/repos/${REPO}/releases/2`, body: { prerelease: false, make_latest: "true" } });
});

it("refuses when the candidate's own checks failed, it never finished, its release run failed, graduation didn't fail, or it isn't next", async () => {
  const cases = [
    github({ candidateBody: `Tested: {"ci_run":"https://github.com/acme/distro/actions/runs/500"}\n\ngraduation: failed ${RUN}\n` }),
    github({ candidateBody: `Tested: {"ci_run":"https://github.com/acme/distro/actions/runs/500"}\n\ngraduation: incomplete ${RUN}\n` }),
    github({ tagConclusion: "failure" }),
    github({ gradConclusion: "success" }),
    github({ gradJobs: [{ name: "select", conclusion: "success" }, { name: "test", conclusion: "failure" }, { name: "reject", conclusion: "failure" }] }),
    github({ older: true }),
    github({ candidateBody: "no tested line" }),
    github({ olderRejectedBy: true }),
    github({ moved: true }),
    github({ noIssue: true }),
    github({ oldIssue: true }),
    github({ prefixIssue: true }), // run 9001's issue is not run 900's
    github({ gradJobs: [{ name: "select", conclusion: "failure" }, { name: "reject", conclusion: "skipped" }] }), // selection failed: no verdict (it also checks the candidate's assets)
  ];
  for (const g of cases) await expect(graduate(g.rest, REPO, "2026.11.22")).rejects.toThrow();
  expect(cases.every((g) => g.patched.length === 0)).toBe(true);
  await expect(graduate(github().rest, REPO, "2026.11.20")).rejects.toThrow(/isn't a published pre-release/);
});
