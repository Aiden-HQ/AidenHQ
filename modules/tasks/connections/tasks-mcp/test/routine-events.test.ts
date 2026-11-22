// routine_events reads the run's batch from the kernel (GET /v1/events/batch/<id>) with this call's assertion: the kernel binds
// it to the calling job's task, agent and routine; nothing here reaches Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, cpSeen, eventsSeen, parse } from "./helpers.ts";

test("routine_events passes the caller through", async () => {
  const { call } = bridge({ agents: { me: { key: "alpha" } }, task: "task-a", run: "run-a", handler: (req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "me" })) });
  cpSeen.length = 0;
  const batch = "0b6c3f1e-8a2d-4c5e-9f10-123456789abc";
  const r = parse(await call("routine_events", { batch }));
  assert.equal(r.out.count, 1);
  const seen = eventsSeen.at(-1);
  assert.equal(seen.path, `/v1/events/batch/${batch}`);
  assert.ok(seen.moduleKey && seen.caller, "the module's key and the call's assertion go along");
  assert.ok(cpSeen.every((c) => c.method === "GET" && c.path === "/api/agents/me"), "no Paperclip write");
  assert.match(JSON.stringify(parse(await call("routine_events", { batch: "../../v1/agents" }))), /batch is the batch id/);
});
