// A call that never reached its module (a replaced container's stale address, or the new one before it listens) is sent once
// more at a freshly resolved address; a timeout, or a failure after the body was written, is never replayed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { postOnce } from "../src/proxy.ts";
import { kernel, moduleServer } from "./helpers.ts";

const listen = async (t, fn) => {
  const s = http.createServer(fn).listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  t.after(() => { s.closeAllConnections?.(); s.close(); });
  return s.address().port;
};

/** A resolver whose cached address is `dead` until it is forgotten, then the live one: as net.ts behaves before a container moves. */
const switched = (dead: number, live: number, path = "/mcp") => {
  let forgotten = false;
  const seen = [];
  return {
    seen,
    async resolve(url: string) {
      const u = new URL(url);
      seen.push(forgotten ? live : dead);
      return { host: "127.0.0.1", port: forgotten ? live : dead, path: u.pathname };
    },
    forget(url: string) {
      if (new URL(url).hostname === "apps") forgotten = true;
    },
  };
};

const conn = (url, tools = { read: ["read_one"], write: [], destructive: [] }) => ({ url: `${url}/mcp`, auth_secret: "apps_service_key", module: "apps", returns: "untrusted", tools });

test("a call at a stale address is re-sent once, at the address the resolver gives after the forget", async (t) => {
  // A port nothing listens on now, as the old container's address is once the new container holds a different one.
  const gone = http.createServer();
  await new Promise<void>((r) => gone.listen(0, "127.0.0.1", () => r()));
  const dead = gone.address().port;
  await new Promise((r) => gone.close(r));
  const apps = await moduleServer(t, { key: "apps-key", tools: ["read_one"], answer: () => ({ content: [{ type: "text", text: "live" }] }) });
  const live = Number(new URL(apps.url).port);
  const resolver = switched(dead, live);
  const k = await kernel(t, {
    agents: { run: { id: "ag-ada" } }, grants: { "ag-ada": { key: "ada", tools: { apps: ["read_one"] } } },
    secrets: { apps_service_key: "apps-key" }, connections: { apps: conn("http://apps:8090") },
    resolver,
  });
  const r = await k.call("apps", "run", { method: "tools/call", params: { name: "read_one", arguments: {} } });
  assert.equal(r.status, 200);
  assert.match((await r.json()).result.content[0].text, /live/);
  assert.equal(apps.seen.filter((s) => s.method === "tools/call").length, 1, "the live module took the call once");
  assert.deepEqual(resolver.seen, [dead, live], "the second send used the address resolved after the forget");
  assert.ok(k.log.some((l) => l.msg === "proxy resend" && l.connection === "apps"));
});

test("postOnce: a connection refused before the body was delivered is sent once more, and succeeds", async (t) => {
  const live = await listen(t, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "live" }] } })));
  });
  // A port nothing listens on: a connect-level ECONNREFUSED, so the request never reached a module.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const refused = probe.address().port;
  await new Promise((r) => probe.close(r));
  const resolver = switched(refused, live);
  const answer = await postOnce({ conn: conn("http://apps:8090"), name: "apps", resolver, secret: () => "apps-key", caller: "jwt", method: "tools/call", params: { name: "read_one", arguments: {} } });
  assert.equal(answer.status, 200);
  assert.match(answer.text, /live/);
  assert.deepEqual(resolver.seen, [refused, live]);
});

test("postOnce: a failure after the body was written is never replayed", async (t) => {
  // The module took the whole request and then its answer was lost: the call may have run, so a write must not be sent again.
  const seen = [];
  const live = await listen(t, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => { seen.push(body); req.socket.destroy(); });
  });
  const resolved = [];
  const resolver = { async resolve() { resolved.push(live); return { host: "127.0.0.1", port: live, path: "/mcp" }; }, forget() {} };
  await assert.rejects(postOnce({ conn: conn("http://apps:8090"), name: "apps", resolver, secret: () => "apps-key", caller: "jwt", method: "tools/call", params: { name: "write_one", arguments: {} } }), /socket hang up|ECONNRESET/);
  assert.equal(seen.length, 1, "the call was sent once");
  assert.equal(resolved.length, 1, "and never resolved again");
});

test("a timeout answers 504 and is sent only once", async (t) => {
  const calls = [];
  const apps = await moduleServer(t, { key: "apps-key", tools: ["read_one"], answer: async () => { calls.push(1); return new Promise(() => {}); } });
  const k = await kernel(t, {
    agents: { run: { id: "ag-ada" } }, grants: { "ag-ada": { key: "ada", tools: { apps: ["read_one"] } } },
    secrets: { apps_service_key: "apps-key" }, connections: { apps: conn(apps.url) },
    socketTimeoutMs: () => 300,
  });
  const r = await k.call("apps", "run", { method: "tools/call", params: { name: "read_one", arguments: {} } });
  assert.equal(r.status, 504);
  assert.match((await r.json()).error.message, /didn't answer in time/);
  assert.equal(calls.length, 1, "the one send is the only one");
  assert.equal(apps.seen.filter((s) => s.method === "tools/call").length, 1);
});
