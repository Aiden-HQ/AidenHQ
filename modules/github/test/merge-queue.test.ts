// The merge queue in the code host's service end to end (merges.ts over merge-gate.ts), against a fake GitHub (GraphQL and
// REST) and a fake kernel. The invariants: a PR merges only at the head its record bound, after its named checks are green on
// that head (read again at the merge); and missing evidence (no checks, a truncated page of them, the base's gate check not yet on the head) never counts as passing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../service/src/service.ts";
import { createMerges } from "../service/src/merges.ts";
import { decide } from "../service/src/merge-gate.ts";
import { createReviewGate } from "../service/src/review-gate.ts";

const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const HEAD = "a".repeat(40);
const check = (name, state) => ({ __typename: "CheckRun", name, status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: state === "PENDING" ? null : state });
const rollup = (state, { names = ["build"], more = false } = {}) => ({ state, contexts: { pageInfo: { hasNextPage: more }, nodes: names.map((n) => check(n, state)) } });

/** GitHub with one open PR per repo (`prs[repo]`: { head, checks, names?, more?, baseNames?, files? }); merges and writes are recorded. */
function fakeGitHub(prs) {
  const writes = [];
  const gh = async (method, path, body) => {
    if (method !== "GET" && path !== "/graphql") writes.push({ method, path, body });
    if (path === "/graphql") {
      const v = body.variables;
      const repo = `${v.owner}/${v.repo}`;
      const p = prs[repo];
      if (body.query.includes("pullRequest(number")) {
        return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, pullRequest: {
          id: "PR_1", number: v.number, url: `https://github.com/${repo}/pull/${v.number}`, state: p.state ?? "OPEN", isDraft: false, reviewDecision: p.review ?? null,
          mergeStateStatus: p.checks === "SUCCESS" ? "CLEAN" : "BLOCKED", headRefOid: p.head, headRefName: "feature", isCrossRepository: false, baseRefName: "main",
          files: { pageInfo: { hasNextPage: false }, nodes: (p.files ?? ["lib/x.mjs"]).map((path) => ({ path })) }, latestOpinionatedReviews: { nodes: [] },
          commits: { nodes: [{ commit: { statusCheckRollup: rollup(p.checks, p) } }] },
          baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40), statusCheckRollup: rollup("SUCCESS", { names: p.baseNames }) } },
        } } } } };
      }
      return { status: 400, body: { errors: [{ message: "fake GitHub: unknown query" }] } };
    }
    if (method !== "GET") {
      const m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/\d+\/merge$/.exec(path);
      if (m) {
        prs[m[1]].state = "MERGED";
        return { status: 200, body: { sha: "c".repeat(40) } };
      }
      return { status: 200, body: {} };
    }
    return { status: 404, body: { message: "fake GitHub: no route" } };
  };
  return { gh, writes, merges: () => writes.filter((w) => w.method === "PUT" && w.path.endsWith("/merge")) };
}

