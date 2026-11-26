// Paperclip caps agent-created trees at parent → child: a grandchild request is created beside its requester under the
// requester's parent, and the create response says so. Dispatch routes what a task needs to whoever asked for it, so it reads
// the requester the plugin recorded (requested-parent.ts), never the placed parent alone. A task that wasn't adjusted
// resolves exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAsker, type Told } from "../service/src/asker.ts";
import { createKernel, KernelError } from "../service/src/kernel.ts";

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
      description: adjusted ? `${MARK("WOR2")}\n\nBuild it.` : "Build it.",
    },
  };
  const seen = { wakes: [] as { task: string; text: string }[], filed: [] as Json[], noted: [] as Json[] };
  const fullReads: string[] = [];
  const kernel = {
    task: async (id: string) => (fullReads.push(id), tasks[id] ?? (() => { throw new KernelError(404, "no task"); })()),
    // A task list cuts every description to 1200 chars: `preview` is the row, the task itself is only read whole.
    children: async (parent: string) => Object.values(tasks).filter((t) => t.parentId === parent).map((t) => (t.preview ? { ...t, ...t.preview } : t)),
    wake: async (task: string, text: string) => void seen.wakes.push({ task, text }),
    fileTask: async (b: Json) => (seen.filed.push(b), { id: `card-${seen.filed.length}` }),
    notify: async (b: Json) => void seen.noted.push(b),
  };
  const clock = 1_000_000;
  const asker = createAsker(kernel as never);
  return { tasks, seen, fullReads, asker, dir: { [ENGINEER]: { key: "engineer" }, [ARCHITECT]: { key: "architect" }, [CHIEF]: { key: "chief-of-staff", roles: ["fleet-admin"] } }, now: () => clock };
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

test("a delegation Paperclip left standalone (no structural parent) still reports to the task that asked for it", async () => {
  const w = world({ adjusted: true });
  // The create sent no expectedParentId, so Paperclip wrote no adjusted edge: no `parentId`, only the recorded requester.
  w.tasks.WOR3.parentId = undefined;
  const told = await w.asker.tell(w.tasks.WOR3, "**WOR-3 is blocked.** Its reason: a stale path.", "is blocked");
  assert.deepEqual([told.heard, w.seen.wakes.map((x) => x.task)], ["parent", ["WOR2"]]);
  const key = await w.asker.summarize(w.tasks.WOR3, { ended: async () => ({ seq: 1, state: "done" }), live: async () => false, dir: w.dir });
  assert.equal(key, 1, "its batch is the requester's, found without a parent to list from");
  assert.deepEqual(w.seen.wakes.map((x) => x.task), ["WOR2", "WOR2"], "the ask, then its batch summary, both on the requester");
});

test("a requester's task whose list row hides its marker behind a 1200-char cut is read whole", async () => {
  const w = world({ adjusted: true });
  // A sibling of WOR-3 filed by the Architect, with a brief long enough that a list row would cut its marker off.
  const brief = `${"Detail. ".repeat(200)}${MARK("WOR2")}`;
  w.tasks.WOR6 = { id: "WOR6", identifier: "WOR-6", title: "Build the other page", status: "done", assigneeAgentId: ENGINEER, parentId: "WOR1", createdByAgentId: ARCHITECT, description: brief, preview: { description: brief.slice(0, 1200), descriptionTruncated: true } };
  const key = await w.asker.summarize(w.tasks.WOR3, { ended: async () => ({ seq: 1, state: "done" }), live: async () => false, dir: w.dir });
  assert.equal(key, 1, "WOR-6 is in the same batch: its requester is resolved from the whole brief");
  assert.match(w.seen.wakes.at(-1)!.text, /WOR-6/);
  assert.equal(w.fullReads.includes("WOR6"), true, "its list row was cut, so its whole brief was read");
});

