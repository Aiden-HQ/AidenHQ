// An agent in a computer may reach Paperclip through a route allowlist without GET /companies/<id>/labels (403 "Route not
// allowed"): task_create must still work, with no labels and with labels already in use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.ts";

async function create(args, existing) {
  const created = [];
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "DevOps Engineer" });
      if (url.endsWith("/agents")) return send([{ id: "a-fleet", name: "Fleet Ops", metadata: { setupKey: "aidenhq:fleet-ops" }, status: "idle" }, { id: "a-old", name: "Fleet Ops", metadata: { setupKey: "aidenhq:old" }, status: "terminated" }]);
      if (url.endsWith("/labels")) return send({ error: `Route not allowed: GET ${url}` }, 403);
      if (req.method === "POST" && url.endsWith("/issues")) return (created.push(JSON.parse(body)), send({ id: "n", identifier: "WOR-9", title: "t", status: "todo" }));
      if (existing && url.includes("/issues?")) return send([existing]);
      if (url.includes("/issues?")) return send(/status=todo/.test(url) ? [] : [{ id: "i", labels: [{ id: "00000000-0000-4000-8000-000000000001", name: "security" }] }]);
      if (url.startsWith("/api/companies/")) return send({ defaultResponsibleUserId: "u-owner" });
      send({});
    });
  };
  const r = await bridge({ handler, agents: { me: { key: "devops" } } }).call("task_create", { title: "t", description: "d", marker: "test:marker", ...args });
  return { r, created };
}

test("task_create without labels never reads /labels", async () => {
  const { r, created } = await create({});
  assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
  assert.deepEqual(created[0].labelIds, []);
});

test("task_create with a label resolves it from issues when /labels is not allowed", async () => {
  const { r, created } = await create({ labels: ["security"] });
  assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
  assert.deepEqual(created[0].labelIds, ["00000000-0000-4000-8000-000000000001"]);
});

test("task_create with an assignee assigns that agent and not the owner; an unknown one fails", async () => {
  const { r, created } = await create({ assignee: "fleet-ops" });
  assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
  assert.equal(created[0].assigneeAgentId, "a-fleet");
  assert.equal(created[0].assigneeUserId, undefined);
  assert.match(created[0].description, /^Filed by DevOps Engineer \(agent\)\. This is an agent request, not the owner's words\./);
  const bad = await create({ assignee: "nobody" });
  assert.equal(bad.r.result?.isError, true);
  assert.equal(bad.created.length, 0);
});

test("task_create status backlog parks an assigned task; without an assignee it stays todo for the owner", async () => {
  assert.equal((await create({ assignee: "fleet-ops", status: "backlog" })).created[0].status, "backlog");
  const mine = (await create({ status: "backlog" })).created[0];
  assert.deepEqual([mine.status, mine.assigneeUserId], ["todo", "u-owner"]);
});

test("a related marker with the source: prefix finds the task that carries it", async () => {
  const { r, created } = await create({ related_markers: ["source:slack:C1:1.2"] }, { id: "x", identifier: "WOR-1", title: "t", status: "todo", description: "d\n\n<!-- source:slack:C1:1.2 -->" });
  assert.match(r.result?.content?.[0]?.text, /"deduplicated": ?true/);
  assert.equal(created.length, 0);
});
