// The session proxy (session-proxy.ts): the board's key opens a lease's terminal and web UI, with the box-side credential added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createSessionProxy, withAuthToken } from "../session-proxy.ts";

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
  try {
    const bearer = { authorization: `Bearer ${KEY}` };
    assert.equal(await s.call(`/session/${LEASE}/term/page?x=1`, bearer), 200);
    assert.equal(await s.call(`/session/${LEASE}/web/session`, bearer), 200);
    assert.equal(await s.call(`/session/${LEASE}/term/ws`, bearer, true), 101);
    assert.deepEqual(s.seen, [
      { path: "/page?x=1", auth: basic("aidenhq:term-secret") },
      { path: "/session", auth: basic("opencode:serve-secret") },
      { path: "/ws", auth: basic("aidenhq:term-secret") },
    ]);
  } finally {
    s.close();
  }
});

test("the progress key and no key are refused", async () => {
  const s = await setup();
  try {
    assert.equal(await s.call(`/session/${LEASE}/term/`, { authorization: `Bearer ${"p".repeat(48)}` }), 401);
    assert.equal(await s.call(`/session/${LEASE}/term/`), 401);
    assert.equal(await s.call(`/session/${LEASE}/term/ws`, {}, true), 401);
    assert.deepEqual(s.seen, []);
  } finally {
    s.close();
  }
});

test("a released or unknown lease is a 404", async () => {
  const s = await setup();
  try {
    assert.equal(await s.call("/session/l-ffffffff/term/", { authorization: `Bearer ${KEY}` }), 404);
    assert.equal(await s.call("/session/l-ffffffff/web/ws", { authorization: `Bearer ${KEY}` }, true), 404);
  } finally {
    s.close();
  }
});

test("ttyd's token never reaches the browser: /token answers empty here, and the first frame's AuthToken is swapped in", async () => {
  const s = await setup();
  try {
    assert.equal(await s.call(`/session/${LEASE}/term/token`, { authorization: `Bearer ${KEY}` }), 200);
    assert.deepEqual(s.seen, []); // answered here, never asked of ttyd
  } finally {
    s.close();
  }
  const mask = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(JSON.stringify({ AuthToken: "", columns: 80, rows: 24 }));
  const frame = Buffer.concat([Buffer.from([0x82, 0x80 | body.length]), mask, body.map((b, i) => b ^ mask[i % 4]!)]);
  const out = withAuthToken(Buffer.concat([frame, Buffer.from("tail")]), "aidenhq:term-secret")!;
  const m = out.frame.subarray(2, 6), len = out.frame[1]! & 0x7f;
  const json = JSON.parse(Buffer.from(out.frame.subarray(6, 6 + len)).map((b, i) => b ^ m[i % 4]!).toString());
  assert.equal(json.AuthToken, Buffer.from("aidenhq:term-secret").toString("base64"));
  assert.equal(json.columns, 80);
  assert.equal(out.rest.toString(), "tail");
  assert.equal(withAuthToken(frame.subarray(0, 10), "x"), undefined);
  const big = Buffer.concat([Buffer.from([0x82, 0x80 | 126, 0, 130]), mask, Buffer.alloc(130)]);
  assert.equal(withAuthToken(big.subarray(0, 3), "x"), undefined); // a split extended header waits for the rest
});
