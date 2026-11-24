// The product-PR watcher end to end against a fake GitHub and a fake kernel (ported from the runner's flow-product cases):
// a Dependabot PR becomes one task for the platform-engineer role once its checks finish, and that task closes when the PR is
// gone; an agent's PR (one this service opened) that conflicts with main wakes its task once, with fixed text only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notePrTask, startPrWatch } from "../service/src/pr-watch.ts";

const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const checks = (status) => ({ state: status === "PENDING" ? "PENDING" : "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "test", status: status === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: status === "PENDING" ? null : "SUCCESS" }] } });
const pr = (n, o = {}) => ({ number: n, url: `https://github.com/acme/app/pull/${n}`, isDraft: false, mergeable: "MERGEABLE", isCrossRepository: false, headRefName: `b${n}`, headRefOid: `h${n}`, author: { __typename: "Bot", login: "dependabot" }, commits: { nodes: [{ commit: { statusCheckRollup: checks(o.checks ?? "SUCCESS") } }] }, ...o });

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
  t.after(() => watch.stop());
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
  assert.equal(wakes().length, 1);
  assert.equal(wakes()[0].body.task, "ACME-7");
  assert.match(wakes()[0].body.text, /pull\/9 now conflicts with `main`/);
  await watch.tick();
  mainOid = "m2"; // main moved: still under half an hour since the last ask
  await watch.tick();
  assert.equal(wakes().length, 1, "once per head of main and half hour");
});

test("an agent's green mergeable PR wakes its task to merge once per head", async (t) => {
  let open = [];
  const wakes = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/v1/wakes") wakes.push(JSON.parse(body));
    res.writeHead(200).end("{}");
  });
  t.after(() => kernel.s.close());
  const gh = async (m, path) => path === "/graphql"
    ? { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } }
    : { status: 404, body: {} };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repos: [{ repo: "acme/app", duties: "all" }], kernelUrl: kernel.url, key: "k", cacheDir, gh });
  t.after(() => watch.stop());
  notePrTask(cacheDir, "https://github.com/acme/app/pull/5", { task: "ACME-5", branch: "b5" });
  const agent = { author: { __typename: "Bot", login: "aidenhq" } };

  open = [pr(5, { ...agent, checks: "PENDING" })];
  await watch.tick();
  assert.equal(wakes.length, 0, "not while checks run");
  open = [pr(5, agent)];
  await watch.tick();
  await watch.tick();
  assert.equal(wakes.length, 1, "once per head");
  assert.equal(wakes[0].task, "ACME-5");
  assert.match(wakes[0].text, /aidenhq merge https:\/\/github.com\/acme\/app\/pull\/5 h5/);
});

// Flow: any PR's CI (the owner's too, not only an agent's) and its merge, whoever merged it (here the owner on GitHub, not the queue).
test("an owner's PR records its CI per head and its merge once it leaves the open list", async (t) => {
  let open = [];
  const kernel = await listen(async (req, res) => { for await (const _ of req); res.writeHead(200).end("{}"); });
  t.after(() => kernel.s.close());
  const merged = { state: "closed", merged_at: "2026-11-20T10:05:00Z", merge_commit_sha: "s7", head: { sha: "h7" }, title: "feat: x", body: "" };
  const gh = async (m, path) => path === "/graphql"
    ? { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } }
    : path === "/repos/acme/app/pulls/7" ? { status: 200, body: merged } : { status: 404, body: {} };
  const got = [];
  const rec = (name) => (...a) => void got.push([name, ...a]);
  const flow = { opened: rec("opened"), pushed: rec("pushed"), closed: rec("closed"), merged: rec("merged"), checksStarted: rec("started"), checksCompleted: rec("completed"), authored: async () => ({ author: "owner", author_kind: "owner" }) };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repos: [{ repo: "acme/app", duties: "all" }], kernelUrl: kernel.url, key: "k", cacheDir, gh, flow });
  t.after(() => watch.stop());
  const run = (status, o = {}) => ({ __typename: "CheckRun", name: "test", status, conclusion: status === "COMPLETED" ? "SUCCESS" : null, startedAt: "2026-11-20T10:01:00Z", ...o });
  const rollup = (nodes) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { pageInfo: { hasNextPage: false }, nodes } } } }] } });
  const owner = { author: { __typename: "User", login: "owner" }, createdAt: "2026-11-20T10:00:00Z" };

  open = [pr(7, { ...owner, ...rollup([run("IN_PROGRESS")]) })];
  await watch.tick();
  open = [pr(7, { ...owner, ...rollup([run("COMPLETED", { completedAt: "2026-11-20T10:04:00Z" })]) })];
  await watch.tick();
  await watch.tick();
  open = [];
  await watch.tick();
  assert.deepEqual(got.filter(([n]) => n !== "opened"), [
    ["started", "acme/app", 7, "h7", "2026-11-20T10:01:00.000Z", null],
    ["completed", "acme/app", 7, "h7", [], "2026-11-20T10:04:00.000Z", null],
    ["merged", "acme/app", 7, "h7", "s7", "2026-11-20T10:05:00.000Z", "feat: x", ""],
  ]);
});

// The behaviours ported from the runner, against one fake GitHub and kernel: each case is one agent PR (acme/app#N, task ACME-N).
const redChecks = (extra = {}) => ({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", databaseId: 77, name: "test", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } }, ...extra }] } });
async function rig(t, { taskStatus = "in_progress", behind = 0, steps = [{ name: "Build" }], job, jobRerun = () => 201, update = 202, updateBody, updateByMethod, wakeFails = 0, closeFails = 0, records = [], merge = () => [200, {}], reviewGate = undefined, mainBefore, rerun = () => 204, restRuns, jobRead = () => undefined, gigRun, listingStatus } = {}) {
  const woke = [], gh = [], merges = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/v1/wakes" && wakeFails-- > 0) return res.writeHead(503).end("{}");
    if (req.url === "/v1/wakes") woke.push(JSON.parse(body));
    if (req.url === "/v1/merges") { merges.push(JSON.parse(body)); const [status, answer] = merge(); return res.writeHead(status).end(JSON.stringify(answer)); }
    res.writeHead(200).end(JSON.stringify(req.url.startsWith("/v1/work") ? { status: taskStatus, records } : {}));
  });
  t.after(() => kernel.s.close());
  let open = [];
  const reran = new Set(); // job ids this head's re-run was asked for: GitHub posts their next attempt
  const jobProbeOpts = []; // the opts of each Actions job read: a probe must carry a deadline
  const headRunsOpts = []; // the opts of each REST check-runs listing: the recovery paths' first read carries one too
  const api = async (method, path, body, opts) => {
    gh.push(`${method} ${path}${body?.update_method ? ` ${body.update_method}` : ""}`);
    if (method === "GET" && /^\/repos\/acme\/app\/actions\/jobs\/\d+$/.test(path)) jobProbeOpts.push(opts ?? {});
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: mainBefore?.() ?? "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    // REST check runs for a head, as GitHub lists them: the full Actions job id is carried in details_url.
    const headRuns = path.match(/^\/repos\/acme\/app\/commits\/([^/?]+)\/check-runs/);
    if (headRuns) {
      headRunsOpts.push(opts ?? {});
      const refused = listingStatus?.();
      if (refused) return { status: refused, body: {} };
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
    if (method === "PATCH" && closeFails-- > 0) return { status: 502, body: {} };
    return { status: 200, body: {} };
  };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repos: [{ repo: "acme/app", duties: "all" }], kernelUrl: kernel.url, key: "k", cacheDir, gh: api, reviewGate });
  t.after(() => watch.stop());
  const agentPr = (n, o = {}) => { notePrTask(cacheDir, `https://github.com/acme/app/pull/${n}`, { task: `ACME-${n}`, branch: `b${n}` }); return pr(n, { author: { __typename: "Bot", login: "aidenhq" }, ...o }); };
  return { woke, gh, merges, watch, cacheDir, agentPr, jobProbeOpts, headRunsOpts, set: (v) => { open = v; }, behind: (v) => { behind = v; update = 422; } };
}
const redPr = (n, o = {}) => ({ commits: { nodes: [{ commit: { statusCheckRollup: redChecks() } }] }, ...o });

