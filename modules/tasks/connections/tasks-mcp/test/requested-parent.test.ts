// A delegation's requester survives Paperclip's agent task-tree cap (2026.1117.0): a grandchild request is created beside
// its requester and the create response says so. The new task records the task that asked for it, so a repeat delegation
// finds that requester's own open tasks (its siblings, not every task under the placed parent), and reading the task shows
// the requester it is part of.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, parse } from "./helpers.ts";

// chief of staff (WOR-1) → architect (WOR-2, a child of WOR-1) → engineer (WOR-3, placed beside the architect under WOR-1)
// The marker leads the description (a list cuts one to 1200 chars), as the plugin writes it.
const MARK = (id: string) => `<!-- aidenhq:requested-parent:${id} -->`;
const marked = (id: string, text: string) => `${MARK(id)}\n\n${text}`;

function world({ adjusted, me = "me" }: { adjusted: boolean; me?: string }) {
  const writes: Json[] = [];
  // Task ids whose single-task read fails (a transient error), so a row that had to be read whole cannot be decided on.
  const broken = new Set<string>();
  const tasks: Record<string, Json> = {
    cur: { id: "cur", identifier: "WOR-2", title: "Design it", status: "in_progress", assigneeAgentId: "me", parentId: "root", createdByAgentId: "boss" },
    root: { id: "root", identifier: "WOR-1", title: "Ship it", status: "in_progress", assigneeAgentId: "boss" },
    // A task the architect delegated earlier, and one the chief of staff delegated. When Paperclip adjusted the first, it sits
    // beside the architect under WOR-1 and records that the architect's task asked for it.
    sibling: { id: "sibling", identifier: "WOR-4", title: "Write the API", status: "in_progress", assigneeAgentId: "eng", parentId: adjusted ? "root" : "cur", createdByAgentId: "me", description: adjusted ? marked("cur", "Build the API.") : "Build the API." },
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
      if (url === "/api/agents/me") return send({ id: me, name: me === "eng" ? "Kai" : "Mira" });
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
      if (m) return broken.has(m[1]) ? send({ error: "unavailable" }, 503) : tasks[m[1]] ? send(tasks[m[1]]) : send({ error: "not found" }, 404);
      const list = /^\/api\/companies\/[^/]+\/issues\?/.exec(url);
      if (list) {
        const q = new URL(url, "http://x").searchParams;
        const parent = q.get("parentId");
        const agent = q.get("assigneeAgentId");
        const from = q.get("createdFromIssueId");
        // A list row is cut to 1200 chars (Paperclip's ISSUE_LIST_DESCRIPTION_MAX_CHARS), flagged by descriptionTruncated.
        const rows = Object.values(tasks)
          .filter((t) => (!parent || t.parentId === parent) && (!from || t.from === from) && (!agent || t.assigneeAgentId === agent))
          // Newest first, then the page: a filter not pushed into the query can be crowded out by earlier rows.
          .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
          .slice(0, Number(q.get("limit") ?? 50))
          .map((t) => (!t.description || t.description.length <= 1200 ? t : { ...t, description: t.description.slice(0, 1200), descriptionTruncated: true }));
        return send(rows);
      }
      if (m && /\/comments$/.test(url)) return send({ id: "c1" });
      send([]);
    });
  };
  const { call } = bridge({ handler, agents: { me: { key: "architect" }, eng: { key: "engineer-openrouter" } }, agent: "me", task: "cur" });
  // The Engineer's task, as the Engineer's own run reads it: placed beside the Architect under WOR-1, recording WOR-2.
  const engineer = bridge({ handler, agents: { eng: { key: "engineer-openrouter" } }, agent: "eng", task: "sibling" });
  return { call, writes, tasks, engineer, fail: (id: string) => void broken.add(id) };
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

test("reading the current task shows the requester that asked for it as its parent, not the placed one", async () => {
  const { engineer } = world({ adjusted: true, me: "eng" });
  const r = parse(await engineer.call("task_current", {}));
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.out.parent?.identifier, "WOR-2", "the Architect's task asked for it");
  assert.doesNotMatch(JSON.stringify(r.out.parts ?? []), /WOR-5/, "and the parts are its own, not the chief of staff's");
});

test("with no placement adjustment, task_current reads the parent as before", async () => {
  const { engineer } = world({ adjusted: false, me: "eng" });
  const r = parse(await engineer.call("task_current", {}));
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.out.parent?.identifier, "WOR-2");
});