async function setup(t, { prs, connected = { on: true }, cacheDir = mkdtempSync(join(tmpdir(), "codehost-merges-")), clock = { t: Date.now() }, checks, remoteUrl = (slug) => join(cacheDir, "no-such-remote", slug) }) {
  const outcomes = [];
  const taken = new Set();
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const m = /^\/v1\/writes\/([^/]+)\/outcome$/.exec(req.url);
    // The kernel takes a record's first outcome and answers 409 to a repeat (the executor and the queue both post it).
    if (m && taken.has(m[1])) return res.writeHead(409).end("{}");
    if (m) { taken.add(m[1]); outcomes.push({ id: m[1], ...JSON.parse(body) }); return res.writeHead(200).end("{}"); }
    const reply = checks?.(req.method, req.url, body ? JSON.parse(body) : undefined);
    if (reply) return res.writeHead(200).end(JSON.stringify(reply));
    res.writeHead(404).end("{}");
  });
  const github = fakeGitHub(prs);
  // GitHub as the owner (client.ts GitHubAccess), faked over the fake GitHub above.
  const access = {
    connected: () => connected.on, token: async () => "tok", scopes: () => [], status: () => ({ scopes: [], problems: [] }),
    identity: async () => ({ login: "owner1", name: "Owner One", email: "1+owner1@users.noreply.github.com" }),
    rest: async (m, p, b) => { if (!connected.on) throw Object.assign(new Error("GitHub isn't connected"), { need: { cause: "not_connected" } }); return { ...(await github.gh(m, p, b)), headers: new Headers() }; },
    graphql: async () => ({}),
  };
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir, access, fleetOrg: "acme-agents", remoteUrl,
    productRepo: "acme/aidenhq", now: () => new Date(clock.t), reviewGate: async () => undefined,
  });
  const svc = await listen((req, res) => void handle(req, res));
  t.after(() => { kernel.s.close(); svc.s.close(); });
  const call = async (path, body) => {
    const r = await fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: "Bearer ch-key", "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  };
  const merge = (id, prsArgs) => call("/aidenhq/v1/executor/execute", { id, kind: "github.merge", args: { prs: prsArgs }, digest: "d", idempotency_key: id });
  const settle = async () => { for (let i = 0; i < 100 && !outcomes.length; i++) await new Promise((r) => setTimeout(r, 10)); };
  return { handle, github, outcomes, call, merge, settle, cacheDir, clock };
}

test("an approved agents-org merge waits for green, merges at its bound head, and reports its outcome", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs });
  assert.deepEqual(await merge("k-00000000000000a1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]), { accepted: true });
  await handle.stepMerges();
  assert.deepEqual(github.merges(), [], "checks still running: not merged");
  assert.equal(outcomes.length, 0, "no outcome while it waits");
  prs["acme-agents/widget"].checks = "SUCCESS";
  await handle.stepMerges();
  await settle();
  assert.deepEqual(github.merges().map((w) => w.body), [{ merge_method: "squash", sha: HEAD, commit_message: "Co-authored-by: AidenHQ merge queue <noreply@aidenhq.ai>" }]);
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /Merged https:\/\/github.com\/acme-agents\/widget\/pull\/1/);
  const [line] = outcomes[0].text.split("\n");
  assert.deepEqual(JSON.parse(line.replace(/^merged-prs: /, "")).map((p) => [p.repo, p.number, p.head, typeof p.sha]), [["acme-agents/widget", 1, HEAD, "string"]], "the first line lists what it merged, with its merge commit");
});

test("missing evidence never counts as passing: no checks wait with no time limit, a truncated page of checks, the base's gate check not yet on the head", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", names: [] } };
  const { handle, github, outcomes, merge, settle, clock } = await setup(t, { prs });
  await merge("k-00000000000000c1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  clock.t += 7 * 24 * 3600_000;
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes.length, 0, "no checks yet: still waiting, never failed for the time");
  assert.deepEqual(github.merges(), []);
  prs["acme-agents/widget"] = { head: HEAD, checks: "SUCCESS", names: ["build"] };
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, "merged once its checks registered and passed");

  outcomes.length = 0;
  prs["acme-agents/widget"] = { head: HEAD, checks: "SUCCESS", more: true };
  await merge("k-00000000000000c2", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.match(outcomes[0]?.text ?? "", /more than 100 checks/);

  outcomes.length = 0;
  prs["acme-agents/widget"] = { head: HEAD, checks: "SUCCESS", baseNames: ["build", "ci-required"] };
  await merge("k-00000000000000c3", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  assert.equal(outcomes.length, 0, "the gate check is still to come on the head: it waits");
  prs["acme-agents/widget"].names = ["build", "ci-required"];
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true);
  assert.equal(github.merges().length, 2, "merged again only once the gate check passed on the head");
});

