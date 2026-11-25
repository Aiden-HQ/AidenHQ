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
import { createService, shipAdoptions } from "../service/src/service.ts";
import { planParts } from "../service/src/plan.ts";
import { decide, mergePath, requiredChecks } from "../service/src/merge-gate.ts";
import { createMerges } from "../service/src/merges.ts";

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
  // A ref update GitHub refuses for its own reasons (a rule), never a moved head: the branch reads back at the expected head.
  let refuseRef = false;
  // A PR closed after ship's first read and before its ref update (`duringPush`), so the recheck before the branch moves is tested.
  let duringPush;
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const m = /^\/v1\/writes\/([^/]+)\/outcome$/.exec(req.url);
    if (m) { outcomes.push({ id: m[1], ...JSON.parse(body) }); return res.writeHead(200).end("{}"); }
    // Ship's repair check job, already done: its result and the file it kept.
    if (req.url === "/v1/checks") { checks.push(JSON.parse(body)); if (duringRepair) duringRepair(); return res.writeHead(200).end(JSON.stringify({ id: "c-1", state: "done", version: 1, result: repairResult.result })); }
    if (req.url === "/v1/checks/c-1/kept") return res.writeHead(200).end(JSON.stringify(repairResult.keep));
    res.writeHead(404).end("{}");
  });
  const calls = [];
  /** git against the bare origin, as GitHub's side would hold it (no hooks from the host's own environment). */
  const bare = (args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: origin, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  const gh = async (method, path, body) => {
    calls.push({ method, path, body, as: body?.as });
    if (path === "/graphql" && body.query.includes("enqueuePullRequest")) return enqueueAnswer(queue);
    if (path === "/graphql") return { status: 200, body: { data: { repository: { pullRequest: { id: "PR_7", state: "OPEN", headRefOid: pr.head, baseRefName: "main", isInMergeQueue: Boolean(queue.head), mergeQueueEntry: queue.head ? { headCommit: { oid: queue.head } } : null, ...queue.review } } } } };
    if (method === "GET" && /\/commits\/[0-9a-f]{40}\/check-runs/.test(path)) return { status: 200, body: { total_count: 0, check_runs: [] } };
    if (method === "GET" && /\/commits\/[0-9a-f]{40}\/status/.test(path)) return { status: 200, body: { total_count: 0, statuses: [] } };
    if (method === "GET" && path === `/repos/${REPO}`) return { status: 200, body: { default_branch: "main" } };
    // The open PR on the published task branch (`github.pr` on it): its head follows a PATCH, so a rewind would show here.
    if (method === "GET" && path.startsWith(`/repos/${REPO}/pulls?state=open&head=acme-agents%3A`)) {
      // The whole query, `&base=main` and all: the branch is its `head` value, never the rest of the path.
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const branch = decodeURIComponent(String(q.get("head") ?? "")).replace(/^acme-agents:/, "");
      return { status: 200, body: branch === "lease" ? [{ number: 8, html_url: `https://github.com/${REPO}/pull/8`, head: { sha: bare(["rev-parse", "refs/heads/lease"]) }, base: { ref: "main" } }] : [] };
    }
    if (method === "PATCH" && path === `/repos/${REPO}/pulls/8`) return { status: 200, body: { number: 8, html_url: `https://github.com/${REPO}/pull/8`, head: { sha: bare(["rev-parse", "refs/heads/lease"]) }, base: { ref: "main" } } };
    // A new PR the publish opens (a branch with none yet): its head is whatever the branch holds when it asks.
    if (method === "POST" && path === `/repos/${REPO}/pulls`) return { status: 201, body: { number: 9, html_url: `https://github.com/${REPO}/pull/9`, head: { sha: bare(["rev-parse", `refs/heads/${body.head}`]), ref: body.head }, base: { ref: body.base, sha: main }, user: { login: "owner1" } } };
    if (method === "GET" && path === `/repos/${REPO}/pulls/7`) return { status: 200, body: { number: 7, state: pr.state ?? "open", head: { sha: pr.head, ref: "contrib", repo: pr.fork ? { full_name: "someone/widget" } : { full_name: REPO } }, base: { ref: pr.base ?? "main", sha: main }, user: { login: pr.author }, maintainer_can_modify: pr.canModify === true } };
    if (method === "POST" && path === `/repos/${REPO}/pulls/7/reviews`) return { status: 200, body: { id: 99 } };
    // A merge's plan lists the PR's files (at most a page): this one changed one file, so the listing is the whole set.
    if (method === "GET" && path === `/repos/${REPO}/pulls/7/files?per_page=100`) return { status: 200, body: [{ filename: "b.txt" }] };
    if (method === "GET" && path.startsWith(`/repos/${REPO}/pulls/7/reviews`)) return { status: 200, body: [{ id: 50, user: { login: "acme-app[bot]" }, state: "APPROVED", commit_id: "e".repeat(40) }, { id: 51, user: { login: "owner1" }, state: "APPROVED", commit_id: "e".repeat(40) }, { id: 99, user: { login: "acme-app[bot]" }, state: "APPROVED", commit_id: pr.head }] };
    if (method === "PUT" && /\/dismissals$/.test(path)) return { status: 200, body: {} };
    // GitHub's git data API over the bare origin: blobs, trees, commits, and a ref update that refuses a non-fast-forward. The
    // review App's manifest carries no contents: write, so its answer is the real one, 403 Resource not accessible by integration.
    if (body?.as === "app" && path.startsWith(`/repos/${REPO}/git/`)) return { status: 403, body: { message: "Resource not accessible by integration" } };
    const git = (args, o = {}) => execFileSync("git", args, { cwd: origin, encoding: "utf8", ...o, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_COMMITTER_NAME: "app", GIT_COMMITTER_EMAIL: "app@example.com", GIT_AUTHOR_NAME: "app", GIT_AUTHOR_EMAIL: "app@example.com", ...o.env } }).trim();
    if (method === "POST" && path === `/repos/${REPO}/git/blobs`) return { status: 201, body: { sha: git(["hash-object", "-w", "--stdin"], { input: Buffer.from(body.content, "base64") }) } };
    if (method === "POST" && path === `/repos/${REPO}/git/trees`) {
      const env = { GIT_INDEX_FILE: join(root, `idx-${Math.random()}`) };
      git(["read-tree", body.base_tree], { env });
      for (const e of body.tree) git(e.sha === null ? ["update-index", "--force-remove", e.path] : ["update-index", "--add", "--cacheinfo", `${e.mode},${e.sha},${e.path}`], { env });
      return { status: 201, body: { sha: git(["write-tree"], { env }) } };
    }
    // GitHub signs a commit as the identity whose token made it: the owner's login, or the reviewer App's bot.
    if (method === "POST" && path === `/repos/${REPO}/git/commits`) {
      // The upload reached its commit: whatever the test wants to happen next does, before the ref moves.
      const hooked = duringPush; duringPush = undefined; hooked?.();
      const who = body.as === "app" ? "app" : "owner1";
      const env = { GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@example.com`, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@example.com` };
      return { status: 201, body: { sha: git(["commit-tree", body.tree, ...body.parents.flatMap((p) => ["-p", p]), "-m", body.message], { env }) } };
    }
    if (method === "GET" && path.startsWith(`/repos/${REPO}/compare/`)) return { status: 200, body: { merge_base_commit: { sha: main } } };
    if (method === "GET" && path.startsWith(`/repos/${REPO}/git/commits/`)) return { status: 200, body: { tree: { sha: git(["rev-parse", `${path.split("/").pop()}^{tree}`]) } } };
    if (method === "PATCH" && path === `/repos/${REPO}/git/refs/heads/contrib`) {
      // A ruleset refusal of GitHub's own (contents: write is there, but a rule refuses the update): its reason, not head movement.
      if (refuseRef) return { status: 422, body: { message: "refusing to allow a GitHub App to create or update workflow" } };
      const cur = git(["rev-parse", "refs/heads/contrib"]);
      try { git(["merge-base", "--is-ancestor", cur, body.sha]); } catch { return { status: 422, body: { message: "Update is not a fast forward" } }; }
      git(["update-ref", "refs/heads/contrib", body.sha]);
      return { status: 200, body: {} };
    }
    if (method === "GET" && path === `/repos/${REPO}/git/ref/heads/contrib`) return { status: 200, body: { object: { sha: git(["rev-parse", "refs/heads/contrib"]) } } };
    return { status: 404, body: { message: "fake GitHub: no route" } };
  };
  const access = {
    connected: () => true, scopes: () => ["repo"], status: () => ({ scopes: ["repo"], problems: [] }), token: async () => "tok",
    identity: async () => ({ login: "owner1", name: "Owner One", email: "1+owner1@users.noreply.github.com" }),
    rest: async (method, path, body) => ({ ...(await gh(method, path, body)), headers: new Headers() }),
    graphql: async () => ({}),
  };
  const adoption = { generation, refused: undefined, hold: undefined, task: "t1" };
  // Ship's answer, and its final tier check where github passes the write and the live head, base and author. A fork's head binding
  // lives in ship's own answer: an `at` other than the handed-off head reads as a stop, even while the adoption is stalled.
  const handoffHead = { head: undefined };
  const ship = { generation: async (_r, _n, at, check) => ({
    generation: adoption.generation,
    ...(adoption.task ? { task: adoption.task } : {}),
    ...(handoffHead.head !== undefined && at !== handoffHead.head ? { hold: { kind: "stopped", reason: "the write isn't on the head handed off" } } : adoption.hold ? { hold: adoption.hold } : {}),
    ...(adoption.refused && check ? { refused: adoption.refused } : {}),
  }) };
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir: join(root, "cache"), tasksDir: join(root, "tasks"), access,
    remoteUrl: (slug) => join(root, "github", `${slug.split("/")[0]}/${slug.split("/")[1]}.git`), fleetOrg: "acme-agents", productRepo: "acme/aidenhq",
    reviewGate: async () => undefined, ship,
    // The App, installed on the repo: its writes are recorded like the owner's (`as` marks whose they are).
    reviewer: async () => (app ? { login: "acme-app[bot]", token: async () => "app-token", rest: async (method, path, body) => ({ ...(await gh(method, path, { ...body, as: "app" })), headers: new Headers() }) } : undefined),
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
  return { root, ws, origin, c1, fix, main, H, F, pr, queue, calls, call, run, adoption, handoffHead, checks, repairResult, duringRepair: (fn) => { duringRepair = fn; }, duringPush: (fn) => { duringPush = fn; }, refuseRef: (v) => { refuseRef = v; } };
}

