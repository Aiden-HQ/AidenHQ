// Ship's watch loop end to end against a fake GitHub and a fake kernel, through the one engine (adopted.ts, rounds.ts) and the CI
// recoveries (ci-recover.ts), under `cautious`: Dependabot tasks, a task's own PR (adopted on its task, merged by ship,
// woken for red checks and findings, closed when superseded or done), and the re-runs of checks that never started or got wedged.
import { verdict } from "./risk.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followFeed, RETRY_MS, startLoop, watchSet } from "../service/src/loop.ts";
import { adoptedPass } from "../service/src/adopted.ts";
import { ciRecover } from "../service/src/ci-recover.ts";
import { PRESETS } from "../service/src/settings.ts";
import { openState } from "../service/src/state.ts";
import { namedChecks } from "../service/src/aidenhq-sdk/checks.ts";
// The merge gate's rule is github's (ship asks it through /internal/ship/decision): the test asks the same function on the list node.
import { decide } from "../../github/service/src/merge-gate.ts";

// github's pr-tasks.json (opener provenance), read through `openers`.
const prTasks = (dir) => join(dir, "pr-tasks.json");
const notePrTask = (dir, url, v) => writeFileSync(prTasks(dir), JSON.stringify({ ...(existsSync(prTasks(dir)) ? JSON.parse(readFileSync(prTasks(dir), "utf8")) : {}), [url.toLowerCase()]: v }));
/** github's decision from ship's list node (merges.ts decision), every named check required, code review's verdict as given. */
const decisionOf = (reviewGate) => async (repo, number, head, { pr, main, stackedOn }) => {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const checks = namedChecks(rollup);
  const data = { repository: { defaultBranchRef: { name: main.name }, pullRequest: { ...pr, state: "OPEN", baseRefName: pr.baseRefName ?? main.name, reviews: { nodes: [] }, baseRef: { compare: { behindBy: 0 }, target: { oid: main.oid, statusCheckRollup: main.rollup } } } } };
  const g = reviewGate ? await reviewGate(repo, number, head) : undefined;
  // `requiredChecks` on the node stands in for branch protection: only those names are required (the product requires
  // `ci-required` alone), while every named check is still read from the rollup.
  const required = pr.requiredChecks ?? checks.map((c) => c.name);
  const v = decide(data, head, { queue: false, approve: false, verdict: g, required, checks, ...(stackedOn ? { stackedOn } : {}) });
  const red = checks.filter((c) => !c.ok && !c.pending).map((c) => c.name);
  return { ...v, failing: red.filter((n) => required.includes(n)), redChecks: red, dirty: pr.mergeStateStatus === "DIRTY", ...(g && g.findingsKey ? { findingsKey: g.findingsKey } : {}) };
};
/** Task-owned adoptions whose heads were first seen at `at` (a done task's PR closes once its head is half an hour old). */
const seen = (dir, prs, at) => writeFileSync(join(dir, "state.json"), JSON.stringify({ records: Object.fromEntries(prs.map((n) => [`acme/app#${n}`, { repo: "acme/app", number: n, generation: 1, trigger: { kind: "fleet", event: `opened:${n}`, actor: `ACME-${n}`, at, head: `h${n}` }, task: `ACME-${n}`, owner: { kind: "task", task: `ACME-${n}` }, hold: null, seen: { head: `h${n}`, at } }])) }));
/** The loop as main.ts starts it, under `cautious`, with github's routes and code review stood in for in process. */
const startPrWatch = (o) => {
  // Read from the file on every call, so a test can seed adoptions after the loop started.
  const file = join(o.cacheDir, "state.json");
  const state = { get: (r, n) => openState(file).get(r, n), put: (a) => openState(file).put(a), all: () => openState(file).all() };
  const kernel = { async call(method, path, body) {
    const r = await fetch(`${o.kernelUrl}${path}`, { method, headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status}`), { status: r.status });
    return j;
  } };
  const comments = o.comments ?? [];
  return startLoop({
    openers: async () => (existsSync(prTasks(o.cacheDir)) ? JSON.parse(readFileSync(prTasks(o.cacheDir), "utf8")) : {}),
    recover: ciRecover({ gh: o.gh, log() {} }),
    adopted: adoptedPass({
      gh: o.gh, state, kernel, settings: o.settings ?? (() => PRESETS.cautious), paused: () => false, log() {},
      decision: decisionOf(o.reviewGate),
      effects: { comment: async (repo, n, body) => (comments.push({ n, body }), 1), askReview: async () => {}, askFresh: async () => {}, verdict: async () => verdict("standard", { verdict: "wait" }) },
    }),
    ...o,
  });
};

const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const checks = (status) => ({ state: status === "PENDING" ? "PENDING" : "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "test", status: status === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: status === "PENDING" ? null : "SUCCESS" }] } });
const pr = (n, o = {}) => ({ number: n, url: `https://github.com/acme/app/pull/${n}`, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: o.mergeable === "CONFLICTING" ? "DIRTY" : "CLEAN", baseRefName: "main", isCrossRepository: false, headRefName: `b${n}`, headRefOid: `h${n}`, author: { __typename: "Bot", login: "dependabot" }, commits: { nodes: [{ commit: { statusCheckRollup: checks(o.checks ?? "SUCCESS") } }] }, ...o });

test("a Dependabot PR becomes one task once its checks finish and closes with it; a conflicting agent PR wakes its task once", async (t) => {
  let open = [];
  let mainOid = "m1";
  const calls = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
    if (req.url === "/v1/tasks") return res.writeHead(200).end(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", identifier: "ACME-1", agent: "pe", deduplicated: false }));
    if (req.url === "/v1/wakes") return res.writeHead(200).end(JSON.stringify({ posted: true }));
    if (req.url === "/v1/writes") return res.writeHead(200).end(JSON.stringify({ id: "w1", state: "claimed" }));
    if (req.url.startsWith("/v1/writes/")) return res.writeHead(200).end(JSON.stringify({ id: "w1", state: "claimed" }));
    if (req.url.startsWith("/v1/work")) return res.writeHead(200).end(JSON.stringify({ status: "in_progress", records: [] }));
    res.writeHead(200).end(JSON.stringify({ status: "done" }));
  });
  t.after(() => kernel.s.close());
  const gh = async (method, path, body) => {
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: mainOid, statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    if (path.startsWith("/repos/acme/app/compare/")) return { status: 200, body: { behind_by: 3 } };
    return { status: 404, body: {} };
  };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repos: [{ repo: "acme/app", duties: "all" }], kernelUrl: kernel.url, key: "k", cacheDir, gh });
  const made = () => calls.filter((c) => c.url === "/v1/tasks");
  const wakes = () => calls.filter((c) => c.url === "/v1/wakes");

  open = [pr(10, { checks: "PENDING" })];
  await watch.tick();
  assert.equal(made().length, 0, "not while its checks run");
  open = [pr(10)];
  await watch.tick();
  await watch.tick();
  assert.equal(made().length, 1, "filed once");
  assert.equal(made()[0].auth, "Bearer k");
  assert.deepEqual([made()[0].body.role, made()[0].body.source, made()[0].body.title], ["platform-engineer", "dependabot:acme/app/10", "Dependabot PR acme/app#10"]);
  assert.match(made()[0].body.description, /pull\/10/);
  // The brief points at the skill, which owns the decision: an inline "close it if it is a major jump" sent agents to close a
  // group PR while its replacement was still open, so the replacement closed unmerged and its bumps never landed.
  assert.doesNotMatch(made()[0].body.description, /close it if it is a major jump/);
  assert.match(made()[0].body.description, /as the .dependabot. skill says/);

  open = [];
  await watch.tick();
  const close = calls.find((c) => c.url === "/v1/tasks/11111111-1111-4111-8111-111111111111/close");
  assert.equal(close?.body.status, "done");

  // An agent's PR the service opened for task ACME-7 now conflicts with main.
  notePrTask(cacheDir, "https://github.com/acme/app/pull/9", { task: "ACME-7", branch: "b9" });
  open = [pr(9, { author: { __typename: "Bot", login: "aidenhq" }, mergeable: "CONFLICTING" })];
  await watch.tick();
  await watch.tick();
  const repairs = calls.filter((c) => c.url === "/v1/writes" && c.body.kind === "github.repair");
  assert.equal(repairs.length, 1, "ship's repair first, once at the head");
  assert.deepEqual([repairs[0].body.task, repairs[0].body.args.number, repairs[0].body.args.base], ["ACME-7", 9, "main"]);
  assert.equal(wakes().length, 0, "the task is woken only for what the repair leaves");
});



// The behaviours ported from the runner, against one fake GitHub and kernel: each case is one agent PR (acme/app#N, task ACME-N).
const redChecks = (extra = {}) => ({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", databaseId: 77, name: "test", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } }, ...extra }] } });
async function rig(t, { taskStatus = "in_progress", behind = 0, steps = [{ name: "Build" }], job, jobRerun = () => 201, update = 202, updateBody, updateByMethod, wakeFails = 0, closeFails = 0, commentFails = 0, refTip, branchUses, tasks, records = [], merge = () => [422, { message: "refused" }], record = () => ({}), settings, reviewGate = undefined, mainBefore, mainChecks, rerun = () => 204, restRuns, jobRead = () => undefined, gigRun, listingStatus, listingThrow } = {}) {
  const woke = [], gh = [], merges = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/v1/wakes" && wakeFails-- > 0) return res.writeHead(503).end("{}");
    if (req.url === "/v1/wakes") woke.push(JSON.parse(body));
    if (req.url === "/v1/writes") { merges.push(JSON.parse(body)); const [status, answer] = merge(); return res.writeHead(status).end(JSON.stringify(answer)); }
    if (req.url.startsWith("/v1/writes/")) return res.writeHead(200).end(JSON.stringify(record()));
    // A task close is recorded, and its task's status changes, exactly as the kernel's own close would: an assertion that a task
    // was not closed must observe the request, never only a readback the fake would answer from its seed.
    const close = String(req.url).match(/^\/v1\/tasks\/([^/]+)\/close$/);
    if (close) {
      closed.push(decodeURIComponent(close[1]));
      const t = tasks?.[decodeURIComponent(close[1])];
      if (t) t.status = String(JSON.parse(body)?.status ?? "done");
      return res.writeHead(200).end(JSON.stringify({}));
    }
    // `tasks` is the kernel's task table for the tests that need a second, real task (a successor): one task's own status and
    // brief, by identifier. A miss under a table answers as the kernel's work read does for no task (a null status), so a test
    // whose watcher read the wrong identifier cannot pass on the default. Without a table every read is the `taskStatus` under test.
    const asked = String(req.url).match(/^\/v1\/work\?task=([^&]+)/)?.[1];
    if (req.url.startsWith("/v1/work")) {
      const t = tasks && asked ? tasks[decodeURIComponent(asked)] : undefined;
      if (tasks) return res.writeHead(200).end(JSON.stringify({ status: t?.status ?? null, ...(t?.description ? { description: t.description } : {}), records }));
      return res.writeHead(200).end(JSON.stringify({ status: taskStatus, records }));
    }
    res.writeHead(200).end(JSON.stringify({}));
  });
  t.after(() => kernel.s.close());
  let open = [];
  const sent = []; // every call's body: a close names the task it was decided for, a delete carries no such field
  const closed = []; // task ids the kernel was asked to close: an assertion about one must see the request, not a readback
  const reran = new Set(); // job ids this head's re-run was asked for: GitHub posts their next attempt
  const jobProbeOpts = []; // the opts of each Actions job read: a probe must carry a deadline
  const headRunsOpts = []; // the opts of each REST check-runs listing: the recovery paths' first read carries one too
  const api = async (method, path, body, opts) => {
    gh.push(`${method} ${path}${body?.update_method ? ` ${body.update_method}` : ""}`);
    sent.push({ method, path, body });
    if (method === "GET" && /^\/repos\/acme\/app\/actions\/jobs\/\d+$/.test(path)) jobProbeOpts.push(opts ?? {});
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: mainBefore?.() ?? "m1", statusCheckRollup: mainChecks?.() ?? checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    // REST check runs for a head, as GitHub lists them: the full Actions job id is carried in details_url.
    const headRuns = path.match(/^\/repos\/acme\/app\/commits\/([^/?]+)\/check-runs/);
    if (headRuns) {
      headRunsOpts.push(opts ?? {});
      const refused = listingStatus?.();
      if (refused) return { status: refused, body: {} };
      const thrown = listingThrow?.();
      if (thrown) throw thrown;
      // The tests that need REST and the rollup to disagree (an old wedged run the rollup no longer lists) name the runs.
      if (restRuns) { const runs = restRuns(headRuns[1]); return { status: 200, body: { total_count: runs.length, check_runs: runs } }; }
      const head = open.find((p) => p.headRefOid === headRuns[1]);
      const nodes = head?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
      const runs = nodes.filter((n) => n.__typename === "CheckRun").map((n) => ({ id: n.databaseId, node_id: n.id, name: n.name, status: String(n.status ?? "").toLowerCase(), app: { slug: "github-actions" }, started_at: n.startedAt, check_suite: { id: n.checkSuite?.workflowRun?.databaseId ?? 500 }, details_url: `https://github.com/acme/app/actions/runs/${n.checkSuite?.workflowRun?.databaseId ?? 500}/job/${n.databaseId}` }));
      return { status: 200, body: { total_count: runs.length, check_runs: runs } };
    }
    if (path.startsWith("/repos/acme/app/compare/")) return { status: 200, body: { behind_by: behind } };
    if (method === "POST" && /^\/repos\/acme\/app\/actions\/jobs\/\d+\/rerun$/.test(path)) {
      const status = jobRerun();
      if (status < 300) reran.add(Number(path.split("/").at(-2)));
      return { status, body: {} };
    }
    if (path.startsWith("/repos/acme/app/actions/jobs/")) {
      // `jobRead` lets a test make this read throw (a timeout, a quota refusal) or answer a status (a deleted run's 404).
      const failure = jobRead();
      if (failure) { if (typeof failure === "number") return { status: failure, body: {} }; throw failure; }
      const id = Number(path.split("/").at(-1));
      const holder = open.find((p) => (p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).some((n) => n.databaseId === id));
      // A job that replaced a re-run original (77 seen as 78) is its next attempt: the mock treats job 78 as the rerun of 77.
      const nextAttempt = id === 78 ? 2 : 1;
      // REST's `run_id` is the real workflow-run id (the rollup's databaseId is 32-bit); the rig's suites are run 500/600.
      const suite = holder?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes?.find((n) => n.databaseId === id)?.checkSuite;
      const runId = gigRun?.(id) ?? (suite?.workflowRun?.databaseId ?? (id >= 90 ? 600 : 500));
      return { status: 200, body: { steps, status: "completed", started_at: new Date(Date.now() - 11 * 60_000).toISOString(), completed_at: new Date(Date.now() - 10 * 60_000).toISOString(), head_sha: holder?.headRefOid, check_run_url: `https://api.github.com/repos/acme/app/check-runs/${id}`, run_attempt: nextAttempt, run_id: runId, ...job } };
    }
    if (path.endsWith("/update-branch")) {
      const m = updateByMethod?.[body?.update_method];
      if (m?.throw) throw new Error(`The operation was aborted due to timeout`);
      return { status: m?.status ?? update, body: m?.body ?? updateBody ?? (update === 422 ? { message: "merge conflict between base and head" } : {}) };
    }
    if (path.startsWith("/repos/acme/app/check-runs/")) return { status: 200, body: { output: { title: "1 test failed", summary: "expected 2, got `3`" } } };
    if (method === "POST" && path.endsWith("/rerun-failed-jobs")) {
      const r = rerun();
      if (r?.throw) throw r.throw; // a POST that never gets an answer (a timeout, a quota refusal)
      return { status: r, body: {} };
    }
    // A branch delete's guards: the ref is still the PR's head, and no other open PR uses the branch (so the delete is allowed).
    const ref = path.match(/^\/repos\/acme\/app\/git\/ref\/heads\/(.+)$/);
    if (ref) {
      const tip = refTip?.(ref[1]);
      if (tip?.throw) throw tip.throw;
      const sha = typeof tip === "string" ? tip : open.find((p) => p.headRefName === ref[1])?.headRefOid ?? "moved";
      return { status: 200, body: { ref: `refs/heads/${ref[1]}`, object: { sha } } };
    }
    if (method === "GET" && path.startsWith("/repos/acme/app/pulls?state=open")) return { status: 200, body: branchUses?.() ?? [] };
    if (method === "PATCH" && closeFails-- > 0) return { status: 502, body: {} };
    if (method === "POST" && /^\/repos\/acme\/app\/issues\/\d+\/comments$/.test(path) && commentFails-- > 0) return { status: 502, body: {} };
    return { status: 200, body: {} };
  };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repos: [{ repo: "acme/app", duties: "all" }], kernelUrl: kernel.url, key: "k", cacheDir, gh: api, reviewGate, ...(settings ? { settings } : {}) });
  const agentPr = (n, o = {}) => { notePrTask(cacheDir, `https://github.com/acme/app/pull/${n}`, { task: `ACME-${n}`, branch: `b${n}` }); return pr(n, { author: { __typename: "Bot", login: "aidenhq" }, ...o }); };
  return { woke, gh, merges, sent, closed, watch, cacheDir, kernelUrl: kernel.url, agentPr, jobProbeOpts, headRunsOpts, reran, set: (v) => { open = v; }, behind: (v) => { behind = v; update = 422; } };
}
const redPr = (n, o = {}) => ({ commits: { nodes: [{ commit: { statusCheckRollup: redChecks() } }] }, ...o });

