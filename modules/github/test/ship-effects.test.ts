// The ship module's typed effects on an adopted PR, end to end against a bare "GitHub" repo, a fake API and a fake ship: a push
// onto the PR's own branch carries a lease on the head it expects (a contributor's push in between wins), approve and enqueue
// are ship's alone and bound to the head, and an ambiguous enqueue is reconciled by reading the queue, never sent twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createService, shipAdoptions } from "../service/src/service.ts";
import { withActors } from "./actors.ts";
import { planParts } from "../service/src/plan.ts";
import { decide, mergePath, requiredChecks } from "../service/src/merge-gate.ts";
import { createMerges as mergesWith } from "../service/src/merges.ts";
/** The merge queue with every merge as the owner, through the test's own fake GitHub (github-mcp's actorFor picks it in the service). */
const createMerges = (d: any) => mergesWith({ actorFor: async () => ({ key: "owner", rest: d.gh }), actorByKey: async () => ({ rest: d.gh }), ...d });
import { githubWrites } from "./fake-github-writes.ts";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" } }).trim();
const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const REPO = "acme-agents/widget";
const SHIP = { kind: "module", module: "ship", roles: [] };

async function setup(t, { generation = 2, queue = {}, asyncMerge = { put: () => ({ status: 202, body: { status: "pending", details: { uuid: "u-d" } } }), get: () => ({ status: 200, body: { status: "enqueued", details: {} } }) }, app = true, appOps = ["pr"], appTokens = undefined, toolsDir = false, fleetOrg = "acme-agents", listed = [], connected = () => true, reviewGate = async () => undefined, queueRead = () => undefined, signedBranches = () => false, baseAhead = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ship-effects-"));
  const origin = join(root, "github", REPO, "..", "widget.git");
  mkdirSync(origin, { recursive: true });
  sh(origin, "init", "--quiet", "--bare", "-b", "main");
  // A contributor's PR #7 on `contrib`, and the task's workspace with one repair commit on top of it.
  const ws = join(root, "tasks", "TASK-1", "widget");
  sh(root, "init", "--quiet", "-b", "main", ws);
  writeFileSync(join(ws, "a.txt"), "a\n");
  sh(ws, "add", "a.txt");
  // `toolsDir`: the base holds `tools` as a file, and main makes it a directory (`tools/run`) while the PR's head keeps the file:
  // git merges the two cleanly into `tools/run` alone, so the repair's result names a directory where the head names a file.
  if (toolsDir) writeFileSync(join(ws, "tools"), "hi\n");
  sh(ws, "add", "a.txt", ...(toolsDir ? ["tools"] : []));
  sh(ws, "commit", "--quiet", "-m", "init");
  sh(ws, "push", "--quiet", origin, "main");
  const base = sh(ws, "rev-parse", "HEAD");
  if (toolsDir) {
    // `toolsDir: "deep"` puts nothing directly under `tools` (only `tools/bin/run`): the file->directory probe must handle depth.
    const inner = toolsDir === "deep" ? "bin/run" : "run";
    sh(ws, "rm", "--quiet", "tools");
    mkdirSync(join(ws, "tools", dirname(inner)), { recursive: true });
    writeFileSync(join(ws, "tools", inner), toolsDir === "deep" ? "run\n" : "run\n");
    sh(ws, "add", `tools/${inner}`);
    sh(ws, "commit", "--quiet", "-m", "main: tools is a directory");
    sh(ws, "push", "--quiet", origin, "main");
  }
  sh(ws, "checkout", "--quiet", "-b", "contrib", base);
  writeFileSync(join(ws, "b.txt"), "b\n");
  if (baseAhead) writeFileSync(join(ws, "gen.txt"), "head\n");
  sh(ws, "add", "b.txt", ...(baseAhead ? ["gen.txt"] : []));
  sh(ws, "commit", "--quiet", "-m", "contributor");
  sh(ws, "push", "--quiet", origin, "contrib");
  const c1 = sh(ws, "rev-parse", "HEAD");
  // `baseAhead`: main moves on past the PR's base and conflicts with it on the generated gen.txt, so a repair has a conflict to
  // resolve (a head that merges main cleanly is a no-op).
  if (baseAhead) {
    sh(ws, "checkout", "--quiet", "main");
    writeFileSync(join(ws, "m.txt"), "m\n");
    writeFileSync(join(ws, "gen.txt"), "base\n");
    sh(ws, "add", "m.txt", "gen.txt");
    sh(ws, "commit", "--quiet", "-m", "main moves on");
    sh(ws, "push", "--quiet", origin, "main");
    sh(ws, "checkout", "--quiet", "contrib");
  }
  const main = sh(ws, "rev-parse", "main");
  writeFileSync(join(ws, "gen.txt"), "regenerated\n");
  sh(ws, "add", "gen.txt");
  sh(ws, "commit", "--quiet", "-m", "repair");
  const fix = sh(ws, "rev-parse", "HEAD");
  const bundle = (sha) => {
    sh(ws, "update-ref", `refs/aidenhq/publish/${sha}`, sha);
    sh(ws, "bundle", "create", "--quiet", join(dirname(ws), ".aidenhq", "bundles", `${sha}.bundle`), `refs/aidenhq/publish/${sha}`);
  };
  mkdirSync(join(dirname(ws), ".aidenhq", "bundles"), { recursive: true });
  bundle(fix);
  // A published task branch at F, a child of H, and the box bundle of H: the write that must never rewind it (a bundle planned
  // before the fix landed). A `github.pr` on it is open at F.
  sh(ws, "checkout", "--quiet", "-b", "lease", "main");
  writeFileSync(join(ws, "h.txt"), "h\n");
  sh(ws, "add", "h.txt");
  sh(ws, "commit", "--quiet", "-m", "H");
  const H = sh(ws, "rev-parse", "HEAD");
  writeFileSync(join(ws, "f.txt"), "f\n");
  sh(ws, "add", "f.txt");
  sh(ws, "commit", "--quiet", "-m", "F");
  const F = sh(ws, "rev-parse", "HEAD");
  sh(ws, "push", "--quiet", origin, "HEAD:refs/heads/lease");
  // A box commit that turns the head's file `tools` into a directory (`tools/run`): the ordinary publish path (`apiCommits`) must
  // build its tree from the commit's own tree too, never a `D tools` next to `A tools/run`.
  let fileToDir;
  if (toolsDir) {
    sh(ws, "checkout", "--quiet", "-b", "filedir", c1);
    sh(ws, "rm", "--quiet", "tools");
    mkdirSync(join(ws, "tools"));
    writeFileSync(join(ws, "tools", "run"), "run as a file first\n");
    sh(ws, "add", "tools/run");
    sh(ws, "commit", "--quiet", "-m", "tools becomes a directory");
    fileToDir = sh(ws, "rev-parse", "HEAD");
    bundle(fileToDir);
  }
  // A branch the same task already owns at H, for the ordinary fast-forward it must still land.
  sh(ws, "push", "--quiet", origin, `${H}:refs/heads/ff`);
  bundle(H);
  bundle(F);

  const pr = { head: c1, author: "contributor" };
  const checks = [];
  const regenerated = Buffer.from("regenerated\n");
  const repairResult = { result: { changed: 1 }, keep: { message: "Merge branch 'main' into the PR", entries: [{ path: "gen.txt", mode: "100644", sha: execFileSync("git", ["hash-object", "--stdin"], { input: regenerated, encoding: "utf8" }).trim(), content: regenerated.toString("base64") }] } };
  const outcomes = [];
  // A contributor's push while ship's repair runs (`duringRepair`), so the head lease it read before the run is tested.
  let duringRepair;
  // A write GitHub refuses for its own reasons (a repository rule), never a moved head: the branch reads back at the expected head.
  let refuseRef = false;
  // GitHub's signed commits (createCommitOnBranch inputs), as sent.
  const signed = [];
  const writes = githubWrites(() => origin, { signed: signedBranches, refuse: () => (refuseRef ? "Repository rule violations found\n\nCommits must have verified signatures.\n\n" : undefined) });
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const m = /^\/v1\/writes\/([^/]+)\/outcome$/.exec(req.url);
    if (m) { outcomes.push({ id: m[1], ...JSON.parse(body) }); return res.writeHead(200).end("{}"); }
    // A held write's own record, read before it runs (`stillClaimed`): live until an outcome is reported for it.
    const w = /^\/v1\/writes\/([^/?]+)$/.exec(req.url);
    if (w && req.method === "GET") return res.writeHead(200).end(JSON.stringify({ state: outcomes.some((o) => o.id === w[1]) ? "done" : "claimed" }));
    // Ship's repair check job, already done: its result and the file it kept.
    if (req.url === "/v1/checks") { checks.push(JSON.parse(body)); if (duringRepair) duringRepair(); return res.writeHead(200).end(JSON.stringify({ id: "c-1", state: "done", version: 1, result: repairResult.result })); }
    if (req.url === "/v1/checks/c-1/kept") return res.writeHead(200).end(JSON.stringify(repairResult.keep));
    res.writeHead(404).end("{}");
  });
  const calls = [];
  const memberPr = { v: { reviewThreads: { nodes: [] }, comments: { nodes: [] } } };
  /** git against the bare origin, as GitHub's side would hold it (no hooks from the host's own environment). */
  const bare = (args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: origin, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  const gh = async (method, path, body, as) => {
    calls.push({ method, path, body, ...(as ? { as } : {}) });
    // GitHub's signed commit (createCommitOnBranch), git data and refs over the bare origin (fake-github-writes.ts), signed where the
    // App makes it. `refuseRef` is a repository rule refusing it. The PR's head follows its branch.
    if (path === "/graphql" && body.query.includes("createCommitOnBranch")) signed.push(body.variables.input);
    const wrote = writes(method, path, body, as);
    if (wrote) {
      if (path === "/graphql" && wrote.body.data?.createCommitOnBranch && body.variables.input.branch.branchName === "contrib") pr.head = wrote.body.data.createCommitOnBranch.commit.oid;
      if (path === "/graphql" && wrote.body.data?.updateRefs) for (const u of body.variables.input.refUpdates) if (u.name === "refs/heads/contrib") pr.head = u.afterOid;
      return wrote;
    }
    // The asynchronous merge REST API: the one way into the queue.
    if (asyncMerge && method === "PUT" && path === `/repos/${REPO}/pulls/7/merge-async`) return asyncMerge.put(body);
    if (asyncMerge && method === "GET" && path.startsWith(`/repos/${REPO}/pulls/7/merge-async/`)) return asyncMerge.get(path.split("/").pop());
    if (path === "/graphql" && body.query.includes("MemberComments") === false && body.query.includes("reviewThreads(last")) return { status: 200, body: { data: { repository: { pullRequest: memberPr.v } } } };
    // A queue read GitHub could not answer (`queueRead()` returns a failure for it): the transient case a read must survive.
    if (path === "/graphql" && body.query.includes("isInMergeQueue")) {
      const failed = queueRead(queue);
      if (failed) return failed;
    }
    if (path === "/graphql") return { status: 200, body: { data: { repository: { pullRequest: { id: "PR_7", state: "OPEN", headRefOid: pr.head, baseRefName: "main", isInMergeQueue: Boolean(queue.head), mergeQueueEntry: queue.head ? { headCommit: { oid: queue.head } } : null, ...queue.review } } } } };
    if (method === "GET" && /\/commits\/[0-9a-f]{40}\/check-runs/.test(path)) return { status: 200, body: { total_count: 0, check_runs: [] } };
    if (method === "GET" && /\/commits\/[0-9a-f]{40}\/status/.test(path)) return { status: 200, body: { total_count: 0, statuses: [] } };
    if (method === "GET" && path === `/repos/${REPO}`) return { status: 200, body: { default_branch: "main", node_id: REPO } };
    // The open PR on the published task branch (`github.pr` on it): its head follows a PATCH, so a rewind would show here.
    if (method === "GET" && path.startsWith(`/repos/${REPO}/pulls?state=open&head=acme-agents%3A`)) {
      // The whole query, `&base=main` and all: the branch is its `head` value, never the rest of the path.
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const branch = decodeURIComponent(String(q.get("head") ?? "")).replace(/^acme-agents:/, "");
      return { status: 200, body: branch === "lease" ? [{ number: 8, html_url: `https://github.com/${REPO}/pull/8`, head: { sha: bare(["rev-parse", "refs/heads/lease"]) }, base: { ref: "main" } }] : [] };
    }
    if (method === "GET" && path === `/repos/${REPO}/pulls/8`) return { status: 200, body: { number: 8, state: "open", head: { sha: bare(["rev-parse", "refs/heads/lease"]) }, base: { ref: "main" } } };
    if (method === "PATCH" && path === `/repos/${REPO}/pulls/8`) return { status: 200, body: { number: 8, html_url: `https://github.com/${REPO}/pull/8`, head: { sha: bare(["rev-parse", "refs/heads/lease"]) }, base: { ref: "main" } } };
    // A new PR the publish opens (a branch with none yet): its head is whatever the branch holds when it asks.
    if (method === "POST" && path === `/repos/${REPO}/pulls`) return { status: 201, body: { number: 9, html_url: `https://github.com/${REPO}/pull/9`, head: { sha: bare(["rev-parse", `refs/heads/${body.head}`]), ref: body.head }, base: { ref: body.base, sha: main }, user: { login: "owner1" } } };
    if (method === "GET" && path === `/repos/${REPO}/pulls/7`) return { status: 200, body: { number: 7, state: pr.state ?? "open", title: pr.title ?? "wip", head: { sha: pr.head, ref: "contrib", repo: pr.fork ? { full_name: "someone/widget" } : { full_name: REPO } }, base: { ref: pr.base ?? "main", sha: bare(["rev-parse", "refs/heads/main"]) }, user: { login: pr.author, id: pr.author === "acme-app[bot]" ? 900 : 1 }, maintainer_can_modify: pr.canModify === true } };
    // The title write: only the title changes; the fake keeps the rest as it read it (a body, base or state sent would show here).
    if (method === "PATCH" && path === `/repos/${REPO}/pulls/7`) { pr.title = body?.title ?? pr.title; return { status: 200, body: { number: 7, title: pr.title, state: "open", head: { sha: pr.head }, base: { ref: pr.base ?? "main" } } }; }
    if (method === "POST" && path === `/repos/${REPO}/pulls/7/reviews`) return { status: 200, body: { id: 99 } };
    // A merge's plan lists the PR's files (at most a page): this one changed one file, so the listing is the whole set.
    if (method === "GET" && path === `/repos/${REPO}/pulls/7/files?per_page=100`) return { status: 200, body: [{ filename: "b.txt" }] };
    if (method === "GET" && path.startsWith(`/repos/${REPO}/pulls/7/reviews`)) return { status: 200, body: [{ id: 50, user: { login: "acme-app[bot]", id: 900 }, state: "APPROVED", commit_id: "e".repeat(40) }, { id: 51, user: { login: "owner1", id: 1 }, state: "APPROVED", commit_id: "e".repeat(40) }, { id: 99, user: { login: "acme-app[bot]", id: 900 }, state: "APPROVED", commit_id: pr.head }] };
    if (method === "PUT" && /\/dismissals$/.test(path)) return { status: 200, body: {} };
    if (method === "GET" && path.startsWith(`/repos/${REPO}/compare/`)) return { status: 200, body: { merge_base_commit: { sha: main } } };
    return { status: 404, body: { message: "fake GitHub: no route" } };
  };
  const access = {
    connected, scopes: () => ["repo"], status: () => ({ scopes: ["repo"], problems: [] }), token: async () => "tok",
    identity: async () => ({ login: "owner1", name: "Owner One", email: "1+owner1@users.noreply.github.com" }),
    rest: async (method, path, body) => ({ ...(await gh(method, path, body)), headers: new Headers() }),
    graphql: async () => ({}),
  };
  const adoption = { generation, refused: undefined, hold: undefined, task: "t1", comments: undefined };
  // Ship's answer, and its final tier check where github passes the write and the live head, base and author. A fork's head binding
  // lives in ship's own answer: an `at` other than the handed-off head reads as a stop, even while the adoption is stalled.
  const handoffHead = { head: undefined };
  const ship = { generation: async (_r, _n, at, check) => ({
    generation: adoption.generation,
    ...(adoption.task ? { task: adoption.task } : {}),
    ...(handoffHead.head !== undefined && at !== handoffHead.head ? { hold: { kind: "stopped", reason: "the write isn't on the head handed off" } } : adoption.hold ? { hold: adoption.hold } : {}),
    ...(adoption.refused && check ? { refused: adoption.refused } : {}),
    ...(adoption.comments && check ? { comments: adoption.comments } : {}),
  }) };
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir: join(root, "cache"), tasksDir: join(root, "tasks"),
    // The App, installed on the repo with the permissions of `appOps` (by default pull requests: approvals): its calls are recorded
    // like the owner's (`as` marks whose they are).
    access: withActors(access, app ? { on: (repo, op) => repo.toLowerCase() === REPO.toLowerCase() && appOps.includes(op), rest: async (method, path, body) => ({ ...(await gh(method, path, body, "app")), headers: new Headers() }), tokens: appTokens } : undefined),
    remoteUrl: (slug) => join(root, "github", `${slug.split("/")[0]}/${slug.split("/")[1]}.git`), fleetOrg, productRepo: "acme/aidenhq", listed,
    reviewGate, ship, asyncPollMs: 0,
  });
  const svc = await listen((req, res) => void handle(req, res));
  t.after(() => { kernel.s.close(); svc.s.close(); });
  const call = async (path, body) => {
    const r = await fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: "Bearer ch-key", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const run = async (id, kind, args, filed) => {
    const n = outcomes.length;
    // The kernel executes a record with the args its plan stored, never the caller's: the plan's own args carry the head it read
    // (and a revalidation gets the record's stored args back unchanged). A publish files its card first, so the test does too; a
    // test that already filed one passes that plan (the card a later push does not widen).
    const plan = filed ?? (kind === "github.push" || kind === "github.pr"
      ? await call("/aidenhq/v1/executor/plan", { kind, args, requester: { kind: "job", roles: [] }, task: "t1" })
      : undefined);
    const exec = plan?.status === 200 ? plan.json.args : args;
    assert.deepEqual((await call("/aidenhq/v1/executor/execute", { id, kind, args: exec, digest: "d", idempotency_key: id, tier: 0 })).json, { accepted: true });
    for (let i = 0; i < 300 && outcomes.length === n; i++) await new Promise((r) => setTimeout(r, 10));
    return outcomes[n];
  };
  return { memberPr, root, ws, origin, base, c1, cacheDir: join(root, "cache"), fileToDir, fix, main, H, F, pr, queue, calls, call, run, adoption, handoffHead, handle, checks, repairResult, signed, duringRepair: (fn) => { duringRepair = fn; }, refuseRef: (v) => { refuseRef = v; } };
}

