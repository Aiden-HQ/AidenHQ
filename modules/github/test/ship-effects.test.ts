// The ship module's typed effects on an adopted PR, end to end against a bare "GitHub" repo, a fake API and a fake ship: a push
// onto the PR's own branch carries a lease on the head it expects (a contributor's push in between wins), approve and enqueue
// are ship's alone and bound to the head, and an ambiguous enqueue is reconciled by reading the queue, never sent twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createService } from "../service/src/service.ts";
import { planParts } from "../service/src/plan.ts";
import { decide, mergePath, requiredChecks } from "../service/src/merge-gate.ts";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" } }).trim();
const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const REPO = "acme-agents/widget";
const SHIP = { kind: "module", module: "ship", roles: [] };

async function setup(t, { generation = 2, queue = {}, enqueueAnswer = () => ({ status: 200, body: { data: {} } }), app = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ship-effects-"));
  const origin = join(root, "github", REPO, "..", "widget.git");
  mkdirSync(origin, { recursive: true });
  sh(origin, "init", "--quiet", "--bare", "-b", "main");
  // A contributor's PR #7 on `contrib`, and the task's workspace with one repair commit on top of it.
  const ws = join(root, "tasks", "TASK-1", "widget");
  sh(root, "init", "--quiet", "-b", "main", ws);
  writeFileSync(join(ws, "a.txt"), "a\n");
  sh(ws, "add", "a.txt");
  sh(ws, "commit", "--quiet", "-m", "init");
  sh(ws, "push", "--quiet", origin, "main");
  sh(ws, "checkout", "--quiet", "-b", "contrib");
  writeFileSync(join(ws, "b.txt"), "b\n");
  sh(ws, "add", "b.txt");
  sh(ws, "commit", "--quiet", "-m", "contributor");
  sh(ws, "push", "--quiet", origin, "contrib");
  const c1 = sh(ws, "rev-parse", "HEAD");
  const main = sh(ws, "rev-parse", "main");
  writeFileSync(join(ws, "gen.txt"), "regenerated\n");
  sh(ws, "add", "gen.txt");
  sh(ws, "commit", "--quiet", "-m", "repair");
  const fix = sh(ws, "rev-parse", "HEAD");
  mkdirSync(join(dirname(ws), ".aidenhq", "bundles"), { recursive: true });
  sh(ws, "update-ref", `refs/aidenhq/publish/${fix}`, fix);
  sh(ws, "bundle", "create", "--quiet", join(dirname(ws), ".aidenhq", "bundles", `${fix}.bundle`), `refs/aidenhq/publish/${fix}`);

  const pr = { head: c1, author: "contributor" };
  const checks = [];
  const regenerated = Buffer.from("regenerated\n");
  const repairResult = { result: { changed: 1 }, keep: { message: "Merge branch 'main' into the PR", entries: [{ path: "gen.txt", mode: "100644", sha: execFileSync("git", ["hash-object", "--stdin"], { input: regenerated, encoding: "utf8" }).trim(), content: regenerated.toString("base64") }] } };
  const outcomes = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const m = /^\/v1\/writes\/([^/]+)\/outcome$/.exec(req.url);
    if (m) { outcomes.push({ id: m[1], ...JSON.parse(body) }); return res.writeHead(200).end("{}"); }
    // Ship's repair check job, already done: its result and the file it kept.
    if (req.url === "/v1/checks") { checks.push(JSON.parse(body)); return res.writeHead(200).end(JSON.stringify({ id: "c-1", state: "done", version: 1, result: repairResult.result })); }
    if (req.url === "/v1/checks/c-1/kept") return res.writeHead(200).end(JSON.stringify(repairResult.keep));
    res.writeHead(404).end("{}");
  });
  const calls = [];
  const gh = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/graphql" && body.query.includes("enqueuePullRequest")) return enqueueAnswer(queue);
    if (path === "/graphql") return { status: 200, body: { data: { repository: { pullRequest: { id: "PR_7", state: "OPEN", headRefOid: pr.head, baseRefName: "main", isInMergeQueue: Boolean(queue.head), mergeQueueEntry: queue.head ? { headCommit: { oid: queue.head } } : null } } } } };
    if (method === "GET" && /\/commits\/[0-9a-f]{40}\/check-runs/.test(path)) return { status: 200, body: { total_count: 0, check_runs: [] } };
    if (method === "GET" && /\/commits\/[0-9a-f]{40}\/status/.test(path)) return { status: 200, body: { total_count: 0, statuses: [] } };
    if (method === "GET" && path === `/repos/${REPO}`) return { status: 200, body: { default_branch: "main" } };
    if (method === "GET" && path === `/repos/${REPO}/pulls/7`) return { status: 200, body: { number: 7, state: pr.state ?? "open", head: { sha: pr.head, ref: "contrib", repo: pr.fork ? { full_name: "someone/widget" } : { full_name: REPO } }, base: { ref: pr.base ?? "main", sha: main }, user: { login: pr.author } } };
    if (method === "POST" && path === `/repos/${REPO}/pulls/7/reviews`) return { status: 200, body: { id: 99 } };
    if (method === "GET" && path.startsWith(`/repos/${REPO}/pulls/7/reviews`)) return { status: 200, body: [{ id: 50, user: { login: "acme-app[bot]" }, state: "APPROVED", commit_id: "e".repeat(40) }, { id: 51, user: { login: "owner1" }, state: "APPROVED", commit_id: "e".repeat(40) }, { id: 99, user: { login: "acme-app[bot]" }, state: "APPROVED", commit_id: pr.head }] };
    if (method === "PUT" && /\/dismissals$/.test(path)) return { status: 200, body: {} };
    // GitHub's git data API, as the App, over the bare origin: blobs, trees, commits, and a ref update that refuses a non-fast-forward.
    const git = (args, o = {}) => execFileSync("git", args, { cwd: origin, encoding: "utf8", ...o, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_COMMITTER_NAME: "app", GIT_COMMITTER_EMAIL: "app@example.com", GIT_AUTHOR_NAME: "app", GIT_AUTHOR_EMAIL: "app@example.com", ...o.env } }).trim();
    if (method === "POST" && path === `/repos/${REPO}/git/blobs`) return { status: 201, body: { sha: git(["hash-object", "-w", "--stdin"], { input: Buffer.from(body.content, "base64") }) } };
    if (method === "POST" && path === `/repos/${REPO}/git/trees`) {
      const env = { GIT_INDEX_FILE: join(root, `idx-${Math.random()}`) };
      git(["read-tree", body.base_tree], { env });
      for (const e of body.tree) git(e.sha === null ? ["update-index", "--force-remove", e.path] : ["update-index", "--add", "--cacheinfo", `${e.mode},${e.sha},${e.path}`], { env });
      return { status: 201, body: { sha: git(["write-tree"], { env }) } };
    }
    if (method === "POST" && path === `/repos/${REPO}/git/commits`) return { status: 201, body: { sha: git(["commit-tree", body.tree, ...body.parents.flatMap((p) => ["-p", p]), "-m", body.message]) } };
    if (method === "GET" && path.startsWith(`/repos/${REPO}/compare/`)) return { status: 200, body: { merge_base_commit: { sha: main } } };
    if (method === "GET" && path.startsWith(`/repos/${REPO}/git/commits/`)) return { status: 200, body: { tree: { sha: git(["rev-parse", `${path.split("/").pop()}^{tree}`]) } } };
    if (method === "PATCH" && path === `/repos/${REPO}/git/refs/heads/contrib`) {
      const cur = git(["rev-parse", "refs/heads/contrib"]);
      try { git(["merge-base", "--is-ancestor", cur, body.sha]); } catch { return { status: 422, body: { message: "Update is not a fast forward" } }; }
      git(["update-ref", "refs/heads/contrib", body.sha]);
      return { status: 200, body: {} };
    }
    return { status: 404, body: { message: "fake GitHub: no route" } };
  };
  const access = {
    connected: () => true, scopes: () => ["repo"], status: () => ({ scopes: ["repo"], problems: [] }), token: async () => "tok",
    identity: async () => ({ login: "owner1", name: "Owner One", email: "1+owner1@users.noreply.github.com" }),
    rest: async (method, path, body) => ({ ...(await gh(method, path, body)), headers: new Headers() }),
    graphql: async () => ({}),
  };
  const adoption = { generation };
  const ship = { generation: async () => ({ generation: adoption.generation, task: "t1" }) };
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir: join(root, "cache"), tasksDir: join(root, "tasks"), access,
    remoteUrl: (slug) => join(root, "github", `${slug.split("/")[0]}/${slug.split("/")[1]}.git`), fleetOrg: "acme-agents", productRepo: "acme/aidenhq",
    reviewGate: async () => undefined, ship,
    // The App, installed on the repo: its writes are recorded like the owner's (`as` marks whose they are).
    reviewer: async () => (app ? { login: "acme-app[bot]", rest: async (method, path, body) => ({ ...(await gh(method, path, { ...body, as: "app" })), headers: new Headers() }) } : undefined),
  });
  const svc = await listen((req, res) => void handle(req, res));
  t.after(() => { kernel.s.close(); svc.s.close(); });
  const call = async (path, body) => {
    const r = await fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: "Bearer ch-key", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const run = async (id, kind, args) => {
    const n = outcomes.length;
    assert.deepEqual((await call("/aidenhq/v1/executor/execute", { id, kind, args, digest: "d", idempotency_key: id, tier: 0 })).json, { accepted: true });
    for (let i = 0; i < 300 && outcomes.length === n; i++) await new Promise((r) => setTimeout(r, 10));
    return outcomes[n];
  };
  return { root, ws, origin, c1, fix, main, pr, queue, calls, call, run, adoption, checks, repairResult };
}