test("a cancelled task's PR is left open with its branch and noted once; a done task's unmerged PR once its head is old and no merge is open", async (t) => {
  const c = await rig(t, { taskStatus: "cancelled" });
  c.set([c.agentPr(1)]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/1").length, 0, "a cancelled task never closes its PR");
  assert.ok(!c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b1"), "a cancelled task never deletes its PR's branch");
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/issues/1/comments").length, 1, "noted once that it is left for a successor");
  const d = await rig(t, { taskStatus: "done" });
  d.set([d.agentPr(2)]);
  await d.watch.tick();
  assert.ok(!d.gh.some((g) => g.startsWith("PATCH")), "its head is new: a just-finished merge isn't raced");
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  const e = await rig(t, { taskStatus: "done", records: [{ kind: "github.merge", state: "claimed", args: { prs: [{ repo: "acme/app", number: 3, head: "h3" }] } }] });
  e.set([e.agentPr(2), e.agentPr(3)]);
  seen(e.cacheDir, [2, 3], old);
  await e.watch.tick(); await e.watch.tick();
  assert.equal(e.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/2").length, 1, "done, unmerged and old: closed once");
  assert.ok(e.gh.includes("DELETE /repos/acme/app/git/refs/heads/b2"));
  assert.ok(!e.gh.includes("PATCH /repos/acme/app/pulls/3"), "a merge of it is in flight: left alone");
});



test("a task's PR red on its own head wakes its task once per head; past a cap it holds, the asker is told, and a new head resumes it", async (t) => {
  const c = await rig(t);
  c.set([c.agentPr(3, redPr(3))]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.woke.length, 1);
  assert.equal(c.woke[0].task, "ACME-3");
  assert.match(c.woke[0].text, /pull\/3: required checks are red at head h3: `test`.*aidenhq ship push/s);
  const capped = await rig(t, { settings: () => ({ ...PRESETS.cautious, caps: { ...PRESETS.cautious.caps, ci_rounds: 0 } }) });
  capped.set([capped.agentPr(8, redPr(8))]);
  await capped.watch.tick(); await capped.watch.tick();
  assert.equal(capped.woke.length, 1, "held: whoever asked for the task is told once");
  assert.deepEqual([capped.woke[0].to, /Ship stopped on .*ci_rounds/.test(capped.woke[0].text)], ["asker", true]);
  capped.set([capped.agentPr(8, redPr(8, { headRefOid: "h8b" }))]);
  await capped.watch.tick();
  assert.equal(capped.woke.length, 2, "a new head clears the hold, and the round runs again");
});


// The `policy` job's "Conventional Commit title" step (and `ci-required`, its aggregate) is the only red: no commit can fix it.
const redNodes = (names) => ({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: names.map((name, i) => ({ __typename: "CheckRun", databaseId: 77 + i, name, status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } })) } });
// The title the `policy` job's Conventional Commit check rejects: what a retitle wake needs to see on the PR itself.
const BAD_TITLE = "Ship PR 1823";
const titleOnlyPr = (n, names = ["policy", "ci-required"], o = {}) => ({ title: BAD_TITLE, commits: { nodes: [{ commit: { statusCheckRollup: redNodes(names) } }] }, ...o });
// The `policy` job's own steps at a head whose only failure is the title step: the positive evidence a retitle wake needs.
const titleJob = (o = {}) => ({ steps: [{ name: "Age check (lockfiles) and pins (images, actions, apt, global installs)", conclusion: "success" }, { name: "Conventional Commit title", conclusion: "failure" }], ...o });

test("a fix_ci whose only red check is the PR title wakes the task to retitle it, never to commit; a red code check still gets the commit line", async (t) => {
  const c = await rig(t, { job: titleJob() });
  c.set([c.agentPr(5, titleOnlyPr(5))]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.woke.length, 1);
  const text = c.woke[0].text;
  assert.match(text, /required checks are red at head h5: `policy`, `ci-required`/);
  assert.match(text, /Conventional Commit title/);
  assert.match(text, /aidenhq ship title https:\/\/github\.com\/acme\/app\/pull\/5 h5 1 /);
  assert.doesNotMatch(text, /one commit/);
  assert.doesNotMatch(text, /aidenhq ship push/);
  assert.doesNotMatch(text, /aidenhq ship checkout/);

  // The product's branch protection requires `ci-required` alone, so the `policy` job's own red is not a required failure: only
  // the aggregate is. The title is still the cause, read from the head's named checks.
  const behind = await rig(t, { job: titleJob() });
  behind.set([behind.agentPr(9, titleOnlyPr(9, ["policy", "ci-required"], { requiredChecks: ["ci-required"] }))]);
  await behind.watch.tick(); await behind.watch.tick();
  assert.equal(behind.woke.length, 1);
  assert.match(behind.woke[0].text, /required checks are red at head h9: `ci-required`, `policy`/);
  assert.match(behind.woke[0].text, /aidenhq ship title https:\/\/github\.com\/acme\/app\/pull\/9 h9 1 /);
  assert.doesNotMatch(behind.woke[0].text, /one commit|aidenhq ship push/);

  // A code check red beside the aggregate (`ci-required` only required) is not metadata-only: the commit instruction stays.
  const hidden = await rig(t);
  hidden.set([hidden.agentPr(10, titleOnlyPr(10, ["policy", "checks", "ci-required"], { requiredChecks: ["ci-required"] }))]);
  await hidden.watch.tick(); await hidden.watch.tick();
  assert.equal(hidden.woke.length, 1);
  assert.match(hidden.woke[0].text, /one commit, never weaken a check\./);
  assert.match(hidden.woke[0].text, /aidenhq ship push https:\/\/github\.com\/acme\/app\/pull\/10 h10 1/);
  assert.doesNotMatch(hidden.woke[0].text, /aidenhq ship title/);

  // A check red on the base as well is pre-existing: it must not hide the metadata case, so only this head's own reds are judged
  // (the base's is named for the Engineer to compare).
  const onBase = await rig(t, { mainChecks: () => redNodes(["test"]), job: titleJob() });
  onBase.set([onBase.agentPr(11, titleOnlyPr(11, ["policy", "ci-required", "test"]))]);
  await onBase.watch.tick(); await onBase.watch.tick();
  assert.equal(onBase.woke.length, 1);
  assert.match(onBase.woke[0].text, /aidenhq ship title https:\/\/github\.com\/acme\/app\/pull\/11 h11 1 /);
  assert.match(onBase.woke[0].text, /These fail on `main`'s latest run too: `test`/);
  assert.doesNotMatch(onBase.woke[0].text, /one commit|aidenhq ship push/);

  // `policy` itself red on the base too: the job's own steps decide. Its age check red on `main` says nothing about this head; the
  // title step is this head's only failure, so the title wake stands.
  const basePolicy = await rig(t, { mainChecks: () => redNodes(["policy"]), job: { steps: [{ name: "Age check (lockfiles) and pins (images, actions, apt, global installs)", conclusion: "success" }, { name: "Conventional Commit title", conclusion: "failure" }] } });
  basePolicy.set([basePolicy.agentPr(13, titleOnlyPr(13, ["policy", "ci-required"]))]);
  await basePolicy.watch.tick(); await basePolicy.watch.tick();
  assert.equal(basePolicy.woke.length, 1);
  assert.match(basePolicy.woke[0].text, /aidenhq ship title https:\/\/github\.com\/acme\/app\/pull\/13 h13 1 /);
  assert.doesNotMatch(basePolicy.woke[0].text, /one commit|aidenhq ship push/);
  // Where the job's steps can't say (nothing readable), a base-red `policy` is left to the commit instruction rather than guessed.
  const unreadable = await rig(t, { mainChecks: () => redNodes(["policy"]), jobRead: () => 404 });
  unreadable.set([unreadable.agentPr(14, titleOnlyPr(14, ["policy", "ci-required"]))]);
  await unreadable.watch.tick(); await unreadable.watch.tick();
  assert.equal(unreadable.woke.length, 1, JSON.stringify(unreadable.woke.map((w) => w.text)));
  assert.doesNotMatch(unreadable.woke[0].text, /aidenhq ship title/);

  // `policy` alone (its aggregate not yet reported) is metadata too.
  const alone = await rig(t, { job: titleJob() });
  alone.set([alone.agentPr(6, titleOnlyPr(6, ["policy"]))]);
  await alone.watch.tick(); await alone.watch.tick();
  assert.equal(alone.woke.length, 1);
  assert.match(alone.woke[0].text, /aidenhq ship title .*\/pull\/6 h6 /);
  assert.doesNotMatch(alone.woke[0].text, /one commit|aidenhq ship push/);

  // `ci-required` alone is another job's failure rolled up, not the title: the commit instruction stays.
  const aggregate = await rig(t);
  aggregate.set([aggregate.agentPr(8, titleOnlyPr(8, ["ci-required"]))]);
  await aggregate.watch.tick(); await aggregate.watch.tick();
  assert.equal(aggregate.woke.length, 1);
  assert.match(aggregate.woke[0].text, /one commit, never weaken a check\./);
  assert.doesNotMatch(aggregate.woke[0].text, /aidenhq ship title/);

  // A red code check (even beside policy) is not metadata-only: the commit instruction stays, and no title line is offered.
  const code = await rig(t);
  code.set([code.agentPr(7, titleOnlyPr(7, ["policy", "test"]))]);
  await code.watch.tick(); await code.watch.tick();
  assert.equal(code.woke.length, 1);
  assert.match(code.woke[0].text, /Fix what this PR broke as the `ship` skill says: one commit, never weaken a check\./);
  assert.match(code.woke[0].text, /aidenhq ship push https:\/\/github\.com\/acme\/app\/pull\/7 h7 1/);
  assert.doesNotMatch(code.woke[0].text, /aidenhq ship title/);
});

test("a metadata-only wake does not spend the head's CI round: a real red check at the same head still wakes the commit fix", async (t) => {
  const c = await rig(t, { job: titleJob() });
  c.set([c.agentPr(12, titleOnlyPr(12))]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.woke.length, 1);
  assert.doesNotMatch(c.woke[0].text, /one commit/);
  // The title was edited (no push, same head) and a code check turned red meanwhile.
  c.set([c.agentPr(12, titleOnlyPr(12, ["checks", "ci-required"]))]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.woke.length, 2, "the same head's code failure is a new wake");
  assert.match(c.woke[1].text, /one commit, never weaken a check\./);
});

test("the policy job's own failing step decides the wake: another of its steps keeps the commit instruction", async (t) => {
  // `policy` runs the lockfile age and pin checks beside the title step: when one of those failed, a title edit clears nothing.
  const other = await rig(t, { job: { steps: [{ name: "Age check (lockfiles) and pins (images, actions, apt, global installs)", conclusion: "failure" }, { name: "Conventional Commit title", conclusion: "failure" }] } });
  other.set([other.agentPr(20, titleOnlyPr(20))]);
  await other.watch.tick(); await other.watch.tick();
  assert.equal(other.woke.length, 1);
  assert.match(other.woke[0].text, /one commit, never weaken a check\./);
  assert.doesNotMatch(other.woke[0].text, /aidenhq ship title/);

  // The title step is the only failing one: the title wake, confirmed by the job's steps.
  const only = await rig(t, { job: { steps: [{ name: "Age check (lockfiles) and pins (images, actions, apt, global installs)", conclusion: "success" }, { name: "Conventional Commit title", conclusion: "failure" }] } });
  only.set([only.agentPr(21, titleOnlyPr(21))]);
  await only.watch.tick(); await only.watch.tick();
  assert.equal(only.woke.length, 1);
  assert.match(only.woke[0].text, /aidenhq ship title https:\/\/github\.com\/acme\/app\/pull\/21 h21 1 /);
  assert.doesNotMatch(only.woke[0].text, /one commit|aidenhq ship push/);

  // The job's age step failed first and only the title step fails now, at the same head: the code-fix wake recorded above must not
  // swallow the title wake (each action is keyed by what it actually asks for).
  const steps = { v: [{ name: "Age check (lockfiles) and pins (images, actions, apt, global installs)", conclusion: "failure" }, { name: "Conventional Commit title", conclusion: "failure" }] };
  const turned = await rig(t, { job: { get steps() { return steps.v; } } });
  turned.set([turned.agentPr(23, titleOnlyPr(23))]);
  await turned.watch.tick(); await turned.watch.tick();
  assert.equal(turned.woke.length, 1);
  assert.match(turned.woke[0].text, /one commit, never weaken a check\./);
  steps.v = [{ name: "Age check (lockfiles) and pins (images, actions, apt, global installs)", conclusion: "success" }, { name: "Conventional Commit title", conclusion: "failure" }];
  await turned.watch.tick(); await turned.watch.tick();
  assert.equal(turned.woke.length, 2, "the title fix is still asked for at the same head");
  assert.match(turned.woke[1].text, /aidenhq ship title https:\/\/github\.com\/acme\/app\/pull\/23 h23 1 /);
});

test("a metadata-only red whose policy steps can't be read re-runs the job once at the head, never asking for a retitle or a commit", async (t) => {
  // A `policy` job that timed out leaves no step with a failure: nothing proves the title failed, so the wake names a re-run (the
  // recovery: a fresh attempt's steps can be read) and names no fix on a guess (a retitle of an already-valid title changes nothing).
  let readable = false;
  const unclear = await rig(t, { job: titleJob(), jobRead: () => (readable ? undefined : 404) });
  unclear.set([unclear.agentPr(24, titleOnlyPr(24))]);
  await unclear.watch.tick(); await unclear.watch.tick();
  assert.equal(unclear.woke.length, 1, JSON.stringify(unclear.woke.map((w) => w.text)));
  assert.match(unclear.woke[0].text, /job's own steps at this head don't show which step failed/);
  assert.match(unclear.woke[0].text, /re-run `policy` once at this head/);
  assert.doesNotMatch(unclear.woke[0].text, /aidenhq ship title/);
  assert.doesNotMatch(unclear.woke[0].text, /one commit|aidenhq ship push/);
  // The recovery is a real one: the `policy` job itself is re-run at this head, once, not merely described to the Engineer.
  assert.equal(unclear.gh.filter((g) => g === "POST /repos/acme/app/actions/jobs/77/rerun").length, 1, "the policy job is re-run once at the head");
  // The same head asks for no second log read and no second re-run while the steps stay unreadable.
  await unclear.watch.tick(); await unclear.watch.tick();
  assert.equal(unclear.woke.length, 1, "the unclear wake is not repeated at the same head");
  assert.equal(unclear.gh.filter((g) => g === "POST /repos/acme/app/actions/jobs/77/rerun").length, 1, "no second re-run at the same head");
  // Once the job's steps can be read and name the title step, the title fix is asked for at that same head.
  readable = true;
  await unclear.watch.tick(); await unclear.watch.tick();
  assert.equal(unclear.woke.length, 2, JSON.stringify(unclear.woke.map((w) => w.text)));
  assert.match(unclear.woke[1].text, /aidenhq ship title https:\/\/github\.com\/acme\/app\/pull\/24 h24 1 /);
  assert.doesNotMatch(unclear.woke[1].text, /one commit|aidenhq ship push/);
});


test("a new policy failure after a title wake is judged on its own run, not deduplicated against the retitle", async (t) => {
  // The title edit re-runs `policy` in place (same head, `edited`). Its new run fails another of its steps, and the job says so:
  // that is a code fix, and it is woken for at the same head instead of being read as the old title diagnosis.
  const steps = { v: [{ name: "Age check (lockfiles) and pins (images, actions, apt, global installs)", conclusion: "success" }, { name: "Conventional Commit title", conclusion: "failure" }] };
  const turned = await rig(t, { job: { get steps() { return steps.v; } } });
  turned.set([turned.agentPr(25, titleOnlyPr(25))]);
  await turned.watch.tick(); await turned.watch.tick();
  assert.equal(turned.woke.length, 1);
  assert.match(turned.woke[0].text, /aidenhq ship title https:\/\/github\.com\/acme\/app\/pull\/25 h25 1 /);
  steps.v = [{ name: "Age check (lockfiles) and pins (images, actions, apt, global installs)", conclusion: "failure" }, { name: "Conventional Commit title", conclusion: "success" }];
  await turned.watch.tick(); await turned.watch.tick();
  assert.equal(turned.woke.length, 2, JSON.stringify(turned.woke.map((w) => w.text)));
  assert.match(turned.woke[1].text, /one commit, never weaken a check\./);
  assert.match(turned.woke[1].text, /aidenhq ship push https:\/\/github\.com\/acme\/app\/pull\/25 h25 1/);
  assert.doesNotMatch(turned.woke[1].text, /aidenhq ship title/);
});

test("red checks whose job never started are re-run once at the head, with no wake", async (t) => {
  const c = await rig(t, { steps: [] });
  c.set([c.agentPr(4, redPr(4))]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/actions/runs/500/rerun-failed-jobs").length, 1);
  assert.equal(c.woke.length, 0);
});

// A check run GitHub left in_progress while its Actions job finished: the job is re-run at its source, once per head, so
// GitHub reposts the check run the merge gate reads. These use check run 77 (redChecks' databaseId) with its job completed.
const stuckChecks = (databaseId = 77) => ({ state: "PENDING", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", id: `CR_${databaseId}`, databaseId, name: "image-changes", status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } }] } });
const stuckPr = (n, databaseId = 77, o = {}) => ({ commits: { nodes: [{ commit: { statusCheckRollup: stuckChecks(databaseId) } }] }, ...o });


test("a check run still in_progress after its job completed is re-run once at that head, and a healthy PR asks for none", async (t) => {
  const c = await rig(t);
  c.set([c.agentPr(40, stuckPr(40))]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/actions/jobs/77/rerun").length, 1, "re-run once at the head, not again next tick");
  const healthy = await rig(t);
  healthy.set([healthy.agentPr(41)]);
  await healthy.watch.tick(); await healthy.watch.tick();
  assert.ok(!healthy.gh.some((g) => g.endsWith("/rerun")), "a completed check run asks for nothing");
  // A job that finished seconds ago is inside the grace period: a fresh check run can lag, so nothing is re-run yet.
  const fresh = await rig(t, { job: { completed_at: new Date(Date.now() - 30_000).toISOString() } });
  fresh.set([fresh.agentPr(42, stuckPr(42))]);
  await fresh.watch.tick();
  assert.ok(!fresh.gh.includes("POST /repos/acme/app/actions/jobs/77/rerun"), "a job inside the grace period is waited for");
});

test("a wedged check run's job re-run GitHub refused is asked again after its backoff, not recorded as handled", async (t) => {
  const c = await rig(t, { jobRerun: () => 502 });
  c.set([c.agentPr(43, stuckPr(43))]);
  await c.watch.tick();
  const key = "acme/app:h43:77";
  const asks = () => c.gh.filter((g) => g === "POST /repos/acme/app/actions/jobs/77/rerun").length;
  assert.equal(asks(), 1);
  const db = JSON.parse(readFileSync(join(c.cacheDir, "loop.json"), "utf8"));
  assert.match(String(db["acme/app"].reran[key]), /^retry:/, "a refusal is not recorded as a re-run");
  await c.watch.tick();
  assert.equal(asks(), 1, "inside the backoff nothing is asked again");
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": { ...db["acme/app"], reran: { [key]: `retry:${new Date(Date.now() - 60_000).toISOString()}` } } }));
  await c.watch.tick();
  assert.equal(asks(), 2, "past the backoff it is asked again instead of staying unhandled");
});

test("a check run still wedged 20 minutes after its re-run wakes its task once at that head, not again", async (t) => {
  const c = await rig(t);
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  c.set([c.agentPr(44, stuckPr(44))]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": { wedged: { "acme/app:h44:500:image-changes": { at: asked, accepted: true, job: 77 } } } }));
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.woke.length, 1, "told once at this head");
  assert.equal(c.woke[0].task, "ACME-44");
  assert.match(c.woke[0].text, /still `in_progress` at `h44`.*merge gate is held by it/);
  assert.doesNotMatch(c.woke[0].text, /image-changes/, "the workflow's check name never enters the wake");
  // A head the re-run was just asked at waits for the interval: nothing is reported yet.
  const fresh = await rig(t);
  fresh.set([fresh.agentPr(45, stuckPr(45))]);
  await fresh.watch.tick(); await fresh.watch.tick();
  assert.equal(fresh.woke.length, 0, "inside the interval nothing is reported");
});

test("a refused re-run is reported after the interval, and a check job still running is not reported", async (t) => {
  // A refused re-run keeps the first ask's clock, so the check is reported rather than retried unseen.
  const c = await rig(t, { jobRerun: () => 502 });
  c.set([c.agentPr(46, stuckPr(46))]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": { wedged: { "acme/app:h46:500:image-changes": { at: new Date(Date.now() - 21 * 60_000).toISOString(), accepted: false, job: 77 } } } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 1);
  assert.match(c.woke[0].text, /the request to re-run the job was refused/);
  // A replacement job still queued or running is not stuck: nothing is reported for it.
  const running = await rig(t, { job: { status: "in_progress", completed_at: null } });
  running.set([running.agentPr(49, stuckPr(49))]);
  writeFileSync(join(running.cacheDir, "loop.json"), JSON.stringify({ "acme/app": { wedged: { "acme/app:h49:500:image-changes": { at: new Date(Date.now() - 21 * 60_000).toISOString(), accepted: true, job: 77 } } } }));
  await running.watch.tick();
  assert.equal(running.woke.length, 0, "a re-run still running is not a stuck check");
});

test("an Actions read that throws does not stop another PR's merge", async (t) => {
  let open = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const x of req) body += x;
    if (req.url === "/v1/wakes") return res.writeHead(200).end("{}");
    if (req.url === "/v1/writes") { merges.push(JSON.parse(body)); return res.writeHead(200).end(JSON.stringify({ id: "r1", tier: 0, state: "claimed" })); }
    res.writeHead(200).end(JSON.stringify({ status: "in_progress", records: [] }));
  });
  t.after(() => kernel.s.close());
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const merges = [];
  const gh = async (method, path) => {
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    const head = path.match(/^\/repos\/acme\/app\/commits\/([^/?]+)\/check-runs/)?.[1];
    if (head) {
      const nodes = open.find((p) => p.headRefOid === head)?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
      const runs = nodes.map((n) => ({ id: n.databaseId, node_id: n.id, name: n.name, status: String(n.status ?? "").toLowerCase(), app: { slug: "github-actions" }, check_suite: { id: 500 }, details_url: `https://github.com/acme/app/actions/runs/500/job/${n.databaseId}` }));
      return { status: 200, body: { total_count: runs.length, check_runs: runs } };
    }
    if (path.startsWith("/repos/acme/app/actions/jobs/")) throw new Error("The operation was aborted due to timeout");
    return { status: 200, body: {} };
  };
  const real = startPrWatch({ repos: [{ repo: "acme/app", duties: "all" }], kernelUrl: kernel.url, key: "k", cacheDir, gh });
  notePrTask(cacheDir, "https://github.com/acme/app/pull/47", { task: "ACME-47", branch: "b47" });
  open = [pr(47, { author: { __typename: "Bot", login: "aidenhq" } }), pr(48, { ...stuckPr(48, 77), number: 48, url: "https://github.com/acme/app/pull/48", headRefOid: "h48", headRefName: "b48", author: { __typename: "Bot", login: "aidenhq" } })];
  await real.tick();
  const rows = JSON.parse(readFileSync(join(cacheDir, "loop.json"), "utf8"))["acme/app"];
  assert.match(String(rows.reran?.["acme/app:h48:77"]), /^retry:/, "the unanswered read backs off instead of being lost");
  assert.deepEqual(merges.map((m) => m.args.prs[0].number), [47], "the PR after it still reached its merge");
});


test("a red PR behind a green base is updated by GitHub once at its head before any wake; a refused update falls to the fix", async (t) => {
  const c = await rig(t, { behind: 2 });
  c.set([c.agentPr(5, redPr(5))]);
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g.startsWith("PUT /repos/acme/app/pulls/5/update-branch")).length, 1);
  assert.equal(c.woke.length, 0, "the update first");
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g.startsWith("PUT /repos/acme/app/pulls/5/update-branch")).length, 1, "once per head");
  assert.equal(c.woke.length, 1, "the head never moved and is still red: the fix is asked for");
  const d = await rig(t, { behind: 2, update: 422 });
  d.set([d.agentPr(6, redPr(6))]);
  await d.watch.tick(); await d.watch.tick();
  assert.equal(d.gh.filter((g) => g.startsWith("PUT /repos/acme/app/pulls/6/update-branch")).length, 1, "asked once at the head");
  assert.equal(d.woke.length, 1);
  assert.match(d.woke[0].text, /required checks are red at head h6/);
  const ahead = await rig(t);
  ahead.set([ahead.agentPr(7, redPr(7))]);
  await ahead.watch.tick();
  assert.ok(!ahead.gh.some((g) => g.includes("update-branch")), "not behind: no update");
  assert.equal(ahead.woke.length, 1);
});