test("a push onto an adopted PR's branch is written through the API as the code host's sign-in, a fast-forward from the head it expects; a contributor's push in between wins", async (t) => {
  const { ws, origin, c1, fix, pr, calls, call, run, duringPush } = await setup(t);
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
  // Closed after the first read, while the upload is under way: the recheck before the ref moves refuses it, and the branch stays.
  pr.state = "open";
  duringPush(() => { pr.state = "closed"; });
  const closedLate = await run("k-00000000000000b6", "github.push", args);
  assert.match(closedLate.text, /^ship-scope: .* is closed/, closedLate.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), c1, "a PR closed during the upload never gets its branch moved");
  pr.state = "open";
  // Retargeted during the upload: the commit was built against the base the plan read, so the branch stays put too.
  duringPush(() => { pr.base = "release"; });
  const retargeted = await run("k-00000000000000b7", "github.push", args);
  assert.match(retargeted.text, /^ship-scope: .*retargeted during the push/, retargeted.text);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), c1, "a PR retargeted during the upload never gets its branch moved");
  pr.base = "main";
  const ok = await run("k-00000000000000b2", "github.push", args);
  assert.equal(ok.ok, true, ok.text);
  // The code host's commit: the repair's tree on top of c1, written as the owner's sign-in (never the reviewer App), not the box's commit.
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^{tree}"), sh(ws, "rev-parse", `${fix}^{tree}`));
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^"), c1);
  assert.equal(sh(origin, "log", "-1", "--format=%cn", "refs/heads/contrib"), "owner1");
  const written = calls.filter((c) => c.path.startsWith(`/repos/${REPO}/git/`) && c.method === "POST").map((c) => c.as);
  assert.ok(written.length >= 3, "a blob, a tree and a commit");
  assert.ok(written.every((as) => as === undefined), "every write is the code host's, none the reviewer App's");
  assert.match(ok.text, / as owner1\.$/);
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