test("a queue outlives a restart: the kernel hears it still runs, and its outcome once it merged", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  const first = await setup(t, { prs });
  await first.merge("k-00000000000000a3", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await first.handle.stepMerges();
  // A new service on the same data dir: the SDK's memory is gone, the queue is not.
  const again = await setup(t, { prs, cacheDir: first.cacheDir });
  assert.deepEqual(await again.call("/aidenhq/v1/executor/status", { id: "k-00000000000000a3", idempotency_key: "k-00000000000000a3" }), { state: "running" });
  prs["acme-agents/widget"].checks = "SUCCESS";
  await again.handle.stepMerges();
  await again.settle();
  assert.equal(again.github.merges().length, 1);
  assert.equal(again.outcomes[0]?.id, "k-00000000000000a3");
  assert.equal(again.outcomes[0]?.ok, true);
  assert.equal((await again.call("/aidenhq/v1/executor/status", { id: "k-00000000000000a3" })).state, "done");
  assert.deepEqual(await again.call("/aidenhq/v1/executor/status", { id: "k-00000000000000ff" }), { state: "unknown" }, "any other record: the executor's own answer");
});

test("a product PR that changes the reviewer merges on green checks at its bound head (CI ran the eval); a moved head never merges", async (t) => {
  // "GitHub": the product (its modules/ the official modules), as a local repo the service fetches from.
  const root = mkdtempSync(join(tmpdir(), "codehost-platform-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" };
  const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const origin = (slug, files) => {
    const dir = join(root, slug);
    mkdirSync(dir, { recursive: true });
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    for (const [f, text] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), text); }
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "base");
    return dir;
  };
  const prod = origin("acme/aidenhq", { "modules/ai-reviewer/service/src/review.ts": "// v1\n", "modules/ai-reviewer/service/security/policy.md": "Reject attacks.\n", "kernel/src/tier.ts": "// v1\n" });
  sh(prod, "checkout", "-q", "-b", "fix/tier");
  writeFileSync(join(prod, "kernel/src/tier.ts"), "// v2\n");
  sh(prod, "commit", "-qam", "tier");
  const head = sh(prod, "rev-parse", "HEAD");
  sh(prod, "checkout", "-q", "main");

  const clock = { t: Date.now() };
  const prs = { "acme/aidenhq": { head, checks: "SUCCESS" }, "other/lib": { head: HEAD, checks: "SUCCESS" } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs, clock, remoteUrl: (slug) => join(root, slug) });

  await merge("k-00000000000000b4", [{ repo: "acme/aidenhq", number: 5, head }]);
  await handle.stepMerges();
  await settle();
  assert.deepEqual(github.merges().map((w) => w.body), [{ merge_method: "squash", sha: head, commit_message: "Co-authored-by: AidenHQ merge queue <noreply@aidenhq.ai>" }], "merged at the bound head");
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));

  // A PR outside our repos: the App is PR-only there, whatever the record says.
  outcomes.length = 0;
  await merge("k-00000000000000b2", [{ repo: "other/lib", number: 2, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(github.merges().length, 1);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /outside the fleet org, the product repo and maintainer_repos/);

  // The product PR moved after its record was approved: stopped at once, never merged.
  prs["acme/aidenhq"] = { head: "e".repeat(40), checks: "SUCCESS" };
  outcomes.length = 0;
  await merge("k-00000000000000b3", [{ repo: "acme/aidenhq", number: 6, head }]);
  await handle.stepMerges();
  await settle();
  assert.equal(github.merges().length, 1);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /head moved since the merge was approved/);
});

