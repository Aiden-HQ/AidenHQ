// The HTTP endpoint: its own key only, the caller assertion on every tools/call, and nothing of one caller in another's call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertion, bridge, parse, rpc } from "./helpers.ts";

test("POST /mcp behind the service key; a tools/call needs a valid assertion for this module", async () => {
  assert.equal((await rpc({ method: "tools/list" }, { authorization: "Bearer wrong" })).status, 401);
  const list = await rpc({ method: "tools/list" });
  assert.ok(list.json.result.tools.some((t) => t.name === "task_comment"));
  assert.equal((await rpc({ method: "notifications/initialized", id: undefined })).status, 202);
  assert.equal((await rpc({ method: "initialize", params: {} })).json.result.serverInfo.name, "paperclip-tasks");
  const call = (h) => rpc({ method: "tools/call", params: { name: "task_get", arguments: { issue: "WOR-1" } } }, h);
  for (const h of [{}, { "x-aidenhq-caller": assertion({ aud: "other" }) }, { "x-aidenhq-caller": assertion({ exp: 1 }) }, { "x-aidenhq-caller": `${assertion().slice(0, -4)}AAAA` }])
    assert.match((await call(h)).json.result.content[0].text, /^Refused: /);
});

test("two agents on one server: each its own run counts, its own task and its own company", async () => {
  const { call } = bridge({
    agents: { a: { key: "alpha" }, b: { key: "beta" } },
    agent: "a",
    handler: async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const send = (x) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(x));
      const who = req.headers.authorization; // the kernel's credential for the caller
      if (req.url === "/api/agents/me") return send({ id: callerOf(who), companyId: `co-${callerOf(who)}` });
      if (req.url.startsWith("/api/issues/")) return send({ id: req.url.split("/")[3], identifier: "WOR-1", title: "t", status: "todo" });
      if (req.url.includes("/advisor/")) return send({ choices: [{ message: { content: "ok" } }] });
      send([]);
    },
  });
  // The fake kernel forwards one credential for everyone: who is asking is in the assertion, so track the last caller.
  let last = "a";
  const callerOf = () => last;
  const A = { agent: "a", key: "alpha", roles: [], task: "task-a", run: "run-a" };
  const B = { agent: "b", key: "beta", roles: [], task: "task-b", run: "run-b" };
  const as = async (who, name, args) => ((last = who.agent), parse(await call(name, args, who)));
  const q = "retry the failing deploy, or roll back first? facts attached";
  for (let i = 0; i < 5; i++) assert.ok((await as(A, "advisor_ask", { question: q })).out);
  assert.match((await as(A, "advisor_ask", { question: q })).error, /advisor_limit/);
  assert.equal((await as(B, "advisor_ask", { question: q })).out.calls_left, 4);
  assert.equal((await as(B, "task_current", {})).out.task.id, "task-b");
  assert.equal((await as(A, "task_current", {})).out.task.id, "task-a");
});
