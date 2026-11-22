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
    focus: null, incremental_from: null, full: true, previous: [{ id: "f1", severity: "nit", path: "a", line: 1, title: "t" }], mandatory: false, budget_usd: 1.5, ignore: ["*.lock"], max_nits: 3,
    intent: `Fix refunds\r\n\r\nRefunds now go negative on purpose.\u0007${"x".repeat(3000)}` };
  const spec = checkSpec(s);
  assert.deepEqual(Object.keys(spec).sort(), ["base", "budget_usd", "combo", "focus", "incremental_from", "intent", "pr", "previous"]);
  // The kernel's text kind (no control characters but newline and tab, at most 2000): a CRLF body never fails the run's start.
  assert.match(spec.intent, /^Fix refunds\n\nRefunds now go negative on purpose\.x+$/);
  assert.equal(spec.intent.length, 2000);
  assert.equal(spec.base, "m".repeat(40));
  assert.equal(spec.incremental_from, spec.base);
  assert.equal(spec.budget_usd, "1.5000");
  assert.deepEqual(JSON.parse(spec.combo), { ...s.combo, ignore: ["*.lock"], max_nits: 3, mandatory: false });
  assert.deepEqual(JSON.parse(spec.previous), { findings: s.previous });
});

test("a check that failed before it got a box spent nothing, so its run retries; one that ran with no figure counts whole", async () => {
  const { kernelRunner } = await import("../service/src/adapters.ts");
  const runner = (v) => kernelRunner({ call: async () => v });
  assert.deepEqual(await runner({ state: "failed", error: "github is unreachable", receipt: null, box_at: null, billed_usd: null }).result("c"), { state: "failed", why: "github is unreachable", billed_usd: 0 });
  assert.equal((await runner({ state: "failed", error: "x", receipt: null, box_at: "2026-11-21T09:00:00Z", billed_usd: null }).result("c")).billed_usd, undefined);
});

test("a done notice's review link is a field the notice kind takes (schemas/notice.json)", async () => {
  const { readFileSync } = await import("node:fs");
  const { validate } = await import("../../../kernel/src/writes.ts");
  let args;
  const poster = kernelPoster({ call: async (m, path, body) => (path === "/v1/writes" && (args = body.args), { id: "k-1", state: "done" }) });
  await poster.ack({ repo: "acme/x", number: 3, head, state: "done", run: "cr-1", combo: { engine: "codex", model: "~a/b", effort: "low" }, counts: { important: 1, nit: 0, pre_existing: 0, cost_usd: 0.1 }, review: "https://github.com/acme/x/pull/3#pullrequestreview-9", ack: 7 });
  validate(JSON.parse(readFileSync(new URL("../schemas/notice.json", import.meta.url), "utf8")), args);
  assert.equal(args.review, "https://github.com/acme/x/pull/3#pullrequestreview-9");
});
