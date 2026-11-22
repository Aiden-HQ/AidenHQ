// serveReviewer's keepalives (kernel/sdk/src/reviewer.ts): progress inside the throttle is kept for one trailing beat, so the
// kernel's window counts from the last step that happened; a review that hangs sends nothing but that one beat.
//
// The clock, the timers and the HTTP call are all controlled here: a real kernel server and wall-clock waits made these tests
// measure arrival times under load, where a correct beat could look early or a slow runner could look like a missing one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { serveReviewer } from "../service/src/aidenhq-sdk/reviewer.ts";

const flush = () => new Promise((ok) => setImmediate(ok));
const body = { id: "r-0123456789abcdef", token: "t", model_token: "m", request: {} };

/** Call the reviewer's handler directly, with the request stream a real POST carries. */
const post = (handler, payload = body) => {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as { url: string; method: string; headers: Record<string, string> };
  req.url = "/aidenhq/v1/reviewer/review";
  req.method = "POST";
  req.headers = { authorization: "Bearer k" };
  const res = { writeHead: () => res, end: () => res } as unknown as Parameters<typeof handler>[1];
  return handler(req as unknown as Parameters<typeof handler>[0], res);
};

/** The keepalives serveReviewer sends, at the moment it sends them; other calls (the verdict) answer ok at once. */
const beatsSent = (t) => {
  const realFetch = globalThis.fetch;
  const realPerformance = globalThis.performance;
  const sent: number[] = [];
  // The throttle runs on a monotonic clock, so the stub must move performance.now with the mocked timers.
  globalThis.performance = { now: () => Date.now() } as Performance;
  globalThis.fetch = ((input, init) => {
    if (String(input).endsWith("/v1/reviews/r-0123456789abcdef") && String(init?.body ?? "").includes('"keepalive":true')) sent.push(Date.now());
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; globalThis.performance = realPerformance; });
  return sent;
};

test("progress inside the throttle is not dropped: one trailing keepalive at its end, however many steps arrived", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const sent = beatsSent(t);
  let progress;
  let release;
  const gate = () => new Promise((ok) => { release = ok; });
  const handler = serveReviewer(async (_req, ctx) => {
    progress = ctx.progress;
    progress(); // starts the throttle at t=0
    await gate();
    progress(); progress(); progress(); // suppressed: kept as one trailing beat at t=100
    await gate();
    return { decision: "approve", reason: "ok", model: "m" };
  }, { key: "k", kernelUrl: "http://kernel", instance: "i-1", beatMs: 100 });

  const running = post(handler);
  await flush();
  assert.ok(progress, "the review was handed its progress");
  assert.deepEqual(sent, [0], "the first step beats at once");

  t.mock.timers.tick(20);
  release(); await flush();
  assert.deepEqual(sent, [0], "a step inside the throttle is suppressed, never sent on every step");

  t.mock.timers.tick(80); // the throttle ends at t=100
  assert.deepEqual(sent, [0, 100], "the suppressed step is sent as one trailing beat when the throttle ends");

  release(); await running;
  assert.deepEqual(sent, [0, 100], "the work finishing sends no further beat");
});

test("a hung review reports nothing: its start beat only, never a trailing one", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const sent = beatsSent(t);
  let release;
  const gate = () => new Promise((ok) => { release = ok; });
  const handler = serveReviewer(async (_req, ctx) => {
    ctx.progress(); // the call starts at t=0
    await gate(); // and then hangs: no step ever arrives
    return { decision: "approve", reason: "ok", model: "m" };
  }, { key: "k", kernelUrl: "http://kernel", instance: "i-1", beatMs: 100 });

  const running = post(handler);
  await flush();
  assert.deepEqual(sent, [0], "the start beat goes at once");
  t.mock.timers.tick(1_000);
  assert.deepEqual(sent, [0], "a hung call gets its start beat and nothing more: no trailing beat without a step");

  release(); await running;
});

/** A fetch stub that records each keepalive's send time; `answers` supplies the first answers, then `fallback`. */
const beatStub = (t, fallback = () => Promise.resolve(new Response("{}", { status: 200 }))) => {
  const realFetch = globalThis.fetch;
  const realPerformance = globalThis.performance;
  const sent: number[] = [];
  const answers: (() => Promise<Response>)[] = [];
  globalThis.performance = { now: () => Date.now() } as Performance;
  globalThis.fetch = ((input, init) => {
    if (String(input).endsWith("/v1/reviews/r-0123456789abcdef") && String(init?.body ?? "").includes('"keepalive":true')) {
      sent.push(Date.now());
      return (answers.shift() ?? fallback)();
    }
    return Promise.resolve(new Response("{}", { status: 200 })); // the verdict
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; globalThis.performance = realPerformance; });
  return { sent, answers };
};