test("a UI head waiting on its design review gets the UI Reviewer's task beside its checks, asked once more past its time", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING", files: ["web/app.css"] } };
  const tasks = [];
  const checks = (method, url, b) => method === "POST" && url === "/v1/tasks" ? (tasks.push(b), { id: `t${tasks.length}`, identifier: `T-${tasks.length}` }) : undefined;
  const { handle, github, outcomes, merge, settle, clock } = await setup(t, { prs, checks });
  await merge("k-00000000000000d1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await handle.stepMerges();
  assert.deepEqual(tasks.map((x) => [x.role, x.source]), [["design-review", `design-review:acme-agents/widget/1@${HEAD}`]], "asked once for the head, while its checks still run");
  prs["acme-agents/widget"].checks = "SUCCESS";
  await handle.stepMerges();
  clock.t += 121 * 60_000;
  await handle.stepMerges();
  assert.equal(tasks[1]?.source, `design-review:acme-agents/widget/1@${HEAD}#again`, "no verdict in time: asked once more");
  assert.deepEqual(github.merges(), [], "never merged without the design review's pass");
  assert.equal(outcomes.length, 0);
  clock.t += 121 * 60_000;
  await handle.stepMerges();
  assert.equal(github.merges().length, 1, "still no verdict after the second ask: the design review is advisory for this head");
  await settle();
});

test("a merge-queue wait and its end become waiting and resumed facts with the reason", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "PENDING" } };
  const facts = [];
  const cacheDir = mkdtempSync(join(tmpdir(), "codehost-flow-"));
  writeFileSync(join(cacheDir, "pr-tasks.json"), JSON.stringify({ "https://github.com/acme-agents/widget/pull/1": { task: "WOR-9", branch: "feature" } }));
  const { handle, merge, settle, clock } = await setup(t, { prs, cacheDir, checks: (m, u, b) => (u === "/v1/facts" ? (facts.push(...b.facts), { recorded: b.facts.length }) : undefined) });
  await merge("k-00000000000000f1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await handle.flushFacts();
  const waiting = facts.find((f) => f.type === "work.waiting");
  assert.deepEqual([waiting.subject, waiting.task, waiting.data], ["pr:acme-agents/widget#1", "WOR-9", { reason: "checks" }]);
  assert.equal(facts.some((f) => f.type === "work.resumed"), false, "still waiting");
  clock.t += 60_000;
  prs["acme-agents/widget"].checks = "SUCCESS";
  await handle.stepMerges();
  await settle();
  await handle.flushFacts();
  const resumed = facts.find((f) => f.type === "work.resumed");
  assert.deepEqual([resumed.version, resumed.data], [waiting.version, { reason: "checks" }], "the end pairs with its wait by version");
  assert.deepEqual(facts.filter((f) => f.type === "pr.merged").map((f) => [f.task, f.data.head]), [["WOR-9", HEAD]]);
  assert.deepEqual(facts.filter((f) => f.type === "pr.checks_completed").map((f) => [f.subject, f.data.conclusion]), [[`pr:acme-agents/widget#1@${HEAD}`, "success"]]);
});

