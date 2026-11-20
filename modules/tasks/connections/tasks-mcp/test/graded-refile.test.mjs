// A delegation repeated under the same parent and marker with a corrected deliverable re-files the rubric on the existing
// task (WOR-882): the correction lands where the work is, keeping its comments, files and runs. A plain retry of the same
// delegation files nothing, and so does one on a task already closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.mjs";

const RUBRIC = ["merged into main", "checks green on the head", "the totals page shows the VAT line"];
/** A fake Paperclip + grading module: one open task `new` the caller filed, with a rubric already on file. */
function world({ status = "in_progress", filed = { rubric: RUBRIC, deliverable: { kind: "pr", ref: "acme/app" } } } = {}) {
  const seen = { reads: [], filed: [] };
  const existing = {
    id: "new", identifier: "WOR-9", title: "Fix the total", status, parentId: "cur", assigneeAgentId: "eng", createdByAgentId: "cos",
    description: "Delegated by Aiden (agent) from WOR-5. This is an agent request, not the owner's words.\n\nShow VAT.\n\n<!-- source:delegate:WOR-5:fix-vat -->",
  };
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      const json = body ? JSON.parse(body) : {};
      if (req.method === "GET" && /^\/grades\//.test(url)) return (seen.reads.push(url.slice("/grades/".length)), send({ grade: filed }));
      if (url === "/grades") return (seen.filed.push(json), send({ created: false, state: "open" }));
      if (url === "/api/agents/me") return send({ id: "cos", name: "Aiden" });
      if (url.endsWith("/agents")) return send([{ id: "eng", name: "Kai", status: "idle", metadata: { setupKey: "aidenhq:engineer-openrouter", runnerEngine: true } }]);
      // The marker lookup: the existing task carries this delegation's source marker.
      if (req.method === "GET" && /\/companies\/[^/]+\/issues\?/.test(url)) return send([existing]);
      if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-5", title: "t", status: "in_progress", assigneeAgentId: "cos", parentId: null });
      send([]);
    });
  };
  const agents = { cos: { key: "chief-of-staff", roles: [] }, eng: { key: "engineer-openrouter", roles: [], graded: true } };
  const b = bridge({ handler, board: handler, agents, agent: "cos", task: "cur" });
  return { ...seen, b, seen };
}

const args = { agent: "Kai", title: "Fix the total", description: "Show VAT on the totals page of acme/app.", marker: "fix-vat", rubric: RUBRIC, deliverable: { kind: "pr", ref: "acme/app" } };

test("a corrected deliverable re-files on the existing task, reading its filed grade first", async () => {
  const w = world();
  const r = await w.b.call("task_delegate", { ...args, deliverable: { kind: "app", ref: "acme-app" } });
  assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.identifier, "WOR-9");
  assert.equal(out.created, false);
  assert.equal(out.refiled, true);
  assert.deepEqual(w.seen.reads, ["new"], "it read the task's filed grade");
  assert.deepEqual(w.seen.filed, [{ issue: "new", rubric: RUBRIC, deliverable: { kind: "app", ref: "acme-app" } }], "it re-filed on the same task");
});

test("a plain retry of the same delegation files nothing", async () => {
  const w = world();
  const r = await w.b.call("task_delegate", args);
  assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.identifier, "WOR-9");
  assert.equal(out.created, false);
  assert.equal(out.refiled, undefined);
  assert.deepEqual(w.seen.reads, ["new"], "it still read the filed grade");
  assert.deepEqual(w.seen.filed, [], "a byte-identical filing files nothing");
});

test("a task already closed is left untouched", async () => {
  for (const status of ["done", "cancelled"]) {
    const w = world({ status });
    const r = await w.b.call("task_delegate", { ...args, deliverable: { kind: "app", ref: "acme-app" } });
    assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
    const out = JSON.parse(r.result.content[0].text);
    assert.equal(out.created, false);
    assert.equal(out.refiled, undefined);
    assert.deepEqual(w.seen.reads, [], "no grade read on a closed task");
    assert.deepEqual(w.seen.filed, [], "and nothing re-filed");
  }
});