test("a cancelled task's PR is closed with its branch once; a done task's unmerged PR once its head is old and no merge is open", async (t) => {
  const c = await rig(t, { taskStatus: "cancelled" });
  c.set([c.agentPr(1)]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/1").length, 1);
  assert.ok(c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b1"));
  const d = await rig(t, { taskStatus: "done" });
  d.set([d.agentPr(2)]);
  await d.watch.tick();
  assert.ok(!d.gh.some((g) => g.startsWith("PATCH")), "its head is new: a just-finished merge isn't raced");
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  const e = await rig(t, { taskStatus: "done", records: [{ kind: "github.merge", state: "claimed", args: { prs: [{ repo: "acme/app", number: 3, head: "h3" }] } }] });
  e.set([e.agentPr(2), e.agentPr(3)]);
  writeFileSync(join(e.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": { headAt: { "https://github.com/acme/app/pull/2": { head: "h2", at: old }, "https://github.com/acme/app/pull/3": { head: "h3", at: old } } } }));
  await e.watch.tick(); await e.watch.tick();
  assert.equal(e.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/2").length, 1, "done, unmerged and old: closed once");
  assert.ok(e.gh.includes("DELETE /repos/acme/app/git/refs/heads/b2"));
  assert.ok(!e.gh.includes("PATCH /repos/acme/app/pulls/3"), "a merge of it is in flight: left alone");
});

test("an agent PR red on its own head wakes its task once per head, and no PR gets more than 3 wakes at one head", async (t) => {
  const c = await rig(t);
  c.set([c.agentPr(3, redPr(3))]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.woke.length, 1);
  assert.match(c.woke[0].text, /pull\/3's checks failed at `h3`: `gh pr checks https:\/\/github.com\/acme\/app\/pull\/3` lists the failures/);
  const capped = await rig(t);
  capped.set([capped.agentPr(8, redPr(8))]);
  writeFileSync(join(capped.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": { wakes: { "https://github.com/acme/app/pull/8": { head: "h8", n: 3 } } } }));
  await capped.watch.tick();
  assert.equal(capped.woke.length, 1, "three wakes at this head: no more, but the asker is told once");
  assert.deepEqual([capped.woke[0].to, /Wake cap on ACME-8/.test(capped.woke[0].text)], ["asker", true]);
  await capped.watch.tick();
  assert.equal(capped.woke.length, 1, "told once per head");
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
  const db = JSON.parse(readFileSync(join(c.cacheDir, "pr-watch.json"), "utf8"));
  assert.match(String(db["acme/app"].reran[key]), /^retry:/, "a refusal is not recorded as a re-run");
  await c.watch.tick();
  assert.equal(asks(), 1, "inside the backoff nothing is asked again");
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": { ...db["acme/app"], reran: { [key]: `retry:${new Date(Date.now() - 60_000).toISOString()}` } } }));
  await c.watch.tick();
  assert.equal(asks(), 2, "past the backoff it is asked again instead of staying unhandled");
});

test("a check run still wedged 20 minutes after its re-run wakes its task once at that head, not again", async (t) => {
  const c = await rig(t);
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  c.set([c.agentPr(44, stuckPr(44))]);
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": { wedged: { "acme/app:h44:500:image-changes": { at: asked, accepted: true, job: 77 } } } }));
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
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": { wedged: { "acme/app:h46:500:image-changes": { at: new Date(Date.now() - 21 * 60_000).toISOString(), accepted: false, job: 77 } } } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 1);
  assert.match(c.woke[0].text, /the request to re-run the job was refused/);
  // A replacement job still queued or running is not stuck: nothing is reported for it.
  const running = await rig(t, { job: { status: "in_progress", completed_at: null } });
  running.set([running.agentPr(49, stuckPr(49))]);
  writeFileSync(join(running.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": { wedged: { "acme/app:h49:500:image-changes": { at: new Date(Date.now() - 21 * 60_000).toISOString(), accepted: true, job: 77 } } } }));
  await running.watch.tick();
  assert.equal(running.woke.length, 0, "a re-run still running is not a stuck check");
});

test("an Actions read that throws does not stop another PR's merge", async (t) => {
  let open = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const x of req) body += x;
    if (req.url === "/v1/wakes") return res.writeHead(200).end("{}");
    if (req.url === "/v1/merges") { merges.push(JSON.parse(body)); return res.writeHead(200).end(JSON.stringify({ filed: { id: "r1", tier: 0, state: "claimed" } })); }
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
  t.after(() => real.stop());
  notePrTask(cacheDir, "https://github.com/acme/app/pull/47", { task: "ACME-47", branch: "b47" });
  open = [pr(47, { author: { __typename: "Bot", login: "aidenhq" } }), pr(48, { ...stuckPr(48, 77), number: 48, url: "https://github.com/acme/app/pull/48", headRefOid: "h48", headRefName: "b48", author: { __typename: "Bot", login: "aidenhq" } })];
  await real.tick();
  const rows = JSON.parse(readFileSync(join(cacheDir, "pr-watch.json"), "utf8"))["acme/app"];
  assert.match(String(rows.reran?.["acme/app:h48:77"]), /^retry:/, "the unanswered read backs off instead of being lost");
  assert.deepEqual(merges.map((m) => m.number), [47], "the PR after it still reached its merge");
});


test("a check re-run GitHub refused is asked again rather than recorded as handled", async (t) => {
  const c = await rig(t, { steps: [], rerun: () => 502 });
  c.set([c.agentPr(33, redPr(33))]);
  await c.watch.tick();
  const db = JSON.parse(readFileSync(join(c.cacheDir, "pr-watch.json"), "utf8"));
  assert.match(String(db["acme/app"].reran["https://github.com/acme/app/pull/33:h33"]), /^retry:/, "a refusal is not recorded as a re-run");
  await c.watch.tick();
  const asks = () => c.gh.filter((g) => g === "POST /repos/acme/app/actions/runs/500/rerun-failed-jobs").length;
  assert.equal(asks(), 1, "inside the backoff nothing is asked again");
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": { ...db["acme/app"], reran: { "https://github.com/acme/app/pull/33:h33": `retry:${new Date(Date.now() - 6 * 60_000).toISOString()}` } } }));
  await c.watch.tick();
  assert.equal(asks(), 2, "past the backoff it is asked again instead of staying unhandled");
});

test("a behind, non-conflicting red PR is updated by GitHub, not woken; a refused update falls back to the wake", async (t) => {
  const c = await rig(t, { behind: 2 });
  c.set([c.agentPr(5, redPr(5))]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "PUT /repos/acme/app/pulls/5/update-branch rebase").length, 1);
  assert.equal(c.woke.length, 0);
  const d = await rig(t, { behind: 2, update: 422 });
  d.set([d.agentPr(6, redPr(6))]);
  await d.watch.tick();
  assert.ok(d.gh.includes("PUT /repos/acme/app/pulls/6/update-branch merge"));
  assert.equal(d.woke.length, 1);
  assert.match(d.woke[0].text, /Rebase the PR's branch onto `origin\/main`/);
  const e = await rig(t, { behind: 2, update: 502 });
  e.set([e.agentPr(7, redPr(7))]);
  await e.watch.tick(); await e.watch.tick();
  assert.equal(e.gh.filter((g) => g === "PUT /repos/acme/app/pulls/7/update-branch rebase").length, 1, "a 5xx is asked again after its backoff, not every tick");
  assert.equal(e.woke.length, 0, "no wake while the update will retry");
});

test("an update-branch refusal is retried unless it is permanent (a conflict or no permission), so a rate limit or a 5xx isn't final", async (t) => {
  // A 403 worded as a rate limit: not a refusal of the rebase, asked again after the backoff (not every tick, and no wake).
  const rate = await rig(t, { behind: 2, update: 403, updateBody: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." } });
  rate.set([rate.agentPr(11, redPr(11))]);
  await rate.watch.tick(); await rate.watch.tick();
  assert.equal(rate.gh.filter((g) => g === "PUT /repos/acme/app/pulls/11/update-branch rebase").length, 1, "asked once, then backed off");
  assert.equal(rate.woke.length, 0, "a rate limit is not final and wakes nobody while it retries");
  // A 5xx on both methods: still retryable, never cached as final for that head.
  const five = await rig(t, { behind: 2, update: 502 });
  five.set([five.agentPr(12, redPr(12))]);
  await five.watch.tick(); await five.watch.tick();
  assert.equal(five.gh.filter((g) => g === "PUT /repos/acme/app/pulls/12/update-branch rebase").length, 1, "a 5xx is retried after its backoff");
  assert.equal(five.woke.length, 0);
  // A 403 with no rate limit wording is no right to update: final at that head+base, and the task is woken to fix it.
  const denied = await rig(t, { behind: 2, update: 403, updateBody: { message: "Resource not accessible by integration" } });
  denied.set([denied.agentPr(14, redPr(14))]);
  await denied.watch.tick(); await denied.watch.tick();
  assert.equal(denied.gh.filter((g) => g === "PUT /repos/acme/app/pulls/14/update-branch rebase").length, 1, "no permission is final");
  assert.equal(denied.woke.length, 1);
  // The last method's answer decides: a "temporarily unavailable" 422 on the rebase followed by a real conflict on the merge
  // fallback is final, because the fallback's conflict is GitHub's word on the branch as it now stands.
  const mixed = await rig(t, { behind: 2, updateByMethod: { rebase: { status: 422, body: { message: "Update branch is temporarily unavailable" } }, merge: { status: 422, body: { message: "merge conflict between base and head" } } } });
  mixed.set([mixed.agentPr(15, redPr(15))]);
  await mixed.watch.tick(); await mixed.watch.tick();
  assert.deepEqual(mixed.gh.filter((g) => g.startsWith("PUT /repos/acme/app/pulls/15/update-branch")).map((g) => g.split(" ").pop()), ["rebase", "merge"], "both methods asked once, then final: no re-ask");
  assert.equal(mixed.woke.length, 1, "the fallback's conflict ends the attempt and wakes the task");
  // A conflict on the rebase but a retryable answer on the merge fallback is not final: the last method decides.
  const mixedRetry = await rig(t, { behind: 2, updateByMethod: { rebase: { status: 422, body: { message: "merge conflict between base and head" } }, merge: { status: 502, body: {} } } });
  mixedRetry.set([mixedRetry.agentPr(16, redPr(16))]);
  await mixedRetry.watch.tick(); await mixedRetry.watch.tick();
  assert.equal(mixedRetry.gh.filter((g) => g === "PUT /repos/acme/app/pulls/16/update-branch rebase").length, 1, "a 5xx on the fallback keeps it retryable");
  assert.equal(mixedRetry.woke.length, 0, "no wake while it retries");
  // And the reverse: a 5xx on the rebase followed by a permanent refusal on the merge fallback stays retryable. The 5xx says
  // nothing about whether asking again works, so a conflict on the fallback alone cannot make the attempt final.
  const mixedReverse = await rig(t, { behind: 2, updateByMethod: { rebase: { status: 502, body: {} }, merge: { status: 422, body: { message: "merge conflict between base and head" } } } });
  mixedReverse.set([mixedReverse.agentPr(17, redPr(17))]);
  await mixedReverse.watch.tick(); await mixedReverse.watch.tick();
  assert.equal(mixedReverse.gh.filter((g) => g === "PUT /repos/acme/app/pulls/17/update-branch rebase").length, 1, "asked once, then backed off");
  assert.equal(mixedReverse.woke.length, 0, "a 5xx on the rebase is retryable: no wake and no final cache");
  // The last method's answer decides here too: an earlier permission refusal on the rebase followed by a "not now" on the merge
  // fallback is retried, never made final by the earlier method's refusal.
  const refused = await rig(t, { behind: 2, updateByMethod: { rebase: { status: 403, body: { message: "Resource not accessible by integration" } }, merge: { status: 422, body: { message: "Update branch is temporarily unavailable" } } } });
  refused.set([refused.agentPr(18, redPr(18))]);
  await refused.watch.tick(); await refused.watch.tick();
  assert.deepEqual(refused.gh.filter((g) => g.startsWith("PUT /repos/acme/app/pulls/18/update-branch")).map((g) => g.split(" ").pop()), ["rebase", "merge"], "asked once, then backed off: not re-asked on the next tick");
  assert.equal(refused.woke.length, 0, "the fallback's transient answer keeps the attempt retryable");
  // A request that never answered (a timeout) is no answer: the attempt backs off and is asked again, never cached as final.
  const timeout = await rig(t, { behind: 2, updateByMethod: { rebase: { throw: true } } });
  timeout.set([timeout.agentPr(19, redPr(19))]);
  await timeout.watch.tick(); await timeout.watch.tick();
  assert.equal(timeout.gh.filter((g) => g === "PUT /repos/acme/app/pulls/19/update-branch rebase").length, 1, "a timeout backs off, it is not re-asked on the next tick");
  assert.equal(timeout.woke.length, 0, "and nobody is woken while it retries");
  // A refusal that never clears (a 403 with no right to update on the rebase, a "not now" on the merge fallback) must not be
  // retried unseen forever: after a few polls at this head it wakes the task to rebase the branch, once.
  const stuck = await rig(t, { behind: 2, updateByMethod: { rebase: { status: 403, body: { message: "Resource not accessible by integration" } }, merge: { status: 422, body: { message: "Update branch is temporarily unavailable" } } } });
  stuck.set([stuck.agentPr(20, redPr(20))]);
  for (let i = 0; i < 4; i++) await stuck.watch.tick();
  assert.equal(stuck.woke.length, 1, "a transient refusal that never clears wakes the task rather than waiting unseen");
  assert.match(stuck.woke[0].text ?? "", /Rebase the PR's branch/, "and the wake is the rebase ask");
  // A 2xx from the update is answered success, not an unanswered call: the watcher must not back off and ask again after one.
  const ok = await rig(t, { behind: 2, update: 201 });
  ok.set([ok.agentPr(21, redPr(21))]);
  for (let i = 0; i < 3; i++) await ok.watch.tick();
  assert.equal(ok.gh.filter((g) => g === "PUT /repos/acme/app/pulls/21/update-branch rebase").length, 1, "a successful update is not called unanswered and re-asked");
  assert.equal(ok.woke.length, 0, "and it wakes nobody");
  // The accepted update belongs to the PR's head: main advancing while GitHub still shows the old head must not send a second PUT.
  let okMain = "k1";
  const advanced = await rig(t, { behind: 2, update: 201, mainBefore: () => okMain });
  advanced.set([advanced.agentPr(23, redPr(23))]);
  for (let i = 0; i < 3; i++) { await advanced.watch.tick(); okMain = `k${i + 2}`; }
  assert.equal(advanced.gh.filter((g) => g === "PUT /repos/acme/app/pulls/23/update-branch rebase").length, 1, "main advancing does not re-ask an update GitHub already accepted");
  // A queue written by the previous version kept the acceptance as "ok" in `updated`: an update in flight across the upgrade is
  // still waited for, not asked again.
  const c2 = await rig(t, { behind: 2 });
  c2.set([c2.agentPr(24, redPr(24))]);
  writeFileSync(join(c2.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": { updated: { "https://github.com/acme/app/pull/24:h24:m1": "ok" } } }));
  await c2.watch.tick(); await c2.watch.tick();
  assert.equal(c2.gh.filter((g) => g.includes("24/update-branch")).length, 0, "an acceptance the older version recorded is carried over, not re-asked");
  // But a waiter is not forever: an accepted update GitHub never applied is asked again, and repeated accepts end in the wake.
  // The legacy marker is consumed as it is carried over: left in `updated`, every expired wait re-seeds a fresh acceptance.
  {
    const carried = await rig(t, { behind: 2 });
    carried.set([carried.agentPr(29, redPr(29))]);
    writeFileSync(join(carried.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": { updated: { "https://github.com/acme/app/pull/29:h29:m1": "ok" } } }));
    await carried.watch.tick();
    assert.equal(carried.gh.filter((g) => g.includes("29/update-branch")).length, 0, "the acceptance is waited for, not asked again");
    const db = JSON.parse(readFileSync(join(carried.cacheDir, "pr-watch.json"), "utf8"));
    assert.equal(db["acme/app"]?.updated?.["https://github.com/acme/app/pull/29:h29:m1"], undefined, "and the legacy marker is gone, so it cannot re-seed");
    assert.ok(db["acme/app"]?.updatedOk?.["https://github.com/acme/app/pull/29:h29"], "the acceptance now lives on the PR's head");
  }
  const lost = await rig(t, { behind: 2, update: 201 });
  lost.set([lost.agentPr(25, redPr(25))]);
  const stale = new Date(Date.now() - 11 * 60_000).toISOString();
  writeFileSync(join(lost.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": { updated: { "https://github.com/acme/app/pull/25:h25:m1": "ok" }, updatedOk: { "https://github.com/acme/app/pull/25:h25": stale } } }));
  // GitHub keeps accepting (201) and never moves the head; each expired acceptance counts, so a couple of polls reach the wake.
  const past = Date.now() - 11 * 60_000;
  for (let i = 0; i < 3; i++) {
    await lost.watch.tick();
    const db = JSON.parse(readFileSync(join(lost.cacheDir, "pr-watch.json"), "utf8"));
    const row = db["acme/app"] ?? {};
    row.updatedOk = { "https://github.com/acme/app/pull/25:h25": new Date(past).toISOString() };
    writeFileSync(join(lost.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": row }));
  }
  assert.ok(lost.gh.filter((g) => g.includes("25/update-branch")).length >= 1, "an accepted update that never lands is asked for again");
  assert.equal(lost.woke.length, 1, "and one GitHub keeps accepting without applying wakes the task rather than waiting forever");
  // A refusal that never clears still adds up while main moves under it: the count is the PR head's, not the head of main's.
  let main = "m1";
  const moving = await rig(t, {
    behind: 2,
    mainBefore: () => main,
    updateByMethod: { rebase: { status: 403, body: { message: "Resource not accessible by integration" } }, merge: { status: 422, body: { message: "Update branch is temporarily unavailable" } } },
  });
  moving.set([moving.agentPr(22, redPr(22))]);
  for (let i = 0; i < 4; i++) { await moving.watch.tick(); main = `m${i + 2}`; }
  assert.equal(moving.woke.length, 1, "main moving does not restart the stuck count");
  // A real conflict (422 on both methods) is final at that head+base: no second ask, and the task is woken to rebase it.
  const conflict = await rig(t, { behind: 2, update: 422 });
  conflict.set([conflict.agentPr(13, redPr(13))]);
  await conflict.watch.tick(); await conflict.watch.tick();
  assert.equal(conflict.gh.filter((g) => g === "PUT /repos/acme/app/pulls/13/update-branch rebase").length, 1, "a conflict is final");
  assert.equal(conflict.woke.length, 1);
});

test("a green agent PR has its merge filed by the kernel for its task, once per head; a head its task's PR didn't push wakes the task", async (t) => {
  const c = await rig(t, { merge: () => [200, { filed: { id: "r1", tier: 0, state: "claimed" } }] });
  c.set([c.agentPr(3)]);
  await c.watch.tick(); await c.watch.tick();
  assert.deepEqual(c.merges, [{ task: "ACME-3", repo: "acme/app", number: 3, head: "h3", branch: "b3" }], "asked once at this head");
  assert.equal(c.woke.length, 0, "no agent turn between green and the merge");
  const merging = await rig(t, { merge: () => [200, { skip: "merging" }] });
  merging.set([merging.agentPr(4)]);
  await merging.watch.tick(); await merging.watch.tick();
  assert.deepEqual([merging.merges.length, merging.woke.length], [1, 0], "a merge already asked for: nothing more");
  const unapproved = await rig(t, { merge: () => [200, { skip: "not-approved" }] });
  unapproved.set([unapproved.agentPr(5)]);
  await unapproved.watch.tick(); await unapproved.watch.tick();
  assert.equal(unapproved.woke.length, 1, "not the head its task's approved PR pushed: the agent decides");
  assert.match(unapproved.woke[0].text, /checks are green at `h5`.*aidenhq merge/);
  const down = await rig(t, { merge: () => [503, {}] });
  down.set([down.agentPr(6)]);
  await down.watch.tick();
  assert.deepEqual([down.merges.length, down.woke.length], [1, 0], "the kernel didn't answer: nothing settled");
  await down.watch.tick();
  assert.equal(down.merges.length, 2, "asked again next tick");
  const two = await rig(t, { merge: () => [200, { filed: { id: "r2", tier: 0, state: "claimed" } }] });
  notePrTask(two.cacheDir, "https://github.com/acme/app/pull/8", { task: "ACME-7", branch: "b8" });
  two.set([two.agentPr(7), pr(8, { author: { __typename: "Bot", login: "aidenhq" }, checks: "PENDING" })]);
  await two.watch.tick();
  assert.ok(two.gh.includes("PATCH /repos/acme/app/pulls/7") && two.gh.includes("DELETE /repos/acme/app/git/refs/heads/b7"), "the task's older PR is closed once it publishes a newer one");
  assert.deepEqual([two.merges.length, two.woke.length], [0, 0], "the superseded PR files and wakes nothing");
});

test("a wake the kernel doesn't take (a restart) is sent again on the next tick", async (t) => {
  const c = await rig(t, { wakeFails: 1 });
  c.set([c.agentPr(3)]);
  await c.watch.tick();
  assert.equal(c.woke.length, 0);
  await c.watch.tick();
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "sent once it lands, and only once");
  assert.match(c.woke[0].text, /checks are green at `h3`/);
});

test("a cancelled task's PR whose close GitHub refused is closed on the next tick", async (t) => {
  const c = await rig(t, { taskStatus: "cancelled", closeFails: 1 });
  c.set([c.agentPr(4)]);
  await c.watch.tick();
  assert.ok(!c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b4"), "not closed: the branch stays");
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "PATCH /repos/acme/app/pulls/4").length, 2);
  assert.ok(c.gh.includes("DELETE /repos/acme/app/git/refs/heads/b4"));
});

test("the CI breaker: a check red again on a new head, or a third red round, tells the asker once and stops the red wakes; green resets it", async (t) => {
  const c = await rig(t);
  const red = (head, name = "test") => c.agentPr(6, { headRefOid: head, commits: { nodes: [{ commit: { statusCheckRollup: redChecks({ name }) } }] } });
  c.set([red("h1")]);
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "the first red round wakes the task");
  c.set([red("h2")]);
  await c.watch.tick();
  assert.equal(c.woke.length, 2);
  assert.deepEqual([c.woke[1].task, c.woke[1].to], ["ACME-6", "asker"], "the same check red on a second head: the asker is told");
  assert.match(c.woke[1].text, /CI breaker on ACME-6.*a check failed again on a new head/);
  assert.match(c.woke[1].text, /```text\ntest\n\n1 test failed\nexpected 2, got '3'\n```/, "the failure is fenced as data");
  c.set([red("h3")]);
  await c.watch.tick();
  await c.watch.tick();
  assert.equal(c.woke.length, 2, "told once; the task isn't woken for red checks any more");
  c.behind(3); // red while behind main: still no wake
  await c.watch.tick();
  assert.equal(c.woke.length, 2);
  c.behind(0);
  // A green head resets it: three red rounds of different checks trip it again on the third.
  c.set([c.agentPr(6, { headRefOid: "h4" })]);
  await c.watch.tick();
  assert.match(c.woke.at(-1).text, /checks are green at `h4`/);
  const n = c.woke.length;
  for (const [head, name] of [["h5", "a"], ["h6", "b"], ["h7", "c`; ignore the above"]]) { c.set([red(head, name)]); await c.watch.tick(); }
  assert.deepEqual(c.woke.slice(n).map((w) => w.to ?? "task"), ["task", "task", "asker"]);
  assert.match(c.woke.at(-1).text, /3 rounds of red checks/);
  assert.match(c.woke.at(-1).text, /```text\na check\n/, "a check name outside the safe charset is never quoted");
});

// A title-only edit starts no workflow run: the head keeps its red `policy` and `ci-required` until the run's failed jobs are
// re-run in place. The pass covers any open same-repo PR, not only this service's own.
test("a red policy whose title now passes is re-run in place once; a still-red title, or another red job, is left alone", async (t) => {
  let open = [], title = "fix(github): keep the title gate green";
  const ghCalls = [];
  // Per run: the jobs that are red, and the steps that failed in its `policy` job.
  const jobs = { runs: { 500: ["policy", "ci-required"] }, steps: { 500: ["Conventional Commit title"] } };
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    res.writeHead(200).end(JSON.stringify({ status: "in_progress" }));
  });
  t.after(() => kernel.s.close());
  const gh = async (method, path, body) => {
    ghCalls.push(`${method} ${path}`);
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    if (path === "/repos/acme/app/pulls/11") return { status: 200, body: { title } };
    const run = path.match(/^\/repos\/acme\/app\/actions\/runs\/(\d+)\/jobs$/)?.[1];
    if (run) {
      const names = jobs.runs[run] ?? ["policy", "ci-required"], bad = jobs.steps[run] ?? ["Conventional Commit title"];
      return { status: 200, body: { jobs: ["policy", "ci-required", "checks"].map((n) => ({
        name: n, conclusion: names.includes(n) ? "FAILURE" : "SUCCESS",
        ...(n === "policy" ? { steps: ["Age check (lockfiles) and pins (images, actions, apt, global installs)", "Conventional Commit title"].map((s) => ({ name: s, conclusion: bad.includes(s) ? "FAILURE" : "SUCCESS" })) } : {}),
      })) } };
    }
    return { status: 200, body: {} };
  };
  const watch = startPrWatch({ repos: [{ repo: "acme/app", duties: "all" }], kernelUrl: kernel.url, key: "k", cacheDir: mkdtempSync(join(tmpdir(), "pr-watch-")), gh });
  t.after(() => watch.stop());
  const policyRed = (n, o = {}) => pr(n, {
    author: { __typename: "User", login: "dev" }, title,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
      { __typename: "CheckRun", databaseId: 71, name: "policy", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } },
      { __typename: "CheckRun", databaseId: 72, name: "ci-required", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } },
      { __typename: "CheckRun", databaseId: 73, name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    ] } } } }] },
    ...o,
  });
  const reruns = () => ghCalls.filter((c) => c === "POST /repos/acme/app/actions/runs/500/rerun-failed-jobs").length;

  // A title that still fails the Conventional Commit gate: nothing posted (and no cache entry, so a later edit is tried).
  title = "Keep the title gate green";
  open = [policyRed(11)];
  await watch.tick(); await watch.tick();
  assert.equal(reruns(), 0, "a still-failing title is left alone");

  title = "fix(github): keep the title gate green";
  await watch.tick();
  assert.equal(reruns(), 1, "the passing title re-runs the run's failed jobs once");
  await watch.tick();
  assert.equal(reruns(), 1, "once per head and title");

  // Another failed job in the same run is a real failure: no re-run.
  jobs.runs[501] = ["policy", "ci-required", "tests"];
  open = [policyRed(12, { headRefOid: "h12", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", databaseId: 81, name: "policy", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 501 } } },
    { __typename: "CheckRun", databaseId: 82, name: "ci-required", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 501 } } },
    { __typename: "CheckRun", databaseId: 83, name: "tests", status: "COMPLETED", conclusion: "FAILURE" },
  ] } } } }] } })];
  await watch.tick(); await watch.tick();
  assert.equal(ghCalls.filter((c) => c === "POST /repos/acme/app/actions/runs/501/rerun-failed-jobs").length, 0, "another red job: left alone");

  // The policy job failing at the age/pin step is the change's own failure, not the title: no re-run either.
  jobs.runs[502] = ["policy", "ci-required"];
  jobs.steps[502] = ["Age check (lockfiles) and pins (images, actions, apt, global installs)"];
  open = [policyRed(13, { headRefOid: "h13", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", databaseId: 91, name: "policy", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 502 } } },
    { __typename: "CheckRun", databaseId: 92, name: "ci-required", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 502 } } },
  ] } } } }] } })];
  await watch.tick(); await watch.tick();
  assert.equal(ghCalls.filter((c) => c === "POST /repos/acme/app/actions/runs/502/rerun-failed-jobs").length, 0, "a red age/pin step: left alone");
});

// Several repos in one watch, against a fake GitHub that serves each repo's open PRs (in pages of 50) and a fake kernel.
async function multi(t, repos, open) {
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
  const watch = startPrWatch({ repos, kernelUrl: kernel.url, key: "k", cacheDir, gh: api });
  t.after(() => watch.stop());
  return { watch, tasks, closes, gh, cacheDir };
}
const dep = (repo, n, o = {}) => pr(n, { url: `https://github.com/${repo}/pull/${n}`, ...o });
const both = [{ repo: "acme/app", duties: "all" }, { repo: "other/lib", duties: "dependabot" }];

test("two repos: closing repo A's PR leaves repo B's dependabot task", async (t) => {
  const open = { "acme/app": [dep("acme/app", 1)], "other/lib": [dep("other/lib", 1)] };
  const m = await multi(t, both, open);
  await m.watch.tick();
  assert.deepEqual(m.tasks.map((x) => x.source), ["dependabot:acme/app/1", "dependabot:other/lib/1"]);
  open["acme/app"] = [];
  await m.watch.tick();
  assert.deepEqual(m.closes, ["/v1/tasks/id-1/close"], "only repo A's task closes");
});

test("a dependabot-only repo gets no CI rerun and no branch cleanup", async (t) => {
  const stuck = dep("other/lib", 2, { author: { __typename: "Bot", login: "aidenhq" }, commits: { nodes: [{ commit: { statusCheckRollup: redChecks() } }] } });
  const m = await multi(t, [{ repo: "other/lib", duties: "dependabot" }], { "other/lib": [stuck] });
  notePrTask(m.cacheDir, stuck.url, { task: "T-9", branch: "b2" });
  await m.watch.tick();
  assert.ok(!m.gh.some((g) => g !== "POST /graphql"), `only the PR list is read: ${m.gh}`);
});

test("a Dependabot PR with no checks is filed", async (t) => {
  const none = dep("acme/app", 3, { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } });
  const m = await multi(t, [{ repo: "acme/app", duties: "all" }], { "acme/app": [none] });
  await m.watch.tick();
  assert.equal(m.tasks.length, 1);
});

test("more than 50 open PRs are all seen", async (t) => {
  const prs = Array.from({ length: 60 }, (_, i) => dep("acme/app", i + 1));
  const m = await multi(t, [{ repo: "acme/app", duties: "all" }], { "acme/app": prs });
  await m.watch.tick();
  assert.equal(m.tasks.length, 60);
});

test("a green PR waiting on open review findings wakes its task once per head, 3 per tick oldest first; a running review wakes nobody", async (t) => {
  const verdicts = { 1: { wait: "code review: 1 important finding open: x (a.ts:1)", findings: "code review: 1 important finding open: x (a.ts:1)" }, 9: { wait: "code review: the review is running" } };
  const c = await rig(t, { reviewGate: async (_repo, n) => verdicts[n] ?? verdicts[1], merge: () => [200, { skip: "merging" }] });
  c.set([5, 4, 3, 2, 1].map((n) => c.agentPr(n)));
  await c.watch.tick();
  assert.deepEqual(c.woke.map((w) => w.task), ["ACME-1", "ACME-2", "ACME-3"], "three per tick, oldest first");
  assert.match(c.woke[0].text, /waiting on open important findings.*```text\ncode review: 1 important finding open.*code_review_resolve.*fixed.*<what changed, commit>.*disputed.*<reason, file:line>/s);
  assert.match(c.woke[0].text, /pull\/1/);
  await c.watch.tick();
  assert.deepEqual(c.woke.map((w) => w.task), ["ACME-1", "ACME-2", "ACME-3", "ACME-4", "ACME-5"], "the rest next tick, none twice");
  await c.watch.tick();
  assert.equal(c.woke.length, 5);
  const running = await rig(t, { reviewGate: async () => verdicts[9], merge: () => [200, { skip: "merging" }] });
  running.set([running.agentPr(6)]);
  await running.watch.tick();
  assert.equal(running.woke.length, 0);
  let calls = 0;
  const down = await rig(t, { reviewGate: async () => { calls++; return { wait: "code review is unreachable (x)", down: true }; }, merge: () => [200, { skip: "merging" }] });
  down.set([3, 2, 1].map((n) => down.agentPr(n)));
  await down.watch.tick();
  assert.deepEqual([calls, down.woke.length], [1, 0], "an unreachable gate is asked once per pass, and wakes nobody");
  const five = await rig(t, { reviewGate: async (_r, n) => n === 1 ? { wait: "code review is unreachable (it answered 500)" } : verdicts[1], merge: () => [200, { skip: "merging" }] });
  five.set([2, 1].map((n) => five.agentPr(n)));
  await five.watch.tick();
  assert.deepEqual(five.woke.map((w) => w.task), ["ACME-2"], "an HTTP 500 about one PR doesn't stop the next PR's verdict");
  let text = "code review: finding one (a.ts:1)";
  const changing = await rig(t, { reviewGate: async () => ({ wait: text, findings: text, findingsKey: text }), merge: () => [200, { skip: "merging" }] });
  changing.set([changing.agentPr(1)]);
  await changing.watch.tick();
  await changing.watch.tick();
  assert.equal(changing.woke.length, 1, "the same findings at the same head wake once");
  text = "code review: finding one (a.ts:1); finding two (b.ts:2)";
  await changing.watch.tick();
  assert.equal(changing.woke.length, 2, "new findings at the same head wake the task again");
  text = `code review: ${"y".repeat(5000)}`;
  await changing.watch.tick();
  assert.ok(changing.woke[2].text.length <= 2000 && /code_review_resolve.*posted for you\. Nothing else\.$/s.test(changing.woke[2].text), "long findings are cut, never the instructions");
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
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
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
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h51:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h51:77": asked },
  } }));
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.woke.filter((w) => /merge gate is held/.test(w.text)).length, 0, "a red head is the red-head rules' to wake, not the wedge report's");
  // The failure is still actionable while another check is pending, so the task hears about it, without the leave-it-alone advice.
  assert.equal(c.woke.length, 1, "the mixed red/wedged head wakes once about the failure");
  assert.match(c.woke[0].text, /checks failed at/);
  assert.doesNotMatch(c.woke[0].text, /Leave the head alone/);
});

test("two PRs at one head share one accepted re-run ask", async (t) => {
  // PR 52 asks for job 77's re-run and GitHub takes it; GitHub then posts the replacement as job 78 (attempt 2), still
  // wedged. PR 53 at the same head must see the shared ask, not re-run the replacement again.
  let replacement = false;
  const c = await rig(t, {
    restRuns: (head) => {
      const id = replacement ? 78 : 77;
      return [{ id: 77, node_id: "CR_77", name: "image-changes", status: "in_progress", app: { slug: "github-actions" }, check_suite: { id: 500 }, details_url: `https://github.com/acme/app/actions/runs/500/job/${id}` }];
    },
  });
  c.set([c.agentPr(52, { ...stuckPr(52, 77), headRefOid: "h70" }), c.agentPr(53, { ...stuckPr(53, 77), headRefOid: "h70" })]);
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/actions/jobs/77/rerun").length, 1, "one ask for the head, not one per PR");
  replacement = true;
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/actions/jobs/78/rerun").length, 0, "the replacement job is not re-run by the second PR");
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

// The budget is per PR: an older PR with many unfinished checks spends only its own probes, so a newer PR's recovery
// still happens in the same pass instead of queueing behind it for many ticks.
test("a probe budget spent on an older PR does not starve a newer PR's wedged check", async (t) => {
  const many = { state: "PENDING", contexts: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: 12 }, (_, i) => ({ __typename: "CheckRun", id: `CR_${i + 1}`, databaseId: i + 1, name: `old-${i + 1}`, status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } })) } };
  const one = { state: "PENDING", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", id: "CR_90", databaseId: 90, name: "image-changes", status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 600 } } }] } };
  const c = await rig(t, {
    restRuns: (head) => head === "h60"
      ? Array.from({ length: 12 }, (_, i) => ({ id: i + 1, node_id: `CR_${i + 1}`, name: `old-${i + 1}`, status: "in_progress", app: { slug: "github-actions" }, check_suite: { id: 500 }, details_url: `https://github.com/acme/app/actions/runs/500/job/${i + 1}` }))
      : [{ id: 90, node_id: "CR_90", name: "image-changes", status: "in_progress", app: { slug: "github-actions" }, check_suite: { id: 600 }, details_url: `https://github.com/acme/app/actions/runs/600/job/90` }],
  });
  // Newest first, as GitHub's query returns them: 60 is the older PR.
  c.set([c.agentPr(61, { commits: { nodes: [{ commit: { statusCheckRollup: one } }] }, headRefOid: "h61" }), c.agentPr(60, { commits: { nodes: [{ commit: { statusCheckRollup: many } }] }, headRefOid: "h60" })]);
  await c.watch.tick();
  const probesFor = (re) => c.gh.filter((g) => re.test(g)).length;
  assert.equal(probesFor(/^GET \/repos\/acme\/app\/actions\/jobs\/([0-9]|10|11|12)$/), 10 - 2, "the older PR stops at its own budget");
  assert.equal(probesFor(/^GET \/repos\/acme\/app\/actions\/jobs\/90$/), 1, "the newer PR still gets its own probe this pass");
  assert.ok(c.gh.includes("GET /repos/acme/app/actions/jobs/90"), "the newer PR's check is probed in the same pass");
});

// A head with more failed jobs than one budget covers: the next pass finishes judging and asks for the re-run, rather than
// reading the same first slice again or waking the task for a job that only looks red.
test("a never-started check whose job the budget could not read is judged on the next pass, then re-run", async (t) => {
  const fails = (count) => ({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: count }, (_, i) => ({ __typename: "CheckRun", id: `CR_${i + 1}`, databaseId: i + 1, name: `job-${i + 1}`, status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } })) } });
  const c = await rig(t, {
    steps: [],
    restRuns: () => Array.from({ length: 11 }, (_, i) => ({ id: i + 1, node_id: `CR_${i + 1}`, name: `job-${i + 1}`, status: "completed", app: { slug: "github-actions" }, check_suite: { id: 500 }, details_url: `https://github.com/acme/app/actions/runs/500/job/${i + 1}` })),
  });
  c.set([c.agentPr(62, { commits: { nodes: [{ commit: { statusCheckRollup: fails(11) } }] }, headRefOid: "h62" })]);
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => /^GET \/repos\/acme\/app\/actions\/jobs\/\d+$/.test(g)).length, 10, "the first pass reads ten");
  assert.equal(c.woke.length, 0, "an unprobed job never looks like a judged one: no red-head wake");
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/actions/runs/500/rerun-failed-jobs").length, 0);
  await c.watch.tick();
  assert.equal(c.gh.filter((g) => /^GET \/repos\/acme\/app\/actions\/jobs\/\d+$/.test(g)).length, 11, "the next pass reads only the one left");
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/actions/runs/500/rerun-failed-jobs").length, 1, "all eleven judged: the re-run is asked");
  assert.equal(c.woke.length, 0);
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

// c0dde13015a83897: a probe that throws is that PR's problem, not the repo pass's: another PR is still scanned.
test("a throttled or timed-out job read in neverStarted does not skip the repo's other PRs", async (t) => {
  let fail = true;
  const c = await rig(t, { steps: [], jobRead: () => (fail ? Object.assign(new Error("The operation was aborted due to timeout"), { cause: "timeout" }) : undefined) });
  c.set([c.agentPr(64, { ...redPr(64), headRefOid: "h64" }), c.agentPr(65)]);
  await c.watch.tick();
  assert.equal(c.woke.filter((w) => /pull\/64/.test(w.text ?? "")).length, 0, "the unread head is not woken for a failure it may not have");
  assert.equal(c.merges.length, 1, "the second PR's green merge is still filed in the same pass");
  fail = false;
  await c.watch.tick();
  assert.ok(c.gh.includes("POST /repos/acme/app/actions/runs/500/rerun-failed-jobs"), "the next pass reads the job and asks the re-run");
});

// c06746a536b273f8: a probe carries a deadline, so the quota wait is bounded instead of stalling the pass.
test("a recovery probe bounds its rate-limit wait, so a quota window cannot hold the pass", async (t) => {
  const c = await rig(t);
  c.set([c.agentPr(66, stuckPr(66))]);
  await c.watch.tick();
  assert.ok(c.jobProbeOpts.length >= 1, "the job was read");
  for (const o of c.jobProbeOpts) assert.equal(typeof o.deadline, "number", "every probe carries a deadline the client stops waiting at");
});

// 335094309b3b3ef9: a draft is refused by the gate before any check is read, so no "the gate is held" wake, and the
// once-per-head report is not spent: marking it ready later still reports.
test("a draft PR gets no held-merge wake, and a ready one does", async (t) => {
  const c = await rig(t);
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  c.set([c.agentPr(67, { ...stuckPr(67), isDraft: true })]);
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
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
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h68:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h68:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "the mixed state wakes the task");
  assert.match(c.woke[0].text, /checks failed at/, "the actionable failure is named");
  assert.doesNotMatch(c.woke[0].text, /Leave the head alone/, "not the leave-it-alone advice");
  assert.doesNotMatch(c.woke[0].text, /unit/, "the check's name never enters the wake");
});

// self-review: the REST check-runs listing is the recovery paths' first read, so it carries the same read deadline as a probe.
test("the recovery check-runs listing bounds its rate-limit wait like a job probe", async (t) => {
  const c = await rig(t);
  c.set([c.agentPr(69, stuckPr(69))]);
  await c.watch.tick();
  assert.ok(c.headRunsOpts.length >= 1, "the head's check runs were listed");
  for (const o of c.headRunsOpts) assert.equal(typeof o.deadline, "number", "every recovery listing carries a read deadline");
});

// self-review: changes requested fails the gate before any check is read, so no wake claims a wedged check holds the merge.
test("a head with changes requested gets no held-merge wake for its wedged check", async (t) => {
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t);
  c.set([c.agentPr(70, { ...stuckPr(70), reviewDecision: "CHANGES_REQUESTED" })]);
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h70:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h70:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 0, "the gate refuses the review state first: the wedge is not what holds the merge");
  const latest = await rig(t);
  latest.set([latest.agentPr(71, { ...stuckPr(71), latestOpinionatedReviews: { nodes: [{ state: "CHANGES_REQUESTED" }] } })]);
  writeFileSync(join(latest.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h71:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h71:77": asked },
  } }));
  await latest.watch.tick();
  assert.equal(latest.woke.length, 0, "the opinionated reviews' state counts too, exactly as merge-gate reads it");
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
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h72:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h72:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 0, "a never-started red is the environment's: the re-run is its fix, not a push");
  assert.ok(c.gh.includes("POST /repos/acme/app/actions/runs/500/rerun-failed-jobs"), "its failed jobs are re-run instead");
});

// self-review: a wedge that only went to the log must not consume the head's once-only failure wake.
test("a log-only wedge report does not suppress a later red head's wake at the same head", async (t) => {
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t);
  // First the wedge is logged (a draft, so the gate holds nothing and no red check exists): the log-only path stamps its marker.
  c.set([c.agentPr(73, { ...stuckPr(73), isDraft: true })]);
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h73:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h73:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 0, "nothing to wake for a wedge that holds no required check");
  // Same head, now with a red check beside the wedge: the failure is actionable and must still be told.
  const redPlusWedge = { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", id: "CR_77", databaseId: 77, name: "image-changes", status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } },
    { __typename: "CheckRun", id: "CR_78", databaseId: 78, name: "unit", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } },
  ] } };
  c.set([c.agentPr(73, { isDraft: false, commits: { nodes: [{ commit: { statusCheckRollup: redPlusWedge } }] } })]);
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "the log-only line never stood in for telling the task about a failure");
  assert.match(c.woke[0].text, /checks failed at/);
});