// The batch reader itself (createKernel.children), against a control plane whose `createdFromIssueId` does not name the placed
// tasks: a placed sibling sits under the requester's parent, so that place is read and the recorded requester decides.
test("a placed sibling is found under the requester's parent even when the create origin does not name it", async () => {
  const rows: Record<string, Json> = {
    WOR1: { id: "WOR1", identifier: "WOR-1", title: "Ship it", status: "in_progress", assigneeAgentId: CHIEF },
    WOR2: { id: "WOR2", identifier: "WOR-2", title: "Design it", status: "in_progress", assigneeAgentId: ARCHITECT, parentId: "WOR1" },
    WOR3: { id: "WOR3", identifier: "WOR-3", title: "Build it", status: "in_progress", assigneeAgentId: ENGINEER, parentId: "WOR1", description: `${MARK("WOR2")}\n\nBuild it.` },
    WOR6: { id: "WOR6", identifier: "WOR-6", title: "Build the other page", status: "in_progress", assigneeAgentId: ENGINEER, parentId: "WOR1", description: `${MARK("WOR2")}\n\nBuild the other page.` },
  };
  const asked: string[] = [];
  const fetcher = (async (url: string | URL) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v1\/cp\/read/, "");
    const single = /^\/api\/issues\/([^/]+)$/.exec(path);
    // A list row is a preview: descriptions are cut at 1200 chars, as Paperclip's are.
    const row = (i: Json) => (String(i.description ?? "").length > 1200 ? { ...i, description: String(i.description).slice(0, 1200), descriptionTruncated: true } : i);
    if (single) return { ok: true, status: 200, json: async () => rows[decodeURIComponent(single[1])] ?? {} } as Response;
    if (path.startsWith("/api/companies/")) {
      const parentId = u.searchParams.get("parentId");
      const from = u.searchParams.get("createdFromIssueId");
      if (from) { asked.push(`from:${from}`); return { ok: true, status: 200, json: async () => [] } as Response; }
      return { ok: true, status: 200, json: async () => Object.values(rows).filter((i) => i.parentId === parentId).map(row) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  const kernel = createKernel("http://kernel.test", "t", fetcher);
  const found = (await kernel.children("WOR2", "co")).map((i) => i.id).sort();
  assert.deepEqual(found, ["WOR3", "WOR6"], "its batch, found by reading the place it was put in");
  assert.equal(asked.includes("from:WOR2"), true, "the create origin was still consulted");
  assert.deepEqual((await kernel.children("WOR1", "co")).map((i) => i.id), ["WOR2"], "the chief of staff's batch is its own child, not the two placed under it: their requester is the Architect");
});

test("a cut row whose whole task cannot be read fails the batch rather than resolving to its placed parent", async () => {
  // WOR-3's row is cut before its marker, and its single-task read fails: answering from the preview would put it in WOR-1's
  // batch (its placed parent) and drop it from WOR-2's, so the batch summary could call the Architect's work finished.
  const brief = "Detail. ".repeat(200);
  const rows: Record<string, Json> = {
    WOR1: { id: "WOR1", identifier: "WOR-1", title: "Ship it", status: "in_progress", assigneeAgentId: CHIEF },
    WOR2: { id: "WOR2", identifier: "WOR-2", title: "Design it", status: "in_progress", assigneeAgentId: ARCHITECT, parentId: "WOR1" },
    WOR3: { id: "WOR3", identifier: "WOR-3", title: "Build it", status: "in_progress", assigneeAgentId: ENGINEER, parentId: "WOR1", description: `${brief}${MARK("WOR2")}` },
  };
  const fetcher = (async (url: string | URL) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v1\/cp\/read/, "");
    const single = /^\/api\/issues\/([^/]+)$/.exec(path);
    if (single) {
      const id = decodeURIComponent(single[1]);
      // Only the cut task's own read fails; the parent tasks read fine (their rows carry no cut).
      return id === "WOR3"
        ? { ok: false, status: 503, json: async () => ({ error: "unavailable" }) } as Response
        : { ok: true, status: 200, json: async () => rows[id] ?? {} } as Response;
    }
    if (path.startsWith("/api/companies/")) {
      const parentId = u.searchParams.get("parentId");
      if (u.searchParams.get("createdFromIssueId")) return { ok: true, status: 200, json: async () => [] } as Response;
      return { ok: true, status: 200, json: async () => Object.values(rows).filter((i) => i.parentId === parentId).map((i) => ({ ...i, description: String(i.description).slice(0, 1200), descriptionTruncated: true })) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  const kernel = createKernel("http://kernel.test", "t", fetcher);
  await assert.rejects(() => kernel.children("WOR2", "co"), /503/);
  await assert.rejects(() => kernel.children("WOR1", "co"), /503/, "nor is it silently counted under the placed parent");
});
