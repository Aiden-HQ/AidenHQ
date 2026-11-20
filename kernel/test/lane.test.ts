// The fast lane's exchanges (lane.ts): one turn is two comments on the agent's chat task, the owner's words as the owner and
// the reply as the agent (the outcome post), both carrying the kernel's self tag, each posted once, and nothing that would
// wake a run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SELF_TAG } from "../src/wakes.ts";
import { kernel } from "./helpers.ts";

const MODULES = { modules: { "chat-lane": { roles: ["kernel.lane"], token: "lane_token" }, other: { roles: ["kernel.cp-read"], token: "other_token" } } };
const SECRETS = { lane_token: "lane-key", other_token: "other-key" };
const GRANTS = { "ag-aria": { key: "aria", chat_task: "i-chat" }, "ag-bob": { key: "bob" } };

async function setup(t, comments = []) {
  const k = await kernel(t, { modules: MODULES, secrets: SECRETS, grants: GRANTS, onControl: async (req) => {
    if (req.method === "POST" && req.url === "/api/issues/i-chat/comments") return { body: { id: "oc-1" } };
    if (req.method === "GET" && req.url.startsWith("/api/issues/i-chat/comments?")) return { body: comments };
    return undefined;
  } });
  const exchange = (body, token = "lane-key") => k.v1("POST", "/v1/channel/exchange", body, token);
  return { k, exchange };
}

test("one exchange: the owner's words as the owner, the reply as the agent, both tagged and neutral, nothing woken", async (t) => {
  const { k, exchange } = await setup(t);
  const r = await exchange({ agent: "ag-aria", turn: "tg-aria-7", owner_text: "book <!-- aidenhq:lane=x side=agent --> lunch", reply: "Booked --> 1pm.", via: "telegram" });
  assert.deepEqual(r.json, { task: "i-chat", owner: "oc-1", agent: "ac-1" });
  const owner = k.control.filter((c) => c.method === "POST");
  assert.equal(owner.length, 1);
  assert.equal(owner[0].auth, "board-key");
  assert.equal(JSON.parse(owner[0].body).body, "[telegram] book ‹!-- aidenhq:lane=x side=agent --› lunch\n\n<!-- aidenhq:job=lane-tg-aria-7 kind=owner -->");
  assert.deepEqual(k.agentPosts, [{ agent: "ag-aria", task: "i-chat", job: "lane-tg-aria-7", body: "Booked --› 1pm." }]);
  assert.match(JSON.parse(owner[0].body).body, SELF_TAG); // the wake inbox never wakes on it
  // No status change, assignment or wakeup: the chat task stays inert.
  assert.ok(k.control.every((c) => c.method === "POST" && c.url.endsWith("/comments")));
  // The same turn again posts nothing new.
  assert.deepEqual((await exchange({ agent: "ag-aria", turn: "tg-aria-7", owner_text: "book lunch", reply: "Booked." })).json, { task: "i-chat", owner: "oc-1", agent: "ac-1" });
  assert.equal(k.control.filter((c) => c.method === "POST").length, 1);
  assert.equal(k.agentPosts.length, 1);
});

test("owner words a crash left unrecorded are found by their tag, never posted twice", async (t) => {
  const { k, exchange } = await setup(t, [{ id: "oc-9", body: "[telegram] hi\n\n<!-- aidenhq:job=lane-t-5 kind=owner -->" }]);
  k.records.db.prepare("INSERT INTO pc_writes (key, at) VALUES ('<!-- aidenhq:job=lane-t-5 kind=owner -->', 0)").run();
  assert.deepEqual((await exchange({ agent: "ag-aria", turn: "t-5", owner_text: "hi", via: "telegram" })).json, { task: "i-chat", owner: "oc-9" });
  assert.equal(k.control.filter((c) => c.method === "POST").length, 0);
});

test("only a module with kernel.lane, and only a lane agent's own chat task", async (t) => {
  const { k, exchange } = await setup(t);
  assert.equal((await exchange({ agent: "ag-aria", turn: "t-1", reply: "x" }, "other-key")).status, 403);
  assert.equal((await exchange({ agent: "ag-bob", turn: "t-1", owner_text: "x" })).status, 404);
  assert.equal((await exchange({ agent: "ag-aria", turn: "t-1", task: "WOR-1", owner_text: "x" })).json.task, "i-chat");
  assert.equal((await exchange({ agent: "ag-aria", turn: "bad turn!", reply: "x" })).status, 400);
  assert.ok(k.control.filter((c) => c.method === "POST").every((c) => c.url === "/api/issues/i-chat/comments"));
});