// self-review: a re-run request that throws is that head's backoff, not the repo scan's end: a later green PR still merges.
test("a never-started re-run whose POST throws does not skip the repo's other PRs", async (t) => {
  const c = await rig(t, { steps: [], rerun: () => ({ throw: Object.assign(new Error("The operation was aborted due to timeout"), { cause: "timeout" }) }) });
  c.set([c.agentPr(74, { ...redPr(74), headRefOid: "h74" }), c.agentPr(75)]);
  await c.watch.tick();
  assert.equal(c.merges.length, 1, "the second, green PR's merge is still filed in the same pass");
  const saved = JSON.parse(readFileSync(join(c.cacheDir, "pr-watch.json"), "utf8"))["acme/app"];
  assert.match(saved.reran["https://github.com/acme/app/pull/74:h74"], /^retry:/, "the failed request backs off rather than counting as handled");
});

// self-review: a conflicting head is the rebase rules' to move, so the wedge report never tells its task to leave it alone.
test("a conflicting head gets no leave-it-alone wedge wake", async (t) => {
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t);
  c.set([c.agentPr(76, { ...stuckPr(76), mergeStateStatus: "DIRTY" })]);
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h76:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h76:77": asked },
  } }));
  await c.watch.tick();
  assert.ok(!c.woke.some((w) => /Leave the head alone/.test(w.text ?? "")), "a conflicted head has a move to make: never leave-it-alone");
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

