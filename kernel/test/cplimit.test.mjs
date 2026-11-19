import { test } from "node:test";
import assert from "node:assert/strict";
import { limitIssueLists } from "../src/cplimit.ts";

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