test("a green task's PR is adopted on its task and ship files its merge once per head; a refused filing holds and tells the asker", async (t) => {
  const c = await rig(t, { merge: () => [200, { id: "r1", tier: 0, state: "claimed" }], record: () => ({ id: "r1", state: "claimed" }) });
  c.set([c.agentPr(3)]);
  await c.watch.tick(); await c.watch.tick();
  assert.deepEqual(c.merges, [{ kind: "github.merge", task: "ACME-3", args: { prs: [{ repo: "acme/app", number: 3, head: "h3", base: "main" }], generation: 1, attempt: 1 } }], "filed once at this head");
  assert.equal(c.woke.length, 0, "no agent turn between green and the merge");
  const adopted = openState(join(c.cacheDir, "state.json")).get("acme/app", 3);
  assert.deepEqual([adopted.generation, adopted.task, adopted.owner, adopted.hold], [1, "ACME-3", { kind: "task", task: "ACME-3" }, null], "adopted at first sight, owned by its task");
  const off = await rig(t, { merge: () => [200, { id: "r9", tier: 0, state: "claimed" }], settings: () => ({ ...PRESETS.cautious, by_tier: { ...PRESETS.cautious.by_tier, standard: { approve: "observe", merge: "off" } } }) });
  off.set([off.agentPr(9)]);
  await off.watch.tick(); await off.watch.tick();
  assert.deepEqual([off.merges.length, off.woke.length], [0, 0], "the tier's merge off: no merge filed and none asked for");
  const refused = await rig(t);
  refused.set([refused.agentPr(5)]);
  await refused.watch.tick(); await refused.watch.tick();
  assert.equal(refused.merges.length, 1, "a refusal is not filed again");
  assert.deepEqual([refused.woke.length, refused.woke[0].to], [1, "asker"]);
  assert.match(refused.woke[0].text, /Ship stopped on .*pull\/5.*merge couldn't be filed/);
  const down = await rig(t, { merge: () => [503, {}] });
  down.set([down.agentPr(6)]);
  await down.watch.tick();
  await down.watch.tick();
  assert.deepEqual([down.merges.length, down.woke.length], [2, 0], "the kernel didn't answer: asked again next pass");
  const two = await rig(t, { merge: () => [200, { id: "r2", tier: 0, state: "claimed" }] });
  notePrTask(two.cacheDir, "https://github.com/acme/app/pull/8", { task: "ACME-7", branch: "b8" });
  two.set([two.agentPr(7), pr(8, { author: { __typename: "Bot", login: "aidenhq" }, checks: "PENDING" })]);
  await two.watch.tick();
  assert.ok(two.gh.includes("PATCH /repos/acme/app/pulls/7") && two.gh.includes("DELETE /repos/acme/app/git/refs/heads/b7"), "the task's older PR is closed once it publishes a newer one");
  assert.deepEqual([two.merges.length, two.woke.length], [0, 0], "the superseded PR files and wakes nothing");
});


test("a wake the kernel doesn't take (a restart) is sent again on the next tick", async (t) => {
  const c = await rig(t, { wakeFails: 1 });
  c.set([c.agentPr(3, redPr(3))]);
  await c.watch.tick();
  assert.equal(c.woke.length, 0);
  await c.watch.tick();
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "sent once it lands, and only once");
  assert.match(c.woke[0].text, /required checks are red at head h3/);
});


