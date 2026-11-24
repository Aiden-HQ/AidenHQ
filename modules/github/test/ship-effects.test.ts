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
import { decideShip, mergePath, queueRemoval, requiredChecks } from "../service/src/merge-gate.ts";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" } }).trim();
const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const REPO = "acme-agents/widget";
const SHIP = { kind: "module", module: "ship", roles: [] };

async function setup(t, { generation = 2, queue = {}, enqueueAnswer = () => ({ status: 200, body: { data: {} } }) } = {}) {
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
  const outcomes = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const m = /^\/v1\/writes\/([^/]+)\/outcome$/.exec(req.url);
    if (m) { outcomes.push({ id: m[1], ...JSON.parse(body) }); return res.writeHead(200).end("{}"); }
    res.writeHead(404).end("{}");
  });
  const calls = [];
  const gh = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/graphql" && body.query.includes("enqueuePullRequest")) return enqueueAnswer(queue);
    if (path === "/graphql") return { status: 200, body: { data: { repository: { pullRequest: { id: "PR_7", state: "OPEN", headRefOid: pr.head, baseRefName: "main", isInMergeQueue: Boolean(queue.head), mergeQueueEntry: queue.head ? { headCommit: { oid: queue.head } } : null } } } } };
    if (method === "GET" && path === `/repos/${REPO}`) return { status: 200, body: { default_branch: "main" } };
    if (method === "GET" && path === `/repos/${REPO}/pulls/7`) return { status: 200, body: { number: 7, head: { sha: pr.head, ref: "contrib", repo: pr.fork ? { full_name: "someone/widget" } : { full_name: REPO } }, base: { ref: pr.base ?? "main", sha: main }, user: { login: pr.author } } };
    if (method === "POST" && path === `/repos/${REPO}/pulls/7/reviews`) return { status: 200, body: { id: 99 } };
    if (method === "GET" && path.startsWith(`/repos/${REPO}/pulls/7/reviews`)) return { status: 200, body: [{ id: 50, user: { login: "owner1" }, state: "APPROVED", commit_id: "e".repeat(40) }, { id: 99, user: { login: "owner1" }, state: "APPROVED", commit_id: pr.head }] };
    if (method === "PUT" && /\/dismissals$/.test(path)) return { status: 200, body: {} };
    return { status: 404, body: { message: "fake GitHub: no route" } };
  };
  const access = {
    connected: () => true, scopes: () => ["repo"], status: () => ({ scopes: ["repo"], problems: [] }), token: async () => "tok",
    identity: async () => ({ login: "owner1", name: "Owner One", email: "1+owner1@users.noreply.github.com" }),
    rest: async (method, path, body) => ({ ...(await gh(method, path, body)), headers: new Headers() }),
    graphql: async () => ({}),
  };
  const ship = { generation: async () => ({ generation, task: "t1" }) };
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir: join(root, "cache"), tasksDir: join(root, "tasks"), access,
    remoteUrl: (slug) => join(root, "github", `${slug.split("/")[0]}/${slug.split("/")[1]}.git`), fleetOrg: "acme-agents", productRepo: "acme/aidenhq",
    reviewGate: async () => undefined, ship,
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
  return { root, ws, origin, c1, fix, pr, queue, calls, call, run };
}

test("a push onto an adopted PR's branch is leased on the head it expects; a contributor's push in between wins", async (t) => {
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

  // A contributor pushes after the read: GitHub's API still says c1 (it lags), the lease refuses, and their commit stays.
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

  // Back at c1, the leased push lands.
  sh(scratch, "push", "--quiet", "--force", origin, `${c1}:refs/heads/contrib`);
  const ok = await run("k-00000000000000b2", "github.push", args);
  assert.equal(ok.ok, true, ok.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), fix);
});

test("approve and enqueue are ship's alone, Tier 0 at the head, and an approval of an earlier head is dismissed", async (t) => {
  const { c1, pr, calls, call, run } = await setup(t);
  const a = { repo: REPO, number: 7, head: c1, generation: 2, base: "main" };
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: { kind: "job", roles: ["platform-engineer"] }, task: "t1" })).json.error, /only the ship module/);
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: SHIP, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.raise, undefined);
  // A PR the owner's account opened can't be approved by it: no reviewer App, so refused.
  pr.author = "owner1";
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: SHIP, task: "t1" })).json.error, /reviewer App/);
  pr.author = "contributor";
  // Retargeted since the filing.
  pr.base = "release";
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: SHIP, task: "t1" })).json.error, /now targets/);
  pr.base = undefined;

  const out = await run("k-00000000000000c1", "github.approve", a);
  assert.equal(out.ok, true, out.text);
  assert.deepEqual(calls.find((c) => c.method === "POST" && c.path.endsWith("/reviews")).body, { event: "APPROVE", commit_id: c1 });
  assert.deepEqual(calls.filter((c) => c.method === "PUT").map((c) => c.path), [`/repos/${REPO}/pulls/7/reviews/50/dismissals`], "only the earlier head's approval");

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