test("a push onto an adopted PR's branch is one commit GitHub makes and signs, bound to the head it expects; a contributor's push in between wins", async (t) => {
  const { ws, origin, c1, fix, pr, calls, call, run, signed } = await setup(t);
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

  // A contributor pushes after the read: GitHub's API still says c1 (it lags), the commit bound to c1 refuses, and their commit stays.
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

  // Back at c1, the push lands, but never after the contributor closed the PR.
  sh(scratch, "push", "--quiet", "--force", origin, `${c1}:refs/heads/contrib`);
  pr.state = "closed";
  const closed = await run("k-00000000000000b3", "github.push", args);
  assert.match(closed.text, /^ship-scope: .* is closed/);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), c1);
  pr.state = "open";
  const before = signed.length;
  const ok = await run("k-00000000000000b2", "github.push", args);
  assert.equal(ok.ok, true, ok.text);
  // One commit GitHub made (and signs) on top of c1, holding the box commit's tree, sent as the code host's sign-in (never the App).
  assert.equal(signed.length - before, 1, "one createCommitOnBranch");
  assert.equal(signed.at(-1).expectedHeadOid, c1, "bound to the head the write expects");
  assert.deepEqual(signed.at(-1).fileChanges.additions.map((f) => f.path), ["gen.txt"]);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^{tree}"), sh(ws, "rev-parse", `${fix}^{tree}`));
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^"), c1);
  assert.equal(sh(origin, "log", "-1", "--format=%cn", "refs/heads/contrib"), "GitHub");
  assert.ok(calls.filter((c) => c.path === "/graphql" && c.body?.query?.includes("createCommitOnBranch")).every((c) => c.as === undefined), "every write is the code host's, none the reviewer App's");
  assert.equal(calls.filter((c) => c.method !== "GET" && c.path.includes("/git/")).length, 0, "no unsigned git-data write");
  assert.match(ok.text, / as owner1 \(commits GitHub signs\)\.$/);
});

/** A fixer's push that merges main (which moved on and adds `b.txt` too, an add/add conflict with the PR's own) into the head,
 * resolves `b.txt`, then commits one more fix on top: its bundle, main's tip, and the box commit. */
function conflictedMerge(ws, origin) {
  const mainMove = join(dirname(ws), "main-move");
  sh(dirname(ws), "clone", "--quiet", "-b", "main", origin, mainMove);
  writeFileSync(join(mainMove, "b.txt"), "b from main\n");
  writeFileSync(join(mainMove, "m.txt"), "m\n");
  sh(mainMove, "add", "b.txt", "m.txt");
  sh(mainMove, "commit", "--quiet", "-m", "main moves");
  sh(mainMove, "push", "--quiet", origin, "main");
  const tip = sh(mainMove, "rev-parse", "HEAD");
  const fixer = join(dirname(ws), "fixer");
  sh(dirname(ws), "clone", "--quiet", "-b", "contrib", origin, fixer);
  try { sh(fixer, "merge", "--quiet", "--no-edit", "origin/main"); } catch {}
  writeFileSync(join(fixer, "b.txt"), "resolved: b and b from main\n");
  sh(fixer, "add", "b.txt");
  sh(fixer, "commit", "--quiet", "--no-edit");
  writeFileSync(join(fixer, "c.txt"), "after the merge\n");
  sh(fixer, "add", "c.txt");
  sh(fixer, "commit", "--quiet", "-m", "fix: after the merge");
  const done = sh(fixer, "rev-parse", "HEAD");
  sh(fixer, "update-ref", `refs/aidenhq/publish/${done}`, done);
  sh(fixer, "bundle", "create", "--quiet", join(dirname(ws), ".aidenhq", "bundles", `${done}.bundle`), `refs/aidenhq/publish/${done}`);
  return { tip, fixer, done };
}

test("a push that merges the base after a conflict lands as one merge commit GitHub signs: parents the head and the base's tip, the resolution's tree, both sides kept", async (t) => {
  const { ws, origin, c1, pr, run, calls, signed } = await setup(t, { appOps: ["pr", "push"] });
  const { tip, fixer, done } = conflictedMerge(ws, origin);
  const ok = await run("k-00000000000000aa", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: done }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 });
  assert.equal(ok.ok, true, ok.text);
  const head = sh(origin, "rev-parse", "refs/heads/contrib");
  // One commit on the head, no intermediate one: its parents exactly the head and main's tip, its tree the fixer's own.
  assert.equal(sh(origin, "rev-list", "--count", "--first-parent", `${c1}..${head}`), "1", "one commit on the head");
  assert.equal(sh(origin, "rev-list", "--parents", "-n", "1", head), `${head} ${c1} ${tip}`);
  assert.equal(sh(origin, "rev-parse", `${head}^{tree}`), sh(fixer, "rev-parse", `${done}^{tree}`), "the branch holds the fixer's exact tree");
  // The conflicted file holds the resolution (never the base's side alone), the base's own change and the fix are both there.
  assert.equal(sh(origin, "show", `${head}:b.txt`), "resolved: b and b from main");
  assert.equal(sh(origin, "show", `${head}:m.txt`), "m");
  assert.equal(sh(origin, "show", `${head}:c.txt`), "after the merge");
  assert.match(sh(origin, "log", "-1", "--format=%B", head), /Merge remote-tracking branch 'origin\/main' into contrib[\s\S]*fix: after the merge/);
  // GitHub's own commit, verified, as the App: one commit write, one fast-forward of the branch, no createCommitOnBranch.
  const commits = calls.filter((c) => c.method === "POST" && c.path === `/repos/${REPO}/git/commits`);
  assert.deepEqual(commits.map((c) => [c.as, c.body.parents, c.body.author, c.body.committer]), [["app", [c1, tip], undefined, undefined]]);
  assert.deepEqual(calls.filter((c) => c.path === "/graphql" && String(c.body?.query).includes("updateRefs")).map((c) => [c.as, c.body.variables.input.refUpdates]), [["app", [{ name: "refs/heads/contrib", beforeOid: c1, afterOid: head }]]], "the branch moves bound to the head exactly");
  assert.equal(signed.length, 0);
  assert.equal(calls.filter((c) => /update-branch/.test(c.path)).length, 0);
  assert.equal(pr.head, head);
});

test("a base merge made with the owner's sign-in lands unsigned where the branch accepts it", async (t) => {
  const { ws, origin, c1, run, calls } = await setup(t);
  const { done } = conflictedMerge(ws, origin);
  const args = { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: done }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 };
  // The owner's sign-in: GitHub makes the REST commit but doesn't sign it. `contrib` has no required_signatures rule, so it is
  // accepted; before this, the App-only signature check refused every owner-token merge.
  const unsigned = await run("k-00000000000000ac", "github.push", args);
  assert.equal(unsigned.ok, true, unsigned.text);
  const head = sh(origin, "rev-parse", "refs/heads/contrib");
  assert.notEqual(head, c1, "the merge is written");
  assert.equal(sh(origin, "rev-list", "--parents", "-n", "1", head).split(" ").length, 3, "one merge commit of the head and the base");
  // The REST commit is the owner's (no `as` mark), and the fake GitHub reports it unsigned — exactly the path that used to refuse.
  const commits = calls.filter((c) => c.method === "POST" && c.path === `/repos/${REPO}/git/commits`);
  assert.deepEqual(commits.map((c) => [c.as, c.body.parents]), [[undefined, [c1, sh(origin, "rev-parse", "main")]]]);
  assert.equal(calls.filter((c) => c.path === "/graphql" && String(c.body?.query).includes("updateRefs")).length, 1, "the branch moves to the merge");
});

