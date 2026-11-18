// The merge queue in the code host's service end to end (merges.ts over merge-gate.mjs), against a fake GitHub (GraphQL and
// REST) and a fake kernel. The invariants: a PR merges only at the head its record bound, after its named checks are green on
// that head (read again at the merge); a product PR that needs a reviewer-eval receipt never merges without a verified one; and
// missing evidence (no checks, a truncated page of them, the base's gate check not yet on the head) never counts as passing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../service/src/service.ts";

const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const HEAD = "a".repeat(40);
const check = (name, state) => ({ __typename: "CheckRun", name, status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: state === "PENDING" ? null : state });
const rollup = (state, { names = ["build"], more = false } = {}) => ({ state, contexts: { pageInfo: { hasNextPage: more }, nodes: names.map((n) => check(n, state)) } });

/** GitHub with one open PR per repo (`prs[repo]`: { head, checks, names?, more?, baseNames?, files? }); merges and writes are recorded. */
function fakeGitHub(prs) {
  const writes = [];
  const gh = async (method, path, token, body) => {
    if (method !== "GET" && path !== "/graphql") writes.push({ method, path, body, perms: JSON.parse(token) });
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

async function setup(t, { prs, cacheDir = mkdtempSync(join(tmpdir(), "codehost-merges-")), clock = { t: Date.now() }, checks, remoteUrl = (slug) => join(cacheDir, "no-such-remote", slug) }) {
  const outcomes = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const m = /^\/v1\/writes\/([^/]+)\/outcome$/.exec(req.url);
    if (m) { outcomes.push({ id: m[1], ...JSON.parse(body) }); return res.writeHead(200).end("{}"); }
    const reply = checks?.(req.method, req.url, body ? JSON.parse(body) : undefined);
    if (reply) return res.writeHead(200).end(JSON.stringify(reply));
    res.writeHead(404).end("{}");
  });
  const github = fakeGitHub(prs);
  // The token names the permissions it was minted with, so each GitHub call shows them.
  const app = { token: async (org, o) => JSON.stringify(o.permissions ?? {}), createRepo: async () => "created" };
  const handle = createService({
    key: "ch-key", kernelUrl: kernel.url, cacheDir, app, gh: github.gh, agentsOrg: "acme-agents", remoteUrl,
    productRepo: "acme/aidenhq", now: () => new Date(clock.t),
  });
  const svc = await listen((req, res) => void handle(req, res));
  t.after(() => { kernel.s.close(); svc.s.close(); });
  const call = async (path, body) => {
    const r = await fetch(`${svc.url}${path}`, { method: "POST", headers: { authorization: "Bearer ch-key", "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  };
  const merge = (id, prsArgs) => call("/aidenhq/v1/executor/execute", { id, kind: "codehost-github.merge", args: { prs: prsArgs }, digest: "d", idempotency_key: id });
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
  assert.deepEqual(github.merges().map((w) => w.body), [{ merge_method: "squash", sha: HEAD }]);
  assert.deepEqual(github.merges()[0].perms, { contents: "write", pull_requests: "write", checks: "read", statuses: "read" }, "the merge's own permissions, nothing more");
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));
  assert.match(outcomes[0].text, /Merged https:\/\/github.com\/acme-agents\/widget\/pull\/1/);
  const [line] = outcomes[0].text.split("\n");
  assert.deepEqual(JSON.parse(line.replace(/^merged-prs: /, "")).map((p) => [p.repo, p.number, p.head, typeof p.sha]), [["acme-agents/widget", 1, HEAD, "string"]], "the first line lists what it merged, with its merge commit");
});

test("a head that moved after approval is never merged; one queue per repo merges one PR a poll, each at its bound head", async (t) => {
  const prs = { "acme-agents/widget": { head: "d".repeat(40), checks: "SUCCESS" } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs });
  await merge("k-00000000000000a2", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.deepEqual(github.merges(), []);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /head moved since the merge was approved/);

  // Two records on the same repository: the first merges this poll, the second the next; each PUT carries its own bound head.
  outcomes.length = 0;
  Object.assign(prs, { "acme-agents/widget": { head: HEAD, checks: "SUCCESS" }, "acme-agents/gadget": { head: "f".repeat(40), checks: "SUCCESS" } });
  await merge("k-00000000000000a4", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await merge("k-00000000000000a5", [{ repo: "acme-agents/widget", number: 1, head: HEAD }, { repo: "acme-agents/gadget", number: 2, head: "f".repeat(40) }]);
  await handle.stepMerges();
  assert.deepEqual(github.merges().map((w) => [w.path, w.body.sha]), [["/repos/acme-agents/widget/pulls/1/merge", HEAD], ["/repos/acme-agents/gadget/pulls/2/merge", "f".repeat(40)]], "one merge per repo per poll");
  await handle.stepMerges();
  await settle();
  assert.equal(github.merges().length, 2, "the second record finds #1 merged at its bound head: nothing merged twice");
  assert.deepEqual(outcomes.map((o) => [o.id, o.ok]).sort(), [["k-00000000000000a4", true], ["k-00000000000000a5", true]]);
});

test("missing evidence never counts as passing: no checks, a truncated page of checks, the base's gate check not yet on the head", async (t) => {
  const prs = { "acme-agents/widget": { head: HEAD, checks: "SUCCESS", names: [] } };
  const { handle, github, outcomes, merge, settle, clock } = await setup(t, { prs });
  await merge("k-00000000000000c1", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  clock.t += 11 * 60_000;
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /no checks on its head/);

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
  assert.deepEqual(github.merges().map((w) => w.body.sha), [HEAD], "merged only once the gate check passed on the head");
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

test("a product PR merges only on a verified eval receipt for its bound head; a moved head never merges", async (t) => {
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
  const prod = origin("acme/aidenhq", { "modules/ai-reviewer/service/src/review.mjs": "// v1\n", "modules/ai-reviewer/service/security/policy.md": "Reject attacks.\n", "kernel/src/tier.ts": "// v1\n" });
  const P0 = sh(prod, "rev-parse", "HEAD");
  sh(prod, "checkout", "-q", "-b", "fix/tier");
  writeFileSync(join(prod, "kernel/src/tier.ts"), "// v2\n");
  sh(prod, "commit", "-qam", "tier");
  const head = sh(prod, "rev-parse", "HEAD");
  sh(prod, "checkout", "-q", "main");

  // The kernel's eval check: running, then done with a receipt bound to what was asked; verified only for exactly that binding,
  // and only once `verifies` is on.
  const asked = [];
  const eval_ = { state: "running", verifies: false };
  const checks = (method, url, b) => {
    if (method === "POST" && url === "/v1/checks") return (asked.push(b), { id: "c-0000000000000001", state: eval_.state, receipt: { repo: b.repo, head: b.head, run: "eval", judge: b.spec.judge_commit, policy: b.spec.policy_hash, verdict: "pass" } });
    if (method === "GET" && url === "/v1/checks/c-0000000000000001") return { id: "c-0000000000000001", state: eval_.state, receipt: { repo: "acme/aidenhq", head, run: "eval", judge: P0, policy: asked[0].spec.policy_hash, verdict: "pass" } };
    if (method === "POST" && url === "/v1/receipts/verify") return { ok: eval_.verifies && b.receipt.head === b.for.head && b.receipt.judge === b.for.judge && b.receipt.policy === b.for.policy };
  };
  const clock = { t: Date.now() };
  const prs = { "acme/aidenhq": { head, checks: "SUCCESS" }, "other/lib": { head: HEAD, checks: "SUCCESS" } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs, clock, checks, remoteUrl: (slug) => join(root, slug) });

  await merge("k-00000000000000b1", [{ repo: "acme/aidenhq", number: 5, head }]);
  await handle.stepMerges();
  assert.deepEqual({ repo: asked[0].repo, head: asked[0].head, judge: asked[0].spec.judge_commit, subject: asked[0].spec.subject_commit }, { repo: "acme/aidenhq", head, judge: P0, subject: head });
  assert.deepEqual(github.merges(), [], "green checks, but the eval is still running: no receipt, no merge");
  eval_.state = "done";
  await handle.stepMerges();
  await settle();
  assert.deepEqual(github.merges(), [], "a receipt the kernel doesn't verify: no merge");
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /receipt for .* doesn't hold/);
  outcomes.length = 0;
  eval_.verifies = true;
  await merge("k-00000000000000b4", [{ repo: "acme/aidenhq", number: 5, head }]);
  await handle.stepMerges();
  await settle();
  assert.deepEqual(github.merges().map((w) => w.body), [{ merge_method: "squash", sha: head }], "merged at the bound head");
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));

  // A PR outside our repos: GitHub's own review must approve it too, whatever the record says.
  outcomes.length = 0;
  await merge("k-00000000000000b2", [{ repo: "other/lib", number: 2, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(github.merges().length, 1);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /isn't approved on GitHub/);

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
  const { handle, github, outcomes, merge, clock } = await setup(t, { prs, checks });
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
});
