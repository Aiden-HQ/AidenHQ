// A `pr` task's deliverable is never the PR its brief ordered closed: a closed-unmerged PR is an evidence wait (the row holds,
// it does not issue a revision request against a branch that can no longer change), and when the task's own records name a
// merged PR in the same repo beside the superseded branch, the merged PR is the one graded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseCommitOf, localPullRequest, prEvidence } from "../service/src/grader/evidence.ts";

const REPO = "acme-agents/app";
const SHA = (c) => c.repeat(40);
const url = (n) => `https://github.com/${REPO}/pull/${n}`;

// A PR as the code host's read answers it: `baseRefOid` is the base ref's commit GitHub records on the PR. `baseRef.target` is
// the base branch's current tip, which moves and is never the base commit.
const merged = (n, head, merge, base = "0") => ({
  number: n, url: url(n), state: "MERGED", title: `Land ${head}`, body: `Lands ${head}.`, headRefOid: SHA(head), headRefName: `branch-${head}`, baseRefName: "main",
  mergedAt: "2026-11-19T22:45:53Z", mergeCommit: { oid: SHA(merge) }, baseRefOid: SHA(base),
  baseRef: { target: { oid: SHA("9") } },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] }, history: { nodes: [] },
});

// The superseded branch: closed unmerged, with the failing checks the failed grade quoted.
const closed = (n, head) => ({
  number: n, url: url(n), state: "CLOSED", title: `Superseded ${head}`, body: `Superseded by a new branch.`, headRefOid: SHA(head), headRefName: `branch-${head}`, baseRefName: "main",
  mergedAt: null, mergeCommit: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "FAILURE" }, { __typename: "StatusContext", context: "tests", state: "FAILURE" }] } } } }] }, history: { nodes: [] },
});

const depsFor = (prs, { taskMerged } = {}) => ({
  pr: async (_repo, n) => ({ repository: { pullRequest: prs.find((p) => p.number === n) } }),
  diff: async () => "diff --git a/x b/x\n+landed",
  ownRepo: () => true,
  ...(taskMerged ? { taskMerged: async () => taskMerged } : {}),
});

test("a branch-row PR closed without merging is an evidence wait, never a graded version", async () => {
  const prs = [closed(223, "a")];
  const ev = await prEvidence([{ repo: REPO, number: 223, url: url(223), heads: ["branch-a"] }], "", depsFor(prs));
  assert.equal(ev.awaiting, `${url(223)} was closed without merging`);
  assert.equal(ev.missing, undefined, "the PR exists: this is pending evidence, not a missing deliverable");
  assert.equal(ev.version, undefined, "no version is graded, so nothing is sent back as a revision");
  assert.equal(ev.facts, undefined);
  assert.equal(ev.prs, undefined);
});

