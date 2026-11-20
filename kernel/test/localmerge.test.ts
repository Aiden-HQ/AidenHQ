// The local auto-merge (localmerge.ts): a green change request on this server asks for its merge once per head and base, as
// the task's own agent, so no Engineer runs `aidenhq merge` — and never for a closed task or a change that isn't green. A
// base that moved starts the change's check again for the new base; an ask already on record for this head and base is not
// repeated.
import assert from "node:assert/strict";
import { test } from "node:test";
import { localMergePass, needsCheck, shouldAskMerge } from "../src/localmerge.ts";

const c = (o = {}) => ({ repo: "local/app", number: 3, url: "codehost:local/app/change/3", head: "a".repeat(40), base: "b".repeat(40), task: "T-1", checks: [{ ok: true, pending: false }], ...o });
const openTask = { status: "in_progress", assigneeAgentId: "ag-1" };
const grants = { "ag-1": { key: "ada" } };
const priorAt = (head, base) => [{ args: { prs: [{ repo: "local/app", number: 3, head }] }, targets: { "local/app#3": { repo: "local/app", ref: "change/3", commit: head, base_sha: base } } }];

test("a green change is asked for once per head and base; a repeat at the same pair is not, a moved head or base is", () => {
  assert.equal(shouldAskMerge(c(), openTask, []), true);
  // Asked already at this head and base: the record is the ask.
  assert.equal(shouldAskMerge(c(), openTask, priorAt(c().head, c().base)), false);
  // A new head (a new push) is a new ask; so is a base that moved under the same head (the change must land on the new base).
  assert.equal(shouldAskMerge(c(), openTask, priorAt("f".repeat(40), c().base)), true);
  assert.equal(shouldAskMerge(c(), openTask, priorAt(c().head, "e".repeat(40))), true);
  assert.equal(shouldAskMerge(c({ base: "e".repeat(40) }), openTask, priorAt(c().head, c().base)), true);
});

test("never for a closed task, a change that isn't green, or a change with no checks", () => {
  for (const status of ["done", "cancelled"]) assert.equal(shouldAskMerge(c(), { ...openTask, status }, []), false, status);
  assert.equal(shouldAskMerge(c(), { status: "in_progress", assigneeAgentId: null }, []), false);
  assert.equal(shouldAskMerge(c(), undefined, []), false);
  assert.equal(shouldAskMerge(c({ checks: [] }), openTask, []), false);
  assert.equal(shouldAskMerge(c({ checks: [{ ok: false, pending: true }] }), openTask, []), false);
  assert.equal(shouldAskMerge(c({ checks: [{ ok: false, pending: false }] }), openTask, []), false);
  assert.equal(shouldAskMerge(c({ checks: [{ ok: true, pending: false }, { ok: false, pending: true }] }), openTask, []), false);
});

test("the pass files as the task's agent, restarts a check missing for a moved base, and never for a stranger's task", async () => {
  const filed = [], restarted = [], tasks = { "T-1": openTask, "T-2": { status: "in_progress", assigneeAgentId: "ag-2" } };
  const changes = [
    c(), // green, asked for
    c({ number: 4, url: "codehost:local/app/change/4", head: "c".repeat(40), base: "d".repeat(40), checks: [{ ok: false, pending: false, missing: true }] }), // the base moved: its check is missing
    c({ number: 5, url: "codehost:local/app/change/5", head: "e".repeat(40), task: "T-2" }), // an agent this kernel has no grant for
  ];
  const out = await localMergePass({
    open: async () => changes, task: async (id) => tasks[id], grant: (a) => grants[a], prior: () => [],
    file: async (b) => { filed.push(b); return { id: `k-${filed.length}`, tier: 1, state: "review" }; },
    restart: async (x) => { restarted.push(x.url); return "started"; },
  });
  assert.deepEqual(filed.map((f) => [f.agent, f.key, f.name, f.task, f.args.prs[0].head]), [["ag-1", "ada", "ada", "T-1", c().head]]);
  assert.deepEqual(out.filed.map((f) => [f.change, f.tier, f.state]), [["codehost:local/app/change/3", 1, "review"]]);
  // The missing check is asked for again for its new base; the stranger's task is never asked for (and has nothing to restart).
  assert.deepEqual(restarted, ["codehost:local/app/change/4"]);
  assert.deepEqual(out.restarted, ["codehost:local/app/change/4"]);
  assert.equal(needsCheck(c({ checks: [{ ok: false, pending: false, missing: true }] })), true);
  assert.equal(needsCheck(c({ checks: [{ ok: false, pending: false }] })), false, "a red check is never restarted: it is the code's");
});

test("a task the control plane can't answer for now is skipped, never asked on a guess", async () => {
  let calls = 0;
  const out = await localMergePass({
    open: async () => [c()], task: async () => { calls++; throw new Error("the control plane didn't answer"); }, grant: (a) => grants[a], prior: () => [],
    file: async () => { throw new Error("must not file"); }, restart: async () => { throw new Error("must not restart"); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(out.filed, []);
  assert.match(out.skipped[0].why, /task unreadable/);
});