test("a base merge whose commit GitHub didn't sign is still refused where the branch requires signed commits", async (t) => {
  const { ws, origin, c1, run, calls } = await setup(t, { signedBranches: () => true });
  const { done } = conflictedMerge(ws, origin);
  const args = { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: done }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 };
  const refused = await run("k-00000000000000ae", "github.push", args);
  assert.equal(refused.ok, false);
  assert.match(refused.text, /^ship-refused: .*requires signed commits.*Nothing was pushed/, refused.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), c1, "the branch is unchanged");
  assert.equal(calls.filter((c) => c.path === "/graphql" && String(c.body?.query).includes("updateRefs")).length, 0, "no ref write");
});

test("a base merge whose branch moved before the ref update is ship-head-moved, and the contributor's push stays", async (t) => {
  const { ws, origin, c1, run } = await setup(t, { appOps: ["pr", "push"] });
  const { done } = conflictedMerge(ws, origin);
  // A contributor pushes after the read: GitHub's PR still says c1 (it lags), so only the ref update's lease on c1 catches it.
  const scratch = `${ws}-contrib`;
  sh(dirname(ws), "clone", "--quiet", "-b", "contrib", origin, scratch);
  writeFileSync(join(scratch, "d.txt"), "d\n");
  sh(scratch, "add", "d.txt");
  sh(scratch, "commit", "--quiet", "-m", "contributor again");
  sh(scratch, "push", "--quiet", origin, "contrib");
  const theirs = sh(scratch, "rev-parse", "HEAD");
  const r = await run("k-00000000000000ad", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: done }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 });
  assert.equal(r.ok, false);
  assert.match(r.text, /^ship-head-moved: .* moved while writing .*nothing was pushed/, r.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), theirs, "the contributor's push is never overwritten");
});

test("a push whose box commit is a merge made on the base is refused, never replayed onto the PR head", async (t) => {
  const { ws, origin, c1, run, signed, calls } = await setup(t);
  // The fixer merged the PR branch into a checkout of the updated base: the merge's first parent is the base tip, not the PR
  // head. Writing it would build the base's commits on the PR head and land a tree that drops the head's own files.
  const mainMove = join(dirname(ws), "main-move");
  sh(dirname(ws), "clone", "--quiet", "-b", "main", origin, mainMove);
  writeFileSync(join(mainMove, "m.txt"), "m\n");
  sh(mainMove, "add", "m.txt");
  sh(mainMove, "commit", "--quiet", "-m", "main moves");
  sh(mainMove, "push", "--quiet", origin, "main");
  const reversed = join(dirname(ws), "reversed");
  sh(dirname(ws), "clone", "--quiet", "-b", "main", origin, reversed);
  sh(reversed, "merge", "--quiet", "-s", "ours", "--no-edit", "origin/contrib");
  const reversedSha = sh(reversed, "rev-parse", "HEAD");
  assert.notEqual(sh(reversed, "rev-parse", `${reversedSha}^1`), c1, "the merge's first parent is the base, not the PR head");
  sh(reversed, "update-ref", `refs/aidenhq/publish/${reversedSha}`, reversedSha);
  sh(reversed, "bundle", "create", "--quiet", join(dirname(ws), ".aidenhq", "bundles", `${reversedSha}.bundle`), `refs/aidenhq/publish/${reversedSha}`);
  const before = sh(origin, "rev-parse", "refs/heads/contrib");
  const r = await run("k-00000000000000ab", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: reversedSha }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 });
  assert.equal(r.ok, false, r.text);
  assert.match(r.text, /^ship-scope: .*not replayed/);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), before, "the branch is untouched");
  assert.equal(signed.length + calls.filter((c) => c.method !== "GET" && c.path.includes("/git/")).length, 0, "nothing is written");
});

test("a stalled adoption's push is the one write that resumes it: the plan and the effect let it land, every other write stays refused", async (t) => {
  const { origin, c1, fix, pr, run, call, adoption, handoffHead } = await setup(t);
  const args = { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: fix }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 };
  const plan = (kind, a, task = "t1") => call("/aidenhq/v1/executor/plan", { kind, args: a, requester: SHIP, task });
  adoption.hold = { kind: "stalled", reason: "the repair didn't finish" };
  // The push at the head the write expects, filed on the adoption's task: it plans as an ordinary agents-org push, and lands.
  const pushed = await plan("github.push", args);
  assert.equal(pushed.status, 200, JSON.stringify(pushed.json));
  assert.equal(pushed.json.raise, undefined, "the stalled push is the task's own push, nothing raised");
  const landed = await run("k-00000000000000f1", "github.push", args);
  assert.equal(landed.ok, true, landed.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^"), c1, "the branch moved, from the head the write expected");
  pr.head = sh(origin, "rev-parse", "refs/heads/contrib");
  // Approve, enqueue and an adoption's merge stay refused on a stalled hold, as they do on any hold.
  const write = { repo: REPO, number: 7, head: pr.head, generation: 2, base: "main" };
  for (const kind of ["github.approve", "github.enqueue", "github.merge"]) {
    const a = kind === "github.merge" ? { prs: [{ repo: REPO, number: 7, head: pr.head, base: "main" }], generation: 2, attempt: 1 } : { ...write, ...(kind === "github.enqueue" ? { attempt: 1 } : {}) };
    const r = await plan(kind, a);
    assert.equal(r.status, 422, `${kind}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, /on hold by ship \(stalled/, `${kind}: ${r.json.error}`);
  }
  // The effect reads the adoption again: an approval filed before the hold posts nothing.
  const approved = await run("k-00000000000000f2", "github.approve", write);
  assert.match(approved.text, /^ship-generation: .*on hold by ship \(stalled/, approved.text);
  // A push off the head the write names is head movement, and one filed on another task is out of scope: both still refuse.
  assert.match((await plan("github.push", { ...args, expected: "f".repeat(40) })).json.error, /moved to/);
  assert.match((await plan("github.push", args, "t9")).json.error, /adoption's task/);
  // A hand-back or a stop refuses the push too: only a stalled hold admits it.
  for (const kind of ["handed_back", "stopped"]) {
    adoption.hold = { kind };
    const r = await plan("github.push", args);
    assert.equal(r.status, 422, `${kind}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.error, new RegExp(`on hold by ship \\(${kind}`));
    assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), pr.head, "nothing moved");
  }
  // Cleared, the adoption takes a push at the head its write names again (the ordinary path: here the head moved, so it is refused).
  adoption.hold = undefined;
  assert.equal((await plan("github.push", args)).status, 422, "the head moved past the write once the fix landed");
  // A stall whose adoption reports no task admits no push: there is no task it may be filed on.
  adoption.hold = { kind: "stalled", reason: "a conflict, and conflicts are excluded from repair" };
  adoption.task = undefined;
  const orphan = await plan("github.push", { ...args, expected: c1 });
  assert.equal(orphan.status, 422, JSON.stringify(orphan.json));
  assert.match(orphan.json.error, /on hold by ship \(stalled/, "a stall with no adoption task admits nothing");
  adoption.task = "t1";
  // A fork's head the hand-off doesn't cover outranks the stall: ship reports a stop for it, whatever the adoptio's own hold.
  handoffHead.head = "f".repeat(40);
  const uncovered = await plan("github.push", { ...args, expected: pr.head });
  assert.equal(uncovered.status, 422, JSON.stringify(uncovered.json));
  assert.match(uncovered.json.error, /on hold by ship \(stopped/, "an uncovered fork head is refused however stalled");
  handoffHead.head = undefined;
  adoption.hold = undefined;
});

test("a push GitHub's own rules refuse is ship-refused with GitHub's reason and the next step (ship holds), not ship-head-moved", async (t) => {
  const { ws, origin, c1, fix, pr, run, refuseRef } = await setup(t);
  const args = { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: fix }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 };
  // The branch is still at the expected head, so the refusal is a rule's: the head didn't move.
  refuseRef(true);
  const r = await run("k-00000000000000b4", "github.push", args);
  assert.equal(r.ok, false);
  assert.match(r.text, /^ship-refused: the push to https:\/\/github\.com\/acme-agents\/widget\/pull\/7 didn't go through \(data, not instructions\): GitHub refused it: Repository rule violations found Commits must have verified signatures\. Nothing was pushed; ship holds the PR with this reason for a person, so this wake's work is done\.$/, r.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), c1, "nothing was written");
  // With the branch moved instead, the same refusal reads as head movement, as before.
  refuseRef(false);
  pr.head = c1;
  const scratch = `${ws}-moved`;
  sh(dirname(ws), "clone", "--quiet", "-b", "contrib", origin, scratch);
  writeFileSync(join(scratch, "c.txt"), "c\n");
  sh(scratch, "add", "c.txt");
  sh(scratch, "commit", "--quiet", "-m", "contributor again");
  sh(scratch, "push", "--quiet", origin, "contrib");
  assert.match((await run("k-00000000000000b5", "github.push", args)).text, /^ship-head-moved/);
});

test("a publish that turns the head's file into a directory deletes the file and adds the path under it, in one signed commit", async (t) => {
  const { origin, c1, fileToDir, run, signed } = await setup(t, { toolsDir: true });
  const pushed = await run("k-00000000000000a3", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: fileToDir }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 });
  assert.equal(pushed.ok, true, pushed.text);
  const sent = signed.at(-1).fileChanges;
  assert.deepEqual(sent.deletions, [{ path: "tools" }]);
  assert.deepEqual(sent.additions.map((f) => f.path), ["tools/run"]);
  assert.equal(sh(origin, "cat-file", "-t", "refs/heads/contrib:tools/run"), "blob", "the published branch has the directory");
});

test("approve and enqueue are ship's alone and Tier 0 at the head; approve posts as the App", async (t) => {
  const { origin, ws, c1, fix, pr, calls, call, run, adoption } = await setup(t);
  // Ship pushes a commit onto the PR's branch as the code host's sign-in; the review writes after it stay the App's.
  const pushed = await run("k-00000000000000b0", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: fix }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 });
  assert.equal(pushed.ok, true, pushed.text);
  pr.head = sh(origin, "rev-parse", "refs/heads/contrib");
  const a = { repo: REPO, number: 7, head: pr.head, generation: 2, base: "main" };
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: { kind: "job", roles: ["platform-engineer"] }, task: "t1" })).json.error, /only the ship module/);
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: SHIP, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.raise, undefined);
  // The App's own PR: GitHub won't let it approve, so a human must.
  pr.author = "acme-app[bot]";
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: SHIP, task: "t1" })).json.error, /approval needs a person/);
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
  const approved = calls.find((c) => c.method === "POST" && c.path.endsWith("/reviews"));
  assert.deepEqual(approved.body, { event: "APPROVE", commit_id: pr.head });
  assert.equal(approved.as, "app", "as the App, never the owner");

  // An enqueue of a head the runner didn't push is a merge by the queue: the AI reviewer reads it first, and the queue is
  // joined as the code host's sign-in (the reviewer App's manifest has no merge_queues, so GitHub would refuse it).
  const e = { ...a, attempt: 1 };
  const enq = await call("/aidenhq/v1/executor/plan", { kind: "github.enqueue", args: e, requester: SHIP, task: "t1" });
  assert.equal(enq.status, 200, JSON.stringify(enq.json));
  assert.equal(enq.json.raise?.rule, "agents-org-merge-foreign-head");
  const queued = await run("k-00000000000000c2", "github.enqueue", e);
  assert.match(queued.text, /in the merge queue/, queued.text);
  const sent = calls.filter((c) => c.method === "PUT" && /\/merge-async$/.test(c.path));
  assert.equal(sent.length, 1);
  assert.ok(sent.every((c) => c.as === undefined), "the queue is joined as the code host's sign-in, never the reviewer App");
});

test("a member's comment since the record was filed ends an approve and an enqueue before they go on, once", async (t) => {
  const { c1, calls, run, adoption, memberPr } = await setup(t);
  adoption.comments = { since: "2020-01-01T00:00:00Z" };
  memberPr.v = { reviewThreads: { nodes: [{ id: "T1", isResolved: false, path: "a.ts", line: 1, comments: { nodes: [{ fullDatabaseId: "1", author: { __typename: "User", login: "maxsam4" }, authorAssociation: "MEMBER" }] }, last: { nodes: [{ fullDatabaseId: "1", body: "fix this", author: { __typename: "User", login: "maxsam4" }, authorAssociation: "MEMBER" }] } }] }, comments: { nodes: [] } };
  const a = { repo: REPO, number: 7, head: c1, generation: 2, base: "main" };
  const approve = await run("k-00000000000000e0", "github.approve", a);
  assert.match(approve.text, /^ship-tier-pending: .*members have open review comments/, approve.text);
  assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/reviews")).length, 0);
  assert.match((await run("k-00000000000000e1", "github.enqueue", { ...a, attempt: 1 })).text, /^ship-tier-pending: .*members have open review comments/);
  assert.equal(calls.filter((c) => /\/merge-async$/.test(c.path)).length, 0);
});

