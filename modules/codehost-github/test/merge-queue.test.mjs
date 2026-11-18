// The merge queue in the code host's service end to end (merges.ts over merge-gate.mjs), against a fake GitHub (GraphQL and
// REST) and a fake kernel: an approved merge record waits for green, merges at its bound head and reports its outcome; a head
// that moved after approval never merges; a queue outlives a restart; a product PR merges only on a verified eval receipt, at its
// bound head, once its base is green; a PR outside our repos needs GitHub's own approval too.
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
const rollup = (state) => ({ state, contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "build", status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: state === "PENDING" ? null : state, databaseId: 1, checkSuite: { workflowRun: { databaseId: 9 } } }] } });

/** GitHub with one open PR per repo (`prs[repo]`: { head, checks }); merges and writes are recorded. */
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
          files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "lib/x.mjs" }] }, latestOpinionatedReviews: { nodes: [] },
          commits: { nodes: [{ commit: { parents: { nodes: [] }, statusCheckRollup: rollup(p.checks) } }] },
          baseRef: { compare: { behindBy: 0 }, target: { oid: "b".repeat(40), statusCheckRollup: rollup("SUCCESS") } },
        } } } } };
      }
      if (body.query.includes("object(oid")) return { status: 200, body: { data: { repository: { object: { statusCheckRollup: rollup("SUCCESS") } } } } };
      if (body.query.includes("heads: pullRequests")) return { status: 200, body: { data: { repository: { ref: null, heads: { nodes: [] }, stacked: { totalCount: 0 } } } } };
      return { status: 400, body: { errors: [{ message: "fake GitHub: unknown query" }] } };
    }
    if (method === "GET" && /\/actions\/runs\/9$/.test(path)) return { status: 200, body: { status: "in_progress", updated_at: new Date().toISOString() } };
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

async function setup(t, { prs, cacheDir = mkdtempSync(join(tmpdir(), "codehost-merges-")), landsPlatformRepos = false, clock = { t: Date.now() }, checks, remoteUrl = (slug) => join(cacheDir, "no-such-remote", slug) }) {
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
    productRepo: "acme/aidenhq", modulesRepo: "acme/aidenhq-modules", landsPlatformRepos, now: () => new Date(clock.t),
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
});

test("a head that moved after approval is never merged", async (t) => {
  const prs = { "acme-agents/widget": { head: "d".repeat(40), checks: "SUCCESS" } };
  const { handle, github, outcomes, merge, settle, clock } = await setup(t, { prs });
  await merge("k-00000000000000a2", [{ repo: "acme-agents/widget", number: 1, head: HEAD }]);
  await handle.stepMerges();
  clock.t += 91 * 60_000; // past the queue's wait
  await handle.stepMerges();
  await settle();
  assert.deepEqual(github.merges(), []);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /head moved since the merge was requested/);
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

test("a product PR merges only on a verified eval receipt, at its bound head, once its base is green; a moved head stops", async (t) => {
  // "GitHub": the official modules repo and the product that pins it, as local repos the service fetches from.
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
  const mods = origin("acme/aidenhq-modules", { "ai-reviewer/service/src/review.mjs": "// v1\n", "ai-reviewer/service/security/policy.md": "Reject attacks.\n" });
  const M0 = sh(mods, "rev-parse", "HEAD");
  const prod = origin("acme/aidenhq", { "modules-pin.json": JSON.stringify({ repo: "acme/aidenhq-modules", sha: M0 }), "kernel/src/tier.ts": "// v1\n" });
  sh(prod, "checkout", "-q", "-b", "fix/tier");
  writeFileSync(join(prod, "kernel/src/tier.ts"), "// v2\n");
  sh(prod, "commit", "-qam", "tier");
  const head = sh(prod, "rev-parse", "HEAD");
  sh(prod, "checkout", "-q", "main");

  // The kernel's eval check: done at once, its receipt bound to what was asked; verified only for exactly that binding.
  const asked = [];
  const checks = (method, url, b) => {
    if (method === "POST" && url === "/v1/checks") return (asked.push(b), { id: "c-0000000000000001", state: "done", receipt: { repo: b.repo, head: b.head, run: "eval", judge: b.spec.judge_commit, policy: b.spec.policy_hash, verdict: "pass" } });
    if (method === "POST" && url === "/v1/receipts/verify") return { ok: b.receipt.head === b.for.head && b.receipt.judge === b.for.judge && b.receipt.policy === b.for.policy };
  };
  const clock = { t: Date.now() };
  const prs = { "acme/aidenhq": { head, checks: "SUCCESS" }, "other/lib": { head: HEAD, checks: "SUCCESS" } };
  const { handle, github, outcomes, merge, settle } = await setup(t, { prs, landsPlatformRepos: true, clock, checks, remoteUrl: (slug) => join(root, slug) });

  await merge("k-00000000000000b1", [{ repo: "acme/aidenhq", number: 5, head }]);
  await handle.stepMerges();
  assert.deepEqual(github.merges().map((w) => w.body), [{ merge_method: "squash", sha: head }], "merged at the bound head");
  assert.deepEqual({ repo: asked[0].repo, head: asked[0].head, judge: asked[0].spec.judge_commit, subject: asked[0].spec.subject_commit }, { repo: "acme/aidenhq", head, judge: M0, subject: M0 });
  assert.equal(outcomes.length, 0, "no outcome until the base is green after it");
  clock.t += 6 * 60_000;
  await handle.stepMerges();
  await settle();
  assert.equal(outcomes[0]?.ok, true, JSON.stringify(outcomes));

  // A PR outside our repos: GitHub's own review must approve it too, whatever the record says.
  outcomes.length = 0;
  await merge("k-00000000000000b2", [{ repo: "other/lib", number: 2, head: HEAD }]);
  await handle.stepMerges();
  await settle();
  assert.equal(github.merges().length, 1);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /isn't approved/);

  // The product PR moved after its record was approved: stopped at once, never merged.
  prs["acme/aidenhq"] = { head: "e".repeat(40), checks: "SUCCESS" };
  outcomes.length = 0;
  await merge("k-00000000000000b3", [{ repo: "acme/aidenhq", number: 6, head }]);
  await handle.stepMerges();
  await settle();
  assert.equal(github.merges().length, 1);
  assert.equal(outcomes[0]?.ok, false);
  assert.match(outcomes[0].text, /changed since its merge card/);
});