test("a push onto an adopted PR's branch that GitHub's own rules refuse keeps GitHub's reason, not ship-head-moved", async (t) => {
  const { ws, origin, c1, fix, pr, run, refuseRef } = await setup(t);
  const args = { workspace: "TASK-1", only: [{ repo: REPO, branch: "contrib", sha: fix }], pr: { repo: REPO, number: 7 }, expected: c1, generation: 2 };
  // The branch is still at the expected head, so the 422 is a rules refusal: the head didn't move.
  refuseRef(true);
  const r = await run("k-00000000000000b4", "github.push", args);
  assert.equal(r.ok, false);
  assert.match(r.text, /^GitHub refused the update of .*: 422 /, r.text);
  assert.doesNotMatch(r.text, /^ship-head-moved/);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib"), c1, "nothing was written");
  // With the ref moved instead, the same status reads as head movement, as before.
  refuseRef(false);
  sh(ws, "push", "--quiet", "--force", origin, `${c1}:refs/heads/contrib`);
  pr.head = c1;
  const scratch = `${ws}-moved`;
  sh(dirname(ws), "clone", "--quiet", "-b", "contrib", origin, scratch);
  writeFileSync(join(scratch, "c.txt"), "c\n");
  sh(scratch, "add", "c.txt");
  sh(scratch, "commit", "--quiet", "-m", "contributor again");
  sh(scratch, "push", "--quiet", origin, "contrib");
  assert.match((await run("k-00000000000000b5", "github.push", args)).text, /^ship-head-moved/);
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
  assert.deepEqual(calls.find((c) => c.method === "POST" && c.path.endsWith("/reviews")).body, { event: "APPROVE", commit_id: pr.head, as: "app" }, "as the App, never the owner");

  // An enqueue of a head the runner didn't push is a merge by the queue: the AI reviewer reads it first, and the queue is
  // joined as the code host's sign-in (the reviewer App's manifest has no merge_queues, so GitHub would refuse it).
  const e = { ...a, attempt: 1 };
  const enq = await call("/aidenhq/v1/executor/plan", { kind: "github.enqueue", args: e, requester: SHIP, task: "t1" });
  assert.equal(enq.status, 200, JSON.stringify(enq.json));
  assert.equal(enq.json.raise?.rule, "agents-org-merge-foreign-head");
  const queued = await run("k-00000000000000c2", "github.enqueue", e);
  assert.match(queued.text, /didn't answer the enqueue/, queued.text);
  const sent = calls.filter((c) => c.path === "/graphql" && typeof c.body?.query === "string" && c.body.query.includes("enqueuePullRequest"));
  assert.equal(sent.length, 1);
  assert.ok(sent.every((c) => c.as === undefined), "the queue is joined as the code host's sign-in, never the reviewer App");
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
  // GitHub still counts an earlier commit's approval, but none is on this head: not queued, asked again once there is one.
  queue.review = { reviewDecision: "APPROVED", latestOpinionatedReviews: { nodes: [{ state: "APPROVED", authorCanPushToRepository: true, author: { __typename: "User", login: "maria" }, commit: { oid: "e".repeat(40) } }] } };
  const stale = await run("k-00000000000000d3", "github.enqueue", { repo: REPO, number: 7, head: c1, generation: 2, attempt: 3, base: "main" });
  assert.match(stale.text, /^ship-tier-pending: .*no approval on/);
  assert.equal(sent, 2, "never sent");
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
  const approval = (commit, writer = true, bot = "") => ({ latestOpinionatedReviews: { nodes: [{ state: "APPROVED", authorCanPushToRepository: writer, author: { __typename: bot ? "Bot" : "User", login: bot || "maria" }, commit: { oid: commit } }] } });
  assert.deepEqual(go({ reviewDecision: "APPROVED", ...approval("b".repeat(40)) }), { do: "wait", why: "its approval is on an earlier commit: someone with write access approves this head" });
  assert.equal(go({ reviewDecision: "APPROVED", ...approval("b".repeat(40)) }, { approve: true }).do, "approve", "ship's App approves the head again where it may");
  assert.equal(go({ reviewDecision: "APPROVED", ...approval(H, false) }).do, "wait", "a reader's approval on the head doesn't count");
  assert.equal(go({ reviewDecision: "APPROVED", ...approval(H) }).do, "merge");
  assert.equal(go({ reviewDecision: "APPROVED", ...approval(H, false, "acme-reviewer") }, { app: "acme-reviewer" }).do, "merge", "the reviewer App's approval on the head");
  assert.equal(go({ reviewDecision: "APPROVED", ...approval(H, true, "other-bot") }, { app: "acme-reviewer" }).do, "wait", "another bot's approval doesn't count");
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
  // Without ship's context: the merge queue's rule, unchanged.
  assert.deepEqual(decide(data({}), H), { do: "merge" });
  assert.equal(decide(data({ mergeStateStatus: "DIRTY" }), H).do, "fail");
  assert.equal(decide(data({ baseRefName: "release" }), H).do, "fail");
  assert.equal(mergePath([{ type: "pull_request" }, { type: "merge_queue" }]), "queue");
  assert.equal(mergePath([]), "direct");
  assert.deepEqual(requiredChecks([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }] } }], { contexts: ["ci-required"] }).sort(), ["build", "ci-required"]);
});