test("a task naming a closed PR and the merged PR that landed the work grades the merged one", async () => {
  const prs = [closed(223, "a"), merged(224, "b", "c")];
  const ev = await prEvidence([
    { repo: REPO, number: 223, url: url(223), heads: ["branch-a"] },
    { repo: REPO, number: 224, url: url(224), heads: ["branch-b"] },
  ], "", depsFor(prs));
  assert.match(ev.version, /#224@/, "the merged PR is the version graded");
  assert.doesNotMatch(ev.version, /#223/, "the superseded branch is not read");
  assert.deepEqual(ev.prs.map((p) => p.number), [224]);
  assert.equal(ev.prs[0].merge, SHA("c"));
  assert.ok(ev.facts.every((f) => !f.includes("/pull/223")), "nothing of the closed branch is a fact");
  assert.ok(ev.facts.some((f) => f.startsWith(`${url(224)}: merged`)));
  assert.doesNotMatch(ev.data.DIFF + ev.data.PR_DESCRIPTION, /223/);
});

test("the same holds when the task's merge records, not its branch rows, name both PRs", async () => {
  const prs = [closed(223, "a"), merged(224, "b", "c")];
  const records = [
    { repo: REPO, number: 223, url: url(223), headRef: "branch-a" },
    { repo: REPO, number: 224, url: url(224), headOid: SHA("b"), merges: [SHA("c")] },
  ];
  const ev = await prEvidence([], "", depsFor(prs, { taskMerged: records }));
  assert.ok(ev.version, "the merged record's PR is graded");
  assert.match(ev.version, /#224@/);
  assert.deepEqual(ev.prs.map((p) => p.number), [224]);
});

test("when every PR the task names is closed, the hold applies: no verdict either way", async () => {
  const prs = [closed(223, "a")];
  const ev = await prEvidence([{ repo: REPO, number: 223, url: url(223), heads: ["branch-a"] }], "", depsFor(prs, { taskMerged: [{ repo: REPO, number: 223, url: url(223), headRef: "branch-a" }] }));
  assert.equal(ev.awaiting, `${url(223)} was closed without merging`);
  assert.equal(ev.version, undefined);
});

// The prerequisite-then-pin shape: a PR based on the commit its prerequisite just merged. The fixture is a prerequisite
// squash-merged as SHA("2") and a PR whose recorded base ref commit is that merge, so the criterion asks about a base that is
// named rather than "not established".
test("a PR whose base is the commit its prerequisite just merged names that base commit in its trusted facts", async () => {
  const prerequisite = merged(201, "1", "2"); // squash-merged as SHA("2")
  const landed = merged(202, "3", "4", "2");
  const ev = await prEvidence([{ repo: REPO, number: 202, url: url(202), heads: ["branch-3"] }], "", depsFor([prerequisite, landed]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(202)}: merged`));
  assert.ok(fact, "the PR's own fact line is present");
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("2"), "the fact gives the prerequisite's merge commit, not 'not established'");
  assert.equal(SHA("2"), prerequisite.mergeCommit.oid, "and that commit is exactly the prerequisite's squash merge");
  assert.match(fact, /base commit [0-9a-f]{40} \(the recorded base ref commit\)/, "and the label says what the value is");
});

// The base commit is the PR's recorded base ref commit, never the base branch's current tip and never the git merge base.
test("the base commit is the recorded base ref commit, not the base branch's moving tip", async () => {
  const pr = { ...merged(601, "3", "4", "2"), baseRef: { target: { oid: SHA("7") } } };
  assert.equal(baseCommitOf(pr), SHA("2"), "the recorded base ref commit is named");
  const ev = await prEvidence([{ repo: REPO, number: 601, url: url(601), heads: ["branch-3"] }], "", depsFor([pr]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(601)}: merged`));
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("2"));
  assert.doesNotMatch(fact, new RegExp(`base commit ${SHA("7")}`), "the base branch's tip is not passed off as the base commit");
});

// The base commit is part of the graded version: a criterion about it is judged from the value, so a PR that keeps its head and
// description but is re-based onto another commit is a new version to grade, not the same one rejected again.
test("the graded version changes when the PR's recorded base commit changes", async () => {
  const onBase = (base) => prEvidence([{ repo: REPO, number: 610, url: url(610), heads: ["branch-3"] }], "", depsFor([merged(610, "3", "4", base)]));
  const a = await onBase("2"), b = await onBase("5");
  assert.notEqual(a.version, b.version, "another base commit is another version");
  assert.match(a.version, new RegExp(`\\.${SHA("2")}$`), "the version names the base commit it graded");
  assert.equal((await onBase("2")).version, a.version, "the same base and head and text is the same version");
});

// A PR that is not merged yet still carries its recorded base commit: the fact states it rather than claiming nothing is known.
test("an open PR's fact names its recorded base commit too", async () => {
  const open = { ...merged(611, "5", "0", "2"), state: "OPEN", mergedAt: null, mergeCommit: null };
  const ev = await prEvidence([{ repo: REPO, number: 611, url: url(611), heads: ["branch-5"] }], "", depsFor([open]));
  const fact = ev.facts.find((f) => f.startsWith(`${url(611)}: open`));
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("2"), "the recorded base ref commit is named before the merge");
});

test("a read with no base ref commit, or one that is not a commit id, establishes nothing", async () => {
  for (const [label, pr] of Object.entries({
    "no base ref commit": { ...merged(602, "3", "4"), baseRefOid: undefined },
    "not a commit id": { ...merged(603, "3", "4"), baseRefOid: "main" },
    "no PR read at all": undefined,
  })) {
    if (pr === undefined) { assert.equal(baseCommitOf(undefined), "", `${label}: nothing is claimed`); continue; }
    assert.equal(baseCommitOf(pr), "", `${label}: nothing is claimed`);
    const ev = await prEvidence([{ repo: REPO, number: pr.number, url: url(pr.number), heads: [`branch-${pr.headRefOid[0]}`] }], "", depsFor([pr]));
    const fact = ev.facts.find((f) => f.startsWith(`${url(pr.number)}: merged`));
    assert.match(fact, /base commit not established/, `${label}: the fact says so`);
    assert.doesNotMatch(fact, /base commit [0-9a-f]/, `${label}: and no sha is shown`);
  }
});