test("ship's final tier check refuses an approve before it posts; a dismissal asks no tier and dismisses only the App's approvals", async (t) => {
  const { c1, calls, run, adoption } = await setup(t);
  const a = { repo: REPO, number: 7, head: c1, generation: 2, base: "main" };
  adoption.refused = "tier `sensitive`: approval is off";
  const refused = await run("k-00000000000000d0", "github.approve", a);
  assert.match(refused.text, /^ship-tier: .*approval is off/);
  assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/reviews")).length, 0);
  const out = await run("k-00000000000000d1", "github.approve", { ...a, dismiss: true, policy: "p2" });
  assert.equal(out.ok, true, out.text);
  assert.deepEqual(calls.filter((c) => c.method === "PUT" && /dismissals$/.test(c.path)).map((c) => c.path.split("/").at(-2)), ["50", "99"], "the App's own approvals, never the owner's");
  assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/reviews")).length, 0, "nothing is approved");
});

test("an enqueue GitHub didn't answer is reconciled by reading the queue entry, never sent twice", async (t) => {
  let sent = 0;
  const queue = {};
  const { c1, run } = await setup(t, { queue, asyncMerge: { put: () => { sent++; queue.head = queue.lands ? c1Ref.v : undefined; return { status: 502, body: {} }; }, get: () => ({ status: 404, body: {} }) } });
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
  // GitHub still counts an earlier commit's approval, but none is on this head: not queued, asked again once there is one.
  queue.review = { reviewDecision: "APPROVED", latestOpinionatedReviews: { nodes: [{ state: "APPROVED", authorCanPushToRepository: true, author: { __typename: "User", login: "maria" }, commit: { oid: "e".repeat(40) } }] } };
  const stale = await run("k-00000000000000d3", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 3, base: "main" });
  assert.match(stale.text, /^ship-tier-pending: .*no approval on/);
  assert.equal(sent, 2, "never sent");
});

test("an enqueue goes through the async merge API at the bound head with merge_queue", async (t) => {
  const puts = [];
  const { c1, calls, run } = await setup(t, {
    asyncMerge: {
      put: (body) => { puts.push(body); return { status: 202, body: { status: "pending", details: { message: "Merge request is in progress.", uuid: "u-1", merge_action: "merge_queue", expected_head_sha: c1Ref.v } } }; },
      get: () => ({ status: 200, body: { status: "enqueued", details: { message: "Pull request is in the merge queue." } } }),
    },
  });
  const c1Ref = { v: c1 };
  const out = await run("k-00000000000000e1", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 1, base: "main" });
  assert.equal(out.ok, true, out.text);
  assert.match(out.text, /in the merge queue at/);
  assert.deepEqual(puts, [{ sha: c1, merge_action: "merge_queue" }], "the head the enqueue was bound to, and the queue action");
  assert.equal(calls.filter((c) => c.method === "PUT" && /\/merge-async$/.test(c.path)).length, 1);
});

test("a stacked PR's 202 is polled to a terminal result and never reported as merged before GitHub says merged", async (t) => {
  const polls = [];
  const { c1, run } = await setup(t, {
    asyncMerge: {
      put: () => ({ status: 202, body: { status: "pending", details: { message: "Merge request is in progress.", uuid: "u-1" } } }),
      // Two pending reads, then the merge: only the terminal `merged` may be reported as merged.
      get: (uuid) => {
        polls.push(uuid);
        if (polls.length < 3) return { status: 200, body: { status: "pending", details: { message: "Merge request is in progress.", uuid } } };
        return { status: 200, body: { status: "merged", details: { message: "Pull request was merged.", sha: "b".repeat(40) } } };
      },
    },
  });
  const out = await run("k-00000000000000e2", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 1, base: "main" });
  assert.equal(out.ok, true, out.text);
  assert.deepEqual(polls, ["u-1", "u-1", "u-1"], "the request's own uuid, read until it is terminal");
  assert.match(out.text, /is merged at/);
  assert.ok(out.text.includes(`merge commit \`${"b".repeat(12)}\``), out.text);
  assert.doesNotMatch(out.text, /in the merge queue/, "an accepted request is never the queue's word");
});

test("a queue read-back that settles a pending request drops its uuid, so a later enqueue makes its own request", async (t) => {
  let puts = 0;
  const { c1, cacheDir, run, queue } = await setup(t, {
    asyncMerge: {
      put: () => { puts++; queue.head = c1; return { status: 202, body: { status: "pending", details: { message: "Merge request is in progress.", uuid: "u-back" } } }; },
      get: (uuid) => ({ status: 200, body: { status: "pending", details: { uuid } } }),
    },
  });
  const args = { repo: REPO, number: 7, head: c1, generation: 2, attempt: 1, base: "main" };
  const out = await run("k-00000000000000f7", "github.enqueue", args);
  assert.equal(out.ok, true, out.text);
  assert.match(out.text, /in the merge queue at/);
  assert.ok(!readFileSync(join(cacheDir, "async-requests.json"), "utf8").includes("u-back"), "a request the PR read-back settled is not kept");
  // The PR leaves the queue again and ship asks once more: a request of its own, never the settled one's answer.
  queue.head = undefined;
  const again = await run("k-00000000000000f8", "github.enqueue", { ...args, attempt: 2 });
  assert.equal(again.ok, true, again.text);
  assert.equal(puts, 2, "the settled request's uuid was not read as this round's answer");
});

test("a code review gate that already waits when the enqueue starts is retryable at that head, never a hold", async (t) => {
  let puts = 0;
  const { c1, run } = await setup(t, {
    reviewGate: async () => ({ wait: "code review: running" }),
    asyncMerge: { put: () => { puts++; return { status: 202, body: { status: "pending", details: { uuid: "u-w" } } }; }, get: () => ({ status: 200, body: { status: "enqueued", details: {} } }) },
  });
  const out = await run("k-00000000000000fb", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 1, base: "main" });
  assert.equal(out.ok, false, out.text);
  assert.match(out.text, /^ship-tier-pending: not queued: code review: running/, "asked again at this head once the gate passes");
  assert.equal(puts, 0);
});

test("a queue read GitHub can't answer at the start of an enqueue waits, never holds the head", async (t) => {
  const { c1, run } = await setup(t, { queueRead: () => ({ status: 502, body: {} }) });
  const out = await run("k-00000000000000fd", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 1, base: "main" });
  assert.equal(out.ok, false, out.text);
  assert.match(out.text, /^ship-tier-pending: .*couldn't read it for the enqueue/, "asked again next round, never a hold");
});

test("a stacked PR's async merge that GitHub reports failed is a refusal in GitHub's words, never a queue entry", async (t) => {
  const { c1, run } = await setup(t, {
    asyncMerge: {
      put: () => ({ status: 202, body: { status: "pending", details: { message: "Merge request is in progress.", uuid: "u-3" } } }),
      get: () => ({ status: 200, body: { status: "failed", details: { message: "Merge conflict: the pull request could not be merged." } } }),
    },
  });
  const out = await run("k-00000000000000e4", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 1, base: "main" });
  assert.equal(out.ok, false, out.text);
  assert.match(out.text, /^GitHub refused to queue .*: Merge conflict/);
});

test("a request still pending at the wait's end keeps its uuid, and the next round reads it to its terminal result", async (t) => {
  let puts = 0;
  const reads = [];
  let merged = false;
  const { c1, cacheDir, run } = await setup(t, {
    asyncMerge: {
      put: () => { puts++; return { status: 202, body: { status: "pending", details: { message: "Merge request is in progress.", uuid: "u-keep" } } }; },
      get: (uuid) => { reads.push(uuid); return merged ? { status: 200, body: { status: "merged", details: { sha: "c".repeat(40) } } } : { status: 200, body: { status: "pending", details: { uuid } } }; },
    },
  });
  const args = { repo: REPO, number: 7, head: c1, generation: 2, attempt: 1, base: "main" };
  const first = await run("k-00000000000000f1", "github.enqueue", args);
  assert.equal(first.ok, false, first.text);
  assert.match(first.text, /^ship-enqueue-pending:/);
  assert.ok(existsSync(join(cacheDir, "async-requests.json")), "the request's id is kept for the next round");
  // The next round makes no second request: it reads the kept one, whose result is now terminal.
  merged = true;
  const second = await run("k-00000000000000f2", "github.enqueue", { ...args, attempt: 2 });
  assert.equal(second.ok, true, second.text);
  assert.match(second.text, /is merged at/);
  assert.equal(puts, 1, "never a second request");
  assert.ok(reads.length >= 1 && reads.every((u) => u === "u-keep"), `every read is the kept request: ${reads.join(",")}`);
  assert.ok(!existsSync(join(cacheDir, "async-requests.json")) || !readFileSync(join(cacheDir, "async-requests.json"), "utf8").includes("u-keep"), "a settled request's id is dropped");
});

test("a 409 naming another head's request asks this head again once, then waits instead of holding or looping", async (t) => {
  const { c1, run } = await setup(t, {
    asyncMerge: {
      put: () => ({ status: 409, body: { status: "pending", details: { message: "A merge request is already pending.", uuid: "u-old", merge_action: "merge_queue", expected_head_sha: "f".repeat(40) } } }),
      get: () => ({ status: 200, body: { status: "pending", details: { uuid: "u-old" } } }),
    },
  });
  const first = await run("k-00000000000000f5", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 1, base: "main" });
  assert.equal(first.ok, false, first.text);
  assert.match(first.text, /^ship-enqueue-pending: .*holds an async merge request for `ffffffffffff`, not/);
  const again = await run("k-00000000000000f6", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 2, base: "main" });
  assert.equal(again.ok, false, again.text);
  assert.doesNotMatch(again.text, /^ship-enqueue-pending:/, "not a second endless ask");
  assert.match(again.text, /asks once that request clears/);
  assert.ok(!/is merged|in the merge queue/.test(again.text), "the other head's request is never credited");
});

