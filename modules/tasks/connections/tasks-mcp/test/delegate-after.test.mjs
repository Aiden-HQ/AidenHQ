// A delegation that waits on other tasks (`after`) is filed parked, then blocked on the open ones: it never runs before they
// close (the kernel moves it to todo and wakes its agent then). A closed one is already past; the parent can't be one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, parse } from "./helpers.mjs";

test("a delegation after an open sibling is filed blocked on it, never todo; a closed one is skipped; the parent is refused", async () => {
  const writes = [];
  const tasks = { cur: { id: "cur", identifier: "WOR-5", status: "in_progress", assigneeAgentId: "cos" }, a: { id: "a", identifier: "WOR-6", status: "in_progress" }, b: { id: "b", identifier: "WOR-7", status: "done" } };
  const byRef = (r) => Object.values(tasks).find((t) => t.id === r || t.identifier === r);
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "cos", name: "Aiden" });
      if (url.endsWith("/agents")) return send([{ id: "eng", name: "Kai", metadata: { setupKey: "aidenhq:engineer-openrouter" }, status: "idle", reportsTo: "cos" }]);
      if (req.method === "POST" && url.endsWith("/issues")) return (writes.push(["POST", JSON.parse(body)]), send({ id: "new", identifier: "WOR-9", status: JSON.parse(body).status, createdByAgentId: "cos" }));
      if (req.method === "PATCH") return (writes.push(["PATCH", JSON.parse(body)]), send({ id: "new", identifier: "WOR-9" }));
      const m = /^\/api\/issues\/([^/?]+)$/.exec(url);
      if (m) return byRef(m[1]) ? send(byRef(m[1])) : send({ error: "not found" }, 404);
      send([]);
    });
  };
  const { call } = bridge({ handler, agents: { cos: { key: "chief-of-staff" }, eng: { key: "engineer-openrouter" } }, agent: "cos", task: "cur" });
  const brief = { agent: "Kai", title: "Ship the second half", description: "Build on WOR-6's API.", deliverable: { kind: "none" } };

  const r = parse(await call("task_delegate", { ...brief, after: ["WOR-6", "WOR-7"] }));
  assert.equal(r.out.status, "blocked");
  assert.equal(writes[0][1].status, "backlog", "filed parked: nothing runs it yet");
  assert.deepEqual(writes[1], ["PATCH", { status: "blocked", blockedByIssueIds: ["a"] }], "blocked on the open one only");
  assert.ok(!writes.some(([, b]) => b.status === "todo"), "never todo before its blocker closes");

  writes.length = 0;
  assert.match(parse(await call("task_delegate", { ...brief, after: ["WOR-5"] })).error, /WOR-5 is the task you delegate from/);
  assert.equal(writes.length, 0, "nothing filed");
});