test("ship's generation answer keeps a stalled adoption's generation and the hold's kind; no adoption is still null", async () => {
  const answer = (body) => shipAdoptions({ url: "http://ship:8101", key: () => "k", fetchFn: async () => new Response(JSON.stringify(body), { status: 200 }) }).generation(REPO, 7, "a".repeat(40));
  const stalled = await answer({ generation: 2, hold: { kind: "stalled", reason: "the repair didn't finish" }, task: "t1" });
  assert.deepEqual(stalled, { generation: 2, hold: { kind: "stalled", reason: "the repair didn't finish" }, task: "t1" });
  const stopped = await answer({ generation: 2, hold: { kind: "stopped", reason: "ship is paused" } });
  assert.deepEqual([stopped.generation, stopped.hold?.kind], [2, "stopped"]);
  assert.deepEqual(await answer({ generation: 2, hold: null }), { generation: 2 });
  assert.deepEqual(await answer({ generation: null, hold: null }), { generation: null }, "no adoption record at all");
  // A hold the code host can't read is never dropped open: it reads as `unknown`, which admits no write.
  assert.equal((await answer({ generation: 2, hold: true })).hold?.kind, "unknown");
  assert.equal((await answer({ generation: 2, hold: { reason: "no kind" } })).hold?.kind, "unknown");
  assert.equal((await answer({ generation: 2, hold: "stalled" })).hold?.kind, "unknown");
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
      if (method === "PUT") return { status: 200, body: { sha: "c".repeat(40) } };
      return { status: 404, body: {} };
    };
    const outcomes = [];
    const { createMerges } = await import("../service/src/merges.ts");
    const m = createMerges({ dir: mkdtempSync(join(tmpdir(), "ship-merge-")), gh, fleetOrg: "acme-agents", reviewGate: async () => undefined, report: async (id, o) => void outcomes.push(o), ship: { generation: async () => ({ generation: adopted ? 2 : null, ...(adopted && o.hold ? { hold: o.hold } : {}) }) }, taskStatus: async () => taskStatus, ...(o.reviewer ? { reviewer: o.reviewer } : {}) });
    if (plain) void m.enqueue("k-1", { prs: [{ repo: REPO, number: 7, head: H }] }, "T1", undefined, undefined, true);
    else void m.enqueue("k-1", { prs: [{ repo: REPO, number: 7, head: H, base: "main" }], generation: 2, attempt: 1 });
    await m.step();
    return { calls, outcomes };
  };
  const merged = await run(true);
  assert.equal(merged.calls.filter((c) => c.startsWith("PUT")).length, 1, merged.calls.join("\n"));
  // GitHub asks for a review: the reviewer App's approval on the head merges it; with no App known, the same approval waits.
  const appApproved = { pr: { reviewDecision: "APPROVED", latestOpinionatedReviews: { nodes: [{ state: "APPROVED", authorCanPushToRepository: false, author: { __typename: "Bot", login: "acme-reviewer" }, commit: { oid: H } }] } }, reviewer: async () => ({ login: "acme-reviewer[bot]" }) };
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
  // The advisory design review alone is no CI: still waiting, never merged on it.
  const design = await run(true, false, "in_progress", 403, [{ name: "design-review", status: "completed", conclusion: "success" }]);
  assert.equal(design.calls.filter((c) => c.startsWith("PUT")).length, 0, design.calls.join("\n"));
  assert.equal(design.outcomes.length, 0, "waiting, not settled");
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