test("one readiness rule: ship's actions with its context, the merge queue's without", () => {
  const H = "a".repeat(40);
  const check = (name, conclusion) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion });
  const data = (pr) => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: { state: "OPEN", headRefOid: H, baseRefName: "main", mergeStateStatus: "CLEAN", reviewDecision: null, isDraft: false, isInMergeQueue: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [check("build", "SUCCESS")] } } } }] }, baseRef: { compare: { behindBy: 0 } }, latestOpinionatedReviews: { nodes: [] }, ...pr } } });
  const ok = [{ name: "build", ok: true, pending: false }];
  const go = (pr, ctx = {}) => decide(data(pr), H, { queue: false, approve: false, required: ["build"], checks: ok, ...ctx });
  assert.equal(go({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", reviewRequests: { nodes: [{ asCodeOwner: true, requestedReviewer: { combinedSlug: "acme/api" } }] } }).why, "waiting on code owner @acme/api");
  assert.equal(go({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }).why, "waiting for required review");
  assert.equal(go({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }, { approve: true }).do, "approve");
  assert.equal(go({ mergeStateStatus: "DIRTY" }).do, "repair");
  assert.equal(go({ mergeStateStatus: "DIRTY" }, { checks: [] }).do, "repair", "a conflict is repaired before waiting on checks that can't run");
  assert.equal(go({}, { queue: true }).do, "enqueue", "no review needed: the hand-off is enough");
  // A gated repo merges on code review's pass: no GitHub approval unless GitHub's own rules ask for one.
  assert.equal(go({}, { verdict: { wait: "code review: running" } }).do, "wait");
  assert.equal(go({}, { verdict: { wait: "code review: findings", findings: "code review: findings", findingsKey: "k" } }).do, "fix_review");
  assert.equal(go({}, { verdict: { pass: true } }).do, "merge", "code review's pass is the review");
  assert.equal(go({}, { verdict: { wait: "code review can't be reached: the merge waits until it answers" } }).do, "wait", "code review unreachable is a wait, never a merge");
  // Where GitHub's rules ask for a review, the approval must be on this head, by someone who can push (or an App): an earlier
  // commit's approval GitHub still counts (stale approvals not dismissed), or a drive-by one on the head, is none.
  const approval = (commit, writer = true, bot = "", id = "r1") => ({ latestOpinionatedReviews: { nodes: [{ fullDatabaseId: id, state: "APPROVED", authorCanPushToRepository: writer, author: { __typename: bot ? "Bot" : "User", login: bot || "maria" }, commit: { oid: commit } }] } });
  assert.deepEqual(go({ reviewDecision: "APPROVED", ...approval("b".repeat(40)) }), { do: "wait", why: "its approval is on an earlier commit: someone with write access approves this head" });
  assert.equal(go({ reviewDecision: "APPROVED", ...approval("b".repeat(40)) }, { approve: true }).do, "approve", "ship's App approves the head again where it may");
  assert.equal(go({ reviewDecision: "APPROVED", ...approval(H, false) }).do, "wait", "a reader's approval on the head doesn't count");
  assert.equal(go({ reviewDecision: "APPROVED", ...approval(H) }).do, "merge");
  assert.equal(go({ reviewDecision: "APPROVED", ...approval(H, false, "acme-reviewer") }, { mine: ["r1"] }).do, "merge", "ship's own App approval on the head");
  assert.equal(go({ reviewDecision: "APPROVED", ...approval(H, true, "acme-reviewer", "r2") }, { mine: ["r1"] }).do, "wait", "an App review ship's approve didn't make (a box's) doesn't count");
  assert.equal(go({ state: "MERGED" }).do, "done");
  assert.equal(go({ isInMergeQueue: true }).do, "wait");
  // A non-default base is unsupported: a wait said each pass, never a stored stall.
  assert.deepEqual(go({ baseRefName: "release" }), { do: "wait", why: "non-default base unsupported (`release`)" });
  // Only the required checks: an optional red one doesn't hold it; none required (and none run) is green.
  const red = [...ok, { name: "lint", ok: false, pending: false }];
  assert.equal(go({}, { checks: red }).do, "merge");
  assert.equal(go({}, { checks: red, required: ["build", "lint"] }).do, "fix_ci");
  assert.equal(go({}, { checks: [], required: ["build"] }).do, "wait", "a required check not reported yet is running");
  assert.equal(go({}, { checks: [], required: [] }).do, "merge", "none required, none run: green");
  assert.equal(go({}, { checks: [...ok, { name: "build", ok: false, pending: false }] }).do, "fix_ci", "a red status hides behind no green run of the same name");
  assert.equal(go({ mergeStateStatus: "BLOCKED" }).do, "stall", "a branch rule ship doesn't handle is a visible stall");
  // On a merge-queue branch a ready PR is always BLOCKED (the queue is the path): it is enqueued, GitHub's enqueue the judge.
  assert.deepEqual(go({ mergeStateStatus: "BLOCKED", reviewDecision: "APPROVED", ...approval(H) }, { queue: true }), { do: "enqueue", why: "ready" });
  assert.equal(go({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }, { queue: true }).do, "wait", "a missing review still waits on a queue branch");
  assert.equal(go({ mergeStateStatus: "BLOCKED" }, { queue: true, checks: [{ name: "build", ok: false, pending: false }] }).do, "fix_ci", "red checks come first");
  // GitHub reports BLOCKED while a check is still running on the head even when every required check is green: a duplicate run's
  // in-flight jobs are a wait, not a stall. The whole head is judged, not only `required`.
  const running = { name: "packages (1)", ok: false, pending: true };
  assert.deepEqual(go({ mergeStateStatus: "BLOCKED" }, { checks: [...ok, running] }), { do: "wait", why: "checks are still running on its head" });
  // A superseded cancelled twin never counts as pending: the newest run of the name decides.
  assert.equal(go({ mergeStateStatus: "BLOCKED" }, { checks: [...ok, { name: "packages (1)", kind: "run", rank: 1, ok: false, pending: false }, { name: "packages (1)", kind: "run", rank: 2, ok: true, pending: false }] }).do, "stall", "an old cancelled run is not a pending check");
  // Code review's advisory commit *status* is not what GitHub holds a merge for, so one pending never
  // hides a stall; a check run that only shares the name is the repo's own job and still waits.
  for (const name of ["aidenhq/review"]) {
    assert.equal(go({ mergeStateStatus: "BLOCKED" }, { checks: [...ok, { name, kind: "status", ok: false, pending: true }] }).do, "stall", `the advisory ${name} status is not a running check`);
    assert.equal(go({ mergeStateStatus: "BLOCKED" }, { checks: [...ok, { name, kind: "run", ok: false, pending: true }] }).do, "wait", `a check run named ${name} is still running`);
  }
  // Without ship's context: the merge queue's rule, unchanged.
  assert.deepEqual(decide(data({}), H), { do: "merge" });
  assert.equal(decide(data({ mergeStateStatus: "DIRTY" }), H).do, "fail");
  assert.equal(decide(data({ baseRefName: "release" }), H).do, "fail");
  assert.deepEqual(decide(data({ mergeStateStatus: "BLOCKED" }), H), { do: "fail", why: "GitHub won't merge it (blocked by a branch rule)" }, "the merge queue never waits on a pending check behind a branch rule");
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
  const run = async (adopted, plain = false, taskStatus = "in_progress", classic = 404, runs = [], o = {}) => {
    const calls = [];
    const gh = async (method, path) => {
      calls.push(`${method} ${path}`);
      if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, pullRequest: {
        number: 7, state: calls.some((c) => c.startsWith("PUT")) ? "MERGED" : "OPEN", headRefOid: H, baseRefName: "main", isDraft: false, mergeStateStatus: "CLEAN", reviewDecision: null, isInMergeQueue: false,
        mergeCommit: null, commits: { nodes: [{ commit: { statusCheckRollup: plain ? { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] } } : null } }] }, baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40) } }, reviews: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, ...o.pr,
      } } } } };
      if (path.includes("/rules/branches/")) return { status: 200, body: [] };
      if (path.includes("/check-runs")) return { status: 200, body: { check_runs: runs } };
      if (path.endsWith("/statuses") || path.includes("/statuses?")) return { status: 200, body: [] };
      if (path.endsWith("/required_status_checks")) return { status: classic, body: {} };
      if (method === "PUT") return { status: 202, body: { status: "merged", details: { sha: "c".repeat(40) } } };
      return { status: 404, body: {} };
    };
    const outcomes = [];
    const { createMerges } = await import("../service/src/merges.ts");
    const m = createMerges({ actorFor: async () => ({ key: "owner", rest: gh }), actorByKey: async () => ({ rest: gh }), dir: mkdtempSync(join(tmpdir(), "ship-merge-")), gh, fleetOrg: "acme-agents", reviewGate: async () => undefined, report: async (id, o) => void outcomes.push(o), ship: { generation: async () => ({ generation: adopted ? 2 : null, ...(adopted && o.hold ? { hold: o.hold } : {}) }) }, taskStatus: async () => taskStatus, ...(o.approvals ? { approvals: o.approvals } : {}) });
    if (plain) void m.enqueue("k-1", { prs: [{ repo: REPO, number: 7, head: H }] }, "T1", undefined, undefined, true);
    else void m.enqueue("k-1", { prs: [{ repo: REPO, number: 7, head: H, base: "main" }], generation: 2, attempt: 1 });
    await m.step();
    return { calls, outcomes };
  };
  const merged = await run(true);
  assert.equal(merged.calls.filter((c) => c.startsWith("PUT")).length, 1, merged.calls.join("\n"));
  // GitHub asks for a review: the reviewer App's approval on the head merges it; with no App known, the same approval waits.
  const appApproved = { pr: { reviewDecision: "APPROVED", latestOpinionatedReviews: { nodes: [{ fullDatabaseId: "r1", state: "APPROVED", authorCanPushToRepository: false, author: { __typename: "Bot", login: "acme-reviewer" }, commit: { oid: H } }] } }, approvals: () => ["r1"] };
  assert.equal((await run(true, false, "in_progress", 404, [], appApproved)).calls.filter((c) => c.startsWith("PUT")).length, 1, "the App's approval counts in the queue too");
  assert.equal((await run(true, false, "in_progress", 404, [], { pr: appApproved.pr })).calls.filter((c) => c.startsWith("PUT")).length, 0);
  assert.equal(merged.outcomes[0]?.ok, true);
  const ended = await run(false);
  assert.equal(ended.calls.filter((c) => c.startsWith("PUT")).length, 0);
  assert.equal(ended.outcomes[0]?.ok, false);
  assert.match(ended.outcomes[0].text, /adoption ended/);
  // A stalled hold ends the merge as any hold does: the push that resumes the adoption is the only write it admits.
  const stalled = await run(true, false, "in_progress", 404, [], { hold: { kind: "stalled" } });
  assert.equal(stalled.calls.filter((c) => c.startsWith("PUT")).length, 0, stalled.calls.join("\n"));
  assert.match(stalled.outcomes[0]?.text ?? "", /on hold by ship \(stalled\)/);
  // A fleet PR's plain merge ship filed stops with ship too: paused (or its repo off), it is never called.
  const paused = await run(false, true);
  assert.equal(paused.calls.filter((c) => c.startsWith("PUT")).length, 0, paused.calls.join("\n"));
  assert.match(paused.outcomes[0]?.text ?? "", /ship is paused/);
  // ...and when its task has ended: the kernel files a module's write on any task, so the queue reads the task at the call.
  const cancelled = await run(true, true, "cancelled");
  assert.equal(cancelled.calls.filter((c) => c.startsWith("PUT")).length, 0, cancelled.calls.join("\n"));
  assert.match(cancelled.outcomes[0]?.text ?? "", /its task is cancelled/);
  const live = await run(true, true);
  assert.equal(live.calls.filter((c) => c.startsWith("PUT")).length, 1, "a live task's merge goes ahead");
  const done = await run(true, true, "done");
  assert.equal(done.calls.filter((c) => c.startsWith("PUT")).length, 1, "a merge in flight still lands after its task is done");
  // Rules unreadable (403) and no check reported yet: the adoption's merge waits, never merges on nothing.
  const unread = await run(true, false, "in_progress", 403);
  assert.equal(unread.calls.filter((c) => c.startsWith("PUT")).length, 0, unread.calls.join("\n"));
  assert.equal(unread.outcomes.length, 0, "waiting, not settled");
});

test("with no App on the repo, approve is refused as needing a human; nothing is posted as the owner", async (t) => {
  const { c1, calls, call, run } = await setup(t, { app: false });
  const a = { repo: REPO, number: 7, head: c1, generation: 2, base: "main" };
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.approve", args: a, requester: SHIP, task: "t1" })).json.error, /approval needs a person/);
  const out = await run("k-00000000000000e1", "github.approve", a);
  assert.equal(out.ok, false);
  assert.match(out.text, /^ship-no-app: .*approval needs a person/);
  assert.equal(calls.filter((c) => c.method !== "GET" && c.path !== "/graphql").length, 0);
});

test("ship's repair: github runs ship's check job, and the merge of the base with the kept files is one commit GitHub signs; leftovers and a fork without edits write nothing", async (t) => {
  const { origin, ws, c1, main, pr, call, run, checks, repairResult } = await setup(t, { baseAhead: true, appOps: ["pr", "push"] });
  const args = { repo: REPO, number: 7, head: c1, generation: 2, base: "main", plan: { globs: ["gen.txt"], commands: [{ dir: ".", cmd: "make gen" }] } };
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.repair", args, requester: SHIP, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.raise, undefined);
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.repair", args, requester: { kind: "job", roles: ["platform-engineer"] }, task: "t1" })).json.error, /only the ship module/);

  const ok = await run("k-00000000000000c1", "github.repair", args);
  assert.equal(ok.ok, true, ok.text);
  assert.deepEqual(checks[0], { repo: REPO, head: c1, run: "ship-repair", spec: { base: main, merge_base: sh(origin, "merge-base", c1, main), base_ref: "main", plan: JSON.stringify(args.plan), attempt: "1" } });
  // One merge commit of the head and main's tip: the regenerated file, and main's own change beside it.
  assert.equal(sh(origin, "rev-list", "--parents", "-n", "1", "refs/heads/contrib").split(" ").slice(1).join(" "), `${c1} ${main}`);
  assert.equal(sh(origin, "show", "refs/heads/contrib:gen.txt"), "regenerated");
  assert.equal(sh(origin, "show", "refs/heads/contrib:m.txt"), "m");
  assert.equal(sh(origin, "log", "-1", "--format=%s%n%cn", "refs/heads/contrib"), "Regenerate the generated files after merging main\nGitHub", "a commit GitHub made and signs");

  // Conflicts no generator rewrites (main moved on again): the outcome lists them and the branch stays.
  pr.head = sh(origin, "rev-parse", "refs/heads/contrib");
  sh(ws, "checkout", "--quiet", "main"); writeFileSync(join(ws, "gen.txt"), "base again\n"); sh(ws, "add", "gen.txt"); sh(ws, "commit", "--quiet", "-m", "main again"); sh(ws, "push", "--quiet", origin, "main");
  repairResult.result = { leftovers: ["src/a.ts"] };
  const left = await run("k-00000000000000c2", "github.repair", { ...args, head: pr.head });
  assert.equal(left.ok, false);
  assert.match(left.text, /^ship-leftovers: [\s\S]*\nleftover: src\/a\.ts$/);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), pr.head);
  pr.fork = true;
  assert.match((await run("k-00000000000000c3", "github.repair", { ...args, head: pr.head })).text, /^ship-fork/);
});

test("ship's repair keeps the head lease: a contributor's push while the repair runs is refused with ship-head-moved and the branch stays theirs", async (t) => {
  const { root, origin, ws, c1, pr, run, duringRepair } = await setup(t, { baseAhead: true });
  // The contributor pushes while the repair's check job runs: the head it read before the run is no longer the PR's.
  const scratch = `${ws}-repair-contrib`;
  sh(root, "clone", "--quiet", "-b", "contrib", origin, scratch);
  writeFileSync(join(scratch, "c.txt"), "c\n");
  sh(scratch, "add", "c.txt");
  sh(scratch, "commit", "--quiet", "-m", "contributor again");
  duringRepair(() => {
    sh(scratch, "push", "--quiet", origin, "contrib");
    pr.head = sh(origin, "rev-parse", "refs/heads/contrib");
  });
  const args = { repo: REPO, number: 7, head: c1, generation: 2, base: "main", plan: { globs: ["gen.txt"] } };
  const r = await run("k-00000000000000f1", "github.repair", args);
  assert.equal(r.ok, false, r.text);
  assert.match(r.text, /^ship-head-moved: .* moved during the repair/);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), pr.head, "the contributor's push is never overwritten");
});

