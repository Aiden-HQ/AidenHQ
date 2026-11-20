// The Agent Coach's task tools against a fake Paperclip: coach_record writes a record the board's coach_due parses, only with fleet-audit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.ts";

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
test("coach_record writes a record coach_due can parse, and needs the fleet-audit role", async () => {
  const args = { agent_key: "roadmap-keeper", outcome: "reviewed", findings: 2, filed: ["WOR-7"], window_from: "2026-11-13T00:00:00Z" };
  const ok = await call({ roles: ["fleet-audit"], review_log: "log-1" }, "coach_record", args);
  assert.equal(ok.error, undefined);
  const rec = JSON.parse(/<!-- coach-review (\{.*\}) -->/.exec(ok.comments[0])[1]);
  assert.deepEqual([rec.agent_id, rec.outcome, rec.findings, rec.filed, rec.run_id], ["rk", "reviewed", 2, ["WOR-7"], "run-1"]);
  assert.match((await call({ roles: [], review_log: "log-1" }, "coach_record", args)).error, /fleet-audit role/);
});
