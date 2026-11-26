// The owner's messages through the kernel (notify.ts): producers queue, the owner's router takes each once and sends each
// through a channel's transport with that channel's own token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel, readBody, serve } from "./helpers.ts";

test("queued by the board or a module, taken once by the router, sent through a channel's transport with its token", async (t) => {
  const seen = [];
  const tg = await serve(async (req, res) => { seen.push({ auth: req.headers.authorization, path: req.url, body: JSON.parse(await readBody(req)) }); res.writeHead(200, { "content-type": "application/json" }).end(seen.length > 1 ? '{"sent":false,"off":true}' : '{"sent":true}'); });
  t.after(() => tg.s.close());
  const modules = { modules: {
    "owner-channel": { roles: ["kernel.notify"], token: "router_token" },
    "channel-telegram": { privileged: ["speaks-as-owner"], channel: { transport: `${tg.url}/transport/send` }, token: "tg_token" },
    "channel-down": { privileged: ["speaks-as-owner"], channel: { transport: "http://127.0.0.1:1/transport/send" }, token: "down_token" },
    plain: { token: "plain_token" },
    dispatch: { roles: ["kernel.owner-notice"], token: "dispatch_token" },
  } };
  const k = await kernel(t, { modules, secrets: { router_token: "router-key", tg_token: "tg-key", down_token: "down-key", plain_token: "plain-key", dispatch_token: "dispatch-key" } });
  assert.equal((await k.v1("POST", "/v1/notify", { kind: "alert", text: "Fleet Ops is unreachable" })).status, 200);
  assert.equal((await k.v1("POST", "/v1/notify", { kind: "decision", text: "WOR-2 needs you", task: "WOR-2", dedupe_key: "asker:WOR-2" })).status, 200);
  assert.equal((await k.v1("POST", "/v1/notify", { kind: "shout", text: "x" })).status, 400);
  assert.equal((await k.v1("POST", "/v1/notify", { kind: "alert", text: "x" }, "plain-key")).status, 401);
  assert.equal((await k.v1("POST", "/v1/notify", { kind: "decision", text: "WOR-3 was stopped", task: "WOR-3" }, "dispatch-key")).status, 200, "a module with kernel.owner-notice");
  // Only the router takes; a taken message isn't handed over again while its lease runs, and goes once acknowledged.
  assert.equal((await k.v1("GET", "/v1/notify/take", undefined, "plain-key")).status, 403);
  const taken = (await k.v1("GET", "/v1/notify/take", undefined, "router-key")).json.messages;
  assert.deepEqual(taken.map(({ id, ...m }) => m), [
    { kind: "alert", text: "Fleet Ops is unreachable" },
    { kind: "decision", text: "WOR-2 needs you", task: "WOR-2", dedupe_key: "asker:WOR-2" },
    { kind: "decision", text: "WOR-3 was stopped", task: "WOR-3" },
  ]);
  assert.deepEqual((await k.v1("GET", "/v1/notify/take", undefined, "router-key")).json.messages, []);
  assert.equal((await k.v1("POST", "/v1/notify/ack", { ids: taken.map((m) => m.id) }, "plain-key")).status, 403);
  assert.deepEqual((await k.v1("POST", "/v1/notify/ack", { ids: taken.map((m) => m.id) }, "router-key")).json, { acked: 3 });
  // A send reaches the channel's transport with the channel's own token; a down transport is a plain "not sent".
  const msg = { kind: "alert", text: "hi" };
  assert.equal((await k.v1("POST", "/v1/notify/send", { to: "channel-telegram", message: msg }, "plain-key")).status, 403);
  assert.deepEqual((await k.v1("POST", "/v1/notify/send", { to: "channel-telegram", message: msg }, "router-key")).json, { sent: true });
  assert.deepEqual(seen, [{ auth: "Bearer tg-key", path: "/transport/send", body: msg }]);
  assert.equal((await k.v1("POST", "/v1/notify/send", { to: "channel-down", message: msg }, "router-key")).json.sent, false);
  // A channel that isn't set up says so: nothing to retry there.
  assert.equal((await k.v1("POST", "/v1/notify/send", { to: "channel-telegram", message: msg }, "router-key")).json.off, true);
  assert.equal((await k.v1("POST", "/v1/notify/send", { to: "plain", message: msg }, "router-key")).status, 404);
});

test("a push test reaches only the named transport and reports its answer", async (t) => {
  const hits = { tg: [] as unknown[], slack: [] as unknown[] };
  const tg = await serve(async (req, res) => { hits.tg.push(JSON.parse(await readBody(req))); res.writeHead(200, { "content-type": "application/json" }).end('{"sent":true}'); });
  const slack = await serve(async (req, res) => { hits.slack.push(JSON.parse(await readBody(req))); res.writeHead(502).end("{}"); });
  t.after(() => { tg.s.close(); slack.s.close(); });
  const modules = { modules: {
    "owner-channel": { roles: ["kernel.notify"], token: "router_token" },
    "channel-telegram": { privileged: ["speaks-as-owner"], channel: { transport: `${tg.url}/transport/send` }, token: "tg_token" },
    slack: { privileged: ["speaks-as-owner"], channel: { transport: `${slack.url}/transport/send` }, token: "slack_token" },
  } };
  const k = await kernel(t, { modules, secrets: { router_token: "router-key", tg_token: "tg-key", slack_token: "slack-key" } });
  assert.equal((await k.v1("POST", "/v1/notify/test", { to: "channel-telegram" }, "router-key")).status, 401, "the board's key only");
  assert.deepEqual((await k.v1("POST", "/v1/notify/test", { to: "channel-telegram" })).json, { sent: true });
  assert.equal(hits.tg.length, 1);
  assert.equal(hits.slack.length, 0, "only the named transport");
  const card = hits.tg[0] as { kind: string; inert?: string[]; actions?: unknown };
  assert.equal(card.kind, "decision");
  assert.deepEqual(card.inert, ["Looks good", "Not now"]);
  assert.equal(card.actions, undefined);
  const down = (await k.v1("POST", "/v1/notify/test", { to: "slack" })).json;
  assert.equal(down.sent, false);
  assert.match(down.reason, /502/);
  assert.equal((await k.v1("POST", "/v1/notify/test", { to: "nowhere" })).status, 404);
  // Nothing was queued for the router.
  assert.deepEqual((await k.v1("GET", "/v1/notify/take", undefined, "router-key")).json.messages, []);
});
