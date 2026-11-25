// A delegation's requester survives Paperclip's agent task-tree cap (2026.1117.0): a grandchild request is created beside
// its requester and the create response says so. The new task records the task that asked for it, so a repeat delegation
// finds that requester's own open tasks (its siblings, not every task under the placed parent), and reading the task shows
// the requester it is part of.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, parse } from "./helpers.ts";

// chief of staff (WOR-1) → architect (WOR-2, a child of WOR-1) → engineer (WOR-3, placed beside the architect under WOR-1)
const MARK = (id: string) => `<!-- aidenhq:requested-parent:${id} -->`;

function world({ adjusted }: { adjusted: boolean }) {
  const writes: Json[] = [];
  const tasks: Record<string, Json> = {
    cur: { id: "cur", identifier: "WOR-2", title: "Design it", status: "in_progress", assigneeAgentId: "me", parentId: "root", createdByAgentId: "boss" },
    root: { id: "root", identifier: "WOR-1", title: "Ship it", status: "in_progress", assigneeAgentId: "boss" },
    // A task the architect delegated earlier, and one the chief of staff delegated. When Paperclip adjusted the first, it sits
    // beside the architect under WOR-1 and records that the architect's task asked for it.
    sibling: { id: "sibling", identifier: "WOR-4", title: "Write the API", status: "in_progress", assigneeAgentId: "eng", parentId: adjusted ? "root" : "cur", createdByAgentId: "me", description: `Build the API.${adjusted ? `\n\n${MARK("cur")}` : ""}` },
    chiefKid: { id: "chiefKid", identifier: "WOR-5", title: "Write the API", status: "in_progress", assigneeAgentId: "eng", parentId: "root", createdByAgentId: "boss", description: "Build the API." },
  };
  let n = 0;
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(x)));
      const json = body ? JSON.parse(body) : {};
      if (url === "/api/agents/me") return send({ id: "me", name: "Mira" });
      if (url.endsWith("/agents")) return send([{ id: "eng", name: "Kai", metadata: { setupKey: "aidenhq:engineer-openrouter" }, status: "idle" }]);
      if (req.method === "POST" && url.endsWith("/issues")) {
        writes.push(json);
        // Paperclip: the requested parent is itself a child, so the task lands beside it, under the requester's parent.
        const placed = adjusted && tasks[json.parentId] ? tasks[json.parentId].parentId : json.parentId;
        const kid = { id: `new${++n}`, identifier: `WOR-${10 + n}`, title: json.title, status: json.status, parentId: placed, createdByAgentId: "me", description: json.description };
        tasks[kid.id] = kid;
        return send(kid);
      }
      const m = /^\/api\/issues\/([^/?]+)$/.exec(url);
      if (m && req.method === "PATCH") return (writes.push({ ...json, id: m[1] }), send(Object.assign(tasks[m[1]], json)));
      if (m) return tasks[m[1]] ? send(tasks[m[1]]) : send({ error: "not found" }, 404);
      const list = /^\/api\/companies\/[^/]+\/issues\?/.exec(url);
      if (list) {
        const q = new URL(url, "http://x").searchParams;
        const parent = q.get("parentId");
        const agent = q.get("assigneeAgentId");
        return send(Object.values(tasks).filter((t) => (!parent || t.parentId === parent) && (!agent || t.assigneeAgentId === agent)));
      }
      if (m && /\/comments$/.test(url)) return send({ id: "c1" });
      send([]);
    });
  };
  const { call } = bridge({ handler, agents: { me: { key: "architect" }, eng: { key: "engineer-openrouter" } }, agent: "me", task: "cur" });
  return { call, writes, tasks };
}

const brief = { agent: "Kai", title: "Write the API", description: "Build the same API the last task asked for.", deliverable: { kind: "pr", ref: "acme/app" } };

test("a delegation placed beside its requester groups by that requester, not by the placed parent", async () => {
  const { call, tasks } = world({ adjusted: true });
  // WOR-4 and WOR-5 are both open, held by Kai, and match the brief; WOR-4 is the Architect's own (recorded requester: WOR-2),
  // WOR-5 is the chief of staff's. The repeat names the Architect's task, so the two aren't confused.
  const refused = parse(await call("task_delegate", { ...brief, marker: "api" }));
  assert.match(refused.error ?? "", /WOR-4 \("Write the API", in_progress\) is already Kai's open task for this brief under WOR-2/);
  assert.doesNotMatch(refused.error ?? "", /WOR-5/);

  // A distinct brief is filed under the current task; Paperclip places it beside the Architect, and the answer still says so.
  const r = parse(await call("task_delegate", { ...brief, title: "Add pagination", description: "Paginate the API's list endpoint.", marker: "paging" }));
  assert.equal(r.error, undefined, r.error);
  assert.equal(tasks.new1.parentId, "root");
});

test("with no placement adjustment, a task is grouped by its parent exactly as before", async () => {
  const { call, tasks } = world({ adjusted: false });
  // WOR-4 and WOR-5 carry the same brief, held by Kai: WOR-4 is the Architect's own task under WOR-2, WOR-5 the chief of
  // staff's under WOR-1. The repeat names only the Architect's own, and the filed task records no requester.
  const r = parse(await call("task_delegate", brief));
  assert.match(r.error ?? "", /WOR-4 \("Write the API", in_progress\) is already Kai's open task for this brief under WOR-2/);
  assert.doesNotMatch(r.error ?? "", /WOR-5/);
  const fresh = { ...brief, title: "Add pagination", description: "Paginate the API's list endpoint." };
  assert.equal(parse(await call("task_delegate", fresh)).error, undefined);
  assert.equal(tasks.new1.parentId, "cur", "no adjustment: the child is under the task that asked for it");
  assert.doesNotMatch(String(tasks.new1.description), /requested-parent/, "nothing to record: the parent is the requester");
});

test("an edit of the description keeps the requester the delegation recorded", async () => {
  const { call, writes, tasks } = world({ adjusted: true });
  const r = parse(await call("task_update", { issue: "sibling", description: "Build the API, with paging." }));
  assert.equal(r.error, undefined, r.error);
  const patch = writes.at(-1)!;
  assert.match(String(patch.description), /Build the API, with paging\./);
  assert.match(String(patch.description), new RegExp(MARK("cur").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the recorded requester outlives the edit");
  assert.equal(tasks.sibling.description, patch.description);
});

test("an edit of a task with no recorded requester writes no marker", async () => {
  const { call, writes } = world({ adjusted: false });
  const r = parse(await call("task_update", { issue: "sibling", description: "Build the API, with paging." }));
  assert.equal(r.error, undefined, r.error);
  assert.doesNotMatch(String(writes.at(-1)!.description), /requested-parent/);
});