test("a fork that allows maintainer edits: the fix and the repair are pushed to the fork's branch as the code host's sign-in, leased on the head", async (t) => {
  const { root, origin, ws, c1, fix, main, pr, run, repairResult } = await setup(t, { baseAhead: true });
  // The contributor's fork, holding the PR's branch.
  const fork = join(root, "github", "someone", "widget.git");
  mkdirSync(dirname(fork), { recursive: true });
  sh(root, "clone", "--quiet", "--bare", origin, fork);
  Object.assign(pr, { fork: true, canModify: true });
  const push = { workspace: "TASK-1", only: [{ repo: REPO, branch: "ship-pr-7", sha: fix }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 };
  // A contributor's push in between wins.
  sh(ws, "push", "--quiet", fork, `${main}:refs/heads/other`);
  const scratch = `${ws}-fork`;
  sh(dirname(ws), "clone", "--quiet", "-b", "contrib", fork, scratch);
  writeFileSync(join(scratch, "c.txt"), "c\n");
  sh(scratch, "add", "c.txt");
  sh(scratch, "commit", "--quiet", "-m", "contributor again");
  sh(scratch, "push", "--quiet", fork, "contrib");
  assert.match((await run("k-00000000000000d1", "github.push", push)).text, /^ship-head-moved/);
  sh(scratch, "push", "--quiet", "--force", fork, `${c1}:refs/heads/contrib`);
  const ok = await run("k-00000000000000d2", "github.push", push);
  assert.equal(ok.ok, true, ok.text);
  assert.match(ok.text, / as owner1\.$/, "pushed as the code host's sign-in, never the reviewer App");
  assert.equal(sh(fork, "rev-parse", "refs/heads/contrib"), fix, "the box's own commit, pushed as it is");
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), c1, "the base repo's branch is untouched");

  // The repair: a merge commit made here from git's merge and the kept generated files, pushed to the fork. The fork's head is
  // the base repo's too, as refs/pull/7/head (GitHub serves it by sha). Here the repair deletes a generated file.
  sh(ws, "push", "--quiet", origin, `${fix}:refs/pull/7/head`);
  sh(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  pr.head = fix;
  repairResult.keep.entries = [{ path: "gen.txt", mode: "100644", sha: null }];
  const r = await run("k-00000000000000d3", "github.repair", { repo: REPO, number: 7, head: fix, generation: 2, base: "main", plan: { globs: ["gen.txt"] } });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, / as owner1 \(pushed to someone\/widget\)\.$/, "repaired as the code host's sign-in, never the reviewer App");
  assert.equal(sh(fork, "rev-parse", "refs/heads/contrib^1"), fix);
  assert.equal(sh(fork, "rev-parse", "refs/heads/contrib^2"), main);
  assert.equal(sh(fork, "ls-tree", "--name-only", "refs/heads/contrib", "gen.txt"), "", "the generated file's deletion is applied");
  assert.equal(sh(fork, "show", "refs/heads/contrib:b.txt"), "b", "the contributor's own file stays");
});

test("ship's repair over a path that is a file at the head and a directory in the base lands the merge with the directory", async (t) => {
  const { origin, c1, main, run, calls } = await setup(t, { toolsDir: true, baseAhead: true, appOps: ["pr", "push"] });
  assert.equal(sh(origin, "cat-file", "-t", "refs/heads/contrib:tools"), "blob", "the head holds `tools` as a file");
  const r = await run("k-00000000000000a1", "github.repair", { repo: REPO, number: 7, head: c1, generation: 2, base: "main", plan: { globs: ["gen.txt"] } });
  assert.equal(r.ok, true, r.text);
  // Only the kept file's content goes up; the base's own entries are named by the objects GitHub holds.
  const entries = calls.filter((c) => c.method === "POST" && c.path === `/repos/${REPO}/git/trees`).flatMap((c) => c.body.tree);
  assert.deepEqual(entries.filter((e) => e.content !== undefined).map((e) => e.path), ["gen.txt"]);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^1"), c1);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^2"), main);
  assert.equal(sh(origin, "cat-file", "-t", "refs/heads/contrib:tools/run"), "blob", "`tools` is the directory main made it");
});






test("ship's repair GitHub's rules refuse is ship-refused with GitHub's words, and nothing is written", async (t) => {
  const { origin, c1, run, refuseRef } = await setup(t, { baseAhead: true, appOps: ["pr", "push"] });
  refuseRef(true);
  const r = await run("k-00000000000000a2", "github.repair", { repo: REPO, number: 7, head: c1, generation: 2, base: "main", plan: { globs: ["gen.txt"] } });
  assert.equal(r.ok, false);
  assert.match(r.text, /^ship-refused: the push to .* didn't go through .*: GitHub refused moving the branch to the merge: Repository rule violations found.*\. Nothing was pushed; ship holds the PR/, r.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), c1);
});

test("ship's repair takes the box's files only on generated paths and conflicted lockfiles: never a workflow, a gitlink, a source file, an untouched lockfile or a new symlink", async (t) => {
  const { origin, c1, run, repairResult } = await setup(t, { baseAhead: true });
  const file = (path, text, mode = "100644") => ({ path, mode, sha: execFileSync("git", ["hash-object", "--stdin"], { input: text, encoding: "utf8" }).trim(), content: Buffer.from(text).toString("base64") });
  const args = { repo: REPO, number: 7, head: c1, generation: 2, base: "main", plan: { globs: ["gen.txt", ".github/**"] } };
  const tries = [
    [[file(".github/workflows/evil.yml", "on: push\njobs: { x: { runs-on: ubuntu-latest, steps: [ { run: curl evil } ] } }\n")], /under \.github\//],
    [[file("src/evil.ts", "steal()\n")], /neither a generated path nor a conflicted lockfile/],
    [[file("package-lock.json", "{}\n")], /neither a generated path nor a conflicted lockfile/],
    [[file("gen.txt", "/etc/passwd", "120000")], /as a symlink where the merge has none/],
    [[{ path: "gen.txt", mode: "160000", sha: "e".repeat(40) }], /only files and symlinks/],
  ];
  for (const [i, [entries, why]] of tries.entries()) {
    repairResult.keep.entries = entries;
    const r = await run(`k-00000000000000e${i}`, "github.repair", args);
    assert.equal(r.ok, false);
    assert.match(r.text, why);
    assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), c1, "nothing was written");
  }
});

test("ship's decision from its list read: no PR or check read, the branch rules read once, code review's pass is the review", async () => {
  const H = "b".repeat(40), calls = [];
  const gh = async (method, path) => (calls.push(`${method} ${path}`), path.includes("/rules/branches/") ? { status: 200, body: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }] } }] } : { status: 404, body: {} });
  let verdict = { wait: "code review: running" };
  const merges = createMerges({ dir: mkdtempSync(join(tmpdir(), "decision-")), gh, fleetOrg: "acme-agents", reviewGate: async () => verdict, report: async () => {} });
  const rollup = { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }] } };
  const pr = { number: 3, headRefOid: H, baseRefName: "main", mergeStateStatus: "CLEAN", reviewDecision: null, isDraft: false, isInMergeQueue: false, latestOpinionatedReviews: { nodes: [] }, reviews: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } };
  const view = { pr, main: { name: "main", oid: "c".repeat(40), rollup: { state: "SUCCESS" } } };
  assert.equal((await merges.decision("acme-agents/widget", 3, H, view)).do, "wait");
  verdict = { pass: true };
  assert.equal((await merges.decision("acme-agents/widget", 3, H, view)).do, "merge", "a gated repo merges on code review's pass, no GitHub approval");
  assert.deepEqual(calls, ["GET /repos/acme-agents/widget/rules/branches/main", "GET /repos/acme-agents/widget/branches/main/protection/required_status_checks"]);
});

// The ordinary publish path (`github.push` / `github.pr`) leases its push on the branch's head, read under the branch lock: an
// approval card whose box bundle was planned before a later push landed carries the older commit and must be refused as
// ship-head-moved, never force the branch back over the newer one (issue #1775: PR #1746 was rewound to a pre-fix commit).
test("a publish whose bundle carries H cannot rewind a branch at F, a child of H: it is refused as ship-head-moved and F stays", async (t) => {
  const { ws, origin, H, F, run, call, calls } = await setup(t);
  // The task's workspace box is at F (the fix, pushed), holding the bundle of H (the plan's older read).
  sh(ws, "checkout", "--quiet", "lease");
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), F, "the branch stands at F before the stale write");

  for (const kind of ["github.push", "github.pr"]) {
    const args = { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: H }], ...(kind === "github.pr" ? { text: { title: "fix: stale write", body: "Why." } } : {}) };
    const before = calls.length;
    const r = await run(`k-00000000000000f${kind === "github.pr" ? "1" : "0"}`, kind, args);
    assert.equal(r.ok, false, `${kind}: ${JSON.stringify(r)}`);
    assert.match(r.text, /^ship-head-moved/, `${kind}: ${r.text}`);
    assert.match(r.text, new RegExp(`moved to \`${F.slice(0, 12)}\` since the write read \`${H.slice(0, 12)}\``), r.text);
    assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), F, `${kind}: the branch still stands at F`);
    assert.deepEqual(calls.slice(before).filter((c) => c.method === "PATCH" && c.path.includes("/pulls/")), [], `${kind}: no PR was moved`);
  }

  // A first publish to a branch that doesn't exist yet still lands: there is no head to lease against, so no lease.
  sh(ws, "checkout", "--quiet", "-b", "fresh", H);
  const first = await run("k-00000000000000f2", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "fresh", sha: H }] });
  assert.equal(first.ok, true, first.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/fresh"), H);

  // The same write's own fast-forward of a branch this task owns still lands (the lease is on the head it read).
  sh(ws, "checkout", "--quiet", "lease");
  const ff = await run("k-00000000000000f3", "github.pr", { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: F }] });
  assert.equal(ff.ok, true, ff.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), F, "an unchanged head pushes nothing new and stays where it is");

  // A rewrite of this task's own branch (a commit on H, diverging from F) is still allowed: its plan read the branch at F and it is
  // still at F, and the new commit isn't one the branch already holds, so nothing is rewound.
  sh(ws, "checkout", "--quiet", "-b", "rewrite", H);
  writeFileSync(join(ws, "r.txt"), "r\n");
  sh(ws, "add", "r.txt");
  sh(ws, "commit", "--quiet", "-m", "rewrite");
  const R = sh(ws, "rev-parse", "HEAD");
  sh(ws, "update-ref", `refs/aidenhq/publish/${R}`, R);
  sh(ws, "bundle", "create", "--quiet", join(dirname(ws), ".aidenhq", "bundles", `${R}.bundle`), `refs/aidenhq/publish/${R}`);
  const rewriteArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: R }] };
  assert.equal((await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: rewriteArgs, requester: { kind: "job", roles: [] }, task: "t1" })).status, 200);
  const rewrite = await run("k-00000000000000f4", "github.push", rewriteArgs);
  assert.equal(rewrite.ok, true, rewrite.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), R, "the task's own rewrite lands");

  // The card path: a write planned while the branch is at H does not rewrite it after the branch moves to F (a different child of
  // H). The bundle's commit isn't an ancestor of F, so only the head the plan bound refuses it -- the ancestry check would not.
  sh(origin, "update-ref", "refs/heads/lease", H);
  const staleArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: R }] };
  const staleCard = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: staleArgs, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(staleCard.status, 200, JSON.stringify(staleCard.json));
  // The card is bound to the head it read, in its own stored args: the branch was at H when it was filed.
  assert.deepEqual(staleCard.json.args.heads, { [`${REPO} lease`]: H });
  sh(origin, "update-ref", "refs/heads/lease", F);
  assert.throws(() => sh(ws, "merge-base", "--is-ancestor", R, F), "R and F diverge: the ancestry check alone would not refuse this");
  const stale = await run("k-00000000000000f5", "github.push", staleArgs, staleCard);
  assert.equal(stale.ok, false, stale.text);
  assert.match(stale.text, /^ship-head-moved/, stale.text);
  assert.match(stale.text, new RegExp(`moved to \`${F.slice(0, 12)}\` since the write read \`${H.slice(0, 12)}\``), stale.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), F, "the branch the card planned against moved; it is never rewritten");

  // A card filed at H cannot be widened by planning the same request again after the branch moved to F: the second plan is its
  // own record (its own args, its own head), and the first card still refuses. This is the finding's case: a mutable cache keyed
  // by the request alone would hand the old card F.
  sh(origin, "update-ref", "refs/heads/lease", H);
  const widenArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: R }] };
  const filed = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: widenArgs, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(filed.status, 200);
  assert.equal(filed.json.args.heads[`${REPO} lease`], H);
  sh(origin, "update-ref", "refs/heads/lease", F);
  const again = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: widenArgs, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(again.status, 200);
  assert.equal(again.json.args.heads[`${REPO} lease`], F, "the new plan reads F, as its own record");
  const oldCard = await run("k-00000000000000f7", "github.push", widenArgs, filed);
  assert.match(oldCard.text, /^ship-head-moved/, oldCard.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), F, "the earlier card keeps H and never rewrites the branch from F");

  // A revalidation is handed the record's stored args back unchanged: the head it bound is the one it still checks.
  const revalidated = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: filed.json.args, requester: { kind: "job", roles: [] }, task: "t1", revalidate: true });
  assert.equal(revalidated.status, 200);
  assert.deepEqual(revalidated.json.args.heads, { [`${REPO} lease`]: H });

  // A card whose own push already landed before GitHub dropped the connection is resumed, not refused: the branch already holds
  // the commit, so there is nothing to push and the PR is finished (a held write retried by id is the same record).
  sh(origin, "update-ref", "refs/heads/lease", H);
  const resumeArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: R }] };
  const resumeCard = await call("/aidenhq/v1/executor/plan", { kind: "github.pr", args: { ...resumeArgs, text: { title: "fix: resume" } }, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(resumeCard.status, 200);
  sh(origin, "update-ref", "refs/heads/lease", R);
  const beforeResume = calls.length;
  const resumed = await run("k-00000000000000f8", "github.pr", { ...resumeArgs, text: { title: "fix: resume" } }, resumeCard);
  assert.equal(resumed.ok, true, resumed.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), R, "the branch still holds the commit its write pushed");
  const resumeCalls = calls.slice(beforeResume);
  assert.deepEqual(resumeCalls.filter((c) => c.method === "POST" && c.path === `/repos/${REPO}/pulls`), [], "the branch already had its PR: none is opened");
  assert.equal(resumeCalls.filter((c) => c.method === "PATCH" && c.path === `/repos/${REPO}/pulls/8`).length, 1, "the existing PR #8 is the one finished");

  // A branch planned absent and created before the push is refused: this write would take a create over a branch it never read.
  const absentArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "late", sha: H }] };
  const absentCard = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: absentArgs, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(absentCard.status, 200);
  assert.deepEqual(absentCard.json.args.heads, { [`${REPO} late`]: null }, "planned absent");
  sh(origin, "update-ref", "refs/heads/late", F);
  const late = await run("k-00000000000000f9", "github.push", absentArgs, absentCard);
  assert.match(late.text, /^ship-head-moved: .*appeared at/, late.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/late"), F, "the branch someone else created is left where it is");

  // A branch deleted since the plan is "missing", not a crash: the write lands as an ordinary first publish.
  const goneArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "gone", sha: F }] };
  sh(origin, "update-ref", "refs/heads/gone", F);
  const goneCard = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: goneArgs, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(goneCard.status, 200);
  assert.equal(goneCard.json.args.heads[`${REPO} gone`], F);
  sh(origin, "update-ref", "-d", "refs/heads/gone");
  const gone = await run("k-00000000000000fa", "github.push", goneArgs, goneCard);
  assert.equal(gone.ok, true, gone.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/gone"), F, "a branch deleted since is created again, no crash");

  // A push straight to an agents-org repo's default branch (plan.ts raises it as `default-branch` rather than refusing it) moves
  // forward with no force and no lease. A lease here would name an empty expected head against an existing `main` and refuse it
  // ("stale info"), which is the regression a default-branch lease introduces.
  const toMain = await run("k-00000000000000f6", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "main", sha: H }] });
  assert.equal(toMain.ok, true, toMain.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/main"), H, "the default branch moved forward, unleased");
});