test("ship's repair: github runs ship's check job and writes what it kept as the code host's sign-in, a merge commit on the head; leftovers and a fork without edits write nothing", async (t) => {
  const { origin, c1, main, pr, call, run, checks, repairResult } = await setup(t);
  const args = { repo: REPO, number: 7, head: c1, generation: 2, base: "main", plan: { globs: ["gen.txt"], commands: [{ dir: ".", cmd: "make gen" }] } };
  const plan = await call("/aidenhq/v1/executor/plan", { kind: "github.repair", args, requester: SHIP, task: "t1" });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.equal(plan.json.raise, undefined);
  assert.match((await call("/aidenhq/v1/executor/plan", { kind: "github.repair", args, requester: { kind: "job", roles: ["platform-engineer"] }, task: "t1" })).json.error, /only the ship module/);

  const ok = await run("k-00000000000000c1", "github.repair", args);
  assert.equal(ok.ok, true, ok.text);
  assert.deepEqual(checks[0], { repo: REPO, head: c1, run: "ship-repair", spec: { base: main, merge_base: main, base_ref: "main", plan: JSON.stringify(args.plan), attempt: "1" } });
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^1"), c1);
  assert.equal(sh(origin, "rev-parse", "refs/heads/contrib^2"), main);
  assert.equal(sh(origin, "show", "refs/heads/contrib:gen.txt"), "regenerated");
  assert.equal(sh(origin, "log", "-1", "--format=%cn", "refs/heads/contrib"), "owner1", "written as the code host's sign-in, never the reviewer App");

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

test("ship's repair keeps the head lease: a contributor's push while the repair runs is refused with ship-head-moved and the branch stays theirs", async (t) => {
  const { root, origin, ws, c1, pr, run, duringRepair } = await setup(t);
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
  const { root, origin, ws, c1, fix, main, pr, run, repairResult } = await setup(t);
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

test("ship's repair takes the box's files only on generated paths and conflicted lockfiles: never a workflow, a gitlink, a source file, an untouched lockfile or a new symlink", async (t) => {
  const { origin, c1, run, repairResult } = await setup(t);
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