test("a push onto an adopted PR's branch is written through the API as the App, a fast-forward from the head it expects; a contributor's push in between wins", async (t) => {
  const { ws, origin, c1, fix, pr, call, run } = await setup(t);
  const args = { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: fix }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 };
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.raise, undefined, "the adopted ref is the task's own branch: an ordinary agents-org push");
  // Stale generation, wrong task, a fork, a moved head: each refused at the plan.
  for (const [what, bad] of [["generation", { ...args, generation: 1 }], ["head", { ...args, expected: "f".repeat(40) }]]) {
    const r = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: bad, requester: { kind: "job", roles: [] }, task: "t1" });
    assert.equal(r.status, 422, what);
  }
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.push", args, requester: { kind: "job", roles: [] }, task: "t9" })).json.error, /adoption's task/);
  pr.fork = true;
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.push", args, requester: { kind: "job", roles: [] }, task: "t1" })).json.error, /fork/);
  pr.fork = false;

  // A contributor pushes after the read: GitHub's API still says c1 (it lags), the fast-forward update refuses, and their commit stays.
  const scratch = `${ws}-contrib`;
  sh(dirname(ws), "clone", "--quiet", "-b", "contrib", origin, scratch);
  writeFileSync(join(scratch, "c.txt"), "c\n");
  sh(scratch, "add", "c.txt");
  sh(scratch, "commit", "--quiet", "-m", "contributor again");
  sh(scratch, "push", "--quiet", origin, "contrib");
  const theirs = sh(scratch, "rev-parse", "HEAD");
  const lost = await run("k-00000000000000b1", "github.push", args);
  assert.equal(lost.ok, false);
  assert.match(lost.text, /^ship-head-moved/);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), theirs, "the contributor's push is never overwritten");

  // Back at c1, the leased push lands, but never after the contributor closed the PR.
  sh(scratch, "push", "--quiet", "--force", origin, `${c1}:refs/heads/contrib`);
  pr.state = "closed";
  const closed = await run("k-00000000000000b3", "github.push", args);
  assert.match(closed.text, /^ship-scope: .* is closed/);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), c1);
  pr.state = "open";
  const ok = await run("k-00000000000000b2", "github.push", args);
  assert.equal(ok.ok, true, ok.text);
  // The App's commit: the repair's tree on top of c1, made by the App (GitHub signs it), not the box's commit.
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^{tree}"), sh(ws, "rev-parse", `${fix}^{tree}`));
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^"), c1);
  assert.equal(sh(origin, "log", "-1", "--format=%cn", "refs/heads/contrib"), "app");
});

