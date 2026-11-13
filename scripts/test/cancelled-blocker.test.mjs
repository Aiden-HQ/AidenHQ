// Paperclip counts a cancelled blocker as unresolved, so a dependent could never move to done,
// cancelled or back to the owner. The bridge clears the cancelled relation, names it, and retries;
// a live blocker still refuses. paperclip-tasks-mcp against a fake Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bridge = join(dirname(fileURLToPath(import.meta.url)), "../../services/paperclip-tasks-mcp/paperclip-tasks-mcp.mjs");

async function call({ blockers, tool = "task_set_status", args = { issue: "cur", status: "done" } }) {
  const relations = new Map(blockers.map((b) => [b.id, b]));
  const issue = { id: "cur", identifier: "WOR-2355", title: "Triage the fleet", status: "blocked", assigneeAgentId: "me", createdByAgentId: "aiden" };
  const patches = [];
  const comments = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (status, x) => (res.statusCode = status, res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send(200, { id: "me", name: "Aiden" });
      if (url.startsWith("/api/companies/")) return send(200, { defaultResponsibleUserId: "owner" });
      const m = /^\/api\/issues\/([^/?]+)(\/comments)?/.exec(url);
      if (!m || m[1] !== "cur") return send(404, {});
      if (m[2] && req.method === "GET") return send(200, comments.map((c) => ({ body: c })));
      if (m[2] && req.method === "POST") return (comments.push(JSON.parse(body).body), send(200, { id: "c1" }));
      if (req.method === "PATCH") {
        const patch = JSON.parse(body);
        patches.push(patch);
        if (Array.isArray(patch.blockedByIssueIds)) {
          for (const id of [...relations.keys()]) if (!patch.blockedByIssueIds.includes(id)) relations.delete(id);
          return send(200, { ...issue, blockedBy: [...relations.values()] });
        }
        if (patch.status && patch.status !== issue.status) {
          const unresolved = [...relations.values()].filter((b) => b.status !== "done");
          if (unresolved.length) return send(409, { error: "Issue follow-up blocked by unresolved blockers", details: { issueId: "cur", unresolvedBlockerIssueIds: unresolved.map((b) => b.id) } });
        }
        if (patch.status) issue.status = patch.status;
        if (patch.comment) comments.push(patch.comment);
        return send(200, { ...issue, blockedBy: [...relations.values()] });
      }
      return send(200, { ...issue, blockedBy: [...relations.values()] });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const grants = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
  writeFileSync(grants, JSON.stringify({ agents: { me: { key: "aiden", roles: [], tools: { paperclip_tasks: ["task_finish", "task_set_status", "task_handoff"] } } } }));
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`, PAPERCLIP_API_KEY: "k", PAPERCLIP_TASK_ID: "cur", PAPERCLIP_COMPANY_ID: "co", AIDENHQ_GRANTS_FILE: grants },
  });
  let out = "";
  const reply = new Promise((resolve) => child.stdout.on("data", (d) => { out += d; const line = out.split("\n").find((l) => l.includes('"id":1')); if (line) resolve(JSON.parse(line)); }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
  const r = await reply;
  child.kill();
  server.close();
  return { error: r.result?.isError ? r.result.content[0].text : undefined, patches, comments };
}

const cancelled = { id: "b1", identifier: "WOR-2431", title: "Stale design review", status: "cancelled" };

test("task_set_status done releases a cancelled blocker and names it", async () => {
  const { error, patches, comments } = await call({ blockers: [cancelled] });
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ status: "done" }, { blockedByIssueIds: [] }, { status: "done" }]);
  assert.match(comments.join("\n"), /WOR-2431 \(cancelled\)/);
});

test("task_finish closes a task whose only blocker is cancelled", async () => {
  const { error, patches } = await call({ blockers: [cancelled], tool: "task_finish", args: { comment: "Done: triaged." } });
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ status: "done", comment: "Done: triaged." }, { blockedByIssueIds: [] }, { status: "done", comment: "Done: triaged." }]);
});

test("task_handoff releases a cancelled blocker too", async () => {
  const { error, patches } = await call({ blockers: [cancelled], tool: "task_handoff", args: { issue: "cur", comment: "Back to you." } });
  assert.equal(error, undefined);
  assert.deepEqual(patches, [{ assigneeUserId: "owner", assigneeAgentId: null, status: "todo", comment: "Back to you." }, { blockedByIssueIds: [] }, { assigneeUserId: "owner", assigneeAgentId: null, status: "todo", comment: "Back to you." }]);
});

test("an active blocker still refuses and the relation is kept", async () => {
  const active = { id: "b2", identifier: "WOR-2430", title: "Open review", status: "in_progress" };
  const { error, patches } = await call({ blockers: [active] });
  assert.match(error, /409/);
  assert.deepEqual(patches, [{ status: "done" }]);
});

test("a cancelled blocker beside a live one does not clear anything", async () => {
  const active = { id: "b2", identifier: "WOR-2430", title: "Open review", status: "in_progress" };
  const { error, patches } = await call({ blockers: [cancelled, active] });
  assert.match(error, /409/);
  assert.deepEqual(patches, [{ status: "done" }]);
});
