// The product-PR watcher end to end against a fake GitHub and a fake kernel (ported from the runner's flow-product cases):
// a Dependabot PR becomes one task for the platform-engineer role once its checks finish, and that task closes when the PR is
// gone; an agent's PR (one this service opened) that conflicts with main wakes its task once, with fixed text only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  const gh = async (method, path, token, body) => {
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: mainOid, statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    if (path.startsWith("/repos/acme/app/compare/")) return { status: 200, body: { behind_by: 3 } };
    return { status: 404, body: {} };
  };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repo: "acme/app", kernelUrl: kernel.url, key: "k", cacheDir, app: { token: async () => "tok" }, gh });
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
  const watch = startPrWatch({ repo: "acme/app", kernelUrl: kernel.url, key: "k", cacheDir, app: { token: async () => "tok" }, gh });
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

// The behaviours ported from the runner, against one fake GitHub and kernel: each case is one agent PR (acme/app#N, task ACME-N).
const redChecks = (extra = {}) => ({ state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", databaseId: 77, name: "test", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 500 } }, ...extra }] } });
async function rig(t, { taskStatus = "in_progress", behind = 0, steps = [{ name: "Build" }], update = 202, wakeFails = 0, closeFails = 0, records = [] } = {}) {
  const woke = [], gh = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/v1/wakes" && wakeFails-- > 0) return res.writeHead(503).end("{}");
    if (req.url === "/v1/wakes") woke.push(JSON.parse(body));
    res.writeHead(200).end(JSON.stringify(req.url.startsWith("/v1/work") ? { status: taskStatus, records } : {}));
  });
  t.after(() => kernel.s.close());
  let open = [];
  const api = async (method, path, token, body) => {
    gh.push(`${method} ${path}${body?.update_method ? ` ${body.update_method}` : ""}`);
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    if (path.startsWith("/repos/acme/app/compare/")) return { status: 200, body: { behind_by: behind } };
    if (path.startsWith("/repos/acme/app/actions/jobs/")) return { status: 200, body: { steps } };
    if (path.endsWith("/update-branch")) return { status: update, body: {} };
    if (path.startsWith("/repos/acme/app/check-runs/")) return { status: 200, body: { output: { title: "1 test failed", summary: "expected 2, got `3`" } } };
    if (method === "PATCH" && closeFails-- > 0) return { status: 502, body: {} };
    return { status: 200, body: {} };
  };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repo: "acme/app", kernelUrl: kernel.url, key: "k", cacheDir, app: { token: async () => "tok" }, gh: api });
  t.after(() => watch.stop());
  const agentPr = (n, o = {}) => { notePrTask(cacheDir, `https://github.com/acme/app/pull/${n}`, { task: `ACME-${n}`, branch: `b${n}` }); return pr(n, { author: { __typename: "Bot", login: "aidenhq" }, ...o }); };
  return { woke, gh, watch, cacheDir, agentPr, set: (v) => { open = v; }, behind: (v) => { behind = v; update = 422; } };
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
  writeFileSync(join(e.cacheDir, "pr-watch.json"), JSON.stringify({ headAt: { "https://github.com/acme/app/pull/2": { head: "h2", at: old }, "https://github.com/acme/app/pull/3": { head: "h3", at: old } } }));
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
  writeFileSync(join(capped.cacheDir, "pr-watch.json"), JSON.stringify({ wakes: { "https://github.com/acme/app/pull/8": { head: "h8", n: 3 } } }));
  await capped.watch.tick();
  assert.equal(capped.woke.length, 0, "three wakes at this head: no more");
});

test("red checks whose job never started are re-run once at the head, with no wake", async (t) => {
  const c = await rig(t, { steps: [] });
  c.set([c.agentPr(4, redPr(4))]);
  await c.watch.tick(); await c.watch.tick();
  assert.equal(c.gh.filter((g) => g === "POST /repos/acme/app/actions/runs/500/rerun-failed-jobs").length, 1);
  assert.equal(c.woke.length, 0);
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

test("a Dependabot PR beyond a full page of open PRs keeps its task until GitHub says it is closed", async (t) => {
  const closes = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/v1/tasks") return res.writeHead(200).end(JSON.stringify({ id: "t-10", identifier: "ACME-10" }));
    if (req.url.endsWith("/close")) closes.push(req.url);
    res.writeHead(200).end("{}");
  });
  t.after(() => kernel.s.close());
  let open = [pr(10)], state10 = "open";
  const gh = async (m, path) => {
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    if (path === "/repos/acme/app/pulls/10") return { status: 200, body: { state: state10 } };
    return { status: 404, body: {} };
  };
  const watch = startPrWatch({ repo: "acme/app", kernelUrl: kernel.url, key: "k", cacheDir: mkdtempSync(join(tmpdir(), "pr-watch-")), app: { token: async () => "tok" }, gh });
  t.after(() => watch.stop());
  await watch.tick();
  open = Array.from({ length: 50 }, (_, i) => pr(100 + i, { author: { __typename: "User", login: "dev" } })); // #10 is past the page
  await watch.tick();
  assert.deepEqual(closes, [], "still open on GitHub: its task stays");
  state10 = "closed";
  await watch.tick();
  assert.deepEqual(closes, ["/v1/tasks/t-10/close"]);
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
  const gh = async (method, path, token, body) => {
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
  const watch = startPrWatch({ repo: "acme/app", kernelUrl: kernel.url, key: "k", cacheDir: mkdtempSync(join(tmpdir(), "pr-watch-")), app: { token: async () => "tok" }, gh });
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