test("a local change request's recorded base ref commit is its base commit, never its merge base", async () => {
  const checks = [{ name: "ci-required", ok: true, pending: false }];
  const pr = localPullRequest(
    { number: 7, url: "codehost:local/app/change/7", state: "merged", head: SHA("3"), base: SHA("2"), baseRef: SHA("5"), into: "main", branch: "fix", title: "Fix", body: "Fixes it.", merged: SHA("4") },
    checks, ["ci-required"], "2026-11-19T22:45:53Z",
  ).repository.pullRequest;
  assert.equal(pr.baseRefOid, SHA("5"), "the recorded base ref commit is carried as the base commit");
  assert.equal(pr.baseRefName, "main");
  const ev = await prEvidence([{ repo: REPO, number: 7, url: "codehost:local/app/change/7", heads: ["fix"] }], "", depsFor([pr]));
  const fact = ev.facts.find((f) => f.includes("change/7"));
  assert.equal(/base commit ([0-9a-f]{40})/.exec(fact)?.[1], SHA("5"), "the recorded base ref commit is named");
  assert.doesNotMatch(fact, new RegExp(`base commit ${SHA("2")}`), "its merge base is not the base");
  assert.doesNotMatch(fact, new RegExp(`base commit ${SHA("4")}`), "and its merge commit is not passed off as the base");
});

// A change written before the opening base was recorded has only the old `base` ref, which was rewritten on every push: it is not
// read as the base commit, so the fact says nothing is established instead of naming the tip it was last pushed against.
test("a legacy local change, with only a rewritten base ref, establishes no base commit", async () => {
  const checks = [{ name: "ci-required", ok: true, pending: false }];
  const pr = localPullRequest(
    { number: 8, url: "codehost:local/app/change/8", state: "merged", head: SHA("3"), base: SHA("2"), into: "main", branch: "fix", title: "Fix", body: "Fixes it.", merged: SHA("4") },
    checks, ["ci-required"], "2026-11-19T22:45:53Z",
  ).repository.pullRequest;
  const ev = await prEvidence([{ repo: REPO, number: 8, url: "codehost:local/app/change/8", heads: ["fix"] }], "", depsFor([pr]));
  const fact = ev.facts.find((f) => f.includes("change/8"));
  assert.match(fact, /base commit not established/, "nothing is claimed");
  assert.doesNotMatch(fact, /base commit [0-9a-f]/, "and no sha is shown");
});

// --- command facts: CI's own per-suite check, bound to the shard job that ran it ------------------------------------------
const KERNEL_RUN = "node --disable-warning=ExperimentalWarning --test --test-shard=1/2 test/*.test.ts";
const GRADING_RUN = "npm test";
const AREAS = JSON.stringify({ everything: [], markdown: [], suites: [
  { name: "kernel#1", secs: 33, run: KERNEL_RUN, paths: ["kernel"] },
  { name: "modules/grading", secs: 4, job: "modules", run: GRADING_RUN, paths: ["modules/grading"] },
] });
/** A PR head with `checks` on it, `files` changed, and a base the PR claims (the run's own base is the deps' business). */
const withChecks = (n, head, merge, checks, files = ["kernel/src/x.ts"]) => ({
  ...merged(n, head, merge), baseRef: { target: { oid: SHA("e") } },
  files: { pageInfo: { hasNextPage: false }, nodes: files.map((path) => ({ path })) },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: checks } } } }] },
});
/**
 * A check as GitHub gives CI's own: GitHub Actions' App, in the shard run's check suite, linking to a shard job of that run.
 * `external` is `<run>/<job id>/<shard>`; the job link follows it, as GitHub's does.
 */