test("approve and enqueue are ship's alone and Tier 0 at the head; approve posts as the App", async (t) => {
  const { c1, pr, calls, call, run, adoption } = await setup(t);
  const a = { repo: REPO, number: 7, head: c1, generation: 2, base: "main" };
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: { kind: "job", roles: ["platform-engineer"] }, task: "t1" })).json.error, /only the ship module/);
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: SHIP, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.raise, undefined);
  // The App's own PR: GitHub won't let it approve, so a human must.
  pr.author = "acme-app[bot]";
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: SHIP, task: "t1" })).json.error, /approval needs a human/);
  pr.author = "contributor";
  // Retargeted since the filing.
  pr.base = "release";
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: SHIP, task: "t1" })).json.error, /base changed/);
  pr.base = undefined;

  // Handed back (or paused) after the filing: the effect reads the adoption once more and does nothing.
  adoption.generation = null;
  const late = await run("k-00000000000000c0", "github.approve", a);
  assert.match(late.text, /^ship-generation/);
  assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/reviews")).length, 0);
  adoption.generation = 2;
  const out = await run("k-00000000000000c1", "github.approve", a);
  assert.equal(out.ok, true, out.text);
  assert.deepEqual(calls.find((c) => c.method === "POST" && c.path.endsWith("/reviews")).body, { event: "APPROVE", commit_id: c1, as: "app" }, "as the App, never the owner");

  // An enqueue of a head the runner didn't push is a merge by the queue: the AI reviewer reads it first.
  const e = { ...a, attempt: 1 };
  const enq = await call("/aidenhq/v1/executor/plan", { kind: "github.enqueue", args: e, requester: SHIP, task: "t1" });
  assert.equal(enq.status, 200, JSON.stringify(enq.json));
  assert.equal(enq.json.raise?.rule, "agents-org-merge-foreign-head");
});