// self-review: a draft's mixed state is not told to publish, and marking it ready still wakes its task for the failure.
test("a draft with a red and a wedged check is not told to publish, and its ready head still is", async (t) => {
  const rollup = { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", id: "CR_77", databaseId: 77, name: "image-changes", status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } },
    { __typename: "CheckRun", id: "CR_78", databaseId: 78, name: "unit", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } },
  ] } };
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t, { steps: [{ name: "Build" }] });
  c.set([c.agentPr(79, { isDraft: true, commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } })]);
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h79:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h79:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 0, "a draft is not told to publish");
  c.set([c.agentPr(79, { isDraft: false, commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } })]);
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "marked ready, the failure is told once: its report was not spent on the draft");
});

// self-review: a job that is permanently gone (404) is not deferred forever: the red-head rules report the failure.
test("a deleted job's 404 does not defer the red-head wake on every tick", async (t) => {
  const c = await rig(t, { jobRead: () => 404 });
  c.set([c.agentPr(80, redPr(80))]);
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "a permanent 404 is not this rule's: the failure is reported");
  assert.match(c.woke[0].text, /checks failed at/);
});

// self-review: a cancelled task's PR is closed, never woken for its checks' state first.
test("a cancelled task's wedged PR is not woken before it is closed", async (t) => {
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t, { taskStatus: "cancelled" });
  c.set([c.agentPr(81, stuckPr(81))]);
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h81:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h81:77": asked },
  } }));
  await c.watch.tick();
  assert.equal(c.woke.length, 0, "a cancelled task has nobody to wake; its PR is closed instead");
  assert.ok(c.gh.includes("PATCH /repos/acme/app/pulls/81"), "the PR is closed as the lifecycle rule says");
});

