// The owner's messages through the kernel (notify.ts): producers queue, the owner's router takes each once and sends each
// through a channel's transport with that channel's own token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel, readBody, serve } from "./helpers.mjs";

test("queued by the board or the runner, taken once by the router, sent through a channel's transport with its token", async (t) => {
  const seen = [];
  const tg = await serve(async (req, res) => { seen.push({ auth: req.headers.authorization, path: req.url, body: JSON.parse(await readBody(req)) }); res.writeHead(200, { "content-type": "application/json" }).end(seen.length > 1 ? '{"sent":false,"off":true}' : '{"sent":true}'); });
  t.after(() => tg.s.close());
  const modules = { modules: {
    "owner-channel": { roles: ["kernel.notify"], token: "router_token" },
    "channel-telegram": { privileged: ["speaks-as-owner"], channel: { transport: `${tg.url}/transport/send` }, token: "tg_token" },
    "channel-down": { privileged: ["speaks-as-owner"], channel: { transport: "http://127.0.0.1:1/transport/send" }, token: "down_token" },
    plain: { token: "plain_token" },
  } };
  const k = await kernel(t, { modules, secrets: { router_token: "router-key", tg_token: "tg-key", down_token: "down-key", plain_token: "plain-key" } });
  assert.equal((await k.v1("POST", "/v1/notify", { kind: "alert", text: "Fleet Ops is unreachable" })).status, 200);
  assert.equal((await k.v1("POST", "/v1/notify", { kind: "decision", text: "WOR-2 needs you", task: "WOR-2", dedupe_key: "asker:WOR-2" }, "the-runners-key")).status, 200);
  assert.equal((await k.v1("POST", "/v1/notify", { kind: "shout", text: "x" })).status, 400);
  assert.equal((await k.v1("POST", "/v1/notify", { kind: "alert", text: "x" }, "plain-key")).status, 401);
  // Only the router takes, and each message once.
  assert.equal((await k.v1("GET", "/v1/notify/take", undefined, "plain-key")).status, 403);
  assert.deepEqual((await k.v1("GET", "/v1/notify/take", undefined, "router-key")).json.messages, [
    { kind: "alert", text: "Fleet Ops is unreachable" },
    { kind: "decision", text: "WOR-2 needs you", task: "WOR-2", dedupe_key: "asker:WOR-2" },
  ]);
  assert.deepEqual((await k.v1("GET", "/v1/notify/take", undefined, "router-key")).json.messages, []);
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
