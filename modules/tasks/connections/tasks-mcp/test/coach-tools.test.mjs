// The Agent Coach's task tools against a fake Paperclip (and apps-mcp): delegate_to limits whom an agent may assign work to
// (keys, or an app's owner), and coach_record writes a record the board's coach_due parses, only with fleet-audit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.mjs";

const AGENTS = [
  { id: "me", name: "Agent Coach", metadata: { setupKey: "aidenhq:coach" } },
  { id: "pe", name: "Platform Engineer", metadata: { setupKey: "aidenhq:fleet-engineer" } },
  { id: "rk", name: "Roadmap Keeper", metadata: { setupKey: "aidenhq:roadmap-keeper" } },
  { id: "eng", name: "Software Engineer", metadata: { setupKey: "aidenhq:engineer" } },
];

async function call(entry, tool, args) {
  const created = [];
  const comments = [];
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/internal/apps") return send([{ name: "roadmap", owner: "roadmap-keeper" }]);
      if (url === "/api/agents/me") return send(AGENTS[0]);
      if (/\/agents$/.test(url)) return send(AGENTS);
      if (req.method === "POST" && url.endsWith("/comments")) return (comments.push(JSON.parse(body).body), send({ id: "c" }));
      if (req.method === "POST" && url.endsWith("/issues")) return (created.push(JSON.parse(body)), send({ id: "n", identifier: "WOR-9" }));
      if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-1", description: "" });
      if (url.includes("/issues")) return send([]);
      if (url.includes("/labels")) return send([]);
      res.statusCode = 404;
      res.end("{}");
    });
  };
  const agents = { me: { key: "coach", ...entry }, pe: { key: "fleet-engineer" }, rk: { key: "roadmap-keeper" }, eng: { key: "engineer" } };
  const r = await bridge({ handler, agents, task: "cur", run: "run-1" }).call(tool, args);
  const text = r.result.content[0].text;
  return { error: r.result.isError ? text : undefined, created, comments };
}
const ask = (assignee) => ({ title: "Fix", description: "evidence: WOR-3", marker: `coach:x:${assignee}`, assignee });
test("delegate_to: work goes only to the listed agents and app owners; anyone else is refused before anything is filed", async () => {
  const entry = { delegate_to: ["fleet-engineer", "app-owners"] };
  assert.equal((await call(entry, "task_create", ask("fleet-engineer"))).created[0].assigneeAgentId, "pe");
  assert.equal((await call(entry, "task_create", ask("roadmap-keeper"))).created[0].assigneeAgentId, "rk"); // owns an app
  const refused = await call(entry, "task_create", ask("engineer"));
  assert.match(refused.error, /only to fleet-engineer, app-owners/);
  assert.deepEqual(refused.created, []);
  assert.equal((await call({}, "task_create", ask("engineer"))).created[0].assigneeAgentId, "eng"); // no list: no limit
  AGENTS[3].metadata.setupKey = "aidenhq:fleet-engineer"; // forged metadata: the key comes from the directory, so still refused
  assert.match((await call(entry, "task_create", { ...ask("eng"), assignee: "Software Engineer" })).error ?? "", /isn't one of them|only to/);
  AGENTS[3].metadata.setupKey = "aidenhq:engineer";
});

test("coach_record writes a record coach_due can parse, and needs the fleet-audit role", async () => {
  const args = { agent_key: "roadmap-keeper", outcome: "reviewed", findings: 2, filed: ["WOR-7"], window_from: "2026-11-13T00:00:00Z" };
  const ok = await call({ roles: ["fleet-audit"], review_log: "log-1" }, "coach_record", args);
  assert.equal(ok.error, undefined);
  const rec = JSON.parse(/<!-- coach-review (\{.*\}) -->/.exec(ok.comments[0])[1]);
  assert.deepEqual([rec.agent_id, rec.outcome, rec.findings, rec.filed, rec.run_id], ["rk", "reviewed", 2, ["WOR-7"], "run-1"]);
  assert.match((await call({ roles: [], review_log: "log-1" }, "coach_record", args)).error, /fleet-audit role/);
});
