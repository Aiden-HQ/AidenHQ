// task_list mine: the caller's open work, incident runs included, and its chats handed back to the owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.mjs";

test("task_list mine: your open work incl. incident runs and chats handed back to the owner; not heartbeat runs or this run", async () => {
  const asked = [];
  const handler = (req, res) => {
    res.setHeader("content-type", "application/json");
    const send = (x) => res.end(JSON.stringify(x));
    if (req.url === "/api/agents/me") return send({ id: "me", companyId: "c", name: "Aiden" });
    if (req.url === "/api/companies/c") return send({ defaultResponsibleUserId: "owner" });
    asked.push(req.url);
    const q = new URL(req.url, "http://x").searchParams;
    if (q.get("assigneeAgentId") === "me") return send([
      { id: "a", identifier: "WOR-1", title: "App incident", assigneeAgentId: "me" },
      { id: "cur", identifier: "WOR-2", title: "Heartbeat: chief-of-staff", assigneeAgentId: "me" },
      { id: "c", identifier: "WOR-3", title: "Heartbeat: chief-of-staff", assigneeAgentId: "me" },
    ]);
    send([
      { id: "d", identifier: "WOR-4", title: "Build the app", assigneeUserId: "owner", description: "hi\n\n<!-- aidenhq-chat-agent:me -->" },
      { id: "e", identifier: "WOR-5", title: "Someone else's chat", assigneeUserId: "owner", description: "hi\n\n<!-- aidenhq-chat-agent:other -->" },
    ]);
  };
  const r = await bridge({ handler, agents: { me: { key: "chief-of-staff", roles: [] } }, task: "cur" }).call("task_list", { mine: true });
  assert.ok(!asked[0].includes("excludeRoutineExecutions")); // incident runs are routine runs
  assert.deepEqual(JSON.parse(r.result.content[0].text).tasks.map((t) => t.identifier), ["WOR-1", "WOR-4"]);
});
