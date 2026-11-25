// A `pr` task's deliverable is never the PR its brief ordered closed: a closed-unmerged PR is an evidence wait (the row holds,
// it does not issue a revision request against a branch that can no longer change), and when the task's own records name a
// merged PR in the same repo beside the superseded branch, the merged PR is the one graded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseCommitOf, localPullRequest, prEvidence, presentNow } from "../service/src/grader/evidence.ts";

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

test("a merge-records read that failed is an unreadable deliverable, never 'the task has no PR'", async () => {
  // No branch row names a PR, so the runner's own records are the only way to the merge. When that read fails, the answer is
  // "could not be read": reading it as absent would let a versionless close land done/ungraded with the merge ungraded.
  const down = await presentNow({ kind: "pr", ref: "" }, { taskPrs: async () => [], taskMerged: async () => { throw new Error("kernel GET /v1/merges → 502"); }, pr: async () => ({}) });
  assert.deepEqual([down.present, down.unknown], [false, true], "a failed records read is unknown, not an absence");
  assert.match(down.facts.join("; "), /merge records for this task could not be read just now/);
  // With the records readable, the same call finds the PR they name and holds it open (not merged yet) rather than absent.
  const open = merged(224, "b", "c");
  Object.assign(open, { state: "OPEN", mergedAt: null, mergeCommit: null });
  const there = await presentNow({ kind: "pr", ref: "" }, { taskPrs: async () => [], taskMerged: async () => [{ repo: REPO, number: 224, url: url(224), headRef: "branch-b" }], pr: async () => ({ repository: { pullRequest: open } }) });
  assert.deepEqual([there.present, there.unknown], [false, false], "a readable record naming an open PR is a known answer");
  assert.match(there.facts.join("; "), /open, not merged yet/);
});

