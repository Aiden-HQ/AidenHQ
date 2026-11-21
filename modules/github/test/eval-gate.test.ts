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
import { REVIEWER_CODE, createEvalGate, touchesReviewer } from "../service/src/evalgate.ts";
import checklist from "../../ai-reviewer/service/security/checklist.json" with { type: "json" };

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
  const P0 = commit(prod, { "modules/ai-reviewer/service/src/review.ts": "// v1\n", "modules/ai-reviewer/service/security/policy.md": "Reject attacks.\n", "kernel/src/tier.ts": "// tier v1\n", "README.md": "x\n" }, "base");

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
    const head = branch(prod, "fix/review", { "modules/ai-reviewer/service/src/review.ts": "// v2\n" });
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
    const head = branch(prod, "fix/weaken", { "modules/ai-reviewer/service/src/review.ts": "// v3\n" });
    await gate("acme/aidenhq", pr(3, head));
    finish("fail", "the reviewer eval scored 1/3, which doesn't pass");
    assert.match((await gate("acme/aidenhq", pr(3, head)))?.stop ?? "", /scored 1\/3[\s\S]*push a new head/);
    const forged = branch(prod, "fix/forged", { "modules/ai-reviewer/service/src/review.ts": "// v4\n" });
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
    const wip = branch(prod, "wip/review", { "modules/ai-reviewer/service/src/review.ts": "// v6\n" });
    assert.match((await gate.bump(unseen, wip))?.stop ?? "", /isn't on acme\/aidenhq's default branch/);
  });

  it("a check that couldn't run is asked again with backoff, and never stops the merge", async () => {
    const head = branch(prod, "fix/flaky-box", { "modules/ai-reviewer/service/src/review.ts": "// v7\n" });
    assert.ok((await gate("acme/aidenhq", pr(9, head)))?.wait);
    checks.at(-1).state = "error";
    const asked = checks.length;
    for (let i = 0; i < 5; i++) assert.match((await gate("acme/aidenhq", pr(9, head)))?.wait ?? "", /couldn't run.*asking again at/);
    assert.equal(checks.length, asked, "not asked again before its backoff ends");
  });

  it("a check the kernel lost at a restart never counts as couldn't run", async () => {
    const head = branch(prod, "fix/restarts", { "modules/ai-reviewer/service/src/review.ts": "// v7b\n" });
    assert.ok((await gate("acme/aidenhq", pr(12, head)))?.wait);
    for (let i = 0; i < 5; i++) {
      checks.at(-1).state = "lost";
      assert.ok((await gate("acme/aidenhq", pr(12, head)))?.wait, `restart ${i + 1}`);
    }
  });

  it("a PR is judged by the base's tip; main moving without changing what judges keeps its eval, a judging change runs it again", async () => {
    const old = sh(prod, "rev-parse", "main");
    const head = branch(prod, "fix/old-base", { "modules/ai-reviewer/service/src/review.ts": "// v9\n" }, old);
    const tip = commit(prod, { "README.md": "moved\n" }, "main moves");
    assert.ok((await gate("acme/aidenhq", pr(11, head)))?.wait);
    assert.equal(checks.at(-1).spec.judge_commit, tip, "judged by the tip, not the merge base it chose");
    const asked = checks.length;
    commit(prod, { "README.md": "moved while it runs\n" }, "main moves while it runs");
    assert.ok((await gate("acme/aidenhq", pr(11, head)))?.wait, "the running eval for the same judging content is waited on");
    finish("pass");
    commit(prod, { "README.md": "moved again\n" }, "main moves again");
    assert.equal(await gate("acme/aidenhq", pr(11, head)), undefined, "the earlier receipt holds, verified for the judge it ran with");
    assert.equal(checks.length, asked, "no second eval");
    const cases = commit(prod, { "modules/ai-reviewer/test/reviewer-cases/new.json": "{}\n" }, "a new base case");
    assert.ok((await gate("acme/aidenhq", pr(11, head)))?.wait, "what judges it changed: the eval runs again");
    assert.equal(checks.length, asked + 1);
    assert.equal(checks.at(-1).spec.judge_commit, cases);
  });

  it("a new head with the content of one that passed is covered (a rebase); one that failed is asked again", async () => {
    const tip = sh(prod, "rev-parse", "main");
    const head = branch(prod, "fix/rebased", { "modules/ai-reviewer/service/src/review.ts": "// v10\n" }, tip);
    await gate("acme/aidenhq", pr(13, head));
    finish("pass");
    assert.equal(await gate("acme/aidenhq", pr(13, head)), undefined);
    const asked = checks.length;
    const rebased = branch(prod, "fix/rebased-2", { "modules/ai-reviewer/service/src/review.ts": "// v10\n", "README.md": "rebased\n" }, tip);
    assert.equal(await gate("acme/aidenhq", pr(13, rebased)), undefined, "same reviewer and judging content: no second eval");
    assert.equal(checks.length, asked);
    const tierToo = branch(prod, "fix/rebased-3", { "modules/ai-reviewer/service/src/review.ts": "// v10\n", "kernel/src/tier.ts": "// tier v3\n" }, tip);
    assert.ok((await gate("acme/aidenhq", pr(13, tierToo)))?.wait, "any other REVIEWER_CODE file changed (the tiers): judged again");
    // git quotes a path with a tab in plain ls-tree output: read unquoted, it is in the key like any other.
    const oddName = branch(prod, "fix/rebased-4", { "modules/ai-reviewer/service/src/review.ts": "// v10\n", "modules/ai-reviewer/test/reviewer-cases/odd\tname.json": "{}\n" }, tip);
    assert.ok((await gate("acme/aidenhq", pr(13, oddName)))?.wait, "a gated file with a tab in its name: judged again");
    const failing = branch(prod, "fix/fails", { "modules/ai-reviewer/service/src/review.ts": "// v11\n" }, tip);
    await gate("acme/aidenhq", pr(14, failing));
    finish("fail", "1/3");
    assert.ok((await gate("acme/aidenhq", pr(14, failing)))?.stop);
    const retry = branch(prod, "fix/fails-2", { "modules/ai-reviewer/service/src/review.ts": "// v11\n", "README.md": "retry\n" }, tip);
    assert.ok((await gate("acme/aidenhq", pr(14, retry)))?.wait, "a failed eval is never reused: a new head asks again");
  });

  it("anything it can't read waits and asks again: the kernel unreachable never passes and never stops the merge", async () => {
    const broken = createEvalGate({ productRepo: "acme/aidenhq", dir: join(root, "data2"), kernel: async () => { throw new Error("the kernel's /v1/checks answered 503"); }, fetch: fetchInto, git: async (dir, args) => sh(dir, ...args), defaultBranch: async () => "main" });
    const head = branch(prod, "fix/down", { "modules/ai-reviewer/service/src/review.ts": "// v8\n" });
    const g = await broken("acme/aidenhq", pr(10, head));
    assert.equal(g?.stop, undefined);
    assert.match(g?.wait ?? "", /couldn't read it yet, asking again \(the kernel's \/v1\/checks answered 503\)/);
  });
});

