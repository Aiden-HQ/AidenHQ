// A launcher restart (ops/run-draining.sh → SIGUSR2 → lib.ts drainServers): a box's model call in flight finishes in the old
// launcher, and a new call reaches the next one on the same port.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { MODEL_BODY_MAX, drainServers, forwardModel } from "../lib.ts";

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

test("a kernel restart: a model call waits for the next gateway's listener instead of failing, its body sent once whole", async () => {
  // A free port with nothing on it: the old kernel has closed its listener and the next one hasn't bound it yet.
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  const bodies: string[] = [];
  const next = http.createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    bodies.push(b);
    res.end("answered");
  });
  const launcher = http.createServer((req, res) => void forwardModel(req, res, `http://127.0.0.1:${port}/api/v1/responses`, "ahqj_t", { retryMs: 50 }));
  const lp = await listen(launcher);
  try {
    const call = post(lp);
    await new Promise((r) => setTimeout(r, 300));
    await listen(next, port);
    assert.equal(await (await call).body, "answered");
    assert.deepEqual(bodies, ["{}"]);
  } finally {
    launcher.close();
    next.close();
  }
});

test("a model request over the gateway's limit is refused 413 and never held or sent", async () => {
  let reached = false;
  const gw = http.createServer((_req, res) => { reached = true; res.end("no"); });
  const gp = await listen(gw);
  const launcher = http.createServer((req, res) => void forwardModel(req, res, `http://127.0.0.1:${gp}/api/v1/responses`, "ahqj_t"));
  const lp = await listen(launcher);
  try {
    const status = await new Promise<number>((ok, fail) => {
      const req = http.request({ host: "127.0.0.1", port: lp, path: "/api/v1/responses", method: "POST", agent: false }, (res) => { res.resume(); ok(res.statusCode!); });
      req.on("error", fail);
      const chunk = Buffer.alloc(1 << 20);
      for (let n = 0; n <= MODEL_BODY_MAX >> 20; n++) req.write(chunk);
      req.end();
    });
    assert.equal(status, 413);
    assert.equal(reached, false);
  } finally {
    launcher.close();
    gw.close();
  }
});
