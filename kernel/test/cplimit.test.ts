import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_MARK, TYPED, limitIssueLists, markCode } from "../src/cplimit.ts";

test("at most `max` company issue lists are in flight; other reads pass straight through", async () => {
  let inFlight = 0, peak = 0, others = 0;
  const f = (async (input) => {
    if (!String(input).includes("/issues?")) { others++; return new Response("{}"); }
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return new Response("[]");
  });
  const limited = limitIssueLists(f, 3);
  const lists = Array.from({ length: 12 }, (_, i) => limited(`http://cp.example.com/api/companies/acme/issues?parentId=${i}`));
  await limited("http://cp.example.com/api/issues/WOR-1");
  const done = await Promise.all(lists);
  assert.equal(done.length, 12);
  assert.equal(peak, 3);
  assert.equal(others, 1);
});

test("every comment the owner-key caller writes is marked as code's, except the owner's own typed words", async () => {
  const sent = [];
  const f = markCode(async (input, init) => (sent.push({ path: new URL(input).pathname, typed: new Headers(init.headers).get(TYPED), body: init.body ? JSON.parse(String(init.body)) : undefined }), new Response("{}")));
  const u = (p) => `http://cp${p}`;
  await f(u("/api/issues/T-1/comments"), { method: "POST", body: JSON.stringify({ body: "Approved: widen it." }) });
  await f(u("/api/issues/T-1/comments"), { method: "POST", headers: { [TYPED]: "owner" }, body: JSON.stringify({ body: "Yes, publish it." }) });
  await f(u("/api/issues/T-1"), { method: "PATCH", body: JSON.stringify({ status: "todo", comment: "[grading] reason" }) });
  await f(u("/api/issues/T-1/comments"), { method: "POST", body: Buffer.from(JSON.stringify({ body: "notice\n\n<!-- aidenhq-wake -->" })) });
  await f(u("/api/issues/T-1"), { method: "PATCH", body: JSON.stringify({ status: "done" }) });
  assert.deepEqual(sent.map((s) => [s.typed, s.body?.body ?? s.body?.comment ?? null]), [
    [null, `Approved: widen it.\n\n${CODE_MARK}`], [null, "Yes, publish it."], [null, `[grading] reason\n\n${CODE_MARK}`], [null, "notice\n\n<!-- aidenhq-wake -->"], [null, null],
  ], "the typed mark never reaches the control plane");
});