test("a merge call that times out after GitHub merged is reported merged, and an outcome the kernel didn't take is delivered again", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  let timeouts = 1;
  const gh = async (m, p, b) => {
    const r = await github.gh(m, p, b);
    const pull = r.body?.data?.repository?.pullRequest;
    if (pull?.state === "MERGED") pull.mergeCommit = { oid: "c".repeat(40) };
    if (m === "PUT" && timeouts-- > 0) throw new Error("The operation was aborted due to timeout");
    return r;
  };
  const reports = [];
  let refuse = 1;
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-")), gh, fleetOrg: "acme-agents",
    reviewGate: async () => undefined, report: async (id, o) => { reports.push({ id, ...o }); if (refuse-- > 0) throw new Error("the kernel answered 503"); },
  });
  void merges.enqueue("k-00000000000000e1", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  await merges.step(); // the PUT times out, though GitHub merged
  assert.equal(merges.status("k-00000000000000e1").state, "running", "an unanswered merge call is no refusal");
  await merges.step(); // the re-poll sees it merged at its head
  const tick = () => new Promise((r) => setTimeout(r, 20));
  await tick();
  assert.equal(merges.status("k-00000000000000e1").state, "done");
  assert.match(reports[0].text, /^merged-prs: \[\{"repo":"acme-agents\/widget","number":1/, "listed as merged by this queue");
  await merges.step(); // the kernel refused the first delivery: delivered again
  await tick();
  assert.equal(reports.length, 2);
  await merges.step();
  await tick();
  assert.equal(reports.length, 2, "taken: not delivered a third time");
});

test("a red default branch takes no merge on top, except the PR that already holds its tip; running base CI is no wait", () => {
  const data = (base, behindBy) => ({ repository: { defaultBranchRef: { name: "main" }, pullRequest: {
    number: 1, state: "OPEN", isDraft: false, baseRefName: "main", headRefOid: HEAD, mergeStateStatus: "CLEAN", latestOpinionatedReviews: { nodes: [] },
    files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "lib/x.mjs" }] }, commits: { nodes: [{ commit: { statusCheckRollup: rollup("SUCCESS") } }] },
    baseRef: { compare: { behindBy }, target: { oid: "b".repeat(40), statusCheckRollup: base } },
  } } });
  assert.deepEqual(decide(data(rollup("FAILURE"), 2), HEAD, { uiReview: false }), { do: "wait", why: "`main` is red at `bbbbbbbbbbbb`: merged once it is green again" });
  assert.deepEqual(decide(data(rollup("FAILURE"), 0), HEAD, { uiReview: false }), { do: "merge" }, "the fix for a red base lands");
  assert.deepEqual(decide(data(rollup("PENDING"), 2), HEAD, { uiReview: false }), { do: "merge" }, "the PR's own green checks proved it");
  assert.deepEqual(decide(data(rollup("CANCELLED", { names: ["build", "ci-required"] }), 2), HEAD, { uiReview: false }), { do: "merge" }, "a cancelled run never judged the base");
  assert.deepEqual(decide(data(rollup("SUCCESS"), 2), HEAD, { uiReview: false }), { do: "merge" });
  assert.deepEqual(decide(data(rollup("SUCCESS", { names: [] }), 2), HEAD, { uiReview: false }), { do: "merge" }, "a base whose CI runs on PRs only");
});