test("a cancelled task's PR whose note GitHub refused is noted on the next tick and never closed", async (t) => {
  const c = await rig(t, { taskStatus: "cancelled", commentFails: 1 });
  c.set([c.agentPr(4)]);
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/issues/4/comments").length, 1, "the note was refused");
  assert.ok(!c.gh.some((g) => g.startsWith("PATCH") || g.startsWith("DELETE")), "nothing is closed or deleted either way");
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/issues/4/comments").length, 2, "the note is retried");
  assert.equal(c.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/4").length, 0);
  assert.ok(!c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b4"));
});

// The incident: ACME-12 hit its spend cap, ACME-13 was filed naming its PR, and cancelling ACME-12 closed the PR seconds later and
// deleted the branch. The kernel really holds that successor here (an open task whose brief names the PR), as it did in the
// incident; the watcher's only ownership record (pr-tasks.json) still names the cancelled opener, because a successor writes
// nothing until it publishes. Ownership cannot be determined, so the rule must fail safe and destroy nothing.
test("a cancelled task's PR with a successor task naming it is neither closed nor branch-deleted, this tick or the next", async (t) => {
  const brief = "Finish https://github.com/acme/app/pull/12 for the user; its branch is agent/WOR-1/topic and the change is half done.";
  const c = await rig(t, { taskStatus: "cancelled", tasks: {
    "ACME-12": { status: "cancelled", description: "build the page" },
    "ACME-13": { status: "in_progress", description: brief },
  } });
  // The successor is a real open task the kernel serves, whose brief names the PR: not a comment's claim.
  const successor = await (await fetch(`${c.kernelUrl}/v1/work?task=ACME-13`)).json();
  assert.deepEqual([successor.status, successor.description.includes("pull/12")], ["in_progress", true], "ACME-13 is open and names the PR");
  c.set([c.agentPr(12)]);
  await c.watch.tick();
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/12").length, 0, "no close for the successor's PR, this tick or the next");
  assert.ok(!c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b12"), "no branch delete for the successor's PR");
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/issues/12/comments").length, 1, "left open for the successor, noted once");
  // And the successor's own task is untouched: no close request named it, it is still open, and it was not woken about a PR
  // that is no longer there. The close is asserted as the request the kernel received, not only as a readback.
  assert.deepEqual(c.closed, [], "no task was asked to close");
  const still = await (await fetch(`${c.kernelUrl}/v1/work?task=ACME-13`)).json();
  assert.equal(still.status, "in_progress", "the successor is still open");
  assert.deepEqual(c.woke.filter((w) => w.task === "ACME-13").length, 0, "the successor is not woken about its own open PR");
});





// Several repos in one watch, against a fake GitHub that serves each repo's open PRs (in pages of 50) and a fake kernel.
async function multi(t, repos, open, extra = {}) {
  const tasks = [], closes = [], gh = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/v1/tasks") { tasks.push(JSON.parse(body)); return res.writeHead(200).end(JSON.stringify({ id: `id-${tasks.length}`, identifier: `T-${tasks.length}` })); }
    if (req.url.endsWith("/close")) closes.push(req.url);
    res.writeHead(200).end("{}");
  });
  t.after(() => kernel.s.close());
  const api = async (method, path, body) => {
    gh.push(`${method} ${path}`);
    if (path === "/graphql") {
      const prs = open[`${body.variables.owner}/${body.variables.repo}`] ?? [];
      const from = Number(body.variables.after ?? 0);
      return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { pageInfo: { hasNextPage: from + 50 < prs.length, endCursor: String(from + 50) }, nodes: prs.slice(from, from + 50) } } } } };
    }
    return { status: 404, body: {} };
  };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repos, kernelUrl: kernel.url, key: "k", cacheDir, gh: api, ...extra });
  return { watch, tasks, closes, gh, cacheDir };
}
const dep = (repo, n, o = {}) => pr(n, { url: `https://github.com/${repo}/pull/${n}`, ...o });
const both = [{ repo: "acme/app", duties: "all" }, { repo: "other/lib", duties: "dependabot" }];

