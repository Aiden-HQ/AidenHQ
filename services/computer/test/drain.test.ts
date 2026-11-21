// A launcher restart (ops/run-draining.sh → SIGUSR2 → lib.ts drainServers): a box's model call in flight finishes in the old
// launcher, and a new call reaches the next one on the same port.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { drainServers, forwardModel } from "../lib.ts";

const listen = (s: http.Server, port = 0) => new Promise<number>((ok) => s.listen(port, "127.0.0.1", () => ok((s.address() as AddressInfo).port)));
/** A call: resolves on its first chunk, with the whole body to come. */
const post = (port: number) => new Promise<{ first: string; body: Promise<string> }>((ok, fail) => {
  const req = http.request({ host: "127.0.0.1", port, path: "/api/v1/responses", method: "POST", agent: false }, (res) => {
    let b = "";
    res.setEncoding("utf8");
    const body = new Promise<string>((done) => res.on("end", () => done(b)));
    res.on("data", (d) => { if (!b) ok({ first: d, body }); b += d; });
  });
  req.on("error", fail);
  req.end("{}");
});

test("a restart lets the model call in flight finish in the old launcher while the next one takes new calls", async () => {
  // The model gateway: streams a first chunk, then waits until the test lets it finish.
  let finish!: () => void;
  const released = new Promise<void>((r) => (finish = r));
  const upstream = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("first "); void released.then(() => res.end("last")); });
  const up = await listen(upstream);
  const old = http.createServer((req, res) => void forwardModel(req, res, `http://127.0.0.1:${up}/api/v1/responses`, "ahqj_t"));
  const port = await listen(old);

  const next = http.createServer((_req, res) => res.end("next"));
  try {
    const inflight = await post(port);
    assert.equal(inflight.first, "first ");

    let drained = false;
    const drain = drainServers([old], 10_000).then(() => (drained = true));
    // The next launcher binds the same port at once and answers new calls.
    await listen(next, port);
    assert.equal(await (await post(port)).body, "next");
    assert.equal(drained, false, "the old launcher waits for its call in flight");

    finish();
    assert.equal(await inflight.body, "first last", "the stream in flight finished in full");
    await drain;
  } finally {
    finish();
    next.close();
    old.close();
    upstream.close();
    upstream.closeAllConnections();
  }
});