const PASS = (name, external) => {
  const [run, job] = String(external).split("/");
  return { __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS", externalId: external,
    app: { slug: "github-actions" }, checkSuite: { workflowRun: { databaseId: Number(run) || 0 } },
    detailsUrl: run && job ? `https://github.com/${REPO}/actions/runs/${run}/job/${job}` : null };
};
/**
 * The command facts' reads: `file` answers `areas.json` at a base and `ci.yml` at the head; `job` answers the shard's Actions
 * job (null is the 404 a check with no job behind it gets); `run` answers the workflow run CI made. `bases` names the run's
 * base (the base `file` is read at), never the PR's own moving base. No log read exists at all.
 */
const factDeps = (prs, { areas = AREAS, jobs = {}, runs = {}, base = SHA("d"), baseAreas } = {}) => {
  const head = prs[0].headRefOid;
  return {
    ...depsFor(prs),
    file: async (_repo, path, ref) => path === ".github/ci/areas.json" && ref === head ? areas : path === ".github/ci/areas.json" && ref === base ? baseAreas ?? areas : null,
    job: async (_repo, id) => jobs[id] === null ? null : { id: Number(id), name: "packages (1)", state: "completed", conclusion: "success", run_id: 7, run_attempt: 1, ...(jobs[id] ?? {}) },
    run: async (_repo, id) => runs[id] === null ? null : { id: Number(id), event: "pull_request", head_sha: head, workflow_path: ".github/workflows/ci.yml",
      workflow_state: "active", run_attempt: 1, base_sha: base, ...(runs[id] ?? {}) },
  };
};
const fact = (name, run, dir) => `${name} green on head ${SHA("a")}: ran "${run}" in ${dir}/ — passed`;
const noCommand = (ev) => !ev.facts.some((f) => f.includes('ran "'));

test("a suite's check with its shard job and run behind it mints the fact naming the command and directory", async () => {
  const prs = [withChecks(300, "a", "b", [PASS("kernel#1", "7/111/1"), PASS("modules/grading", "7/112/3")])];
  const ev = await prEvidence([{ repo: REPO, number: 300, url: url(300), heads: ["branch-a"] }], "", factDeps(prs, { jobs: { 112: { name: "modules (3)" } } }));
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
  assert.ok(ev.facts.includes(fact("modules/grading", GRADING_RUN, "modules/grading")), ev.facts.join("\n"));
});

test("a check whose external_id has no job behind it mints nothing", async () => {
  const prs = [withChecks(301, "a", "b", [PASS("kernel#1", "7/114/1")])];
  const ev = await prEvidence([{ repo: REPO, number: 301, url: url(301), heads: ["branch-a"] }], "", factDeps(prs, { jobs: { 114: null } }));
  assert.ok(noCommand(ev), ev.facts.join("\n"));
});

test("a job from another run, or of another shard, is not that check's job", async () => {
  const prs = [withChecks(302, "a", "b", [PASS("kernel#1", "7/118/1")])];
  const otherRun = await prEvidence([{ repo: REPO, number: 302, url: url(302), heads: ["branch-a"] }], "", factDeps(prs, { jobs: { 118: { run_id: 8 } } }));
  assert.ok(noCommand(otherRun), otherRun.facts.join("\n"));
  const otherShard = await prEvidence([{ repo: REPO, number: 302, url: url(302), heads: ["branch-a"] }], "", factDeps(prs, { jobs: { 118: { name: "packages (2)" } } }));
  assert.ok(noCommand(otherShard), otherShard.facts.join("\n"));
});

test("a check whose run is not ci.yml on a pull_request at the graded head mints nothing", async () => {
  const prs = [withChecks(303, "a", "b", [PASS("kernel#1", "7/119/1")])];
  const others = [{ workflow_path: ".github/workflows/other.yml" }, { workflow_state: "disabled_manually" }, { event: "push" }, { head_sha: SHA("f") }, { base_sha: null }];
  for (const fake of others) {
    const ev = await prEvidence([{ repo: REPO, number: 303, url: url(303), heads: ["branch-a"] }], "", factDeps(prs, { runs: { 7: fake } }));
    assert.ok(noCommand(ev), JSON.stringify(fake));
  }
});