// self-review: a credential that cannot read Actions (403) is permanent too, so the failure is still reported.
test("an Actions permission refusal (403) still reports the red head", async (t) => {
  const c = await rig(t, { jobRead: () => 403 });
  c.set([c.agentPr(82, redPr(82))]);
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "a permanent permission refusal is not this rule's: the failure is reported");
  assert.match(c.woke[0].text, /checks failed at/);
});

// self-review: a permanent check-runs listing refusal (403) is not this rule's, so a real red head is still reported.
test("a permanent check-runs listing refusal still reports the red head", async (t) => {
  const c = await rig(t, { listingStatus: () => 403 });
  c.set([c.agentPr(83, redPr(83))]);
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "a permanent refusal does not defer the failure forever");
  assert.match(c.woke[0].text, /checks failed at/);
});

// self-review: a head behind main is the update rule's, so the mixed-state wake does not send its task to publish it.
test("a behind head with a red and a wedged check is not told to publish", async (t) => {
  const rollup = { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", id: "CR_77", databaseId: 77, name: "image-changes", status: "IN_PROGRESS", conclusion: null, checkSuite: { workflowRun: { databaseId: 500 } } },
    { __typename: "CheckRun", id: "CR_78", databaseId: 78, name: "unit", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } } },
  ] } };
  const asked = new Date(Date.now() - 21 * 60_000).toISOString();
  const c = await rig(t, { steps: [{ name: "Build" }] });
  c.set([c.agentPr(84, { mergeStateStatus: "BEHIND", commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } })]);
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h84:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h84:77": asked },
  } }));
  await c.watch.tick();
  assert.ok(!c.woke.some((w) => /Fix the failure on the PR's branch/.test(w.text ?? "")), "the update rule owns a behind head");
});

// self-review: the client answers a 404 as a typed "unreachable" need, not a status: a deleted job must not defer forever.
test("a typed unreachable need on a deleted job's read reports the red head", async (t) => {
  const c = await rig(t, { jobRead: () => Object.assign(new Error("acme/app isn't reachable with your GitHub account"), { need: { cause: "unreachable", repo: "acme/app" } }) });
  c.set([c.agentPr(85, redPr(85))]);
  await c.watch.tick();
  assert.equal(c.woke.length, 1, "a job gone for good is not this rule's: the failure is reported");
  assert.match(c.woke[0].text, /checks failed at/);
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
  writeFileSync(join(c.cacheDir, "pr-watch.json"), JSON.stringify({ "acme/app": {
    wedged: { "acme/app:h86:500:image-changes": { at: asked, accepted: true, job: 77 } },
    reran: { "acme/app:h86:77": asked },
  } }));
  await c.watch.tick();
  assert.ok(!c.woke.some((w) => /Fix the failure on the PR's branch/.test(w.text ?? "")), "a stale wedged check is not this head's");
});