// The check recipes and what wires them to a receipt are reviewer code: a change to one needs an eval receipt.
it("check recipes, their manifests and wiring are reviewer code", () => {
  const paths = ["modules/github/checks/tests.sh", "modules/platform/checks/contract.sh", "modules/github/module.yaml", "modules/platform/module.yaml", "scripts/modules.ts", "kernel/src/checkbox.ts", "kernel/src/checkjobs.ts"];
  assert.deepEqual(paths.filter((p) => !touchesReviewer([p])), []);
});

// The reviewer's checklist tells it a change to these paths is the eval's to judge: true only while each is REVIEWER_CODE.
it("every path the eval-receipt checklist item names is reviewer code", () => {
  const item = checklist.items.find((i) => i.check.includes("100% receipt"));
  const missing = item.trigger.paths.filter((p) => !touchesReviewer([p.replace("**", "x").replace("*", "ts")]));
  assert.deepEqual(missing, []);
});

// A stale pattern (a .mjs that became .ts) would take the renamed file out of the eval and out of its reuse key.
it("every REVIEWER_CODE pattern matches a tracked file", () => {
  const root = join(import.meta.dirname, "../../..");
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
  assert.deepEqual(REVIEWER_CODE.filter((r) => !tracked.some((f) => r.test(f))).map(String), []);
});