// The same on a branch whose rules require signed commits: each publish is one commit GitHub makes with the box commit's tree, bound
// to the branch's head, and every binding names GitHub's commit.
test("on a signature-required branch a publish is GitHub's own commit of the box's tree, and a stale bundle still cannot rewind it", async (t) => {
  const { ws, origin, H, F, main, run, call, calls, signed } = await setup(t, { signedBranches: () => true });
  // The task's workspace box is at F (the fix, pushed), holding the bundle of H (the plan's older read).
  sh(ws, "checkout", "--quiet", "lease");
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), F, "the branch stands at F before the stale write");

  for (const kind of ["github.push", "github.pr"]) {
    const args = { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: H }], ...(kind === "github.pr" ? { text: { title: "fix: stale write", body: "Why." } } : {}) };
    const before = calls.length;
    const r = await run(`k-00000000000000f${kind === "github.pr" ? "1" : "0"}`, kind, args);
    assert.equal(r.ok, false, `${kind}: ${JSON.stringify(r)}`);
    assert.match(r.text, /^ship-head-moved/, `${kind}: ${r.text}`);
    assert.match(r.text, new RegExp(`moved to \`${F.slice(0, 12)}\` since the write read \`${H.slice(0, 12)}\``), r.text);
    assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), F, `${kind}: the branch still stands at F`);
    assert.deepEqual(calls.slice(before).filter((c) => c.method === "PATCH" && c.path.includes("/pulls/")), [], `${kind}: no PR was moved`);
  }

  // A first publish creates the branch at the commit the box's branch forked from on the base (main), then lands one commit GitHub
  // makes with the box commit's tree. Every binding names GitHub's commit, never the box's.
  sh(ws, "checkout", "--quiet", "-b", "fresh", H);
  const before = signed.length;
  const first = await run("k-00000000000000f2", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "fresh", sha: H }] });
  assert.equal(first.ok, true, first.text);
  const P = sh(origin, "rev-parse", "refs/heads/fresh");
  assert.notEqual(P, H, "GitHub's own commit, not the box's");
  assert.equal(sh(origin, "rev-parse", `${P}^{tree}`), sh(ws, "rev-parse", `${H}^{tree}`), "the box commit's tree");
  assert.equal(sh(origin, "rev-parse", `${P}^`), main, "on the base point the reviewed diff was read from");
  assert.equal(sh(origin, "log", "-1", "--format=%cn", P), "GitHub");
  assert.deepEqual(signed.slice(before).map((i) => i.expectedHeadOid), [main], "one signed commit, bound to the new branch's start");
  assert.match(first.text, new RegExp(`at \`${P}\``), "the outcome names GitHub's head");
  assert.deepEqual(first.objects, [`github:${REPO}@${P}`]);

  // The same write's own fast-forward of a branch this task owns still lands (the lease is on the head it read).
  sh(ws, "checkout", "--quiet", "lease");
  const ff = await run("k-00000000000000f3", "github.pr", { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: F }] });
  assert.equal(ff.ok, true, ff.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), F, "a branch already holding the tree is written nothing and stays where it is");

  // A rewrite of this task's own branch (a commit on H, diverging from F) is still allowed: its plan read the branch at F and it is
  // still at F. GitHub's commit goes on F (it can't rewrite history) and brings the branch to R's tree.
  sh(ws, "checkout", "--quiet", "-b", "rewrite", H);
  writeFileSync(join(ws, "r.txt"), "r\n");
  sh(ws, "add", "r.txt");
  sh(ws, "commit", "--quiet", "-m", "rewrite");
  const R = sh(ws, "rev-parse", "HEAD");
  sh(ws, "update-ref", `refs/aidenhq/publish/${R}`, R);
  sh(ws, "bundle", "create", "--quiet", join(dirname(ws), ".aidenhq", "bundles", `${R}.bundle`), `refs/aidenhq/publish/${R}`);
  const rewriteArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: R }] };
  assert.equal((await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: rewriteArgs, requester: { kind: "job", roles: [] }, task: "t1" })).status, 200);
  const rewrite = await run("k-00000000000000f4", "github.push", rewriteArgs);
  assert.equal(rewrite.ok, true, rewrite.text);
  const C = sh(origin, "rev-parse", "refs/heads/lease");
  assert.equal(sh(origin, "rev-parse", `${C}^{tree}`), sh(ws, "rev-parse", `${R}^{tree}`), "the task's own rewrite lands as R's tree");
  assert.equal(sh(origin, "rev-parse", `${C}^`), F, "on the head it was bound to");

  // The card path: a write planned while the branch is at H does not rewrite it after the branch moves to F (a different child of
  // H). The bundle's commit isn't an ancestor of F, so only the head the plan bound refuses it -- the ancestry check would not.
  sh(origin, "update-ref", "refs/heads/lease", H);
  const staleArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: R }] };
  const staleCard = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: staleArgs, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(staleCard.status, 200, JSON.stringify(staleCard.json));
  // The card is bound to the head it read, in its own stored args: the branch was at H when it was filed.
  assert.deepEqual(staleCard.json.args.heads, { [`${REPO} lease`]: H });
  sh(origin, "update-ref", "refs/heads/lease", F);
  assert.throws(() => sh(ws, "merge-base", "--is-ancestor", R, F), "R and F diverge: the ancestry check alone would not refuse this");
  const stale = await run("k-00000000000000f5", "github.push", staleArgs, staleCard);
  assert.equal(stale.ok, false, stale.text);
  assert.match(stale.text, /^ship-head-moved/, stale.text);
  assert.match(stale.text, new RegExp(`moved to \`${F.slice(0, 12)}\` since the write read \`${H.slice(0, 12)}\``), stale.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), F, "the branch the card planned against moved; it is never rewritten");

  // A card filed at H cannot be widened by planning the same request again after the branch moved to F: the second plan is its
  // own record (its own args, its own head), and the first card still refuses. This is the finding's case: a mutable cache keyed
  // by the request alone would hand the old card F.
  sh(origin, "update-ref", "refs/heads/lease", H);
  const widenArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: R }] };
  const filed = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: widenArgs, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(filed.status, 200);
  assert.equal(filed.json.args.heads[`${REPO} lease`], H);
  sh(origin, "update-ref", "refs/heads/lease", F);
  const again = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: widenArgs, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(again.status, 200);
  assert.equal(again.json.args.heads[`${REPO} lease`], F, "the new plan reads F, as its own record");
  const oldCard = await run("k-00000000000000f7", "github.push", widenArgs, filed);
  assert.match(oldCard.text, /^ship-head-moved/, oldCard.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), F, "the earlier card keeps H and never rewrites the branch from F");

  // A revalidation is handed the record's stored args back unchanged: the head it bound is the one it still checks.
  const revalidated = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: filed.json.args, requester: { kind: "job", roles: [] }, task: "t1", revalidate: true });
  assert.equal(revalidated.status, 200);
  assert.deepEqual(revalidated.json.args.heads, { [`${REPO} lease`]: H });

  // A card whose own push already landed before GitHub dropped the connection is resumed, not refused: the branch already holds
  // the commit's tree, so there is nothing to push and the PR is finished (a held write retried by id is the same record).
  sh(origin, "update-ref", "refs/heads/lease", H);
  const resumeArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: R }] };
  const resumeCard = await call("/aidenhq/v1/executor/plan", { kind: "github.pr", args: { ...resumeArgs, text: { title: "fix: resume" } }, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(resumeCard.status, 200);
  sh(origin, "update-ref", "refs/heads/lease", C);
  const beforeResume = calls.length;
  const resumed = await run("k-00000000000000f8", "github.pr", { ...resumeArgs, text: { title: "fix: resume" } }, resumeCard);
  assert.equal(resumed.ok, true, resumed.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/lease"), C, "the branch still holds the commit its write made");
  const resumeCalls = calls.slice(beforeResume);
  assert.deepEqual(resumeCalls.filter((c) => c.method === "POST" && c.path === `/repos/${REPO}/pulls`), [], "the branch already had its PR: none is opened");
  assert.equal(resumeCalls.filter((c) => c.method === "PATCH" && c.path === `/repos/${REPO}/pulls/8`).length, 1, "the existing PR #8 is the one finished");

  // A branch planned absent and created before the push is refused: this write would take a create over a branch it never read.
  const absentArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "late", sha: H }] };
  const absentCard = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: absentArgs, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(absentCard.status, 200);
  assert.deepEqual(absentCard.json.args.heads, { [`${REPO} late`]: null }, "planned absent");
  sh(origin, "update-ref", "refs/heads/late", F);
  const late = await run("k-00000000000000f9", "github.push", absentArgs, absentCard);
  assert.match(late.text, /^ship-head-moved: .*appeared at/, late.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/late"), F, "the branch someone else created is left where it is");

  // A branch deleted since the plan is "missing", not a crash: the write lands as an ordinary first publish.
  const goneArgs = { workspace: "TASK-1", only: [{ repo: REPO, branch: "gone", sha: F }] };
  sh(origin, "update-ref", "refs/heads/gone", F);
  const goneCard = await call("/aidenhq/v1/executor/plan", { kind: "github.push", args: goneArgs, requester: { kind: "job", roles: [] }, task: "t1" });
  assert.equal(goneCard.status, 200);
  assert.equal(goneCard.json.args.heads[`${REPO} gone`], F);
  sh(origin, "update-ref", "-d", "refs/heads/gone");
  const gone = await run("k-00000000000000fa", "github.push", goneArgs, goneCard);
  assert.equal(gone.ok, true, gone.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/gone^{tree}"), sh(origin, "rev-parse", `${F}^{tree}`), "a branch deleted since is created again, no crash");

  // A fix built on GitHub's own commit C, then a fresh publish of the older bundle R: R was already published from this branch, so
  // it is refused although neither C nor the fix holds it.
  sh(origin, "update-ref", "refs/heads/lease", C);
  sh(ws, "fetch", "--quiet", origin, "+refs/heads/lease:refs/heads/signed-c");
  sh(ws, "checkout", "--quiet", "-b", "onc", "signed-c");
  writeFileSync(join(ws, "d.txt"), "d\n");
  sh(ws, "add", "d.txt");
  sh(ws, "commit", "--quiet", "-m", "fix on GitHub's commit");
  const D = sh(ws, "rev-parse", "HEAD");
  sh(ws, "update-ref", `refs/aidenhq/publish/${D}`, D);
  sh(ws, "bundle", "create", "--quiet", join(dirname(ws), ".aidenhq", "bundles", `${D}.bundle`), `refs/aidenhq/publish/${D}`);
  const fixed = await run("k-00000000000000fc", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: D }] });
  assert.equal(fixed.ok, true, fixed.text);
  const older = await run("k-00000000000000fd", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: R }] });
  assert.equal(older.ok, false, older.text);
  assert.match(older.text, /^ship-head-moved/, older.text);

  // A push straight to an agents-org repo's default branch (plan.ts raises it as `default-branch` rather than refusing it) moves
  // forward only: one commit on its head.
  const toMain = await run("k-00000000000000f6", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "main", sha: H }] });
  assert.equal(toMain.ok, true, toMain.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/main^{tree}"), sh(ws, "rev-parse", `${H}^{tree}`), "the default branch moved forward");
  assert.equal(sh(origin, "rev-parse", "refs/heads/main^"), main);
});

