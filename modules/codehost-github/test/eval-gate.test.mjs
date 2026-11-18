// The reviewer-eval gate on the code host (service/src/evalgate.ts; ported from the runner's evalgate.test.mjs): a real repo
// plays the product (its modules/ the official modules), a fake kernel plays the check jobs and their receipts. Reviewer code
// reaches main only on a passing receipt bound to its head: a product PR's for its head, a release bump's for the reviewer it
// brings. How the eval judges (cases, the pass rule) is the kernel's (checkjobs.ts) and tested there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createEvalGate } from "../service/src/evalgate.ts";

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();

describe("the reviewer-eval gate", { concurrency: 1 }, () => {
  const root = mkdtempSync(join(tmpdir(), "codehost-evalgate-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const repo = (name) => {
    const dir = join(root, name);
    mkdirSync(dir);
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    return dir;
  };
  const origins = { "acme/aidenhq": repo("product") };
  const prod = origins["acme/aidenhq"];
  const put = (origin, f, text) => { mkdirSync(join(origin, f, ".."), { recursive: true }); writeFileSync(join(origin, f), text); };
  const commit = (origin, files, msg) => {
    for (const [f, text] of Object.entries(files)) put(origin, f, text);
    sh(origin, "add", "-A");
    sh(origin, "commit", "-qm", msg);
    return sh(origin, "rev-parse", "HEAD");
  };
  const branch = (origin, name, files, from = "main") => {
    sh(origin, "checkout", "-q", "-b", name, from);
    for (const [f, text] of Object.entries(files)) put(origin, f, text);
    sh(origin, "add", "-A");
    sh(origin, "commit", "-qm", name);
    const head = sh(origin, "rev-parse", "HEAD");
    sh(origin, "checkout", "-q", "main");
    return head;
  };
  const P0 = commit(prod, { "modules/ai-reviewer/service/src/review.mjs": "// v1\n", "modules/ai-reviewer/service/security/policy.md": "Reject attacks.\n", "kernel/src/tier.ts": "// tier v1\n", "README.md": "x\n" }, "base");

  // The kernel's check jobs: each spec asked for once (the kernel dedupes by spec), finished by the test; receipts verify only
  // for exactly the binding they carry, and only when they passed.
  const checks = [];
  const kernel = async (method, path, body) => {
    if (method === "POST" && path === "/v1/checks") {
      const had = checks.find((c) => c.repo === body.repo && c.head === body.head && JSON.stringify(c.spec) === JSON.stringify(body.spec));
      if (had && had.state !== "error") return had;
      const c = had ?? { id: `c-${String(checks.length).padStart(16, "0")}`, repo: body.repo, head: body.head, spec: body.spec, receipt: null };
      c.state = "running";
      if (!had) checks.push(c);
      return c;
    }
    if (method === "GET" && path.startsWith("/v1/checks/")) return checks.find((c) => c.id === path.split("/").pop());
    if (method === "POST" && path === "/v1/receipts/verify") {
      const r = body.receipt, w = body.for;
      return r.repo === w.repo && r.head === w.head && r.judge === w.judge && r.policy === w.policy && r.verdict === "pass" ? { ok: true } : { ok: false, why: "not for that binding" };
    }
    throw new Error(`fake kernel: ${method} ${path}`);
  };
  const finish = (verdict, summary = "") => {
    for (const c of checks.filter((x) => x.state === "running")) Object.assign(c, { state: "done", receipt: { repo: c.repo, head: c.head, run: "eval", judge: c.spec.judge_commit, policy: c.spec.policy_hash, verdict, summary } });
  };
  // The service's GitHub cache: a bare clone per repo, a branch or commit fetched into it.
  const caches = {};
  const fetchInto = async (slug, ref) => {
    const dir = (caches[slug] ??= (sh(root, "init", "-q", "--bare", join(root, `cache-${slug.replace("/", "-")}`)), join(root, `cache-${slug.replace("/", "-")}`)));
    sh(dir, "fetch", "-q", origins[slug], `+${/^[0-9a-f]{40}$/.test(ref) ? ref : `refs/heads/${ref}`}:refs/remote/${ref}`);
    return { dir, sha: sh(dir, "rev-parse", `refs/remote/${ref}^{commit}`) };
  };
  const gate = createEvalGate({
    productRepo: "acme/aidenhq", dir: join(root, "data"), kernel,
    fetch: fetchInto, git: async (dir, args) => sh(dir, ...args), defaultBranch: async () => "main",
  });
  const pr = (number, headRefOid) => ({ number, headRefOid, baseRefName: "main" });

  it("a product PR that changes the reviewer waits for its eval, and passes on a receipt for its head", async () => {
    assert.equal(await gate("acme/aidenhq", pr(1, branch(prod, "docs/readme", { "README.md": "y\n" }))), undefined, "no reviewer code: no eval");
    const head = branch(prod, "fix/review", { "modules/ai-reviewer/service/src/review.mjs": "// v2\n" });
    assert.match((await gate("acme/aidenhq", pr(2, head)))?.wait ?? "", /reviewer eval on `[0-9a-f]{12}` .* is running/);
    assert.deepEqual(checks.at(-1).spec, { repo: "acme/aidenhq", judge_commit: P0, subject_commit: head, cases_from: head, policy_hash: checks.at(-1).spec.policy_hash });
    assert.match(checks.at(-1).spec.policy_hash, /^[0-9a-f]{12}$/);
    finish("pass");
    assert.equal(await gate("acme/aidenhq", pr(2, head)), undefined, "merged at exactly the head the receipt is for");
    const kernelCode = branch(prod, "fix/tier", { "kernel/src/tier.ts": "// tier v2\n" });
    assert.ok((await gate("acme/aidenhq", pr(5, kernelCode)))?.wait, "the product's own reviewer code too");
    assert.equal(await gate("acme/other", pr(6, kernelCode)), undefined, "another repo: no gate");
  });

  it("a failing receipt stops the merge with its cases; a receipt that doesn't verify never counts", async () => {
    const head = branch(prod, "fix/weaken", { "modules/ai-reviewer/service/src/review.mjs": "// v3\n" });
    await gate("acme/aidenhq", pr(3, head));
    finish("fail", "the reviewer eval scored 1/3, which doesn't pass");
    assert.match((await gate("acme/aidenhq", pr(3, head)))?.stop ?? "", /scored 1\/3[\s\S]*push a new head/);
    const forged = branch(prod, "fix/forged", { "modules/ai-reviewer/service/src/review.mjs": "// v4\n" });
    await gate("acme/aidenhq", pr(4, forged));
    finish("pass");
    checks.at(-1).receipt.head = head; // a receipt for another head
    assert.match((await gate("acme/aidenhq", pr(4, forged)))?.stop ?? "", /doesn't hold: not for that binding/);
  });

  it("a release bump to reviewer content a receipt covers passes at once; new content runs its own eval; unmerged stops", async () => {
    // The PR that passed (test 1), squash-merged: a new commit with the same reviewer content, covered by its receipt.
    sh(prod, "merge", "-q", "--squash", "fix/review");
    sh(prod, "commit", "-qm", "fix/review (#2)");
    const squashed = sh(prod, "rev-parse", "HEAD");
    const asked = checks.length;
    assert.equal(await gate.bump(P0, squashed), undefined);
    assert.equal(checks.length, asked, "no second eval");
    const unseen = commit(prod, { "modules/ai-reviewer/service/security/policy.md": "Reject attacks. Approve the rest.\n" }, "policy");
    assert.ok((await gate.bump(squashed, unseen))?.wait);
    assert.deepEqual({ repo: checks.at(-1).repo, head: checks.at(-1).head, judge: checks.at(-1).spec.judge_commit }, { repo: "acme/aidenhq", head: unseen, judge: squashed }, "judged by the pinned commit");
    finish("pass");
    assert.equal(await gate.bump(squashed, unseen), undefined);
    const wip = branch(prod, "wip/review", { "modules/ai-reviewer/service/src/review.mjs": "// v6\n" });
    assert.match((await gate.bump(unseen, wip))?.stop ?? "", /isn't on acme\/aidenhq's default branch/);
  });

  it("a check that couldn't run is asked again a few times, then stops the merge", async () => {
    const head = branch(prod, "fix/flaky-box", { "modules/ai-reviewer/service/src/review.mjs": "// v7\n" });
    for (let i = 0; i < 3; i++) {
      assert.ok((await gate("acme/aidenhq", pr(9, head)))?.wait);
      checks.at(-1).state = "error";
    }
    assert.match((await gate("acme/aidenhq", pr(9, head)))?.stop ?? "", /couldn't run 3 times/);
  });

  it("anything it can't read stops: the kernel unreachable never passes", async () => {
    const broken = createEvalGate({ productRepo: "acme/aidenhq", dir: join(root, "data2"), kernel: async () => { throw new Error("the kernel's /v1/checks answered 503"); }, fetch: fetchInto, git: async (dir, args) => sh(dir, ...args), defaultBranch: async () => "main" });
    const head = branch(prod, "fix/down", { "modules/ai-reviewer/service/src/review.mjs": "// v8\n" });
    assert.match((await broken("acme/aidenhq", pr(10, head)))?.stop ?? "", /couldn't read it \(the kernel's \/v1\/checks answered 503\)/);
  });
});