/** A reviewer whose work waits on the test, a step at a time. */
const gatedReview = () => {
  const gates: (() => void)[] = [];
  return { next: () => new Promise<void>((ok) => gates.push(ok)), release: () => gates.shift()?.() };
};

test("a keepalive the kernel never got is sent again after a second, and no retry outlives the review", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const { sent, answers } = beatStub(t);
  const g = gatedReview();
  const handler = serveReviewer(async (_req, ctx) => {
    ctx.progress(); // one step at t=0: its beat is lost on the wire
    await g.next();
    return { decision: "approve", reason: "ok", model: "m" };
  }, { key: "k", kernelUrl: "http://kernel", instance: "i-1", beatMs: 100 });

  answers.push(() => Promise.reject(new Error("ECONNRESET")));
  const running = post(handler);
  await flush();
  assert.deepEqual(sent, [0], "the first beat went out and was lost");
  t.mock.timers.tick(1_000); await flush();
  assert.deepEqual(sent, [0, 1_000], "a beat lost to a reset is sent again after a second, never dropped while the review is fine");
  g.release(); await running;
  t.mock.timers.tick(60_000); await flush();
  assert.deepEqual(sent, [0, 1_000], "the review is over: no retry outlives it");
});

test("a keepalive the kernel answers 404 for is not retried, and the review sends no further beat", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  // The kernel waits for nothing on this token: every beat is answered 404.
  const { sent } = beatStub(t, () => Promise.resolve(new Response("{}", { status: 404 })));
  const g = gatedReview();
  const handler = serveReviewer(async (_req, ctx) => {
    ctx.progress(); // t=0: the kernel says this review is gone
    await g.next();
    ctx.progress(); // still working, but nobody waits for it any more
    await g.next();
    return { decision: "approve", reason: "ok", model: "m" };
  }, { key: "k", kernelUrl: "http://kernel", instance: "i-1", beatMs: 100 });

  const running = post(handler);
  await flush();
  assert.deepEqual(sent, [0], "the one beat goes out");
  g.release(); await flush();
  t.mock.timers.tick(1_000); await flush();
  assert.deepEqual(sent, [0], "a 404 is not a lost beat: no retry, and no beat for later steps");
  g.release(); await running;
});

test("a reviewer that fails with nothing still sends its error back, never crashing the handler", async (t) => {
  const realFetch = globalThis.fetch;
  const delivered: string[] = [];
  globalThis.fetch = ((input, init) => {
    if (String(input).endsWith("/v1/reviews/r-0123456789abcdef")) delivered.push(String(init?.body ?? ""));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  // An unhandled rejection would fail the runner: none may escape, whatever the reviewer rejects with.
  const unhandled: unknown[] = [];
  const onUnhandled = (e) => void unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => { globalThis.fetch = realFetch; process.off("unhandledRejection", onUnhandled); });
  // Built per review: a rejected promise made up front would be unhandled before the handler ever sees it.
  const failures: [string, () => Promise<never>][] = [["null", () => Promise.reject(null)], ["undefined", () => Promise.reject(undefined)], ["a string", () => Promise.reject("boom")], ["a non-Error object", () => Promise.reject({})]];
  for (const [what, fail] of failures) {
    const handler = serveReviewer(fail, { key: "k", kernelUrl: "http://kernel", instance: "i-1", beatMs: 100 });
    assert.equal(await post(handler), true, `a rejection of ${what} is still a handled review`);
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(delivered.map((b) => JSON.parse(b).error), ["the reviewer failed", "the reviewer failed", "boom", "the reviewer failed"], "each failure is delivered as the review's error, exactly once");
  assert.deepEqual(unhandled, [], "no rejection escapes the handler: the service and its other reviews survive");
});

test("a keepalive answered with a transient HTTP failure is sent again; one the kernel took is not", async (t) => {
  // `fetch` resolves on an HTTP error, so a 502/503/429 (a gateway in front of the kernel, a throttle) must be retried like a
  // reset; a 2xx or an auth refusal reached the kernel and counted.
  for (const [status, retried] of [[503, true], [502, true], [429, true], [200, false], [401, false]] as const) {
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const { sent } = beatStub(t, () => Promise.resolve(new Response("{}", { status })));
    const g = gatedReview();
    const handler = serveReviewer(async (_req, ctx) => {
      ctx.progress(); // t=0: the kernel answers this one with `status`
      await g.next();
      return { decision: "approve", reason: "ok", model: "m" };
    }, { key: "k", kernelUrl: "http://kernel", instance: "i-1", beatMs: 100 });
    const running = post(handler);
    await flush();
    t.mock.timers.tick(5_000); await flush();
    assert.equal(sent.length, retried ? 2 : 1, `a ${status} answer is ${retried ? "" : "not "}a lost beat`);
    g.release(); await running;
  }
});
