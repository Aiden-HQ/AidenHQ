// task_file_upload: an agent attaches a file to the task it is working on (a `file` deliverable), and the board refuses
// another agent's task. The tasks module against a fake Paperclip and a fake board's internal route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, parse, rpc } from "./helpers.ts";

function run() {
  const files = [];
  const issues = {
    mine: { id: "mine", identifier: "WOR-1", title: "Write the report", status: "in_progress", assigneeAgentId: "me" },
    other: { id: "other", identifier: "WOR-2", title: "Someone else's", status: "in_progress", assigneeAgentId: "them" },
  };
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Alpha" });
      const one = /^\/api\/issues\/([^/?]+)\/attachments$/.exec(url);
      if (one && req.method === "GET") return send(files.filter((f) => f.issueId === (issues[one[1]] ?? Object.values(issues).find((i) => i.identifier === one[1]))?.id));
      const byRef = /^\/api\/issues\/([^/?]+)$/.exec(url);
      if (byRef) return send(issues[byRef[1]] ?? Object.values(issues).find((i) => i.identifier === byRef[1]));
      send({}, 404);
    });
  };
  // The board's internal listener: the agent's assertion is already checked by requireAgentTool in the real route; here the
  // test proves the ownership guard and the upload body (name, type?, data base64).
  const board = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      const m = /^\/internal\/issues\/([^/]+)\/files$/.exec(req.url ?? "");
      if (!m) return send({ error: "not found" }, 404);
      const ref = decodeURIComponent(m[1]);
      const issue = issues[ref] ?? Object.values(issues).find((i) => i.identifier === ref);
      if (!issue) return send({ error: "not found" }, 404);
      const input = JSON.parse(body);
      if (issue.assigneeAgentId !== "me") return send({ error: "a file may be attached only to the task assigned to you" }, 403);
      const data = Buffer.from(String(input.data), "base64");
      const file = { id: `f${files.length + 1}`, issueId: issue.id, originalFilename: input.name, contentType: input.type || "application/octet-stream", byteSize: data.length, createdAt: new Date().toISOString(), data };
      files.push(file);
      // The board's reply: the new file as fileViews lists it.
      return send({ file: { id: file.id, name: file.originalFilename, type: file.contentType, size: file.byteSize, createdAt: file.createdAt, by: "agent", textOf: null } });
    });
  };
  return { files, ...bridge({ handler, board, agents: { me: { key: "alpha", roles: [] }, them: { key: "beta", roles: [] } }, agent: "me", task: "mine" }) };
}

test("task_file_upload attaches a file to the caller's own task and task_files lists it", async () => {
  const r = run();
  const up = parse(await r.call("task_file_upload", { issue: "WOR-1", name: "report.md", type: "text/markdown", text: "# Report\n" }));
  assert.equal(up.error, undefined, up.error);
  assert.equal(up.out.file.name, "report.md");
  assert.equal(up.out.file.size, 9);
  assert.equal(r.files[0].data.toString(), "# Report\n");
  const list = parse(await r.call("task_files", { issue: "WOR-1" }));
  assert.deepEqual(list.out.files.map((f) => [f.name, f.id]), [["report.md", up.out.file.id]]);
  // Base64 bytes work too (a binary file is not forced through text).
  const bin = parse(await r.call("task_file_upload", { issue: "WOR-1", name: "chart.png", data: Buffer.from("png-bytes").toString("base64") }));
  assert.equal(bin.error, undefined, bin.error);
  assert.equal(r.files[1].data.toString(), "png-bytes");
});

test("task_file_upload refuses another agent's task, and needs exactly one of data and text", async () => {
  const r = run();
  assert.match(parse(await r.call("task_file_upload", { issue: "WOR-2", name: "x.txt", text: "no" })).error, /only to the task assigned to you/);
  assert.equal(r.files.length, 0);
  assert.match(parse(await r.call("task_file_upload", { issue: "WOR-1", name: "x.txt" })).error, /either as `data`/);
  assert.match(parse(await r.call("task_file_upload", { issue: "WOR-1", name: "x.txt", text: "a", data: "YQ==" })).error, /either as `data`/);
  assert.equal(r.files.length, 0);
});

test("task_file_upload is offered as a write tool that takes base64 data or text", async () => {
  const tool = (await rpc({ method: "tools/list" })).json.result.tools.find((t) => t.name === "task_file_upload");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.deepEqual(tool.inputSchema.required, ["issue", "name"]);
  assert.match(tool.description, /base64/);
});