test("under failing only a bump with a red check gets a task; under off none does", async (t) => {
  const red = (n) => dep("other/lib", n, { commits: { nodes: [{ commit: { statusCheckRollup: redChecks() } }] } });
  const open = { "other/lib": [dep("other/lib", 1), red(2)] };
  const m = await multi(t, [{ repo: "other/lib", duties: "dependabot", dependabot: "failing" }], open);
  await m.watch.tick();
  assert.deepEqual(m.tasks.map((x) => x.source), ["dependabot:other/lib/2"]);
  const off = await multi(t, [{ repo: "acme/app", duties: "all", dependabot: "off" }], { "acme/app": [dep("acme/app", 1)] });
  await off.watch.tick();
  assert.deepEqual(off.tasks, []);
});

test("under failing a green Dependabot PR is adopted by the round (no label needed) and gets no task; a red one gets the task", async (t) => {
  const red = dep("acme/app", 2, { commits: { nodes: [{ commit: { statusCheckRollup: redChecks() } }] } });
  const m = await multi(t, [{ repo: "acme/app", duties: "all", dependabot: "failing" }], { "acme/app": [dep("acme/app", 1), red] }, { settings: () => PRESETS.cautious });
  await m.watch.tick();
  assert.deepEqual(m.tasks.map((x) => x.source).filter((x) => x.startsWith("dependabot:")), ["dependabot:acme/app/2"]);
  const a = openState(join(m.cacheDir, "state.json"));
  assert.equal(a.get("acme/app", 1)?.trigger.kind, "all");
  assert.equal(a.get("acme/app", 2), undefined);
  const none = dep("acme/app", 3, { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } });
  const n = await multi(t, [{ repo: "acme/app", duties: "all", dependabot: "failing" }], { "acme/app": [none] }, { settings: () => PRESETS.full });
  await n.watch.tick();
  assert.equal(openState(join(n.cacheDir, "state.json")).get("acme/app", 3), undefined, "no reported check is not green");
});

test("a live merge record at the bound head holds the fix_review wake; once the record ends, the fixer is woken", async (t) => {
  const text = "code review: 1 important finding open (a.ts:1)";
  const head = "h1";
  let live = { state: "review", outcome: undefined };
  const rec = { id: "r1", kind: "github.merge", state: "review", args: { prs: [{ repo: "acme/app", number: 1, head }] } };
  const c = await rig(t, {
    reviewGate: async () => ({ wait: text, findings: text, findingsKey: "k1" }),
    records: [rec],
    record: () => live,
  });
  c.set([c.agentPr(1)]);
  await c.watch.tick();
  assert.equal(c.woke.length, 0, "a live merge record is followed, not re-decided");
  live = { state: "failed", outcome: { text: "Not merged: acme/app#1: code review has open important findings" } };
  rec.state = "failed";
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "the record ended, so the findings wake the fixer");
  assert.match(c.woke[0].text, /open important findings/);
});