test("ship's decide: waits, repairs, fixes and the merge path", () => {
  const H = "a".repeat(40);
  const check = (name, conclusion) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion });
  const data = (pr) => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: { state: "OPEN", headRefOid: H, baseRefName: "main", mergeStateStatus: "CLEAN", reviewDecision: null, isDraft: false, isInMergeQueue: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [check("build", "SUCCESS")] } } } }] }, baseRef: { compare: { behindBy: 0 } }, reviews: { nodes: [] }, ...pr } } });
  const go = (pr, ctx = {}) => decideShip(data(pr), H, { queue: false, approve: false, ...ctx });
  assert.equal(go({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", reviewRequests: { nodes: [{ asCodeOwner: true, requestedReviewer: { combinedSlug: "acme/api" } }] } }).why, "waiting on code owner @acme/api");
  assert.equal(go({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }).why, "waiting for required review");
  assert.equal(go({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }, { approve: true }).do, "approve");
  assert.equal(go({ mergeStateStatus: "DIRTY" }).do, "repair");
  assert.equal(go({}, { queue: true }).do, "enqueue", "no review needed: the hand-off is enough");
  assert.equal(go({}, { review: true }).do, "wait", "a gated repo needs an approval on the head");
  assert.equal(go({ reviews: { nodes: [{ state: "APPROVED", commit: { oid: H } }] } }, { review: true }).do, "merge");
  assert.equal(go({ state: "MERGED" }).do, "done");
  // Only the required checks are judged: an optional red one doesn't hold it, and none required with none run is green.
  const red = { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [check("build", "SUCCESS"), check("lint", "FAILURE")] } } } }] } };
  assert.equal(go(red).do, "fix_ci");
  assert.equal(go(red, { required: ["build"] }).do, "merge");
  assert.equal(go({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }).do, "wait");
  assert.equal(go({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }, { required: [] }).do, "merge");
  // Queue removals at this head.
  const removed = (reason) => ({ timelineItems: { nodes: [{ __typename: "RemovedFromMergeQueueEvent", createdAt: "2026-11-24T10:00:00Z", reason, beforeCommit: { oid: H } }] } });
  assert.deepEqual([go(removed("Merge conflict")).do, go(removed("CI timed out")).do, go(removed("A required check failed")).do, go(removed("Manually dequeued")).do, go(removed("something new")).do], ["repair", "enqueue", "fix_ci", "stall", "wait"]);
  assert.equal(queueRemoval(removed("Merge conflict"), H, "2026-11-25T00:00:00Z"), undefined, "before this generation: history");
  assert.equal(mergePath([{ type: "pull_request" }, { type: "merge_queue" }]), "queue");
  assert.equal(mergePath([]), "direct");
  assert.deepEqual(requiredChecks([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }] } }], { contexts: ["ci-required"] }).sort(), ["build", "ci-required"]);
});

test("plan: an adopted PR's merge is refused when the generation is stale or ship isn't installed", () => {
  const ship = { number: 3, generation: 2, expected: "a".repeat(40), head: "a".repeat(40), headRepo: "acme-agents/x", current: 2, filedOn: ["t1"] };
  const pr = (s) => ({ repo: "acme-agents/x", number: 3, head: "a".repeat(40), files: ["a.ts"], checks: [{ name: "b", ok: true }], headMatches: true, ownHead: true, ship: s });
  const st = { agentsOrgs: ["acme-agents"], productRepo: "acme/aidenhq" };
  assert.deepEqual(planParts("merge", { ...st, prs: [pr(ship)] })[0].map((p) => p.rule), ["agents-org-merge"]);
  assert.deepEqual(planParts("merge", { ...st, prs: [pr({ ...ship, current: 3 })] })[0].map((p) => p.rule), ["ship-generation"]);
  assert.deepEqual(planParts("merge", { ...st, prs: [pr({ ...ship, current: undefined })] })[0].map((p) => p.rule), ["ship-generation"]);
});

test("an adoption's direct merge: no checks and none required merges at its bound target; a hand-back before the call ends it", async () => {
  const H = "a".repeat(40);
  const run = async (adopted) => {
    const calls = [];
    const gh = async (method, path) => {
      calls.push(`${method} ${path}`);
      if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, pullRequest: {
        number: 7, state: calls.some((c) => c.startsWith("PUT")) ? "MERGED" : "OPEN", headRefOid: H, baseRefName: "main", isDraft: false, mergeStateStatus: "CLEAN", reviewDecision: null, isInMergeQueue: false,
        mergeCommit: null, commits: { nodes: [{ commit: { statusCheckRollup: null } }] }, baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40) } }, reviews: { nodes: [] }, latestOpinionatedReviews: { nodes: [] },
      } } } } };
      if (path.includes("/rules/branches/")) return { status: 200, body: [] };
      if (path.endsWith("/required_status_checks")) return { status: 404, body: {} };
      if (method === "PUT") return { status: 200, body: { sha: "c".repeat(40) } };
      return { status: 404, body: {} };
    };
    const outcomes = [];
    const { createMerges } = await import("../service/src/merges.ts");
    const m = createMerges({ dir: mkdtempSync(join(tmpdir(), "ship-merge-")), gh, fleetOrg: "acme-agents", reviewGate: async () => undefined, report: async (id, o) => void outcomes.push(o), ship: { generation: async () => ({ generation: adopted ? 2 : null }) } });
    void m.enqueue("k-1", { prs: [{ repo: REPO, number: 7, head: H, base: "main" }], generation: 2, attempt: 1 });
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
});
