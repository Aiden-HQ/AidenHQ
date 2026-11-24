// The owner-key client's read sharing (cplimit.ts shareReads) and its strict JSON answers (jsonApi).
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonApi, readCapped, shareReads, TooLarge } from "../src/cplimit.ts";

/** A fake control plane counting requests per path; each answer waits a tick, so concurrent reads overlap. */
function plane() {
  const hits: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    hits.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify({ path: u.pathname }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { hits, f };
}

test("identical reads in flight share one request; static reads are kept a few seconds; a write to them drops them", async () => {
  const { hits, f } = plane();
  let clock = 0;
  const get = shareReads(f, () => clock);
  const auth = { headers: { authorization: "Bearer k" } };
  const answers = await Promise.all([1, 2, 3].map(() => get("http://cp/api/issues/t1", auth).then((r) => r.json())));
  assert.deepEqual(answers, [1, 2, 3].map(() => ({ path: "/api/issues/t1" })), "each caller reads its own copy");
  assert.equal(hits.length, 1);
  await get("http://cp/api/issues/t1", auth);
  assert.equal(hits.length, 2, "an issue read is shared only while in flight, never cached");
  await get("http://cp/api/agents/a1", auth);
  await get("http://cp/api/agents/a1", auth);
  assert.equal(hits.length, 3, "an agent read is kept");
  await get("http://cp/api/agents/a1", { headers: { authorization: "Bearer other" } });
  assert.equal(hits.length, 4, "never shared across credentials");
  await get("http://cp/api/agents/a1/pause", { ...auth, method: "POST" });
  await get("http://cp/api/agents/a1", auth);
  assert.equal(hits.length, 6, "a write to an agent drops the kept reads");
  clock += 20_000;
  await get("http://cp/api/agents/a1", auth);
  assert.equal(hits.length, 7, "and they expire");
});

test("an answer over the cap is refused while it streams; a 2xx that isn't JSON is a failure, not an empty task", async () => {
  const big = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } }));
  await assert.rejects(readCapped(big, 10_000), TooLarge);
  const api = jsonApi(async () => new Response("<html>cut off", { status: 200 }));
  await assert.rejects(api("GET", "/api/issues/t1"), /isn't JSON/);
  const empty = jsonApi(async () => new Response(null, { status: 204 }));
  assert.deepEqual(await empty("POST", "/api/x"), { status: 204, json: {} });
  const missing = jsonApi(async () => new Response("not found", { status: 404 }));
  assert.deepEqual(await missing("GET", "/api/issues/gone"), { status: 404, json: {} });
});

test("a read made after a write never shares an answer begun before it", async () => {
  const { hits, f } = plane();
  const get = shareReads(f);
  const before = get("http://cp/api/issues/t1");
  await get("http://cp/api/issues/t1", { method: "PATCH", body: "{}" });
  const after = get("http://cp/api/issues/t1");
  await Promise.all([before, after]);
  assert.equal(hits.filter((h) => h === "GET /api/issues/t1").length, 2);
});