test("code review's open findings wake the task once per set of findings at a head; a running review wakes nobody", async (t) => {
  let text = "code review: finding one (a.ts:1)";
  const c = await rig(t, { reviewGate: async () => ({ wait: text, findings: text, findingsKey: text }), merge: () => [200, { id: "r1" }] });
  c.set([c.agentPr(1)]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.woke.length, 1, "the same findings at the same head wake once");
  assert.match(c.woke[0].text, /open important findings.*code_review_resolve/s);
  text = "code review: finding one (a.ts:1); finding two (b.ts:2)";
  await c.watch.tick();
  assert.equal(c.woke.length, 2, "new findings at the same head wake the task again");
  assert.equal(c.merges.length, 0, "no merge while code review waits");
  const running = await rig(t, { reviewGate: async () => ({ wait: "code review: the review is running" }), merge: () => [200, { id: "r1" }] });
  running.set([running.agentPr(6)]);
  await running.watch.tick();
  assert.deepEqual([running.woke.length, running.merges.length], [0, 0]);
  const passed = await rig(t, { reviewGate: async () => ({ pass: true }), merge: () => [200, { id: "r1" }] });
  passed.set([passed.agentPr(7)]);
  await passed.watch.tick();
  assert.equal(passed.merges.length, 1, "code review's pass is the review: merged with no GitHub approval");
});


// The rollup's CheckRun `id` is the check run's GraphQL node id; REST's `node_id` is the same value. A wedged check is the
// merge's when the rollup shows that very check run pending, never a newer check run that merely shares its display name.
test("a wedged check is matched to the rollup by node id, so a same-named newer check does not wake the task", async (t) => {
  const rollup = { state: "PENDING", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", id: "CR_new", databaseId: 77, name: "image-changes", status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } },
  ] } };
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t, {
    // REST still lists the old run as unfinished; the rollup now holds the newer one under the same display name.
    restRuns: (head) => [{ id: 77, node_id: "CR_old", name: "image-changes", status: "in_progress", app: { slug: "github-actions" }, check_suite: { id: 500 }, details_url: `https://github.com/acme/app/actions/runs/500/job/77` }],
  });
  c.set([c.agentPr(50, { commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } })]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h50:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h50:77": asked },
  } }));
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.woke.filter((w) => /merge gate is held/.test(w.text)).length, 0, "the newer check run is not the wedged one");
  assert.equal(c.woke.length, 0);
});

test("a red named check beats a wedged pending one: no wake claims the merge gate is held", async (t) => {
  const rollup = { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", id: "CR_77", databaseId: 77, name: "image-changes", status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } },
    { __typename: "CheckRun", id: "CR_78", databaseId: 78, name: "unit", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } },
  ] } };
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t, {
    restRuns: () => [{ id: 77, node_id: "CR_77", name: "image-changes", status: "in_progress", app: { slug: "github-actions" }, check_suite: { id: 500 }, details_url: `https://github.com/acme/app/actions/runs/500/job/77` }],
  });
  c.set([c.agentPr(51, { commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } })]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h51:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h51:77": asked },
  } }));
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.woke.filter((w) => /merge gate is held/.test(w.text)).length, 0, "a red head is the red-head rules' to wake, not the wedge report's");
  // The failure is still actionable while another check is pending, so the task hears about it, without the leave-it-alone advice.
  assert.equal(c.woke.length, 1, "the mixed red/wedged head wakes once about the failure");
  assert.match(c.woke[0].text, /required checks are red at head/);
  assert.doesNotMatch(c.woke[0].text, /Leave the head alone/);
});

// PROBES_PER_PASS Actions job reads per PR on the recovery paths: later PRs are still scanned in the same tick.
test("recovery probes are bounded per PR, so a PR with many unfinished checks does not hold the next PR's merge", async (t) => {
  const many = (n) => ({ state: "PENDING", contexts: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: n }, (_, i) => ({ __typename: "CheckRun", id: `CR_${i + 1}`, databaseId: i + 1, name: `job-${i + 1}`, status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } })) } });
  const c = await rig(t);
  // The first PR (oldest) has 12 unfinished checks; the second is green and must still have its merge filed this tick.
  c.set([c.agentPr(54, { commits: { nodes: [{ commit: { statusCheckRollup: many(12) } }] }, headRefOid: "h54" }), c.agentPr(55)]);
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => /^GET \/repos\/acme\/app\/actions\/jobs\/\d+$/.test(g)).length, 10 - 2, "its budget less the failed-check reserve, then the rest wait for the next tick");
  assert.equal(c.merges.length, 1, "the green PR's merge is still filed in the same pass");
});

// 06e6998984655358: the re-run is posted to the job's own REST run_id, never the rollup's 32-bit workflowRun.databaseId.
test("a never-started re-run is posted to the job's REST run id, not the rollup's truncated one", async (t) => {
  const c = await rig(t, { steps: [], gigRun: () => 3000000000 });
  // The rollup's databaseId (500) is what the old code would have used; 3000000000 does not fit a 32-bit Int.
  c.set([c.agentPr(63, redPr(63))]);
  await c.watch.tick();
  assert.ok(c.gh.includes("POST /repos/acme/app/actions/runs/3000000000/rerun-failed-jobs"), "the job's REST run id is the re-run's target");
  assert.ok(!c.gh.includes("POST /repos/acme/app/actions/runs/500/rerun-failed-jobs"), "the rollup's databaseId is never the target");
});

// 335094309b3b3ef9: a draft is refused by the gate before any check is read, so no "the gate is held" wake, and the
// once-per-head report is not spent: marking it ready later still reports.
test("a draft PR gets no held-merge wake, and a ready one does", async (t) => {
  const c = await rig(t);
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  c.set([c.agentPr(67, { ...stuckPr(67), isDraft: true })]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h67:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h67:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 0, "the gate refuses a draft before it reads a check: nothing to report as holding it");
  c.set([c.agentPr(67, { ...stuckPr(67), isDraft: false })]);
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "marked ready, the same wedge now holds the merge and is reported");
  assert.match(c.woke[0].text, /merge gate is held by it/);
});

// f31048674ac8c6c3: a failed check beside a wedged one is actionable, so the wake names the failure instead of "leave it alone".
test("a red check beside a wedged one wakes the task about the failure, not with leave-it-alone advice", async (t) => {
  const rollup = (red) => ({ state: red ? "FAILURE" : "PENDING", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", id: "CR_77", databaseId: 77, name: "image-changes", status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } },
    ...(red ? [{ __typename: "CheckRun", id: "CR_78", databaseId: 78, name: "unit", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } }] : []),
  ] } });
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t, { restRuns: () => [{ id: 77, node_id: "CR_77", name: "image-changes", status: "in_progress", app: { slug: "github-actions" }, check_suite: { id: 500 }, details_url: "https://github.com/acme/app/actions/runs/500/job/77" }] });
  c.set([c.agentPr(68, { commits: { nodes: [{ commit: { statusCheckRollup: rollup(true) } }] } })]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h68:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h68:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "the mixed state wakes the task");
  assert.match(c.woke[0].text, /required checks are red at head/, "the actionable failure is named");
  assert.doesNotMatch(c.woke[0].text, /Leave the head alone/, "not the leave-it-alone advice");
});

// self-review: changes requested fails the gate before any check is read, so no wake claims a wedged check holds the merge.
test("a head with changes requested gets no held-merge wake for its wedged check", async (t) => {
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t);
  c.set([c.agentPr(70, { ...stuckPr(70), reviewDecision: "CHANGES_REQUESTED" })]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h70:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h70:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "changes requested: a fix_review wake, not the wedge's");
  assert.doesNotMatch(c.woke[0].text, /merge gate is held/, "the gate refuses the review state first: the wedge is not what holds the merge");
  const latest = await rig(t);
  latest.set([latest.agentPr(71, { ...stuckPr(71), latestOpinionatedReviews: { nodes: [{ state: "CHANGES_REQUESTED" }] } })]);
  writeFileSync(join(latest.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h71:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h71:77": asked },
  } }));
  await latest.watch.tick();
  assert.doesNotMatch(latest.woke[0]?.text ?? "", /merge gate is held/, "the opinionated reviews' state counts too, exactly as merge-gate reads it");
});

// self-review: a red check whose job never started is the environment's: re-run it, never wake the task to push.
test("a never-started red beside a wedged check is re-run, not woken as a fix-and-publish", async (t) => {
  const rollup = { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", id: "CR_77", databaseId: 77, name: "image-changes", status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } },
    { __typename: "CheckRun", id: "CR_78", databaseId: 78, name: "unit", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } },
  ] } };
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  // The red job 78 has no steps: it never started, so the environment owns it (the rig's default `steps` is empty for that job).
  const c = await rig(t, { steps: [] });
  c.set([c.agentPr(72, { commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } })]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h72:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h72:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 0, "a never-started red is the environment's: the re-run is its fix, not a push");
  assert.ok(c.gh.includes("POST /repos/acme/app/actions/runs/500/rerun-failed-jobs"), "its failed jobs are re-run instead");
});

// self-review: an unreadable check-runs listing leaves the classification pending, so no red-head wake for a failure CI may
// never have run. The next tick reads it and re-runs the job.
test("a failed listing defers the red-head wake instead of fixing a failure CI may not have run", async (t) => {
  let broken = true;
  const c = await rig(t, { steps: [], restRuns: () => { if (broken) throw new Error("The operation was aborted due to timeout"); return [{ id: 77, node_id: `CR_77`, name: "test", status: "completed", app: { slug: "github-actions" }, check_suite: { id: 500 }, details_url: "https://github.com/acme/app/actions/runs/500/job/77" }]; } });
  c.set([c.agentPr(77, redPr(77))]);
  await c.watch.tick();
  assert.equal(c.woke.length, 0, "an unread list is not proof the failure is the code's");
  broken = false;
  await c.watch.tick();
  assert.ok(c.gh.includes("POST /repos/acme/app/actions/runs/500/rerun-failed-jobs"), "the next pass judges it and re-runs the never-started job");
  assert.equal(c.woke.length, 0, "still no wake: the job never started");
});

// self-review: a cancelled task's PR is left for a successor, never woken for its checks' state first, and never closed.
test("a cancelled task's wedged PR is neither woken nor closed", async (t) => {
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t, { taskStatus: "cancelled" });
  c.set([c.agentPr(81, stuckPr(81))]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h81:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h81:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 0, "a cancelled task has nobody to wake");
  assert.equal(c.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/81").length, 0, "the PR is left open for a successor");
  assert.ok(!c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b81"), "and its branch is not deleted");
});

// self-review: a wedged REST check the head's rollup no longer shows does not make the mixed-state report fire.
test("a stale REST wedged check absent from the rollup does not wake a red head", async (t) => {
  const rollup = { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", id: "CR_90", databaseId: 90, name: "image-changes", status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } },
    { __typename: "CheckRun", id: "CR_78", databaseId: 78, name: "unit", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } },
  ] } };
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  // REST lists an old check (77) that the rollup no longer has; the head's own check is 90.
  const c = await rig(t, { steps: [{ name: "Build" }], restRuns: () => [{ id: 77, node_id: "CR_77", name: "image-changes", status: "in_progress", app: { slug: "github-actions" }, check_suite: { id: 500 }, details_url: "https://github.com/acme/app/actions/runs/500/job/77" }] });
  c.set([c.agentPr(86, { commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } })]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h86:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h86:77": asked },
  } }));
  await c.watch.tick();
  assert.ok(!c.woke.some((w) => /Fix the failure on the PR's branch/.test(w.text ?? "")), "a stale wedged check is not this head's");
});

