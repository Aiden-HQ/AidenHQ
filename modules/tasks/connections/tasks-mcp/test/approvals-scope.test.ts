// task_approvals is in scripts/computers.ts PUBLIC_TASKS, so an Engineer without private_reads may call it: that promise
// holds only while it reads the run's own task. Another task is refused before the board is asked, exactly as task_finish
// refuses an `issue` that is not the run's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.ts";

const ISSUES = { "WOR-1": { id: "cur", identifier: "WOR-1", status: "in_progress", assigneeAgentId: "me" }, "WOR-9": { id: "other", identifier: "WOR-9", status: "in_progress", assigneeAgentId: "someone" } };

/** One call as `agents.me`; `asked` records the issue the board was asked about. */
async function call(grant, issue) {
  const asked = [];
  const handler = (req, res) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Engineer" });
      if (url.startsWith("/api/companies/")) return send({ defaultResponsibleUserId: "owner" });
      const m = /^\/api\/issues\/([^/?]+)$/.exec(url);
      if (m) return send(ISSUES[m[1]] ?? Object.values(ISSUES).find((i) => i.identifier === decodeURIComponent(m[1]!)) ?? {});
      res.statusCode = 404;
      res.end("{}");
    });
  };
  const board = (req, res) => {
    req.resume();
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      asked.push(u.searchParams.get("issue"));
      res.setHeader("content-type", "application/json").end(JSON.stringify({ approvals: [] }));
    });
  };
  const r = await bridge({ handler, board, agents: { me: grant }, task: "cur" }).call("task_approvals", { issue });
  return { error: r.result?.isError ? r.result.content[0].text : undefined, asked };
}

const engineer = { key: "engineer", roles: ["platform-engineer"], profile: "engineer" };

test("an Engineer without private_reads reads its own run task, by id or identifier", async () => {
  assert.deepEqual(await call(engineer, "cur"), { error: undefined, asked: ["cur"] });
  assert.deepEqual(await call(engineer, "WOR-1"), { error: undefined, asked: ["WOR-1"] });
});

test("an Engineer without private_reads is refused another task, and the board is never asked", async () => {
  const other = await call(engineer, "WOR-9");
  assert.match(other.error, /without private reads you read only the task this run is working on/);
  assert.deepEqual(other.asked, [], "refused before the board call");
  assert.match((await call(engineer, "other")).error, /without private reads you read only the task this run is working on/, "an id, not only an identifier");
});

test("an Engineer with private_reads, or any other agent, still reads any task", async () => {
  assert.deepEqual(await call({ ...engineer, private_reads: true }, "WOR-9"), { error: undefined, asked: ["WOR-9"] });
  assert.deepEqual(await call({ key: "chief-of-staff", roles: [] }, "WOR-9"), { error: undefined, asked: ["WOR-9"] });
});