test("a failed merge-records read in prEvidence is an evidence wait, never 'no pull request yet'", async () => {
  // "no pull request yet" is a missing deliverable (it closes the task after MISSING_WAIT_MS). A 502 on the records that are
  // the only route to the merge is unavailable evidence: the row waits, and nothing is closed on it.
  const ev = await prEvidence([], "", { ...depsFor([]), taskMerged: async () => { throw new Error("kernel GET /v1/merges → 502"); } });
  assert.match(ev.awaiting, /merge records for this task could not be read just now/);
  assert.equal(ev.missing, undefined, "an unreadable record is not 'no pull request yet'");
  assert.equal(ev.version, undefined);
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
 * A check as CI's own `post-checks` makes it: GitHub Actions' App, completed `success`, `external` `<run>/<job id>/<shard>`.
 * It carries no job link and sits in an unrelated check suite, exactly as real posted checks do (see the docblock in
 * evidence.ts); the job record and the `post-checks` job are what the fact binds to.
 */
const PASS = (name, external) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS", externalId: external, checkSuite: { app: { slug: "github-actions" } } });
/**
 * The command facts' reads: `file` answers `areas.json` at a base, `ci.yml` at the head and its base, and the map; `job`
 * answers the shard's Actions job (null is the 404 a check with no job behind it gets); `run` answers the workflow run CI
 * made; `exists` answers whether a suite's directory is a directory at the head. `base` names the run's base (the base `file`
 * is read at), never the PR's own moving base. No log read exists at all.
 */
const factDeps = (prs, { areas = AREAS, jobs = {}, runs = {}, base = SHA("d"), baseAreas, headWorkflow = "name: ci\n", baseWorkflow, dirs, commits = {} } = {}) => {
  const head = prs[0].headRefOid;
  const here = dirs ?? ["kernel", "modules/grading", "scripts"];
  return {
    ...depsFor(prs),
    commit: async (_repo, ref) => commits[ref] === null ? null : { sha: ref, parents: [base], ...(commits[ref] ?? {}) },
    file: async (_repo, path, ref) => path === ".github/ci/areas.json" ? (ref === head ? areas : ref === base ? baseAreas ?? areas : null)
      : path === ".github/workflows/ci.yml" ? (ref === head ? headWorkflow : ref === base ? baseWorkflow ?? headWorkflow : null) : null,
    exists: async (_repo, path, ref) => ref === head && here.includes(path),
    job: async (_repo, id) => jobs[id] === null ? null : { id: Number(id), name: "packages (1)", state: "completed", conclusion: "success", run_id: 7, run_attempt: 1, ...(jobs[id] ?? {}) },
    run: async (_repo, id) => runs[id] === null ? null : { id: Number(id), event: "pull_request", head_sha: head, workflow_path: ".github/workflows/ci.yml",
      workflow_state: "active", run_attempt: 1, base_sha: base, post_checks: [{ run_attempt: 1, state: "completed", conclusion: "success" }],
      // The run's shard jobs, latest instance per name (`filter=latest`): the job each passing check must be, so a pass a re-run
      // replaced cannot mint. Built from the checks' own `<run>/<job id>/<shard>`, through the same `jobs` records the job read
      // answers, so the two cannot disagree; a test overrides it to stand in for a shard that was re-run.
      latest_shard_jobs: Object.fromEntries((prs[0].commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).flatMap((c) => {
        const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(String(c?.externalId ?? ""));
        if (!m || jobs[m[2]] === null) return [];
        const job = { id: Number(m[2]), name: "packages (1)", state: "completed", conclusion: "success", run_attempt: 1, ...(jobs[m[2]] ?? {}) };
        return [[job.name, { id: job.id, run_attempt: job.run_attempt, state: job.state, conclusion: job.conclusion }]];
      })), ...(runs[id] ?? {}) },
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

test("a shard that passed and was then re-run and failed mints nothing: the old passing check is superseded", async () => {
  // Attempt 1's `packages (1)` passed and post-checks published kernel#1's check naming job 111. Then the shard was re-run as
  // attempt 2 and failed. post-checks never deletes the old check, so it is still a completed success on the head — but the
  // run's latest `packages (1)` is now job 121, which did not pass, so nothing is a fact.
  const prs = [withChecks(320, "a", "b", [PASS("kernel#1", "7/111/1")])];
  const rerun = await prEvidence([{ repo: REPO, number: 320, url: url(320), heads: ["branch-a"] }], "", factDeps(prs, {
    runs: { 7: { run_attempt: 2, post_checks: [{ run_attempt: 2, state: "completed", conclusion: "success" }],
      latest_shard_jobs: { "packages (1)": { id: 121, run_attempt: 2, state: "completed", conclusion: "failure" } } } },
  }));
  assert.ok(noCommand(rerun), rerun.facts.join("\n"));
  // The same holds when the re-run is still going: an unfinished latest instance is no pass either.
  const running = await prEvidence([{ repo: REPO, number: 320, url: url(320), heads: ["branch-a"] }], "", factDeps(prs, {
    runs: { 7: { latest_shard_jobs: { "packages (1)": { id: 121, run_attempt: 2, state: "in_progress", conclusion: null } } } },
  }));
  assert.ok(noCommand(running), running.facts.join("\n"));
});

test("a shard whose latest instance is the check's own job still mints, even after another shard was re-run", async () => {
  // `filter=latest` answers one instance per job name: re-running `packages (2)` does not replace `packages (1)`. A suite check
  // naming packages (1)'s only job is that shard's current record, so it still counts.
  const prs = [withChecks(321, "a", "b", [PASS("kernel#1", "7/131/1")])];
  const ev = await prEvidence([{ repo: REPO, number: 321, url: url(321), heads: ["branch-a"] }], "", factDeps(prs, {
    runs: { 7: { run_attempt: 2, post_checks: [{ run_attempt: 2, state: "completed", conclusion: "success" }],
      latest_shard_jobs: { "packages (1)": { id: 131, run_attempt: 1, state: "completed", conclusion: "success" },
        "packages (2)": { id: 132, run_attempt: 2, state: "completed", conclusion: "failure" } } } },
  }));
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
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
  const others = [{ workflow_path: ".github/workflows/other.yml" }, { workflow_state: "disabled_manually" }, { event: "push" }, { head_sha: SHA("f") }];
  for (const fake of others) {
    const ev = await prEvidence([{ repo: REPO, number: 303, url: url(303), heads: ["branch-a"] }], "", factDeps(prs, { runs: { 7: fake } }));
    assert.ok(noCommand(ev), JSON.stringify(fake));
  }
});

test("a PR that edits the workflows, the map or the suite runner mints nothing", async () => {
  // `.ci-base/` is gitignored, but a PR can force-add a file there (`git add -f`), and GitHub lists it in the PR's files: the
  // runner CI executes lives at that path, so a PR shipping one mints nothing.
  for (const edited of [".github/ci/areas.json", ".github/ci/select.ts", ".github/ci/run-suites.sh", ".github/workflows/ci.yml", ".github/workflows/other.yml", ".ci-base/.github/ci/run-suites.sh"]) {
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
  // CI's select.ts reads the map from the tree it tests (the PR's merge commit), which carries the base's map exactly when the PR
  // did not edit it. The fact names the command at the base and requires that map to be the head's own bytes: a base that differs
  // is a tree the graded head did not run, so no fact — never a command only the base carries.
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

test("the PR's current base is never a stand-in: the run's own base, or the merge commit's first parent, is", async () => {
  // GitHub empties a run's `pull_requests` once the PR merges, so a merged run answers no base. The PR's `baseRef` is where its
  // base branch points *now* and main has moved since the run, so a map read there is another commit's map: it mints nothing.
  // The merge commit's first parent is where the merge was made, which is what the run read, and is used in its place.
  const tip = SHA("f");
  const prs = [withChecks(308, "a", "b", [PASS("kernel#1", "7/124/1")])];
  prs[0].baseRef = { target: { oid: tip } };
  const noCommit = await prEvidence([{ repo: REPO, number: 308, url: url(308), heads: ["branch-a"] }], "",
    factDeps(prs, { runs: { 7: { base_sha: null } }, commits: { [SHA("b")]: null } }));
  assert.ok(noCommand(noCommit), noCommit.facts.join("\n"));
  // A base that is not a full sha is no answer either, and with no readable merge commit behind it nothing is minted.
  const bad = [withChecks(308, "a", "b", [PASS("kernel#1", "7/124/1")])];
  assert.ok(noCommand(await prEvidence([{ repo: REPO, number: 308, url: url(308), heads: ["branch-a"] }], "",
    factDeps(bad, { runs: { 7: { base_sha: "main" } }, commits: { [SHA("b")]: { parents: [] } } }))));
  // The run's own recorded base is what mints, even when the PR's current tip is something else entirely.
  const ok = [withChecks(308, "a", "b", [PASS("kernel#1", "7/124/1")])];
  ok[0].baseRef = { target: { oid: tip } };
  const good = await prEvidence([{ repo: REPO, number: 308, url: url(308), heads: ["branch-a"] }], "", factDeps(ok, { base: SHA("d") }));
  assert.ok(good.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), good.facts.join("\n"));
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

test("a suite whose directory is gone at the graded head mints nothing: a green job that ran nothing is not a pass", async () => {
  const prs = [withChecks(320, "a", "b", [PASS("kernel#1", "7/171/1"), PASS("modules/grading", "7/172/3")])];
  // `kernel` is absent at the head (a deleted directory: `run-suites.sh` writes `gone:` and exits 0); `modules/grading` is there.
  const ev = await prEvidence([{ repo: REPO, number: 320, url: url(320), heads: ["branch-a"] }], "", factDeps(prs, { dirs: ["modules/grading", "scripts"], jobs: { 172: { name: "modules (3)" } } }));
  assert.ok(!ev.facts.some((f) => f.startsWith("kernel#1 green on head")), "a deleted directory cannot pass its suite");
  assert.ok(ev.facts.includes(fact("modules/grading", GRADING_RUN, "modules/grading")), ev.facts.join("\n"));
  // An exists read that fails mints nothing at all: no answer is never a pass.
  const deps = factDeps(prs);
  deps.exists = async () => { throw new Error("GitHub said 502"); };
  const bad = await prEvidence([{ repo: REPO, number: 320, url: url(320), heads: ["branch-a"] }], "", deps);
  assert.ok(noCommand(bad), bad.facts.join("\n"));
});

test("a head whose ci.yml differs from the run's base mints nothing: that CI was not the repository's", async () => {
  const prs = [withChecks(321, "a", "b", [PASS("kernel#1", "7/181/1")])];
  const ev = await prEvidence([{ repo: REPO, number: 321, url: url(321), heads: ["branch-a"] }], "",
    factDeps(prs, { headWorkflow: "name: ci\njobs: { test: { runs-on: ubuntu-latest } }\n", baseWorkflow: "name: ci\n" }));
  assert.ok(noCommand(ev), ev.facts.join("\n"));
  // Byte-identical at both ends is the one that mints. Same map, same workflow.
  const ok = await prEvidence([{ repo: REPO, number: 321, url: url(321), heads: ["branch-a"] }], "", factDeps(prs));
  assert.ok(ok.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ok.facts.join("\n"));
  // An unreadable ci.yml at the head mints nothing either.
  const unreadable = factDeps(prs);
  unreadable.file = async (_repo, path) => (path === ".github/workflows/ci.yml" ? null : AREAS);
  assert.ok(noCommand(await prEvidence([{ repo: REPO, number: 321, url: url(321), heads: ["branch-a"] }], "", unreadable)));
});

test("a check that only claims a job's id mints nothing: a real job, run and poster must stand behind it", async () => {
  // A check posted through the API can repeat a green job's `external_id` verbatim. What it cannot produce is the shard job
  // record, the repository's own CI run on the head, and the `post-checks` job that ran in the shard's own attempt.
  const forged = (extra) => ({ ...PASS("kernel#1", "7/150/1"), ...extra });
  const cases: [string, any, any, string][] = [
    ["another App", forged({ checkSuite: { app: { slug: "aidenhq" } } }), {}, "posted by something other than GitHub Actions"],
    ["no App at all", forged({ checkSuite: null }), {}, "a check with no App"],
    ["no job behind its id", PASS("kernel#1", "7/150/1"), { jobs: { 150: null } }, "a job GitHub has no record of"],
    ["a job of another run", PASS("kernel#1", "7/151/1"), { jobs: { 151: { run_id: 8 } } }, "a job in a different run"],
    ["a job whose shard disagrees", PASS("kernel#1", "7/152/1"), { jobs: { 152: { name: "packages (2)" } } }, "a job for another shard"],
    ["a red job", PASS("kernel#1", "7/153/1"), { jobs: { 153: { conclusion: "failure" } } }, "a job that did not pass"],
    ["another workflow", PASS("kernel#1", "7/154/1"), { runs: { 7: { workflow_path: ".github/workflows/community.yml" } } }, "a run of another workflow"],
    ["another event", PASS("kernel#1", "7/155/1"), { runs: { 7: { event: "push" } } }, "a push run, which posts no suite checks"],
    ["another head", PASS("kernel#1", "7/156/1"), { runs: { 7: { head_sha: SHA("f") } } }, "a run of a different head"],
    ["no poster", PASS("kernel#1", "7/157/1"), { runs: { 7: { post_checks: [] } } }, "a run with no post-checks job"],
    ["a red poster", PASS("kernel#1", "7/158/1"), { runs: { 7: { post_checks: [{ run_attempt: 1, state: "completed", conclusion: "failure" }] } } }, "a post-checks job that did not pass"],
    ["a poster from before the shard", PASS("kernel#1", "7/159/1"), { runs: { 7: { post_checks: [{ run_attempt: 0, state: "completed", conclusion: "success" }] } } }, "a poster that ran before the shard did"],
  ];
  for (const [what, check, opts, why] of cases) {
    const prs = [withChecks(313, "a", "b", [check])];
    const ev = await prEvidence([{ repo: REPO, number: 313, url: url(313), heads: ["branch-a"] }], "", factDeps(prs, opts));
    assert.ok(!ev.facts.some((f) => f.startsWith("kernel#1 green on head")), `${what}: ${why}`);
  }
  // The same check with all of them right is the one that mints: the refusal is the binding, not a blanket distrust.
  const prs = [withChecks(313, "a", "b", [PASS("kernel#1", "7/150/1")])];
  const ev = await prEvidence([{ repo: REPO, number: 313, url: url(313), heads: ["branch-a"] }], "", factDeps(prs));
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
});

test("a failed-job re-run keeps the earlier passing shard, and the later poster still mints: the poster may not predate it", async () => {
  // Attempt 2 re-ran the failed job; the shard's own passing job is attempt 1, and `post-checks` ran again in attempt 2.
  const prs = [withChecks(330, "a", "b", [PASS("kernel#1", "7/160/1")])];
  const ev = await prEvidence([{ repo: REPO, number: 330, url: url(330), heads: ["branch-a"] }], "",
    factDeps(prs, { runs: { 7: { post_checks: [{ run_attempt: 2, state: "completed", conclusion: "success" }] } } }));
  assert.ok(ev.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), ev.facts.join("\n"));
});

test("a merged PR's run records no base, so the merge commit's first parent is the base graded: never the PR's current tip", async () => {
  // GitHub drops `pull_requests` on merge, which is the head a merged task is graded on. The merge commit's first parent is the
  // tree the merge was made on; the PR's `baseRef` is where main points now. Only the former can name the map CI read.
  const tip = SHA("f");
  const prs = [withChecks(331, "a", "b", [PASS("kernel#1", "7/161/1")])];
  prs[0].baseRef = { target: { oid: tip } };
  const merged1 = await prEvidence([{ repo: REPO, number: 331, url: url(331), heads: ["branch-a"] }], "",
    factDeps(prs, { runs: { 7: { base_sha: null } }, base: SHA("d") }));
  assert.ok(merged1.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), merged1.facts.join("\n"));
  // A commit GitHub cannot read, or one with no parent, is no base: nothing is minted.
  const unreadable = await prEvidence([{ repo: REPO, number: 331, url: url(331), heads: ["branch-a"] }], "",
    factDeps(prs, { runs: { 7: { base_sha: null } }, commits: { [SHA("b")]: null } }));
  assert.ok(noCommand(unreadable), unreadable.facts.join("\n"));
  const parentless = await prEvidence([{ repo: REPO, number: 331, url: url(331), heads: ["branch-a"] }], "",
    factDeps(prs, { runs: { 7: { base_sha: null } }, commits: { [SHA("b")]: { parents: [] } } }));
  assert.ok(noCommand(parentless), parentless.facts.join("\n"));
  // The first parent is the base; a second parent is the PR's own head and is never used.
  const second = await prEvidence([{ repo: REPO, number: 331, url: url(331), heads: ["branch-a"] }], "",
    factDeps(prs, { runs: { 7: { base_sha: null } }, commits: { [SHA("b")]: { parents: [SHA("d"), SHA("a")] } } }));
  assert.ok(second.facts.includes(fact("kernel#1", KERNEL_RUN, "kernel")), second.facts.join("\n"));
});

test("the module's evidence grant lists every path the fact reads: the code and the grant can't drift apart", async () => {
  // The tests pass with a stubbed `file`, so a grant that omits a path the code reads is invisible to them and fatal in
  // production: the kernel refuses an unlisted `file` path and the fact silently mints nothing. Read the module's own
  // manifest and require both files, exactly as the code names them.
  const { readFileSync } = await import("node:fs");
  const manifest = readFileSync(new URL("../module.yaml", import.meta.url), "utf8");
  const listed = (/^\s+paths:\s*\[([^\]]*)\]/m.exec(manifest)?.[1] ?? "").split(",").map((p) => p.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const src = readFileSync(new URL("../service/src/grader/evidence.ts", import.meta.url), "utf8");
  const read = [...src.matchAll(/const (CI_WORKFLOW|CI_AREAS) = "([^"]+)";/g)].map((m) => m[2]);
  assert.deepEqual([...read].sort(), [".github/ci/areas.json", ".github/workflows/ci.yml"]);
  for (const path of read) assert.ok(listed.includes(path!), `the evidence grant does not list ${path}, so that read is refused`);
  assert.ok(listed.every((p) => !p.endsWith("/") && !p.includes("*")), "the grant names files exactly, never a directory or a prefix");
});

// GitHub answering "no such repository" or "no such PR" is an answer, unlike a read that threw: a PR that cannot reappear must
// not keep a close waiting, while a failed read still must. Both are exercised through `presentNow`, which is what the close's
// staleness check and escalationFor consult.
test("a presence lookup GitHub answers as gone is a fact, never an unreadable wait", async () => {
  const rows = [{ repo: REPO, number: 224, url: url(224) }];
  const gone = (answer: any) => presentNow({ kind: "pr", ref: "" }, { taskPrs: async () => rows, pr: async () => answer });
  // The repository node is null: GitHub answered, and there is no PR to wait for.
  const noRepo = await gone({ repository: null });
  assert.deepEqual([noRepo.present, noRepo.unknown], [false, false], "a null repository is an answer, not a wait");
  assert.match(noRepo.facts.join("; "), new RegExp(`${url(224)} no longer exists`));
  // An explicit `pullRequest: null` beside the repository node is the same answer.
  const noPr = await gone({ repository: { defaultBranchRef: { name: "main" }, pullRequest: null } });
  assert.deepEqual([noPr.present, noPr.unknown], [false, false], "an explicit null PR is a definitive absence");
  assert.match(noPr.facts.join("; "), /no longer exists/);
  // A field that is simply missing is not that answer: the read did not say what the PR is, so it is unknown and waits.
  const omitted = await gone({ repository: { defaultBranchRef: { name: "main" } } });
  assert.deepEqual([omitted.present, omitted.unknown], [false, true], "an omitted PR field is not a definitive absence");
  assert.match(omitted.facts.join("; "), /could not be read just now/);
  // A read that threw is unknown too.
  const threw = await presentNow({ kind: "pr", ref: "" }, { taskPrs: async () => rows, pr: async () => { throw new Error("GitHub answered 502"); } });
  assert.deepEqual([threw.present, threw.unknown], [false, true], "a failed read is unknown, never 'gone'");
});

// A deploy history the app read could not complete is not proof that a healthy deploy is absent: the fact must say it is
// unknown, because the close can quote that fact to the owner as its reason.
test("an unreadable deploy history is reported as unknown, never as 'no healthy deploy'", async () => {
  const mergedPr = merged(701, "a", "b");
  const base = {
    taskPrs: async () => [{ repo: REPO, number: 701, url: url(701), heads: ["branch-a"] }],
    pr: async () => ({ repository: { pullRequest: mergedPr } }),
    appOfRepo: async () => ({ name: "roadmap-keeper", deploys: [] }),
  };
  // The history read failed (`deployHistory` threw): deploysOf falls back to the status row's recent entries and says the
  // history is incomplete. The status row has no entry for this merge commit, which proves nothing.
  const incomplete = await presentNow({ kind: "pr", ref: "" }, { ...base, deployHistory: async () => { throw new Error("apps-mcp GET /internal/deploys → 504"); } });
  const fact = incomplete.facts.find((f) => f.startsWith("app roadmap-keeper:"));
  assert.ok(fact, "the app's deploy fact is present");
  assert.match(fact, /deploy history could not be read just now/);
  assert.match(fact, /is unknown/);
  assert.doesNotMatch(fact, /no healthy deploy/, "a lookup failure is never reported as a missing deploy");
  // The same read answering with the complete history still says what it found: no healthy deploy is a real answer then.
  const complete = await presentNow({ kind: "pr", ref: "" }, { ...base, deployHistory: async () => [] });
  const said = complete.facts.find((f) => f.startsWith("app roadmap-keeper:"));
  assert.match(String(said), /no healthy deploy/, "a complete history with no healthy row is a real miss");
});

// The runner's own merge record fills in the identifier a branch row may lack. When that read fails, a row whose own identifiers
// prove nothing is an unreadable answer, never "this number is not the task's change": a retry may confirm the PR.
test("an unreadable identity record is unknown, not proof the PR is not the task's", async () => {
  // The branch row names the PR by number only: no branch, head commit or merge commit to tell it by.
  const bare = [{ repo: REPO, number: 224, url: url(224) }];
  const mergedPr = merged(224, "b", "c");
  const record = { repo: REPO, number: 224, url: url(224), headRef: "branch-b", merge: SHA("c") };
  const deps = (taskMerged: any) => ({
    taskPrs: async () => bare, pr: async () => ({ repository: { pullRequest: mergedPr } }), taskMerged,
    appOfRepo: async () => null,
  });
  // The record read failed: the row alone can't establish identity, so the close waits rather than closing on the silence.
  const unread = await presentNow({ kind: "pr", ref: "" }, deps(async () => { throw new Error("kernel GET /v1/merges → 502"); }));
  assert.deepEqual([unread.present, unread.unknown], [false, true], "a failed records read is unknown");
  assert.match(unread.facts.join("; "), /could not be read just now/);
  assert.doesNotMatch(unread.facts.join("; "), /keeps no branch, head commit or merge commit/, "never worded as an unverifiable number");
  // The same read answering, with no row for this PR, is a real answer: the number proves nothing and is not read as the change.
  const nothing = await presentNow({ kind: "pr", ref: "" }, deps(async () => []));
  assert.deepEqual([nothing.present, nothing.unknown], [false, false], "a readable record with no row is a known answer");
  assert.match(nothing.facts.join("; "), /keeps no branch, head commit or merge commit/);
  // With the record, the identifiers are there and the merged PR is the deliverable.
  const found = await presentNow({ kind: "pr", ref: "" }, deps(async () => [record]));
  assert.deepEqual([found.present, found.unknown], [true, false], "the record's identifiers establish the PR");
  // A row that carries its own identifiers needs no record: a failed read still leaves a definitive answer, no wait.
  const own = await presentNow({ kind: "pr", ref: "" }, {
    taskPrs: async () => [{ ...bare[0], headRef: "branch-b" }], pr: async () => ({ repository: { pullRequest: mergedPr } }),
    taskMerged: async () => { throw new Error("502"); }, appOfRepo: async () => null,
  });
  assert.deepEqual([own.present, own.unknown], [true, false], "the row's own branch identifies it without the record");
});

test("a rubric that names a merged PR another task opened is graded on that PR, with no record of the task's own", async () => {
  const prs = [merged(1301, "d", "e")];
  const deps = depsFor(prs, { taskMerged: [] });
  const ev = await prEvidence([], url(1301), deps);
  assert.equal(ev.awaiting, undefined);
  assert.match(ev.version, /#1301@/);
  assert.deepEqual(ev.prs.map((p) => p.number), [1301]);
  assert.ok(ev.facts.some((f) => f.startsWith(`${url(1301)}: merged`) && f.includes("named by the deliverable's own ref")));
  const open = Object.assign(merged(1302, "f", "g"), { state: "OPEN", mergedAt: null, mergeCommit: null });
  assert.equal((await prEvidence([], url(1302), depsFor([open]))).awaiting, `${url(1302)} is not merged yet`);
  const now = await presentNow({ kind: "pr", ref: url(1301) }, { taskPrs: async () => [], taskMerged: async () => [], pr: deps.pr });
  assert.equal(now.present, true);
});

test("a named PR the task's own merge record holds keeps its identity check; a named PR that does not exist is missing", async () => {
  const replaced = merged(1301, "d", "e");
  const stale = await prEvidence([], url(1301), depsFor([replaced], { taskMerged: [{ repo: REPO, number: 1301, url: url(1301), sha: SHA("9") }] }));
  assert.match(stale.awaiting, /now names a different change/);
  const gone = await prEvidence([], url(1399), { ...depsFor([]), pr: async () => ({ repository: { pullRequest: null } }), taskMerged: async () => [] });
  assert.equal(gone.missing, true);
});

test("a ref naming several PRs is delivered by the merged one: an absent or open sibling neither marks it missing nor waits", async () => {
  const open = Object.assign(merged(1401, "a", "b"), { state: "OPEN", mergedAt: null, mergeCommit: null });
  const deps = { ...depsFor([open, merged(1402, "c", "d")], { taskMerged: [] }), pr: async (_r, n) => (n === 1400 ? { repository: { pullRequest: null } } : { repository: { pullRequest: [open, merged(1402, "c", "d")].find((p) => p.number === n) } }) };
  const ev = await prEvidence([], `replaces ${REPO}#1400 and ${REPO}#1401, delivered in ${REPO}#1402`, deps);
  assert.deepEqual(ev.prs.map((p) => p.number), [1402]);
});

test("a PR ref written owner/repo/pull/N names the same PR the filing accepts", async () => {
  const ev = await prEvidence([], `${REPO}/pull/1301`, depsFor([merged(1301, "d", "e")], { taskMerged: [] }));
  assert.deepEqual(ev.prs.map((p) => p.number), [1301]);
});

// --- code review's status: left out of the named checks, stated as its own fact so a rubric that names `aidenhq/review` reads it
/** A merged PR whose head carries `ci-required` plus code review's commit status in `state` (or none when `state` is null). */
const reviewed = (n, head, merge, state) => {
  const nodes = [{ __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "SUCCESS" }];
  if (state) nodes.push({ __typename: "StatusContext", context: "aidenhq/review", state });
  return { ...merged(n, head, merge), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] } };
};

test("a graded PR's facts name code review's aidenhq/review status green on the head", async () => {
  const prs = [reviewed(1501, "a", "b", "SUCCESS")];
  const ev = await prEvidence([{ repo: REPO, number: 1501, url: url(1501), heads: ["branch-a"] }], "", depsFor(prs));
  assert.ok(ev.facts.includes(`${url(1501)}: code review's aidenhq/review status on head ${SHA("a")}: green`), ev.facts.join("\n"));
  const line = ev.facts.find((f) => f.startsWith(`${url(1501)}: merged`));
  assert.match(line, /checks: ci-required green/, "the named checks line is unchanged");
  assert.doesNotMatch(line, /aidenhq\/review/, "the status is a fact of its own, not folded into the named checks");
});

test("a head whose aidenhq/review status failed is stated as not green", async () => {
  const prs = [reviewed(1502, "c", "d", "FAILURE")];
  const ev = await prEvidence([{ repo: REPO, number: 1502, url: url(1502), heads: ["branch-c"] }], "", depsFor(prs));
  assert.ok(ev.facts.includes(`${url(1502)}: code review's aidenhq/review status on head ${SHA("c")}: not green (failed)`), ev.facts.join("\n"));
});

test("a head with no aidenhq/review status adds no such fact", async () => {
  const prs = [reviewed(1503, "e", "f", null)];
  const ev = await prEvidence([{ repo: REPO, number: 1503, url: url(1503), heads: ["branch-e"] }], "", depsFor(prs));
  assert.ok(ev.facts.some((f) => f.startsWith(`${url(1503)}: merged`)), "the PR's own fact line is present");
  assert.ok(ev.facts.every((f) => !f.includes("aidenhq/review")), "an absent status stays not shown");
});

test("the gate check is read from its newest run at the head, and two judgements of its name take the worst", async () => {
  // An edit re-runs CI and cancels the run before it: the cancelled check stays on the head, but the newer run is the verdict, so
  // the head reads green and the PR is graded rather than waiting on a superseded run.
  const superseded = { ...merged(1505, "i", "j"), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: "CheckRun", databaseId: 10, name: "ci-required", status: "COMPLETED", conclusion: "CANCELLED" },
    { __typename: "CheckRun", databaseId: 11, name: "ci-required", status: "COMPLETED", conclusion: "SUCCESS" },
  ] } } } }] } };
  const ev = await prEvidence([{ repo: REPO, number: 1505, url: url(1505), heads: ["branch-i"] }], "", depsFor([superseded]));
  const line = ev.facts.find((f) => f.startsWith(`${url(1505)}: merged`));
  assert.match(line, /checks: ci-required green/, "the newer successful run is the gate's verdict, not the cancelled one");
  // A status sharing the gate's name is a second judgement: the failed one makes the gate red, never green.
  const twoJudgements = { ...merged(1506, "k", "l"), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: "CheckRun", databaseId: 12, name: "ci-required", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "ci-required", state: "FAILURE", createdAt: "2026-01-01T00:00:00Z" },
  ] } } } }] } };
  const red = await prEvidence([{ repo: REPO, number: 1506, url: url(1506), heads: ["branch-k"] }], "", depsFor([twoJudgements]));
  const redLine = red.facts.find((f) => f.startsWith(`${url(1506)}: merged`));
  assert.match(redLine, /checks: ci-required not green \(failed\)/, "a red judgement beside a green run is not papered over");
});

test("a check run merely named aidenhq/review is not code review's status", async () => {
  // Code review publishes a commit status; a check run wearing the name is something else and proves nothing about its verdict.
  const pr = { ...merged(1504, "g", "h"), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: "CheckRun", name: "ci-required", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "aidenhq/review", status: "COMPLETED", conclusion: "SUCCESS" },
  ] } } } }] } };
  const ev = await prEvidence([{ repo: REPO, number: 1504, url: url(1504), heads: ["branch-g"] }], "", depsFor([pr]));
  assert.ok(ev.facts.every((f) => !f.includes("code review's")), ev.facts.join("\n"));
});