// f860612ff95e4e6a: a later attempt is a replacement only of the workflow run that was re-run, never of a same-named sibling.
test("a same-named job on another workflow run is not taken as the re-run's replacement", async (t) => {
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  // The ledger's ask was for job 77 of run 500; REST now lists a different job, 78, on attempt 2 of run 600. It merely shares
  // the suite and display name, so it is a job of its own and must get its own ask.
  const c = await rig(t, { gigRun: () => 600, job: { run_attempt: 2 },
    restRuns: () => [{ id: 78, node_id: "CR_78", name: "image-changes", status: "in_progress", app: { slug: "github-actions" }, check_suite: { id: 500 }, details_url: "https://github.com/acme/app/actions/runs/600/job/78" }] });
  c.set([c.agentPr(89, stuckPr(89, 78))]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h89:500:image-changes": { at: asked, accepted: true, job: 77, run: 500 } },
    reran: { "acme/app:h89:77": asked },
  } }));
  await c.watch.tick();
  assert.ok(c.gh.includes("POST /repos/acme/app/actions/jobs/78/rerun"), "another run's job is its own check and gets its own ask");
});

// self-review: a PR the lifecycle rule is about to close as superseded spends no CI and wakes nobody.
test("a superseded PR's wedged check is neither re-run nor reported", async (t) => {
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t);
  // Both PRs belong to one task: 93 is the newer branch it published, so 92 is superseded.
  notePrTask(c.cacheDir, "https://github.com/acme/app/pull/93", { task: "ACME-92", branch: "b93" });
  c.set([c.agentPr(92, stuckPr(92)), pr(93, { author: { __typename: "Bot", login: "aidenhq" } })]);
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h92:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h92:77": asked },
  } }));
  await c.watch.tick();
  assert.ok(c.gh.includes("PATCH /repos/acme/app/pulls/92"), "the older PR is closed as superseded");
  assert.equal(c.woke.filter((w) => /pull\/92/.test(w.text ?? "")).length, 0, "a PR about to be closed is not woken for its checks");
  assert.ok(!c.gh.some((g) => g.startsWith("POST /repos/acme/app/actions/jobs/")), "no recovery run is spent on it");
});



// A done task's cleanup closes the PR and would delete the branch: a tip that moved since this PR's head, any open PR on the
// branch, or a read that failed keeps the branch (deleting one that may be in use is unrecoverable).
test("a done task's PR whose head branch moved since its head is closed but never branch-deleted", async (t) => {
  // The branch's tip is a successor's push, not this PR's head any more: a delete would destroy that work.
  const c = await rig(t, { taskStatus: "done", refTip: () => "h4-successor" });
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  c.set([c.agentPr(4, { headRefOid: "h4" })]);
  seen(c.cacheDir, [4], old);
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/4").length, 1, "the done PR is still closed");
  assert.ok(!c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b4"), "a moved tip keeps the branch");
  // Any open PR still using the branch keeps it too, and so does a read that failed.
  const shared = await rig(t, { taskStatus: "done", branchUses: () => [{ number: 9 }] });
  shared.set([shared.agentPr(6)]);
  seen(shared.cacheDir, [6], old);
  await shared.watch.tick();
  assert.ok(!shared.gh.includes("DELETE /repos/acme/app/git/refs/heads/b6"), "another open PR on the branch keeps it");
  const blind = await rig(t, { taskStatus: "done", refTip: () => ({ throw: new Error("timeout") }) });
  blind.set([blind.agentPr(7)]);
  seen(blind.cacheDir, [7], old);
  await blind.watch.tick();
  assert.ok(!blind.gh.some((g) => g.startsWith("DELETE")), "a branch whose tip could not be read is not deleted");
});

// Two PRs from one task into different bases are different proposals: the task's newer PR into main does not supersede its PR
// into a release branch (closing it would take a release back out of the train).
test("a PR into another base is not closed as superseded by the task's newer PR into main", async (t) => {
  const c = await rig(t);
  c.set([c.agentPr(23, { baseRefName: "release-1", checks: "PENDING" }), pr(24, { author: { __typename: "Bot", login: "aidenhq" }, checks: "PENDING" })]);
  notePrTask(c.cacheDir, "https://github.com/acme/app/pull/24", { task: "ACME-23", branch: "b24" });
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/23").length, 0, "the release PR is not superseded by the main PR");
  assert.ok(!c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b23"), "and its branch stays");
});

// A `ship-pr-<n>` branch is ship's own scratch checkout of an adopted PR, not a replacement for it: a PR on one must never make
// the PR it was checked out from look superseded (that closed #1879 as "superseded by #1881" and deleted its branch, unmerged).
test("an adopted PR is not closed as superseded by a newer PR on ship's own scratch branch", async (t) => {
  const c = await rig(t);
  notePrTask(c.cacheDir, "https://github.com/acme/app/pull/93", { task: "ACME-92", branch: "ship-pr-92" });
  c.set([c.agentPr(92), pr(93, { headRefName: "ship-pr-92", author: { __typename: "Bot", login: "aidenhq" } })]);
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/92").length, 0, "the adopted PR is not closed as superseded by a scratch-branch PR");
  assert.ok(!c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b92"), "and its branch stays");
});

// The guard is narrow: the same task's newer PR on an ordinary branch still supersedes the older one, as before.
test("an adopted PR is still closed as superseded by the same task's newer PR on an ordinary branch", async (t) => {
  const c = await rig(t);
  notePrTask(c.cacheDir, "https://github.com/acme/app/pull/93", { task: "ACME-92", branch: "b93" });
  c.set([c.agentPr(92), pr(93, { headRefName: "b93", author: { __typename: "Bot", login: "aidenhq" } })]);
  await c.watch.tick();
  assert.ok(c.gh.includes("PATCH /repos/acme/app/pulls/92"), "the older PR is closed as superseded");
  assert.ok(c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b92"), "and its branch goes with it");
});

// self-review: a run GitHub already took a re-run for is not asked again when another run at the head was refused.
test("an accepted re-run is remembered per run, so a refused sibling run's retry never re-posts it", async (t) => {
  const c = await rig(t, { steps: [], gigRun: (id) => (id === 77 ? 500 : 600), rerun: () => 502 });
  const twoRuns = { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", id: "CR_77", databaseId: 77, name: "a", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } },
    { __typename: "CheckRun", id: "CR_78", databaseId: 78, name: "b", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 600 } } },
  ] } };
  c.set([c.agentPr(95, { commits: { nodes: [{ commit: { statusCheckRollup: twoRuns } }] } })]);
  await c.watch.tick();
  const posts = (run) => c.gh.filter((g) => g === `POST /repos/acme/app/actions/runs/${run}/rerun-failed-jobs`).length;
  assert.deepEqual([posts(500), posts(600)], [1, 1], "the first pass asks each run once");
  // 500 was accepted; 600 was refused, so only 600 is retried after its backoff.
  const db = JSON.parse(readFileSync(join(c.cacheDir, "loop.json"), "utf8"));
  db["acme/app"].reranRuns = { "acme/app:h95:500": new Date().toISOString() };
  db["acme/app"].reran = { "https://github.com/acme/app/pull/95:h95": `retry:${new Date(Date.now() - 60_000).toISOString()}` };
  writeFileSync(join(c.cacheDir, "loop.json"), JSON.stringify(db));
  await c.watch.tick();
  assert.deepEqual([posts(500), posts(600)], [1, 2], "the accepted run is never posted again; the refused one is retried");
});

test("a stack A←B: B waits on #A; once A merges, B is retargeted onto main and then merged", async (t) => {
  let open = [];
  const writes = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/v1/writes") { writes.push(JSON.parse(body)); return res.writeHead(200).end(JSON.stringify({ id: `w${writes.length}`, state: "claimed" })); }
    if (req.url.startsWith("/v1/writes/")) return res.writeHead(200).end(JSON.stringify({ state: "claimed" }));
    res.writeHead(200).end(JSON.stringify(req.url.startsWith("/v1/work") ? { status: "in_progress", records: [] } : {}));
  });
  t.after(() => kernel.s.close());
  const updated = [];
  const gh = async (method, path) => {
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    if (path.endsWith("/update-branch")) { updated.push(path); return { status: 202, body: {} }; }
    if (path === "/repos/acme/app/pulls/1") return { status: 200, body: { state: "closed", merged_at: "2026-11-25T10:00:00Z", html_url: "https://github.com/acme/app/pull/1", head: { sha: "h1" }, base: { ref: "main" }, user: { login: "aidenhq", type: "Bot" } } };
    return { status: 200, body: {} };
  };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repos: [{ repo: "acme/app", duties: "all" }], kernelUrl: kernel.url, key: "k", cacheDir, gh });
  const agent = { author: { __typename: "Bot", login: "aidenhq" } };
  notePrTask(cacheDir, "https://github.com/acme/app/pull/1", { task: "ACME-1", branch: "bA" });
  notePrTask(cacheDir, "https://github.com/acme/app/pull/2", { task: "ACME-2", branch: "bB" });
  const A = pr(1, { ...agent, headRefName: "bA" }), B = pr(2, { ...agent, headRefName: "bB", baseRefName: "bA" });
  const of = (kind, n) => writes.filter((w) => w.kind === kind && (w.args.number ?? w.args.prs?.[0]?.number) === n);

  open = [B, A];
  await watch.tick();
  assert.equal(of("github.merge", 1).length, 1, "A, on main, merges");
  assert.equal(writes.filter((w) => (w.args.number ?? w.args.prs?.[0]?.number) === 2).length, 0, "B waits on #1");
  open = [B]; // A merged
  await watch.tick();
  assert.deepEqual(of("github.retarget", 2).map((w) => [w.task, w.args.base, w.args.to, w.args.head]), [["ACME-2", "bA", "main", "h2"]], "B goes onto main once");
  await watch.tick();
  assert.equal(of("github.retarget", 2).length, 1, "once per head");
  open = [{ ...B, baseRefName: "main" }]; // retargeted
  await watch.tick();
  assert.deepEqual([updated, of("github.merge", 2).length], [["/repos/acme/app/pulls/2/update-branch"], 0], "main is merged in first: never merged on the old diff");
  await watch.tick(); // GitHub took the update but the head hasn't moved yet
  assert.deepEqual([updated.length, of("github.merge", 2).length], [1, 0], "nothing moves on the old head, and the update isn't asked twice");
  open = [{ ...B, baseRefName: "main", headRefOid: "h2b" }]; // the updated head, reviewed whole
  await watch.tick();
  assert.deepEqual(of("github.merge", 2).map((w) => [w.args.prs[0].base, w.args.prs[0].head]), [["main", "h2b"]], "then the normal path: merged into main");
});