test("on a signature-required branch, a republish of a branch rebased onto the base's new tip is one signed merge of that tip, so the PR's diff stays the task's own", async (t) => {
  const { ws, origin, F, main, run } = await setup(t, { signedBranches: () => true, appOps: ["pr", "push"] });
  // The base moves on after the task published `lease` at F (PR #8), and the box rebases its branch onto the new tip.
  sh(ws, "checkout", "--quiet", "-b", "moved", main);
  writeFileSync(join(ws, "m.txt"), "m\n");
  sh(ws, "add", "m.txt");
  sh(ws, "commit", "--quiet", "-m", "main moves on");
  const M = sh(ws, "rev-parse", "HEAD");
  sh(ws, "push", "--quiet", origin, `${M}:refs/heads/main`);
  sh(ws, "checkout", "--quiet", "-b", "rebased", F);
  sh(ws, "rebase", "--quiet", M);
  const R = sh(ws, "rev-parse", "HEAD");
  sh(ws, "update-ref", `refs/aidenhq/publish/${R}`, R);
  sh(ws, "bundle", "create", "--quiet", join(dirname(ws), ".aidenhq", "bundles", `${R}.bundle`), `refs/aidenhq/publish/${R}`);
  const r = await run("k-00000000000000fb", "github.pr", { workspace: "TASK-1", only: [{ repo: REPO, branch: "lease", sha: R }], text: { title: "fix: rebased" } });
  assert.equal(r.ok, true, r.text);
  const P = sh(origin, "rev-parse", "refs/heads/lease");
  assert.equal(sh(origin, "rev-parse", `${P}^{tree}`), sh(ws, "rev-parse", `${R}^{tree}`), "the box commit's tree");
  assert.equal(sh(origin, "merge-base", P, "main"), M, "the PR's diff is read from the new tip: none of the base's changes in it");
  assert.equal(sh(origin, "rev-list", "--parents", "-n", "1", P), `${P} ${F} ${M}`, "one merge of the published head and the tip");
  assert.match(r.text, new RegExp(`pull/8 at \`${P}\``), "the outcome names GitHub's head");
});

test("retitle is ship's alone, Tier 0 at the head, and refuses a moved head, a stale generation or a non-adopted PR; a valid one writes only the title", async (t) => {
  const { c1, calls, call, run, adoption, pr } = await setup(t);
  const title = "fix(widget): keep the drawer open";
  const a = { repo: REPO, number: 7, head: c1, generation: 2, title };
  // The Engineer's own `aidenhq ship title` files it on the adoption's task (its task differs from the adoption's is refused).
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.retitle", args: a, requester: { kind: "job", roles: ["platform-engineer"] }, task: "t9" })).json.error, /adoption's task/);
  // A stale generation, a moved head and a PR no longer adopted are each refused before any PATCH.
  adoption.generation = 1;
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.retitle", args: a, requester: SHIP, task: "t1" })).json.error, /generation 2 is stale/);
  adoption.generation = null;
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.retitle", args: a, requester: SHIP, task: "t1" })).json.error, /isn't adopted/);
  adoption.generation = 2;
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.retitle", args: { ...a, head: "f".repeat(40) }, requester: SHIP, task: "t1" })).json.error, /head moved|moved to/);

  // An adoption with no task yet belongs to no job: no job may retitle it.
  adoption.task = null;
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.retitle", args: a, requester: SHIP, task: "t1" })).json.error, /no task owns the adoption/);
  adoption.task = "t1";
  // At the plan's own head the write is Tier 0 (no raise), and it PATCHes the title alone.
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.retitle", args: a, requester: SHIP, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.raise, undefined);
  assert.equal(plan.json.args.from, pr.title ?? "wip", "the title the plan read rides in the record");
  const out = await run("k-00000000000000ea", "github.retitle", plan.json.args, plan);
  assert.equal(out.ok, true, out.text);
  assert.equal(pr.title, title);
  const patches = calls.filter((c) => c.method === "PATCH" && c.path === `/repos/${REPO}/pulls/7`);
  assert.deepEqual(patches.map((c) => c.body), [{ title }], "only the title is sent: never the body, base or state");

  // The same record replayed after its PATCH landed (a lost answer, a crash): already that title is done, never a scope refusal.
  const replay = await run("k-00000000000000ee", "github.retitle", plan.json.args, plan);
  assert.equal(replay.ok, true, replay.text);
  assert.match(replay.text, /is titled/);
  assert.equal(calls.filter((c) => c.method === "PATCH" && c.path === `/repos/${REPO}/pulls/7`).length, 1, "the replay sends nothing");

  // The author corrected the title while the record waited: that edit is theirs, and nothing is sent.
  pr.title = "fix(widget): the author's own wording";
  const retitled = await run("k-00000000000000ec", "github.retitle", plan.json.args, plan);
  assert.match(retitled.text, /^ship-scope: .*title changed since the write was filed/);
  assert.equal(pr.title, "fix(widget): the author's own wording", "the author's edit stands");
  pr.title = title;

  // Read again off its head after filing: the write is refused, and nothing is sent.
  pr.head = "e".repeat(40);
  const moved = await run("k-00000000000000eb", "github.retitle", plan.json.args, plan);
  assert.match(moved.text, /^ship-head-moved/);
  assert.equal(calls.filter((c) => c.method === "PATCH" && c.path === `/repos/${REPO}/pulls/7`).length, 1, "no PATCH on a moved head");
});

test("a retitle held while GitHub is away resumes on reconnect as the Engineer that filed it, and reaches the PATCH", async (t) => {
  // The record is held with the requester the plan noted: the plan's args carry `from` (the title it read) and the lookup that
  // finds that requester strips it too, so a reconnect does not read the held write as one nobody asked for.
  let on = false;
  const { c1, pr, calls, call, handle } = await setup(t, { connected: () => on });
  const title = "fix(widget): hold the drawer";
  const a = { repo: REPO, number: 7, head: c1, generation: 2, title };
  const requester = { kind: "job", roles: ["platform-engineer"] };
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.retitle", args: a, requester, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.args.from, pr.title ?? "wip", "the plan bound the title it read");
  assert.deepEqual((await call("/aidenhq/v1/executor/execute", { id: "k-00000000000000ef", kind: "github.retitle", args: plan.json.args, digest: "d", idempotency_key: "held-retitle", tier: 0 })).json, { accepted: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call("/aidenhq/v1/executor/status", { id: "k-00000000000000ef" })).json.state, "running", "held, not run");
  assert.notEqual(pr.title, title, "nothing was written while GitHub was away");
  const before = calls.filter((c) => c.method === "PATCH" && c.path === `/repos/${REPO}/pulls/7`).length;
  on = true;
  await handle.stepHeld();
  assert.equal(pr.title, title, "the held retitle ran after the reconnect");
  assert.equal(calls.filter((c) => c.method === "PATCH" && c.path === `/repos/${REPO}/pulls/7`).length, before + 1, "one PATCH, and only the title");
  assert.equal((await call("/aidenhq/v1/executor/status", { id: "k-00000000000000ef" })).json.state, "done");
});

test("a retitle outside the fleet's own repos is refused when the title names our tooling, and nothing is sent", async (t) => {
  // The same repo, not in the agents org and not listed: its PR's title is public text, read as a `.pr`'s is.
  const { c1, calls, call } = await setup(t, { fleetOrg: "other-agents", listed: [] });
  const args = { repo: REPO, number: 7, head: c1, generation: 2, title: "fix(widget): run it from the aidenhq worktree" };
  const refused = await call("/aidenhq/v1/executor/plan", { kind: "github.retitle", args, requester: SHIP, task: "t1" });
  assert.equal(refused.status >= 400, true, JSON.stringify(refused.json));
  assert.match(String(refused.json?.error ?? refused.json?.message ?? ""), /mentions "aidenhq"|internal names/);
  assert.equal(calls.filter((c) => c.method === "PATCH" && c.path === `/repos/${REPO}/pulls/7`).length, 0, "nothing is sent");
  // The same title in the fleet's own repo is the fleet's to write.
  const own = await setup(t);
  assert.equal((await own.call("/aidenhq/v1/executor/plan", { kind: "github.retitle", args: { ...args, head: own.c1 }, requester: SHIP, task: "t1" })).status, 200);
});

test("where the App is installed with every permission each write goes as the App (a git push, a signed commit, a PR, a merge); ship's approve skips a PR the App opened", async (t) => {
  const tokens = [];
  const { ws, origin, H, c1, pr, run, calls } = await setup(t, { appOps: ["push", "pr", "merge", "issue", "dequeue"], appTokens: tokens, signedBranches: (_slug, branch) => branch === "signed" });
  // A git push and the PR it opens: the push's token and the REST write are the App's.
  sh(ws, "checkout", "--quiet", "-b", "fresh", H);
  const opened = await run("k-0000000000000a01", "github.pr", { workspace: "TASK-1", only: [{ repo: REPO, branch: "fresh", sha: H }], text: { title: "fix: a thing", body: "Why." } });
  assert.equal(opened.ok, true, opened.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/fresh"), H);
  assert.deepEqual(tokens, ["app"], "the push carries the App's token");
  assert.equal(calls.find((c) => c.method === "POST" && c.path === `/repos/${REPO}/pulls`)?.as, "app", "the PR is opened as the App");
  // A branch whose rules require signed commits: GitHub's own commit (createCommitOnBranch), as the App.
  sh(ws, "checkout", "--quiet", "-b", "signed", H);
  const signedOut = await run("k-0000000000000a02", "github.push", { workspace: "TASK-1", only: [{ repo: REPO, branch: "signed", sha: H }] });
  assert.equal(signedOut.ok, true, signedOut.text);
  const mutations = calls.filter((c) => c.path === "/graphql" && String(c.body?.query).includes("createCommitOnBranch"));
  assert.ok(mutations.length && mutations.every((c) => c.as === "app"), "the signed commit is the App's");
  assert.ok(calls.filter((c) => c.method === "POST" && c.path === `/repos/${REPO}/git/refs`).every((c) => c.as === "app"), "its branch too");
  // The merge queue is joined as the App.
  const queued = await run("k-0000000000000a03", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, base: "main", attempt: 1 });
  assert.match(queued.text, /in the merge queue/, queued.text);
  assert.ok(calls.filter((c) => c.method === "PUT" && /\/merge-async$/.test(c.path)).every((c) => c.as === "app"));
  // A PR the App opened waits for a person's approval: nothing is posted.
  pr.author = "acme-app[bot]";
  const approve = await run("k-0000000000000a04", "github.approve", { repo: REPO, number: 7, head: pr.head, generation: 2, base: "main" });
  assert.match(approve.text, /^ship-no-app: .*approval needs a person \(the GitHub App opened it/, approve.text);
  assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/reviews")).length, 0);
});

test("the async enqueue rechecks code review's gate before the PUT", async (t) => {
  let puts = 0, calls = 0;
  const { c1, run } = await setup(t, {
    reviewGate: async () => (++calls === 1 ? undefined : { wait: "code review: running" }),
    asyncMerge: { put: () => { puts++; return { status: 202, body: { status: "pending", details: { uuid: "u-g" } } }; }, get: () => ({ status: 200, body: { status: "enqueued", details: {} } }) },
  });
  const out = await run("k-00000000000000fa", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 1, base: "main" });
  assert.equal(out.ok, false, out.text);
  assert.match(out.text, /^ship-tier-pending: not queued: code review: running/, "a gate wait is retryable, never a hold");
  assert.equal(puts, 0, "a review gate that closed while the enqueue was in flight stops the request");
});