test("a PR that edits the workflows, the map or the suite runner mints nothing", async () => {
  for (const edited of [".github/ci/areas.json", ".github/ci/select.ts", ".github/ci/run-suites.sh", ".github/workflows/ci.yml", ".github/workflows/other.yml"]) {
    const prs = [withChecks(304, "a", "b", [PASS("kernel#1", "7/120/1")], ["kernel/src/x.ts", edited])];
    const ev = await prEvidence([{ repo: REPO, number: 304, url: url(304), heads: ["branch-a"] }], "", factDeps(prs));
    assert.ok(noCommand(ev), edited);
  }
  // What CI does not run from: a template or a policy file beside them changes nothing about which suite ran.
  const prs = [withChecks(304, "a", "b", [PASS("kernel#1", "7/120/1")], ["kernel/src/x.ts", ".github/CODEOWNERS"])];
  const ev = await prEvidence([{ repo: REPO, number: 304, url: url(304), heads: ["branch-a"] }], "", factDeps(prs));
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
});

test("a base map that differs from the head's (main moved, or a PR edit) mints nothing", async () => {
  // CI reads the map from the base; the fact names the command at the base. If the head's map is not the same bytes, the base
  // describes a tree the graded head did not run, so no fact — never a command only the base carries.
  const prs = [withChecks(310, "a", "b", [PASS("kernel#1", "7/126/1")])];
  const moved = JSON.stringify({ everything: [], markdown: [], suites: [{ name: "kernel#1", secs: 33, run: "npm test", paths: ["kernel"] }] });
  const ev = await prEvidence([{ repo: REPO, number: 310, url: url(310), heads: ["branch-a"] }], "", factDeps(prs, { baseAreas: moved }));
  assert.ok(noCommand(ev), ev.facts.join("\n"));
});

test("an unreadable map, a truncated list, or a suite the map does not name mints nothing", async () => {
  const prs = [withChecks(305, "a", "b", [PASS("kernel#1", "7/121/1")])];
  const at = (deps) => prEvidence([{ repo: REPO, number: 305, url: url(305), heads: ["branch-a"] }], "", deps);
  assert.ok(noCommand(await at(factDeps(prs, { areas: "{not json" }))), "an unreadable map");
  assert.ok(noCommand(await at(factDeps(prs, { areas: JSON.stringify({ everything: [], markdown: [], suites: [] }) }))), "a suite the map doesn't name");
  const cutChecks = [withChecks(305, "a", "b", [PASS("kernel#1", "7/121/1")])];
  cutChecks[0].commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo = { hasNextPage: true };
  assert.ok(noCommand(await at(factDeps(cutChecks))), "a cut check list");
  const cutFiles = [withChecks(305, "a", "b", [PASS("kernel#1", "7/121/1")])];
  cutFiles[0].files.pageInfo = { hasNextPage: true };
  assert.ok(noCommand(await at(factDeps(cutFiles))), "a cut file list");
});

test("a merged PR's run, whose pull_requests list GitHub dropped, takes the base from the PR itself", async () => {
  // GitHub empties a run's `pull_requests` once the PR merges: the run answers no base, and the PR's own base oid is what CI
  // read the map from. The fact still mints, and names the same command.
  const prs = [withChecks(308, "a", "b", [PASS("kernel#1", "7/124/1")])];
  prs[0].baseRef = { target: { oid: SHA("c") } };
  const ev = await prEvidence([{ repo: REPO, number: 308, url: url(308), heads: ["branch-a"] }], "", factDeps(prs, { runs: { 7: { base_sha: null } }, base: SHA("c") }));
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
  // Neither one readable: no base, no fact.
  const none = [withChecks(308, "a", "b", [PASS("kernel#1", "7/124/1")])];
  none[0].baseRef = { target: { oid: "" } };
  assert.ok(noCommand(await prEvidence([{ repo: REPO, number: 308, url: url(308), heads: ["branch-a"] }], "", factDeps(none, { runs: { 7: { base_sha: null } } }))));
});

test("an external_id that isn't CI's <run>/<job>/<shard> mints nothing", async () => {
  for (const external of ["", "7/122", "7/122/1/2", "7/x/1", "abc/122/1"]) {
    const prs = [withChecks(306, "a", "b", [PASS("kernel#1", external)])];
    const ev = await prEvidence([{ repo: REPO, number: 306, url: url(306), heads: ["branch-a"] }], "", factDeps(prs));
    assert.ok(noCommand(ev), external);
  }
});

