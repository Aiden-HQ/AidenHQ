// A green PR's merge, filed by the kernel for its task (writes.fileOwnMerge, POST /v1/merges): only at the head the task's own
// approved PR record pushed, as that record's requester, once; its outcome reaches the task even at Tier 0 (no caller waits).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";

const [HEAD, OTHER] = ["a".repeat(40), "b".repeat(40)];
const ENGINEER = { agent: "agent-1", key: "engineer", name: "engineer", roles: ["platform-engineer"], kind: "run", task: "task-1", model: "~acme/flash" };
const card = { sentence: "s", changes: "c", reads: "r", cost: "0", details: "d" };
const kind = (module: string) => ({ module, floor: 0 as const, tools: [] });

function kernel(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "own-merge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const records = openRecords(join(dir, "kernel.db"));
  const notices: { task: string; text: string }[] = [], planned: unknown[] = [];
  const writes = createWrites({
    records, registry: () => ({ "github.pr": kind("github"), "github.merge": kind("github") }), connections: () => ({}), secret: () => "", resolver: {} as never,
    onTask: { open: async (task) => task !== "closed-task", notify: async (task, text) => void notices.push({ task, text }) }, replay: async () => ({ ok: false, text: "" }),
    // The code host's plan and execute, in process: Tier 0 on its merits (an agents-org merge), merged at once.
    executors: () => ({ github: { plan: async (req: unknown) => (planned.push(req), { args: (req as { args: unknown }).args, targets: {} }), execute: async () => ({ ok: true, text: "Merged acme/app#3 as cccc" }) } as never }),
  });
  const pr = (task: string, sha: string, branch = "agent/ACME-1/fix") => records.file({ kind: "github.pr", module: "github", args: { workspace: "ACME-1", only: [{ repo: "acme/app", branch, sha }], text: { title: "t", body: "b" } }, targets: {}, executor: { module: "github" }, policy: "p", tier: 1, card, requester: { ...ENGINEER, task }, task, identifier: "ACME-1", state: "done" });
  return { records, writes, notices, planned, pr };
}
const ask = (head: string, o: Record<string, unknown> = {}) => ({ task: "ACME-1", repo: "acme/app", number: 3, head, branch: "agent/ACME-1/fix", ...o });

test("green at the head its task's approved PR pushed: the merge is filed once, as that PR's requester, and the task hears it land", async (t) => {
  const k = kernel(t);
  k.pr("task-1", HEAD);
  const out = await k.writes.fileOwnMerge("github", ask(HEAD));
  const r = k.records.get(out.filed!.id)!;
  assert.deepEqual([r.kind, r.task, r.identifier, r.args], ["github.merge", "task-1", "ACME-1", { prs: [{ repo: "acme/app", number: 3, head: HEAD }] }]);
  assert.deepEqual(r.requester, { ...ENGINEER, filed_by: "github" }, "the opener's identity, roles and model: tiered and reviewed as its own `aidenhq merge`");
  assert.deepEqual((k.planned[0] as { requester: { agent: string; roles: string[] }; task: string }).requester.roles, ["platform-engineer"], "the code host plans it for the opener");
  assert.equal(k.records.get(r.id)!.state, "done");
  assert.equal(k.notices.length, 1, "Tier 0, but no caller waited: the task is told");
  assert.match(k.notices[0]!.text, /^\*\*Done\*\* \(approval .*, github\.merge\)[\s\S]*Merged acme\/app#3 as cccc/);
  assert.deepEqual(await k.writes.fileOwnMerge("github", ask(HEAD)), { skip: "merging" }, "filed at this head already: never twice");
});

test("no merge is filed for a head its task's PR record didn't push, an open merge, a closed task, or another module", async (t) => {
  const k = kernel(t);
  k.pr("task-1", HEAD);
  assert.deepEqual(await k.writes.fileOwnMerge("github", ask(OTHER)), { skip: "not-approved" }, "a head nobody approved (GitHub updated the branch)");
  assert.deepEqual(await k.writes.fileOwnMerge("github", ask(HEAD, { branch: "agent/ACME-1/other" })), { skip: "not-approved" }, "another branch");
  assert.deepEqual(await k.writes.fileOwnMerge("github", ask(HEAD, { task: "ACME-2" })), { skip: "not-approved" }, "another task's PR");
  await assert.rejects(k.writes.fileOwnMerge("acme", ask(HEAD)), /acme doesn't own github\.merge/);
  // The agent already asked for this PR's merge at an earlier head: open, so nothing more.
  k.records.file({ kind: "github.merge", module: "github", args: { prs: [{ repo: "acme/app", number: 3, head: OTHER }] }, targets: {}, executor: { module: "github" }, policy: "p", tier: 1, card, requester: ENGINEER, task: "task-1", identifier: "ACME-1", state: "review" });
  assert.deepEqual(await k.writes.fileOwnMerge("github", ask(HEAD)), { skip: "merging" });
  const c = kernel(t);
  c.pr("closed-task", HEAD);
  assert.deepEqual(await c.writes.fileOwnMerge("github", ask(HEAD)), { skip: "closed" });
  assert.equal(c.records.list(["review", "owner", "approved", "claimed", "done"], 50, { kinds: ["github.merge"] }).length, 0);
});