test("an enqueue GitHub didn't answer is reconciled by reading the queue entry, never sent twice", async (t) => {
  let sent = 0;
  const queue = {};
  const { c1, run } = await setup(t, { queue, enqueueAnswer: (q) => { sent++; q.head = q.lands ? c1Ref.v : undefined; return { status: 502, body: {} }; } });
  const c1Ref = { v: c1 };
  queue.lands = true;
  const out = await run("k-00000000000000d1", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 1, base: "main" });
  assert.equal(out.ok, true, out.text);
  assert.match(out.text, /in the merge queue/);
  assert.equal(sent, 1);
  // It didn't land: failed for the next round, still only one call.
  queue.head = undefined;
  queue.lands = false;
  const lost = await run("k-00000000000000d2", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 2, base: "main" });
  assert.equal(lost.ok, false);
  assert.equal(sent, 2);
});

test("one readiness rule: ship's actions with its context, the merge queue's without", () => {
  const H = "a".repeat(40);
  const check = (name, conclusion) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion });
  const data = (pr) => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: { state: "OPEN", headRefOid: H, baseRefName: "main", mergeStateStatus: "CLEAN", reviewDecision: null, isDraft: false, isInMergeQueue: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [check("build", "SUCCESS")] } } } }] }, baseRef: { compare: { behindBy: 0 } }, reviews: { nodes: [] }, ...pr } } });
  const ok = [{ name: "build", ok: true, pending: false }];
  const go = (pr, ctx = {}) => decide(data(pr), H, { queue: false, approve: false, required: ["build"], checks: ok, ...ctx });
  assert.equal(go({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", reviewRequests: { nodes: [{ asCodeOwner: true, requestedReviewer: { combinedSlug: "acme/api" } }] } }).why, "waiting on code owner @acme/api");
  assert.equal(go({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }).why, "waiting for required review");
  assert.equal(go({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }, { approve: true }).do, "approve");
  assert.equal(go({ mergeStateStatus: "DIRTY" }).do, "repair");
  assert.equal(go({ mergeStateStatus: "DIRTY" }, { checks: [] }).do, "repair", "a conflict is repaired before waiting on checks that can't run");
  assert.equal(go({}, { queue: true }).do, "enqueue", "no review needed: the hand-off is enough");
  assert.equal(go({}, { review: true }).do, "wait", "a gated repo needs an approval on the head");
  assert.equal(go({ reviews: { nodes: [{ state: "APPROVED", commit: { oid: H } }] } }, { review: true }).do, "merge");
  assert.equal(go({ state: "MERGED" }).do, "done");
  assert.equal(go({ isInMergeQueue: true }).do, "wait");
  // A non-default base is unsupported: a visible stall, never a silent wait.
  assert.deepEqual(go({ baseRefName: "release" }), { do: "stall", why: "non-default base unsupported (`release`)" });
  // Only the required checks: an optional red one doesn't hold it; none required (and none run) is green.
  const red = [...ok, { name: "lint", ok: false, pending: false }];
  assert.equal(go({}, { checks: red }).do, "merge");
  assert.equal(go({}, { checks: red, required: ["build", "lint"] }).do, "fix_ci");
  assert.equal(go({}, { checks: [], required: ["build"] }).do, "wait", "a required check not reported yet is running");
  assert.equal(go({}, { checks: [], required: [] }).do, "merge", "none required, none run: green");
  assert.equal(go({}, { checks: [...ok, { name: "build", ok: false, pending: false }] }).do, "fix_ci", "a red status hides behind no green run of the same name");
  assert.equal(go({ mergeStateStatus: "BLOCKED" }).do, "stall", "a branch rule ship doesn't handle is a visible stall");
  // Without ship's context: the merge queue's rule, unchanged.
  assert.deepEqual(decide(data({}), H), { do: "merge" });
  assert.equal(decide(data({ mergeStateStatus: "DIRTY" }), H).do, "fail");
  assert.equal(decide(data({ baseRefName: "release" }), H).do, "fail");
  assert.equal(mergePath([{ type: "pull_request" }, { type: "merge_queue" }]), "queue");
  assert.equal(mergePath([]), "direct");
  assert.deepEqual(requiredChecks([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }] } }], { contexts: ["ci-required"] }).sort(), ["build", "ci-required"]);
});

