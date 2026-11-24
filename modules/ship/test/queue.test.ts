// Ship through a merge queue: a ready PR is enqueued bound to head and base, then watched; a removal for a red merge_group check
// of its own is a fix_ci round, one that fails on the base too is queued once more and then waits visibly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { round as roundWith } from "../service/src/rounds.ts";
import { RISK } from "./risk.ts";
// Every round here sees a classified head whose tier approves and merges (risk.ts).
const round = ((d: any, pr: any, v: any, f: any = {}) => roundWith(d, pr, v, { risk: RISK, ...f })) as typeof roundWith;
import { effective } from "../service/src/settings.ts";
import { openState } from "../service/src/state.ts";
import type { PrView } from "../service/src/handoff.ts";

const H1 = "1".repeat(40), H2 = "2".repeat(40);

function world() {
  const state = openState(join(mkdtempSync(join(tmpdir(), "ship-q-")), "state.json"));
  state.put({ repo: "a/b", number: 7, generation: 1, trigger: { kind: "label", event: "e1", actor: "admin1", at: "2026-11-24T01:00:00Z", head: H1 }, hold: null } as any);
  const calls: { what: string; body?: any }[] = [];
  const records: Record<string, any> = {};
  let n = 0;
  const kernel = {
    async call(method: string, path: string, body?: any) {
      calls.push({ what: `${method} ${path}`, body });
      if (path === "/v1/tasks") return { id: "task-1" };
      if (path === "/v1/writes") { const id = `rec-${++n}`; records[id] = { state: "claimed" }; return { id }; }
      if (path.startsWith("/v1/writes/")) return records[path.split("/").pop()!];
      return {};
    },
  };
  const deps = {
    state, kernel, log: () => {}, paused: () => false,
    settings: (repo: string) => effective({ repos: { "a/b": { preset: "full", merge: "ready" } } }, repo, { fleet: ["a/b"], listed: [] }),
    updateBranch: async () => {}, assign: async () => {}, comment: async (_r: string, _n: number, body: string) => (calls.push({ what: "comment", body }), 9),
  };
  const pr = (o: Partial<PrView> = {}): PrView => ({ repo: "a/b", number: 7, url: "https://github.com/a/b/pull/7", head: H1, base: "main", defaultBranch: "main", author: "me", authorBot: false, fork: false, canModify: false, draft: false, state: "open", labels: [], assignees: [], events: [], ...o });
  const of = (w: string) => calls.filter((c) => c.what === w);
  return { state, deps, pr, of, records, calls };
}

test("a ready PR on a queue branch is enqueued once, bound to head and base, and is done when it lands there", async () => {
  const w = world();
  const ready = { do: "enqueue" as const, why: "ready" };
  await round(w.deps as any, w.pr(), ready, { queue: true });
  await round(w.deps as any, w.pr(), ready, { queue: true });
  assert.equal(w.of("POST /v1/writes").length, 1);
  assert.equal(w.of("POST /v1/writes")[0]!.body.kind, "github.enqueue");
  assert.deepEqual(w.of("POST /v1/writes")[0]!.body.args, { repo: "a/b", number: 7, head: H1, base: "main", generation: 1, attempt: 1 });
  assert.equal(w.of("POST /v1/writes").length, 1, "no direct merge");
  assert.equal(w.of("POST /v1/writes")[0]!.body.task, "task-1", "filed on the adoption's quiet records task");
  assert.equal(w.of("POST /v1/tasks").length, 1);
  // Queued: decide says wait while it is in the queue; then it lands.
  w.records["rec-1"] = { state: "done" };
  await round(w.deps as any, w.pr(), { do: "wait", why: "in the merge queue" }, { queue: true });
  assert.equal(await round(w.deps as any, w.pr({ state: "merged" }), { do: "done" }), "acted");
  assert.match(w.of("comment").at(-1)!.body, /\*\*State:\*\* merged/);
  // A merge that landed on another base than the one it was queued for is reported, not called merged.
  const o = world();
  await round(o.deps as any, o.pr(), ready, { queue: true });
  await round(o.deps as any, o.pr({ state: "merged", base: "other" }), { do: "done" });
  assert.match(o.of("comment").at(-1)!.body, /not the base it was queued for/);
});

test("removed from the queue: a conflict is repaired and queued again; its own red merge_group check is fix_ci; one failing on the base waits and queues once more", async () => {
  const w = world();
  const ready = { do: "enqueue" as const, why: "ready" };
  await round(w.deps as any, w.pr(), ready, { queue: true });
  w.records["rec-1"] = { state: "done" };
  // Out of the queue with a conflict: decide says repair (a new head), and the new head is enqueued afresh.
  await round(w.deps as any, w.pr(), { do: "repair", why: "it conflicts with `main`" }, { queue: true, dirty: true });
  assert.equal(w.of("POST /v1/writes")[1]!.body.kind, "github.repair");
  await round(w.deps as any, w.pr({ head: H2 }), ready, { queue: true });
  assert.deepEqual(w.of("POST /v1/writes")[2]!.body.args, { repo: "a/b", number: 7, head: H2, base: "main", generation: 1, attempt: 1 });
  w.records["rec-3"] = { state: "done" };
  // Removed for a red required check on the merge_group run that is the PR's own: a CI fix round.
  await round(w.deps as any, w.pr({ head: H2 }), ready, { queue: true, groupFailing: ["test"], onBase: [] });
  assert.equal(of(w, "POST /v1/tasks").filter((c) => !/:records$/.test(c.body.source)).length + of(w, "POST /v1/wakes").length, 1, "one Engineer job beside the records task");
  // Failing on the base too: queued once more, then a visible wait.
  const x = world();
  await round(x.deps as any, x.pr(), ready, { queue: true });
  x.records["rec-1"] = { state: "done" };
  const baseRed = { queue: true, groupFailing: ["lint"], onBase: ["lint"] };
  await round(x.deps as any, x.pr(), ready, baseRed);
  assert.equal(x.of("POST /v1/writes")[1]!.body.args.attempt, 2);
  x.records["rec-2"] = { state: "done" };
  await round(x.deps as any, x.pr(), ready, baseRed);
  assert.equal(x.of("POST /v1/writes").length, 2, "only one more enqueue");
  assert.match(x.of("comment").at(-1)!.body, /Waiting on:\*\* removed from the merge queue again/);
});

const of = (w: ReturnType<typeof world>, what: string) => w.of(what);