test("a maintained repo merges as the owner; once it leaves maintainer_repos its approved merge is refused at queue time", async () => {
  const prs = { "globex/payments": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const dir = mkdtempSync(join(tmpdir(), "merges-"));
  const reports = [];
  const queue = (maintained) => createMerges({
    dir, gh: github.gh, fleetOrg: "acme-agents", productRepo: "acme/aidenhq", maintained,
    reviewGate: async () => undefined, report: async (id, o) => void reports.push({ id, ...o }),
  });
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const listed = queue(["Globex/Payments"]);
  void listed.enqueue("k-00000000000000f1", { prs: [{ repo: "globex/payments", number: 1, head: HEAD }] });
  await listed.step();
  await tick();
  assert.deepEqual(github.merges().map((w) => [w.path, w.body.sha]), [["/repos/globex/payments/pulls/1/merge", HEAD]]);
  assert.equal(listed.status("k-00000000000000f1").state, "done");

  // Approved while listed, then the owner took the repo off the list (the service restarts with the new setting).
  prs["globex/payments"] = { head: HEAD, checks: "SUCCESS" };
  void listed.enqueue("k-00000000000000f2", { prs: [{ repo: "globex/payments", number: 2, head: HEAD }] });
  const unlisted = queue([]);
  await unlisted.step();
  await tick();
  assert.equal(github.merges().length, 1, "not merged");
  assert.equal(unlisted.status("k-00000000000000f2").state, "failed");
  assert.match(reports.find((r) => r.id === "k-00000000000000f2").text, /outside the fleet org, the product repo and maintainer_repos/);
});

test("merge queue waits while disconnected", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" } };
  const facts = [];
  const connected = { on: false };
  const { handle, github, merge, settle, outcomes } = await setup(t, { prs, connected, checks: (m, u, b) => (u === "/v1/facts" ? (facts.push(...b.facts), { recorded: b.facts.length }) : undefined) });
  await merge("k-00000000000000b9", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await handle.flushFacts();
  assert.deepEqual(github.merges(), [], "nothing merges while GitHub is signed out");
  assert.deepEqual(facts.filter((f) => f.type === "work.waiting").map((f) => [f.subject, f.data.reason]), [["pr:acme-agents/widget#1", "github"]]);
  connected.on = true;
  await handle.stepMerges();
  assert.equal(github.merges().length, 1, "merged once connected again");
  await settle();
  await handle.flushFacts();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.deepEqual(facts.filter((f) => f.type === "work.resumed").map((f) => f.data.reason), ["github"]);
});

test("a repo code review gates merges only on its pass for the bound head; a wait keeps the merge queued with no time limit; unreachable over 10 minutes lets it go, recorded; other repos never ask", async () => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" }, "acme-agents/other": { head: HEAD, checks: "SUCCESS" } };
  const github = fakeGitHub(prs);
  const asked = [];
  let answer = { status: 200, body: { verdict: "wait", reasons: [{ code: "findings", text: "1 important finding open: t (a.ts:3)", unblock: "fix and push" }] } };
  const fetchFn = async (url, init) => {
    asked.push([String(url), init.headers.authorization]);
    if (answer === "down") throw new Error("connect ECONNREFUSED");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const clock = { t: Date.now() };
  const logs = [], bypassed = [];
  const merges = createMerges({
    dir: mkdtempSync(join(tmpdir(), "merges-")), gh: github.gh, fleetOrg: "acme-agents", now: () => new Date(clock.t),
    report: async () => {}, log: (msg, f) => logs.push([msg, f]),
    flow: { reviewBypassed: (...a) => bypassed.push(a), checksCompleted: () => {}, waiting: () => {}, resumed: () => {}, merged: () => {} },
    reviewGate: createReviewGate({ gated: ["Acme-Agents/Widget"], url: "http://code-review:8098", key: () => "github-module-token", fetchFn, now: () => clock.t }),
  });
  void merges.enqueue("k-00000000000000g1", { prs: [{ repo: "acme-agents/widget", number: 1, head: HEAD }] });
  void merges.enqueue("k-00000000000000g2", { prs: [{ repo: "acme-agents/other", number: 2, head: HEAD }] });
  await merges.step();
  assert.deepEqual(asked, [[`http://code-review:8098/v1/verdict?repo=acme-agents%2Fwidget&pr=1&head=${HEAD}`, "Bearer github-module-token"]], "only the gated repo asks");
  assert.deepEqual(github.merges().map((w) => w.path), ["/repos/acme-agents/other/pulls/2/merge"]);
  assert.match(logs.find(([m]) => m === "merge waits for code review")[1].why, /1 important finding open: t \(a\.ts:3\) \(fix and push\)/);
  clock.t += 7 * 24 * 3600_000; // a week of waiting on findings: still waiting
  await merges.step();
  assert.equal(merges.status("k-00000000000000g1").state, "running");
  answer = "down"; // the service goes down: a wait, until it has been down over 10 minutes
  await merges.step();
  clock.t += 9 * 60_000;
  await merges.step();
  assert.equal(github.merges().length, 1);
  clock.t += 2 * 60_000;
  await merges.step();
  assert.deepEqual(github.merges().map((w) => [w.path, w.body.sha]), [["/repos/acme-agents/other/pulls/2/merge", HEAD], ["/repos/acme-agents/widget/pulls/1/merge", HEAD]]);
  assert.deepEqual(bypassed.map(([repo, n, head]) => [repo, n, head]), [["acme-agents/widget", 1, HEAD]], "recorded as pr.review_bypassed");
});