test("plan: an adopted PR's merge is refused when the generation is stale or ship isn't installed", () => {
  const ship = { number: 3, generation: 2, expected: "a".repeat(40), head: "a".repeat(40), headRepo: "acme-agents/x", current: 2, filedOn: ["t1"], byShip: true };
  const pr = (s) => ({ repo: "acme-agents/x", number: 3, head: "a".repeat(40), files: ["a.ts"], checks: [{ name: "b", ok: true }], headMatches: true, ownHead: true, ship: s });
  const st = { agentsOrgs: ["acme-agents"], productRepo: "acme/aidenhq" };
  assert.deepEqual(planParts("merge", { ...st, prs: [pr(ship)] })[0].map((p) => p.rule), ["agents-org-merge"]);
  assert.deepEqual(planParts("merge", { ...st, prs: [pr({ ...ship, current: 3 })] })[0].map((p) => p.rule), ["ship-generation"]);
  assert.deepEqual(planParts("merge", { ...st, prs: [pr({ ...ship, current: undefined })] })[0].map((p) => p.rule), ["ship-generation"]);
  assert.deepEqual(planParts("merge", { ...st, prs: [pr({ ...ship, byShip: false })] })[0].map((p) => p.rule), ["ship-only"], "an adoption's merge is ship's alone");
});

