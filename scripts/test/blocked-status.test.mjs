// A dependency wait is recorded as a first-class blocker: the task API only lets an agent enter blocked
// with an unresolved blocker (or a pending interaction/approval), and the recovery checker reads those
// relations. paperclip-tasks-mcp against a fake task API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bridge = join(dirname(fileURLToPath(import.meta.url)), "../../services/paperclip-tasks-mcp/paperclip-tasks-mcp.mjs");

async function call({ tool = "task_set_status", args, blockers = [] }) {
  const issues = new Map();
  const add = (i) => {
    issues.set(i.id, i);
    if (i.identifier) issues.set(i.identifier, i);
  };
  add({ id: "cur", identifier: "WOR-3594", title: "Record the wait", status: "in_progress", assigneeAgentId: "me", createdByAgentId: "roadmap-keeper", blockedBy: [...blockers] });
  add({ id: "child", identifier: "WOR-3583", title: "Dependency", status: "in_progress", assigneeAgentId: "linus" });
  add({ id: "finished", identifier: "WOR-3582", title: "Already shipped", status: "done", assigneeAgentId: "sam" });
  const patches = [];
  const comments = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (status, x) => (res.statusCode = status, res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send(200, { id: "me", name: "Roadmap Keeper" });
      if (url.startsWith("/api/companies/")) return send(200, { defaultResponsibleUserId: "owner" });
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?/.exec(url);
      const issue = m ? issues.get(decodeURIComponent(m[1])) : undefined;
      if (!m || !issue) return send(404, {});
      if (m[2] && req.method === "GET") return send(200, comments.map((c) => ({ body: c })));
      if (m[2] && req.method === "POST") return (comments.push(JSON.parse(body).body), send(200, { id: "c1" }));
      if (req.method === "PATCH") {
        const patch = JSON.parse(body || "{}");
        patches.push(patch);
        if (Array.isArray(patch.blockedByIssueIds)) issue.blockedBy = patch.blockedByIssueIds.map((id) => issues.get(id)).filter(Boolean);
        if (patch.status === "blocked") {
          const unresolved = (issue.blockedBy ?? []).filter((b) => !["done", "cancelled"].includes(b.status));
          if (!unresolved.length) return send(422, { error: "Entering blocked requires unresolved blockers" });
        }
        if (patch.status) issue.status = patch.status;
        if (patch.comment) comments.push(patch.comment);
        return send(200, { ...issue });
      }
      return send(200, { ...issue });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const grants = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
  writeFileSync(grants, JSON.stringify({ agents: { me: { key: "roadmap-keeper", roles: [], tools: { paperclip_tasks: ["task_set_status"] } } } }));
  const child = spawn(process.execPath, [bridge], {
    env: {
      PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`,
      PAPERCLIP_API_KEY: "k",
      PAPERCLIP_TASK_ID: "cur",
      PAPERCLIP_COMPANY_ID: "co",
      AIDENHQ_GRANTS_FILE: grants,
      AIDENHQ_BOARD_TOKEN: "",
      AIDENHQ_RUN_TOKEN: "",
    },
  });
  let out = "";
  const reply = new Promise((resolve) => child.stdout.on("data", (d) => { out += d; const line = out.split("\n").find((l) => l.includes('"id":1')); if (line) resolve(JSON.parse(line)); }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
  const r = await reply;
  child.kill();
  server.close();
  return { error: r.result?.isError ? r.result.content[0].text : undefined, result: r.result?.isError ? undefined : JSON.parse(r.result.content[0].text), patches, comments };
}

test("task_set_status blocked records the named task as a first-class blocker", async () => {
  const { error, result, patches } = await call({ args: { issue: "cur", status: "blocked", blocked_by: "WOR-3583", comment: "Waiting on the child." } });
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ status: "blocked", blockedByIssueIds: ["child"], comment: "Waiting on the child." }]);
  assert.equal(result.status, "blocked");
});

test("task_set_status blocked keeps an open blocker it already has", async () => {
  const child = { id: "child", identifier: "WOR-3583", title: "Dependency", status: "in_progress" };
  const { error, result, patches } = await call({ args: { issue: "cur", status: "blocked" }, blockers: [child] });
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ status: "blocked", blockedByIssueIds: ["child"] }]);
  assert.equal(result.status, "blocked");
});

test("task_set_status blocked without a target is refused", async () => {
  const { error, patches } = await call({ args: { issue: "cur", status: "blocked" } });
  assert.match(error, /needs blocked_by/);
  assert.deepEqual(patches, []);
});

test("task_set_status blocked by a finished task is refused", async () => {
  const { error, patches } = await call({ args: { issue: "cur", status: "blocked", blocked_by: "WOR-3582" } });
  assert.match(error, /it is done/);
  assert.deepEqual(patches, []);
});

test("task_set_status todo and in_progress send no blocker relation", async () => {
  for (const status of ["todo", "in_progress"]) {
    const { error, patches } = await call({ args: { issue: "cur", status } });
    assert.equal(error, undefined);
    assert.deepEqual(patches, [{ status }]);
  }
});
