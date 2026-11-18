// The owner's messages through the kernel (notify.ts): producers queue, the owner's router takes each once and sends each
// through a channel's transport with that channel's own token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel, readBody, serve } from "./helpers.mjs";

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
  // Only the router takes, and each message once.
  assert.equal((await k.v1("GET", "/v1/notify/take", undefined, "plain-key")).status, 403);
  assert.deepEqual((await k.v1("GET", "/v1/notify/take", undefined, "router-key")).json.messages, [
    { kind: "alert", text: "Fleet Ops is unreachable" },
    { kind: "decision", text: "WOR-2 needs you", task: "WOR-2", dedupe_key: "asker:WOR-2" },
    { kind: "decision", text: "WOR-3 was stopped", task: "WOR-3" },
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

test("a transport is a compose service: an address, localhost or a name that resolves to loopback gets no token", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createNotify } = await import("../src/notify.ts");
  const hit = [];
  const resolver = { resolve: async (u) => (hit.push(u), { host: "127.0.0.1", port: 1, path: "/transport/send" }), forget: () => {} };
  const ch = (transport) => ({ privileged: ["speaks-as-owner"], channel: { transport }, token: "t" });
  const n = createNotify({ db: new DatabaseSync(":memory:"), secret: () => "key", resolver, modules: () => ({ modules: { ip: ch("http://169.254.169.254:80/x"), local: ch("http://localhost:8089/x"), named: ch("http://telegram:8089/x") } }) });
  const send = (to) => n.send(["kernel.notify"], { to, message: { kind: "done", text: "x" } }).then((r) => r, (e) => ({ status: e.status }));
  assert.deepEqual(await send("ip"), { status: 403 });
  assert.deepEqual(await send("local"), { status: 403 });
  assert.deepEqual(hit, []);
  assert.deepEqual(await send("named"), { sent: false, reason: "unreachable (it resolves to loopback)" });
});

test("a credential goes only to the private owner chat, never to the router; kept until that chat takes it", async (t) => {
  const seen = [];
  let up = false;
  const tg = await serve(async (req, res) => { seen.push(JSON.parse(await readBody(req)).text); res.writeHead(up ? 200 : 503, { "content-type": "application/json" }).end(up ? '{"sent":true}' : "{}"); });
  const slack = await serve(async (req, res) => { seen.push(`slack: ${JSON.parse(await readBody(req)).text}`); res.writeHead(200).end('{"sent":true}'); });
  t.after(() => { tg.s.close(); slack.s.close(); });
  const { DatabaseSync } = await import("node:sqlite");
  const { createNotify } = await import("../src/notify.ts");
  const { createResolver } = await import("../src/net.ts");
  const modules = { modules: {
    "channel-telegram": { privileged: ["speaks-as-owner"], channel: { transport: `${tg.url}/transport/send`, credentials: true }, token: "tg" },
    "channel-slack": { privileged: ["speaks-as-owner"], channel: { transport: `${slack.url}/transport/send` }, token: "sl" },
  } };
  const n = createNotify({ db: new DatabaseSync(":memory:"), secret: () => "key", resolver: createResolver(), modules: () => modules, testHosts: true });
  n.secret("Board account reset for sam@example.com: https://example.com/r/abc");
  assert.deepEqual(n.take(["kernel.notify"]).messages, []); // the router never sees it
  assert.equal(await n.deliverSecrets(), 0); // Telegram down: kept, not sent anywhere else
  up = true;
  assert.equal(await n.deliverSecrets(), 1);
  assert.equal(await n.deliverSecrets(), 0);
  assert.deepEqual(seen, ["Board account reset for sam@example.com: https://example.com/r/abc", "Board account reset for sam@example.com: https://example.com/r/abc"]);
});
