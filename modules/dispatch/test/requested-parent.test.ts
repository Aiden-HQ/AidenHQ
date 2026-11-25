// Paperclip caps agent-created trees at parent → child: a grandchild request is created beside its requester under the
// requester's parent, and the create response says so. Dispatch routes what a task needs to whoever asked for it, so it reads
// the requester the plugin recorded (requested-parent.ts), never the placed parent alone. A task that wasn't adjusted
// resolves exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAsker, type Told } from "../service/src/asker.ts";
import { KernelError } from "../service/src/kernel.ts";

const ENGINEER = "10000000-0000-4000-8000-000000000003";
const ARCHITECT = "10000000-0000-4000-8000-000000000002";
const CHIEF = "10000000-0000-4000-8000-000000000001";
const MARK = (id: string) => `<!-- aidenhq:requested-parent:${id} -->`;

// WOR-1 the chief of staff's task, WOR-2 the Architect's under it, WOR-3 the Engineer's: placed beside the Architect under
// WOR-1 when the cap applied, recording that WOR-2 asked for it.
function world({ adjusted }: { adjusted: boolean }) {
  const tasks: Record<string, Json> = {
    WOR1: { id: "WOR1", identifier: "WOR-1", title: "Ship it", status: "in_progress", assigneeAgentId: CHIEF, createdByUserId: "u1" },
    WOR2: { id: "WOR2", identifier: "WOR-2", title: "Design it", status: "in_progress", assigneeAgentId: ARCHITECT, parentId: "WOR1", createdByAgentId: CHIEF },
    WOR3: {
      id: "WOR3", identifier: "WOR-3", title: "Build it", status: "blocked", assigneeAgentId: ENGINEER,
      parentId: adjusted ? "WOR1" : "WOR2", createdByAgentId: ARCHITECT,
      description: `Build it.${adjusted ? `\n\n${MARK("WOR2")}` : ""}`,
    },
  };
  const seen = { wakes: [] as { task: string; text: string }[], filed: [] as Json[], noted: [] as Json[] };
  const kernel = {
    task: async (id: string) => tasks[id] ?? (() => { throw new KernelError(404, "no task"); })(),
    children: async (parent: string) => Object.values(tasks).filter((t) => t.parentId === parent),
    wake: async (task: string, text: string) => void seen.wakes.push({ task, text }),
    fileTask: async (b: Json) => (seen.filed.push(b), { id: `card-${seen.filed.length}` }),
    notify: async (b: Json) => void seen.noted.push(b),
  };
  const clock = 1_000_000;
  const asker = createAsker(kernel as never);
  return { tasks, seen, asker, dir: { [ENGINEER]: { key: "engineer" }, [ARCHITECT]: { key: "architect" }, [CHIEF]: { key: "chief-of-staff", roles: ["fleet-admin"] } }, now: () => clock };
}

test("what a blocked task needs reaches the task that asked for it, not the parent it was placed under", async () => {
  const w = world({ adjusted: true });
  const told: Told = await w.asker.tell(w.tasks.WOR3, "**WOR-3 is blocked.** Its reason: the brief names a stale path.", "is blocked");
  assert.deepEqual([told.heard, w.seen.wakes.map((x) => x.task)], ["parent", ["WOR2"]], "the Architect hears it");
  assert.equal(w.seen.filed.length, 0, "no decision card: the requester's task is open");
  assert.match(w.seen.wakes[0].text, /WOR-3 is blocked/);

  // Its batch summary is the Architect's: its own open tasks, the placed grandchild included, and not the chief of staff's.
  const key = await w.asker.summarize(w.tasks.WOR3, { ended: async () => ({ seq: 1, state: "done" }), live: async () => false, dir: w.dir });
  assert.equal(key, 1);
  assert.deepEqual(w.seen.wakes.map((x) => x.task), ["WOR2", "WOR2"]);
  assert.match(w.seen.wakes[1].text, /WOR-3/);
});

test("a task the cap didn't move resolves to its parent, as before", async () => {
  const w = world({ adjusted: false });
  const told = await w.asker.tell(w.tasks.WOR3, "**WOR-3 is blocked.** Its reason: a stale path.", "is blocked");
  assert.deepEqual([told.heard, w.seen.wakes.map((x) => x.task)], ["parent", ["WOR2"]]);
  assert.equal(await w.asker.summarize(w.tasks.WOR3, { ended: async () => ({ seq: 1, state: "done" }), live: async () => false, dir: w.dir }), 1);
  assert.deepEqual(w.seen.wakes.map((x) => x.task), ["WOR2", "WOR2"]);
});

test("with the requester closed, the ask becomes a card for the agent that made the task, as before", async () => {
  const w = world({ adjusted: true });
  w.tasks.WOR2.status = "done";
  const told = await w.asker.tell(w.tasks.WOR3, "**WOR-3 is blocked.** Its reason: a stale path.", "is blocked");
  assert.equal(told.heard, "asker");
  assert.deepEqual(w.seen.wakes, []);
  assert.equal(w.seen.filed.length, 1);
  assert.equal(w.seen.filed[0].agent, ARCHITECT);
});