test("a stack GitHub retargeted itself (the parent's branch deleted) still brings main in first; a conflict there goes to the repair", async (t) => {
  let open = [], update = 202;
  const writes = [], updated = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/v1/writes") { writes.push(JSON.parse(body)); return res.writeHead(200).end(JSON.stringify({ id: `w${writes.length}`, state: "claimed" })); }
    if (req.url.startsWith("/v1/writes/")) return res.writeHead(200).end(JSON.stringify({ state: "claimed" }));
    res.writeHead(200).end(JSON.stringify(req.url.startsWith("/v1/work") ? { status: "in_progress", records: [] } : {}));
  });
  t.after(() => kernel.s.close());
  const gh = async (method, path) => {
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    if (path.endsWith("/update-branch")) { updated.push(path); return { status: update, body: update === 422 ? { message: "merge conflict between base and head" } : {} }; }
    if (path.includes("/git/trees/")) return { status: 200, body: { tree: [] } };
    return { status: 200, body: {} };
  };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repos: [{ repo: "acme/app", duties: "all" }], kernelUrl: kernel.url, key: "k", cacheDir, gh });
  const agent = { author: { __typename: "Bot", login: "aidenhq" } };
  notePrTask(cacheDir, "https://github.com/acme/app/pull/1", { task: "ACME-1", branch: "bA" });
  notePrTask(cacheDir, "https://github.com/acme/app/pull/2", { task: "ACME-2", branch: "bB" });
  const A = pr(1, { ...agent, headRefName: "bA", checks: "PENDING" }), B = pr(2, { ...agent, headRefName: "bB", baseRefName: "bA" });
  open = [B, A];
  await watch.tick();
  open = [{ ...B, baseRefName: "main" }]; // A merged, its branch deleted: GitHub moved B itself
  await watch.tick();
  assert.deepEqual([updated, writes.filter((w) => w.kind === "github.retarget").length, writes.filter((w) => w.kind === "github.merge").length], [["/repos/acme/app/pulls/2/update-branch"], 0, 0], "main brought in first, never merged on the old head");
  // The same with a conflict: GitHub refuses the update, and the repair makes the new head.
  const c = { ...B, number: 3, url: "https://github.com/acme/app/pull/3", headRefName: "bC", headRefOid: "h3" };
  notePrTask(cacheDir, "https://github.com/acme/app/pull/3", { task: "ACME-3", branch: "bC" });
  open = [c, A];
  await watch.tick();
  update = 422;
  open = [{ ...c, baseRefName: "main", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }];
  await watch.tick();
  assert.equal(writes.filter((w) => w.kind === "github.repair" && w.args.number === 3).length, 1, "the conflict goes to ship's repair, not a hold");
});

test("the change feed drives the passes: every repo once at the start, then a repo an event names; a pass that asks is read again when due; paused, nothing is read", async () => {
  let t = 1_000_000, paused = false;
  const passed = [], log = [];
  const due = 3 * RETRY_MS;
  const next = { "acme/app": due };
  const loop = { repos: ["acme/app", "other/lib"], pass: async (r) => { passed.push(r); if (r === "other/lib" && log.length === 0) { log.push(1); throw new Error("GitHub 502"); } return next[r]; } };
  const queue = [];
  let seq = 0;
  const feed = followFeed(loop, { now: () => t, paused: () => paused, feed: async (after) => after === undefined ? { events: [], next: seq, gap: false } : { events: queue.splice(0).map((e) => ({ seq: ++seq, ...e })), next: seq, gap: false } });
  feed.stop();
  await feed.pump();
  assert.deepEqual(passed.splice(0), ["acme/app", "other/lib"], "the start reads every repo");
  await feed.pump();
  assert.deepEqual(passed.splice(0), [], "nothing changed, nothing is due");
  queue.push({ resource: "Other/Lib", kind: "pull_request.synchronize" }, { resource: "other/lib", kind: "check_run.completed" }, { resource: "elsewhere/x", kind: "push" });
  await feed.pump();
  assert.deepEqual(passed.splice(0), ["other/lib"], "one pass for the repo the events name");
  t += RETRY_MS; await feed.pump();
  assert.deepEqual(passed.splice(0), [], "a repo read fine waits for its next event");
  t += due - RETRY_MS; await feed.pump();
  assert.deepEqual(passed.splice(0), ["acme/app"], "a pass that asked to be read again is, when due");
  paused = true;
  queue.push({ resource: "acme/app", kind: "pull_request.closed" });
  await feed.pump();
  assert.deepEqual([passed.splice(0), queue.length], [[], 1], "paused: the log isn't read");
  paused = false;
  await feed.pump();
  assert.deepEqual(passed.splice(0), ["acme/app", "other/lib"], "a resume reads every repo");
});

test("a head's checks are probed at most every five minutes however often the loop reads; a changed head or a failed read is probed again", async () => {
  const calls = [];
  let listFails = false;
  const gh = async (method, path) => {
    calls.push(path);
    if (path.includes("/check-runs")) return listFails ? { status: 500, body: {} } : { status: 200, body: { total_count: 1, check_runs: [{ id: 1, node_id: "CR_1", name: "a", status: "queued", app: { slug: "github-actions" }, details_url: "https://github.com/acme/app/actions/runs/5/job/9", check_suite: { id: 3 } }] } };
    return { status: 200, body: { status: "queued", head_sha: "h1", check_run_url: "https://api.github.com/repos/acme/app/check-runs/1" } };
  };
  const recover = ciRecover({ gh, log() {} });
  const state = {};
  const queued = (head) => ({ url: "https://github.com/acme/app/pull/1", isCrossRepository: false, mergeable: "MERGEABLE", headRefOid: head, commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", id: "CR_1", name: "a", status: "QUEUED", conclusion: null }] } } } }] } });
  await recover("acme/app", queued("h1"), state, () => {});
  const first = calls.length;
  assert.ok(first >= 2, "the first pass lists the checks and reads the queued job");
  await recover("acme/app", queued("h1"), state, () => {});
  assert.equal(calls.length, first, "a second pass within five minutes reads nothing");
  await recover("acme/app", queued("h2"), state, () => {});
  assert.ok(calls.length > first, "a new head is probed at once");
  const n = calls.length;
  state.probed["https://github.com/acme/app/pull/1"].at -= 6 * 60_000;
  listFails = true;
  await recover("acme/app", queued("h2"), state, () => {});
  assert.ok(calls.length > n, "five minutes on it is probed again");
  const m = calls.length;
  await recover("acme/app", queued("h2"), state, () => {});
  assert.ok(calls.length > m, "a failed read is not stamped: the next pass reads again");
  assert.equal((await recover("acme/app", queued("h2"), state, () => {})).again, true, "and the loop is told to read the repo again");
});

test("the watch set comes from Ship's own entries: a repo ship works gets every duty; one it doesn't, only its Dependabot duty while that is on", () => {
  const settings: Record<string, { enabled: boolean; dependabot: "off" | "failing" | "all" }> = {
    "acme/product": { enabled: true, dependabot: "all" }, "on/repo": { enabled: true, dependabot: "off" },
    "off/bumps": { enabled: false, dependabot: "failing" }, "off/quiet": { enabled: false, dependabot: "off" }, "off/tracked": { enabled: false, dependabot: "off" },
  };
  const set = Object.fromEntries(watchSet({ repos: ["acme/product", "on/repo", "On/Repo", "off/bumps", "off/quiet", "off/tracked", "no/entry"], settings: (r) => settings[r] ?? null, tracked: (r) => r === "off/tracked" }));
  assert.deepEqual(set, {
    "acme/product": { duties: "all", dependabot: "all" },
    "on/repo": { duties: "all", dependabot: "off" },
    "off/bumps": { duties: "dependabot", dependabot: "failing" },
    "off/tracked": { duties: "dependabot", dependabot: "off" }, // polled only to close the tasks it filed
  });
});

test("a list page that times out is retried at half the size, the size is kept, and a quick page grows it back", async (t) => {
  const sizes = [];
  let full = false;
  const gh = async (method, path, body) => {
    if (path !== "/graphql") return { status: 404, body: {} };
    sizes.push(body.variables.first);
    // A heavy page fails as a 504 or as a 200 with no PR list; GitHub is quick again once pages are full.
    if (!full && body.variables.first > 10) return body.variables.first === 25 ? { status: 200, body: {} } : { status: 504, body: {} };
    // A full page (more to come) is what may grow the size; the empty last page after it isn't.
    const more = full && !body.variables.after;
    return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { pageInfo: { hasNextPage: more, endCursor: more ? "c1" : null }, nodes: [] } } } } };
  };
  const m = await multi(t, [{ repo: "acme/app", duties: "all" }], {}, { gh });
  await m.watch.tick();
  assert.deepEqual(sizes, [50, 25, 12, 6], "halved at once until a page answered");
  assert.equal(JSON.parse(readFileSync(join(m.cacheDir, "loop.json"), "utf8"))["acme/app"].pageSize, 6);
  await m.watch.tick();
  assert.deepEqual(sizes.slice(4), [6], "the next read starts at the kept size");
  assert.equal(JSON.parse(readFileSync(join(m.cacheDir, "loop.json"), "utf8"))["acme/app"].pageSize, 6, "no growth right after a shrink");
  const db = JSON.parse(readFileSync(join(m.cacheDir, "loop.json"), "utf8"));
  db["acme/app"].shrunkAt = Date.now() - 11 * 60_000;
  writeFileSync(join(m.cacheDir, "loop.json"), JSON.stringify(db));
  await m.watch.tick();
  assert.equal(JSON.parse(readFileSync(join(m.cacheDir, "loop.json"), "utf8"))["acme/app"].pageSize, 6, "a quick but short page doesn't grow it");
  full = true;
  await m.watch.tick();
  assert.equal(JSON.parse(readFileSync(join(m.cacheDir, "loop.json"), "utf8"))["acme/app"].pageSize, 12, "a quick full page doubles it once the cooldown passed");
});
