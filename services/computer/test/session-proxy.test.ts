// The session proxy (session-proxy.ts): the board's key opens a lease's terminal and web UI, with the box-side credential added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createSessionProxy } from "../session-proxy.ts";

const KEY = "k".repeat(48);
const LEASE = "l-0a0b0c0d";

async function setup() {
  const seen: { path?: string; auth?: string }[] = [];
  const box = createServer((req, res) => (seen.push({ path: req.url, auth: req.headers.authorization }), res.end("ok")));
  box.on("upgrade", (req, socket) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((r) => box.listen(0, "127.0.0.1", r));
  const port = (box.address() as AddressInfo).port;
  const proxy = createSessionProxy({ key: KEY, lease: async (id) => (id === LEASE ? { host: "127.0.0.1", ports: { serve: port, term: port }, secrets: { serve: "serve-secret", term: "term-secret" } } : undefined) });
  const front = createServer((req, res) => void proxy.http(req, res).then((done) => done || res.writeHead(404).end()));
  front.on("upgrade", (req, socket, head) => void proxy.upgrade(req, socket, head).then((done) => done || socket.destroy()));
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const fport = (front.address() as AddressInfo).port;
  const call = (path: string, headers: Record<string, string> = {}, ws = false) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: fport, path, headers: { ...headers, ...(ws ? { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"), "sec-websocket-version": "13" } : {}) } }, (res) => (res.resume(), resolve(res.statusCode!)));
      req.on("upgrade", (res) => resolve(res.statusCode!));
      req.on("error", reject);
      req.end();
    });
  return { seen, call, close: () => (box.close(), front.close()) };
}
const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

test("proxies HTTP and WS to the lease, adding the box-side credential the client never sends", async () => {
  const s = await setup();
  const bearer = { authorization: `Bearer ${KEY}` };
  assert.equal(await s.call(`/session/${LEASE}/term/token?x=1`, bearer), 200);
  assert.equal(await s.call(`/session/${LEASE}/web/session`, bearer), 200);
  assert.equal(await s.call(`/session/${LEASE}/term/ws`, bearer, true), 101);
  assert.deepEqual(s.seen, [
    { path: "/token?x=1", auth: basic("aidenhq:term-secret") },
    { path: "/session", auth: basic("opencode:serve-secret") },
    { path: "/ws", auth: basic("aidenhq:term-secret") },
  ]);
  s.close();
});

test("the progress key and no key are refused", async () => {
  const s = await setup();
  assert.equal(await s.call(`/session/${LEASE}/term/`, { authorization: `Bearer ${"p".repeat(48)}` }), 401);
  assert.equal(await s.call(`/session/${LEASE}/term/`), 401);
  assert.equal(await s.call(`/session/${LEASE}/term/ws`, {}, true), 401);
  assert.deepEqual(s.seen, []);
  s.close();
});

test("a released or unknown lease is a 404", async () => {
  const s = await setup();
  assert.equal(await s.call("/session/l-ffffffff/term/", { authorization: `Bearer ${KEY}` }), 404);
  assert.equal(await s.call("/session/l-ffffffff/web/ws", { authorization: `Bearer ${KEY}` }, true), 404);
  s.close();
});
