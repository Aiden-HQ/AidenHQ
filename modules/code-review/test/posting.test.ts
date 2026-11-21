import { test } from "node:test";
import assert from "node:assert/strict";
import { kernelPoster, reviewExecutor } from "../service/src/adapters.ts";

const head = "a".repeat(40);
const me = { kind: "module", module: "code-review" };

test("the executor posts only this service's own record for its run; the poster files the run's target on the PR's task", async () => {
  const sent = [];
  const ex = reviewExecutor(async (op, body) => (sent.push([op, body]), op === "preview" ? { facts: { target: "acme/x#3" }, targets: {} } : { ok: true, text: "posted" }),
    (id) => (id === "cr-1" ? { repo: "acme/x", number: 3, head } : undefined));
  const args = { repo: "acme/x", pr: 3, head, run: "cr-1", review: {} };
  assert.equal((await ex.plan({ kind: "code-review.post", args, requester: me })).facts.target, "acme/x#3");
  await assert.rejects(ex.plan({ kind: "code-review.post", args: { ...args, pr: 4 }, requester: me }), /doesn't match its run/);
  await assert.rejects(ex.plan({ kind: "code-review.post", args, requester: { kind: "run", agent: "x" } }), /only the code-review service/);
  assert.deepEqual(await ex.execute({ kind: "code-review.post", args }), { ok: true, text: "posted" });

  const calls = [];
  const kernel = { call: async (m, path, body) => (calls.push([path, body]), path === "/v1/tasks" ? { id: "t-1" } : { id: "k-1", state: "review" }) };
  const poster = kernelPoster(kernel);
  const posted = await poster.post({ run: "cr-1", target: { repo: "acme/x", number: 3, head }, review: { repo: "acme/evil", pr: 9, head: "b".repeat(40) }, previous: null });
  assert.equal(posted.state, "pending");
  const w = calls.find(([p]) => p === "/v1/writes")[1];
  assert.deepEqual([w.kind, w.task, w.args.repo, w.args.pr, w.args.head, w.args.review.repo, w.args.review.pr], ["code-review.post", "t-1", "acme/x", 3, head, "acme/x", 3]);
  await poster.ack({ repo: "acme/x", number: 3, head, state: "skipped", why: "budget: the instance has $0.00 of its $200 left" });
  assert.deepEqual(calls.at(-1)[1].args, { repo: "acme/x", pr: 3, head, phase: "skipped", reason: "budget_instance" });
});

test("the check job's spec is exactly the recipe's fields, base the merge base, a full review from it, rechecking the open findings", async () => {
  const { checkSpec } = await import("../service/src/adapters.ts");
  const s = { repo: "acme/x", number: 9, base: "b".repeat(40), head: "h".repeat(40), merge_base: "m".repeat(40), combo: { engine: "codex", model: "~a/b", effort: "high" },
    focus: null, incremental_from: null, full: true, previous: [{ id: "f1", severity: "nit", path: "a", line: 1, title: "t" }], mandatory: false, budget_usd: 1.5, ignore: ["*.lock"], max_nits: 3 };
  const spec = checkSpec(s);
  assert.deepEqual(Object.keys(spec).sort(), ["base", "budget_usd", "combo", "focus", "incremental_from", "pr", "previous"]);
  assert.equal(spec.base, "m".repeat(40));
  assert.equal(spec.incremental_from, spec.base);
  assert.equal(spec.budget_usd, "1.5000");
  assert.deepEqual(JSON.parse(spec.combo), { ...s.combo, ignore: ["*.lock"], max_nits: 3, mandatory: false });
  assert.deepEqual(JSON.parse(spec.previous), { findings: s.previous });
});