test("an adoption's direct merge: no checks and none required merges at its bound target; a hand-back before the call ends it", async () => {
  const H = "a".repeat(40);
  const run = async (adopted, plain = false) => {
    const calls = [];
    const gh = async (method, path) => {
      calls.push(`${method} ${path}`);
      if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, pullRequest: {
        number: 7, state: calls.some((c) => c.startsWith("PUT")) ? "MERGED" : "OPEN", headRefOid: H, baseRefName: "main", isDraft: false, mergeStateStatus: "CLEAN", reviewDecision: null, isInMergeQueue: false,
        mergeCommit: null, commits: { nodes: [{ commit: { statusCheckRollup: plain ? { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] } } : null } }] }, baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40) } }, reviews: { nodes: [] }, latestOpinionatedReviews: { nodes: [] },
      } } } } };
      if (path.includes("/rules/branches/")) return { status: 200, body: [] };
      if (path.includes("/check-runs")) return { status: 200, body: { check_runs: [] } };
      if (path.endsWith("/statuses") || path.includes("/statuses?")) return { status: 200, body: [] };
      if (path.endsWith("/required_status_checks")) return { status: 404, body: {} };
      if (method === "PUT") return { status: 200, body: { sha: "c".repeat(40) } };
      return { status: 404, body: {} };
    };
    const outcomes = [];
    const { createMerges } = await import("../service/src/merges.ts");
    const m = createMerges({ dir: mkdtempSync(join(tmpdir(), "ship-merge-")), gh, fleetOrg: "acme-agents", reviewGate: async () => undefined, report: async (id, o) => void outcomes.push(o), ship: { generation: async () => ({ generation: adopted ? 2 : null }) } });
    if (plain) void m.enqueue("k-1", { prs: [{ repo: REPO, number: 7, head: H }] }, undefined, undefined, undefined, true);
    else void m.enqueue("k-1", { prs: [{ repo: REPO, number: 7, head: H, base: "main" }], generation: 2, attempt: 1 });
    await m.step();
    return { calls, outcomes };
  };
  const merged = await run(true);
  assert.equal(merged.calls.filter((c) => c.startsWith("PUT")).length, 1, merged.calls.join("\n"));
  assert.equal(merged.outcomes[0]?.ok, true);
  const ended = await run(false);
  assert.equal(ended.calls.filter((c) => c.startsWith("PUT")).length, 0);
  assert.equal(ended.outcomes[0]?.ok, false);
  assert.match(ended.outcomes[0].text, /adoption ended/);
  // A fleet PR's plain merge ship filed stops with ship too: paused (or its repo off), it is never called.
  const paused = await run(false, true);
  assert.equal(paused.calls.filter((c) => c.startsWith("PUT")).length, 0, paused.calls.join("\n"));
  assert.match(paused.outcomes[0]?.text ?? "", /ship is paused/);
});

test("with no App on the repo, approve is refused as needing a human; nothing is posted as the owner", async (t) => {
  const { c1, calls, call, run } = await setup(t, { app: false });
  const a = { repo: REPO, number: 7, head: c1, generation: 2, base: "main" };
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: SHIP, task: "t1" })).json.error, /approval needs a human/);
  const out = await run("k-00000000000000e1", "github.approve", a);
  assert.equal(out.ok, false);
  assert.match(out.text, /^ship-no-app: .*approval needs a human/);
  assert.equal(calls.filter((c) => c.method !== "GET" && c.path !== "/graphql").length, 0);
});

test("ship's repair: github runs ship's check job and writes what it kept as the App, a merge commit on the head; leftovers and a fork without edits write nothing", async (t) => {
  const { origin, c1, main, pr, call, run, checks, repairResult } = await setup(t);
  const args = { repo: REPO, number: 7, head: c1, generation: 2, base: "main", plan: { globs: ["gen.txt"], commands: [{ dir: ".", cmd: "make gen" }] } };
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.repair", args, requester: SHIP, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.raise, undefined);
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.repair", args, requester: { kind: "job", roles: ["platform-engineer"] }, task: "t1" })).json.error, /only the ship module/);

  const ok = await run("k-00000000000000c1", "github.repair", args);
  assert.equal(ok.ok, true, ok.text);
  assert.deepEqual(checks[0], { repo: REPO, head: c1, run: "ship-repair", spec: { base: main, merge_base: main, base_ref: "main", plan: JSON.stringify(args.plan) } });
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^1"), c1);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^2"), main);
  assert.equal(sh(origin, "show", "refs/heads/contrib:gen.txt"), "regenerated");

  // Conflicts no generator rewrites: the outcome lists them and the branch stays.
  pr.head = sh(origin, "rev-parse", "refs/heads/contrib");
  repairResult.result = { leftovers: ["src/a.ts"] };
  const left = await run("k-00000000000000c2", "github.repair", { ...args, head: pr.head });
  assert.equal(left.ok, false);
  assert.match(left.text, /^ship-leftovers: [\s\S]*\nleftover: src\/a\.ts$/);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), pr.head);
  pr.fork = true;
  assert.match((await run("k-00000000000000c3", "github.repair", { ...args, head: pr.head })).text, /^ship-fork/);
});