test("no job log is read at all: the fact comes from CI's per-suite check and the shard job behind it", async () => {
  const prs = [withChecks(307, "a", "b", [PASS("kernel#1", "7/123/1")])];
  const deps = factDeps(prs);
  assert.equal("jobLog" in deps, false, "the log is gone from grading's dependencies");
  assert.equal("log" in deps, false);
  const ev = await prEvidence([{ repo: REPO, number: 307, url: url(307), heads: ["branch-a"] }], "", deps);
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
});

test("one shard's job and run are read once however many suites its check names", async () => {
  // A shard carries several suites and CI posts one check per suite, all with the same `<run>/<job id>/<shard>`: the same
  // Actions record answers for each, so the reads are memoized, never a second fetch that could disagree.
  const prs = [withChecks(309, "a", "b", [PASS("kernel#1", "7/131/1"), PASS("kernel#2", "7/131/1"), PASS("scripts#1", "7/131/1")])];
  const deps = factDeps(prs);
  let jobReads = 0, runReads = 0;
  const job = deps.job, run = deps.run;
  deps.job = (repo, id) => (jobReads++, job(repo, id));
  deps.run = (repo, id) => (runReads++, run(repo, id));
  const ev = await prEvidence([{ repo: REPO, number: 309, url: url(309), heads: ["branch-a"] }], "", deps);
  assert.equal(jobReads, 1, "one job read for one shard");
  assert.equal(runReads, 1, "one run read for one run");
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
});

test("a job or run read that throws is no answer, not a failed grade", async () => {
  const prs = [withChecks(312, "a", "b", [PASS("kernel#1", "7/141/1"), PASS("modules/grading", "7/142/1")])];
  const deps = factDeps(prs, { jobs: { 142: { name: "modules (1)" } } });
  deps.job = async (_repo, id) => { if (String(id) === "141") throw new Error("GitHub said 502"); return { id: Number(id), name: "modules (1)", state: "completed", conclusion: "success", run_id: 7, run_attempt: 1 }; };
  const ev = await prEvidence([{ repo: REPO, number: 312, url: url(312), heads: ["branch-a"] }], "", deps);
  assert.ok(!ev.facts.some((f) => f.startsWith("kernel#1 green on head")), ev.facts.join("\n"));
  assert.ok(ev.facts.includes(fact("modules/grading", GRADING_RUN, "modules/grading")), ev.facts.join("\n"));
});

test("a check that only claims a job's id mints nothing: it must be GitHub's own for that job", async () => {
  // A check posted through the API can repeat a green job's `external_id` verbatim. What it cannot have is GitHub Actions'
  // App, a check suite whose `workflow_run` is that run, and that run's job link — so each of those alone is enough to
  // refuse it, and the job read behind the id is then never even the question.
  const forged = (extra) => ({ ...PASS("kernel#1", "7/150/1"), ...extra });
  const cases = [
    ["another App", forged({ app: { slug: "aidenhq" } }), "posted by something other than GitHub Actions"],
    ["no App at all", forged({ app: null }), "a check with no App"],
    ["its own check suite", forged({ checkSuite: { workflowRun: { databaseId: 99 } } }), "a check suite whose run is another run"],
    ["no check suite", forged({ checkSuite: null }), "a check in no check suite"],
    ["a URL of its own", forged({ detailsUrl: "https://example.com/actions/runs/7/job/150" }), "a URL that is not this run's job"],
    ["another job's URL", forged({ detailsUrl: `https://github.com/${REPO}/actions/runs/7/job/151` }), "a link to another job"],
    ["another repo's URL", forged({ detailsUrl: `https://github.com/acme-agents/other/actions/runs/7/job/150` }), "a link into another repository"],
    ["no URL", forged({ detailsUrl: null }), "no link at all"],
  ];
  for (const [what, check, why] of cases) {
    const prs = [withChecks(313, "a", "b", [check])];
    const ev = await prEvidence([{ repo: REPO, number: 313, url: url(313), heads: ["branch-a"] }], "", factDeps(prs));
    assert.ok(!ev.facts.some((f) => f.startsWith("kernel#1 green on head")), `${what}: ${why}`);
  }
  // The same check with all of them right is the one that mints: the refusal is the binding, not a blanket distrust.
  const prs = [withChecks(313, "a", "b", [PASS("kernel#1", "7/150/1")])];
  const ev = await prEvidence([{ repo: REPO, number: 313, url: url(313), heads: ["branch-a"] }], "", factDeps(prs));
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
});
