// A8 and A9 (lean-core adversarial checks) through the kernel's real write lifecycle with the code host's real plan: an
// approved push or merge whose commit, base or head moved after approval, or whose executor was updated in between, is
// closed as stale and never executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveExecutor } from "../../../kernel/sdk/src/executor.ts";
import { kernel, serve } from "../../../kernel/test/helpers.mjs";
import { plan } from "../src/plan.mjs";

const sha = (c) => c.repeat(40);
const until = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(fn()); };
const repos = { agentsOrg: "acme-agents", productRepo: "acme/aidenhq", instanceRepo: "acme-agents/aidenhq-instance" };

async function codehost(t, state) {
  const fx = { executes: [] };
  let handler = () => false;
  const ex = await serve(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
  t.after(() => ex.s.close());
  const executor = { url: `${ex.url}/aidenhq/v1/executor`, auth_secret: "codehost_github_token", rev: "r1" };
  const kinds = { "codehost-github.push": { module: "codehost-github", floor: 0, tools: [], executor }, "codehost-github.merge": { module: "codehost-github", floor: 1, tools: [], executor } };
  const verdicts = [];
  const k = await kernel(t, { secrets: { codehost_github_token: "ch-key" }, connections: {}, writes: kinds, reviewer: () => verdicts.shift(), modules: { modules: { "codehost-github": { token: "codehost_github_token" } } } });
  handler = serveExecutor({
    plan: async (req) => plan(req, state.now),
    execute: async (rec) => (fx.executes.push(rec), { ok: true, text: "pushed" }),
  }, { key: "ch-key", kernelUrl: k.url });
  const file = async (kind, args) => (await k.v1("POST", "/v1/writes", { kind, args, task: "TASK-1" }, "ch-key")).json;
  // The kernel's review loop asks for the record's review; the bound reviewer approves.
  const approve = async (id) => (verdicts.push({ decision: "approve", reason: "fine", model: "~acme/model-a" }), { status: 200, json: await k.writes.review(id, { input: { model: "~acme/model-b", tier: 1 }, request: { card: {} } }) });
  const updateExecutor = (rev) => {
    const file = join(k.dir, "writes.json");
    writeFileSync(file, JSON.stringify({ ...kinds, "codehost-github.push": { ...kinds["codehost-github.push"], executor: { ...executor, rev } } }));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
  };
  return { k, fx, file, approve, updateExecutor };
}

// A branch push outside the agents org: Tier 1 (outside-push), bound to its commit and base.
const outsidePush = (over = {}) => ({ ...repos, requester: { platform: false }, branches: [{ repo: "other/lib", branch: "fix/a", sha: sha("a"), base: sha("b"), defaultBranch: "main", empty: false, files: ["src/a.ts"], ...over }] });
const pushArgs = { only: [{ repo: "other/lib", branch: "fix/a", sha: sha("a") }] };

test("an approved push that nothing moved runs once", async (t) => {
  const state = { now: outsidePush() };
  const { k, fx, file, approve } = await codehost(t, state);
  const r = await file("codehost-github.push", pushArgs);
  assert.deepEqual({ tier: r.tier, state: r.state }, { tier: 1, state: "review" });
  assert.deepEqual(k.records.get(r.id).targets, { "other/lib fix/a": { repo: "other/lib", ref: "fix/a", commit: sha("a"), base_sha: sha("b") } });
  await approve(r.id);
  await until(() => k.records.get(r.id).state === "done");
  assert.equal(fx.executes.length, 1);
});

test("A8: the workspace commit or the base moving after approval makes the push stale; it never runs", async (t) => {
  for (const moved of [{ sha: sha("c") }, { base: sha("d") }]) {
    const state = { now: outsidePush() };
    const { k, fx, file, approve } = await codehost(t, state);
    const r = await file("codehost-github.push", pushArgs);
    state.now = outsidePush(moved);
    await approve(r.id);
    await until(() => k.records.get(r.id).state === "stale");
    assert.equal(fx.executes.length, 0, JSON.stringify(moved));
  }
});

test("A8: a product PR's head moving after its merge was approved makes the merge stale; it never runs", async (t) => {
  const pr = (head) => ({ ...repos, requester: { platform: true }, prs: [{ repo: "acme/aidenhq", number: 7, head, files: ["README.md"], checks: [{ name: "ci", ok: true }], headMatches: true, ownHead: true }] });
  const state = { now: pr(sha("e")) };
  const { k, fx, file, approve } = await codehost(t, state);
  const r = await file("codehost-github.merge", { prs: [{ repo: "acme/aidenhq", number: 7, url: "https://github.com/acme/aidenhq/pull/7", head: sha("e") }] });
  assert.deepEqual({ tier: r.tier, state: r.state }, { tier: 1, state: "review" });
  state.now = pr(sha("f"));
  await approve(r.id);
  await until(() => k.records.get(r.id).state === "stale");
  assert.equal(fx.executes.length, 0);
});

test("A9: the code host's executor updated between approval and execution makes the push stale; it never runs", async (t) => {
  const state = { now: outsidePush() };
  const { k, fx, file, approve, updateExecutor } = await codehost(t, state);
  const r = await file("codehost-github.push", pushArgs);
  assert.equal(k.records.get(r.id).executor.rev, "r1");
  updateExecutor("r2");
  await approve(r.id);
  await until(() => k.records.get(r.id).state === "stale");
  assert.equal(fx.executes.filter((e) => e.id === r.id).length, 0);
});

test("the plan refuses what code refuses: the instance repo, and an agents-org merge with red checks", () => {
  assert.throws(() => plan({ kind: "codehost-github.push", args: {} }, { ...repos, branches: [{ repo: repos.instanceRepo, branch: "x", sha: sha("a"), files: [] }] }), /only through apply/);
  assert.throws(() => plan({ kind: "codehost-github.merge", args: {} }, { ...repos, prs: [{ repo: "acme-agents/app", number: 1, files: ["a"], checks: [{ name: "ci", ok: false }], headMatches: true, ownHead: true }] }), /failed on the head/);
});