test("a placed task whose 1200-char list row hides its marker is read whole, so it still groups by its requester", async () => {
  const { call, tasks } = world({ adjusted: true });
  // A long brief that would have put the marker past the cut before it led the description: the list row is cut, the marker with it.
  const long = `${"Detail. ".repeat(200)}`;
  tasks.sibling.description = `${long}${MARK("cur")}`;
  tasks.sibling.descriptionTruncated = true;
  const refused = parse(await call("task_delegate", { ...brief, marker: "api" }));
  assert.match(refused.error ?? "", /WOR-4 .* is already Kai's open task for this brief under WOR-2/);
});

test("a direct child whose cut list row hides its marker still groups by the requester it records", async () => {
  const { call, tasks } = world({ adjusted: true });
  // The board keeps the marker, but an older edit put it at the end: a direct child of the Architect whose row is cut there, and
  // whose marker names the chief of staff's task instead. Its row's `parentId` says WOR-2; only the whole task says otherwise.
  const long = "Detail. ".repeat(200);
  tasks.kid = { id: "kid", identifier: "WOR-7", title: "Write the docs", status: "in_progress", assigneeAgentId: "eng", parentId: "cur", createdByAgentId: "me", description: `${long}${MARK("root")}` };
  // It is the chief of staff's batch, not the Architect's: taking the cut row's `parentId` would refuse a fresh delegation of
  // the Architect's as a repeat of the chief of staff's task.
  const r = parse(await call("task_delegate", { ...brief, title: "Write the docs", description: "Document the API.", marker: "docs" }));
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.out?.created, true, "the Architect may delegate its own work: WOR-7 belongs to the chief of staff");
  assert.doesNotMatch(r.error ?? "", /WOR-7/);
});

test("a cut row whose full read fails is not counted under the placed parent", async () => {
  const w = world({ adjusted: true });
  const long = "Detail. ".repeat(200);
  w.tasks.sibling.description = `${long}${MARK("cur")}`;
  // Its row is cut and its single-task read fails: answering from the preview would file it under the placed parent (WOR-1).
  w.fail("sibling");
  const refused = parse(await w.call("task_delegate", { ...brief, marker: "api" }));
  // The row cannot be decided on, so the check does not answer: it fails rather than filing a second task on a guess.
  assert.equal(refused.created, undefined, "no delegation is filed on a guess");
  assert.match(refused.error ?? "", /503|unavailable|no such task/i, "the failed read is reported, not swallowed");
});

test("the duplicate check sees every task of the target agent, not just the first 50 under the parent", async () => {
  const { call, tasks } = world({ adjusted: true });
  // Fifty higher-ranked open tasks held by other agents come first; the older matching one, held by Kai, is behind them.
  for (let i = 0; i < 50; i++) tasks[`other${i}`] = { id: `other${i}`, identifier: `WOR-${100 + i}`, title: `Unrelated ${i}`, status: "in_progress", assigneeAgentId: "someone", parentId: "root", createdAt: `2026-11-25T10:${String(i).padStart(2, "0")}:00Z` };
  tasks.sibling.createdAt = "2026-11-20T00:00:00Z";
  tasks.chiefKid.createdAt = "2026-11-19T00:00:00Z";
  tasks.cur.createdAt = "2026-11-18T00:00:00Z";
  tasks.root.createdAt = "2026-11-17T00:00:00Z";
  tasks.sibling.createdAt = "2026-11-20T00:00:00Z";
  const refused = parse(await call("task_delegate", { ...brief, marker: "api" }));
  assert.match(refused.error ?? "", /WOR-4 .* is already Kai's open task/, "the matching task behind 50 others is found");
});

test("a delegation Paperclip filed at the top level is still found by the task that asked for it", async () => {
  const { call, tasks } = world({ adjusted: true });
  // No structural parent at all: the create sent no expectedParentId, so Paperclip wrote a standalone task. Its create origin
  // (the run's task) still names the requester, and the first marker says which task asked for it.
  tasks.sibling.parentId = undefined;
  tasks.sibling.from = "cur";
  const refused = parse(await call("task_delegate", { ...brief, marker: "api" }));
  assert.match(refused.error ?? "", /WOR-4 .* is already Kai's open task for this brief under WOR-2/);
  const fresh = parse(await call("task_delegate", { ...brief, title: "Add pagination", description: "Paginate the API's list endpoint.", marker: "paging" }));
  assert.equal(fresh.error, undefined, fresh.error);
  assert.equal(tasks.new1.parentId, "root");
});
