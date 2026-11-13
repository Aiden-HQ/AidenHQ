import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/store.js";
import { WAKE_LIMIT, wakeCheck } from "../src/brake.js";

const t0 = Date.parse("2026-11-12T10:00:00Z");
const noGrants = "/nonexistent";
const log = { info() {} };

/** Paperclip: Aiden's task t1, an Engineer's task t2; every comment queues a run of the task's agent that names it. */
function fake() {
  const comments: { id: string; body: string; authorType: string; authorAgentId: string | null; createdAt: string }[] = [];
  const runs: { id: string; status: string; wakeCommentId: string | null }[] = [];
  const cancelled: string[] = [];
  const released: string[] = [];
  // The first cancel lands as the run starts: Paperclip holds the task for that run until it is resolved.
  let held: string | null = null;
  const pc = {
    issue: async (id: string) => ({ id, identifier: `WOR-${id}`, status: "in_progress", assigneeAgentId: id === "t2" ? "eng" : "aiden", executionBlocker: held ? { cause: "legacy_execution_requires_reconciliation", runId: held, recoveryActionId: "ra1" } : null }),
    agents: async () => [{ id: "aiden", runtimeConfig: { heartbeat: { wakeOnDemand: true } } }, { id: "arch" }, { id: "eng", runtimeConfig: { heartbeat: { wakeOnDemand: false } } }],
    comments: async () => comments,
    agentRuns: async () => runs,
    cancelRun: async (id: string) => {
      cancelled.push(id);
      if (cancelled.length === 1) held = id;
    },
    releaseCancelledRun: async (_issue: unknown, runId: string) => {
      released.push(runId);
      held = null;
    },
  };
  const post = (by: string) => {
    const id = `c${comments.length}`;
    comments.push({ id, body: by === "runner" ? "Merged.\n\n<!-- aidenhq-runner -->" : "PR is up", authorType: by === "runner" ? "user" : "agent", authorAgentId: by === "runner" ? null : by, createdAt: "" });
    runs.unshift({ id: `r${id}`, status: "queued", wakeCommentId: id });
    return id;
  };
  return { pc: pc as never, post, cancelled, released };
}

// WOR-2275: 75 wakes of Aiden on one task in a day from others' comments. Now each commenter's 13th wake there is cancelled;
// the comment itself stays, under the commenter's own name.
it("loop brake: past a commenter's daily limit on a task, the wake its comment caused is cancelled", async () => {
  const f = fake();
  const store = new Store(":memory:");
  const opts = { now: t0, grantsFile: noGrants, waitMs: 1 };
  for (let i = 0; i < WAKE_LIMIT; i++) expect(await wakeCheck(f.pc, store, "t1", f.post("runner"), "runner", log, opts)).toEqual({ woke: true });
  const over = f.post("runner");
  expect(await wakeCheck(f.pc, store, "t1", over, "runner", log, opts)).toEqual({ woke: false, cancelled: true });
  expect(f.cancelled).toEqual([`r${over}`]);
  // It had just started, so Paperclip held the task; the brake clears that hold (WOR-2275).
  expect(f.released).toEqual([`r${over}`]);
  // The owner commented after it: Paperclip folded the owner's wake into that queued run, so it is never cancelled.
  const over2 = f.post("runner");
  f.post("owner");
  expect(await wakeCheck(f.pc, store, "t1", over2, "runner", log, opts)).toEqual({ woke: true });
  expect(f.cancelled).toEqual([`r${over}`]);

  // Another commenter has its own budget; a commenter can only report its own comment.
  expect(await wakeCheck(f.pc, store, "t1", f.post("arch"), "arch", log, opts)).toEqual({ woke: true });
  await expect(wakeCheck(f.pc, store, "t1", f.post("arch"), "runner", log, opts)).rejects.toThrow(/not your comment/);
  // An Engineer's task: Paperclip never wakes it on a comment, so nothing is counted or cancelled.
  expect(await wakeCheck(f.pc, store, "t2", f.post("runner"), "runner", log, opts)).toEqual({ woke: false });

  // The next UTC day starts over; the kill switch never cancels.
  expect(await wakeCheck(f.pc, store, "t1", f.post("runner"), "runner", log, { ...opts, now: Date.parse("2026-11-13T00:05:00Z") })).toEqual({ woke: true });
  const off = join(mkdtempSync(join(tmpdir(), "brake-")), "grants.json");
  writeFileSync(off, JSON.stringify({ loop_brake: "off" }));
  for (let i = 0; i < WAKE_LIMIT + 2; i++) await wakeCheck(f.pc, store, "t1", f.post("arch"), "arch", log, { ...opts, grantsFile: off });
  expect(f.cancelled).toHaveLength(1);
});
