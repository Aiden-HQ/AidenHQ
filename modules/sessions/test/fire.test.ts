import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeKernel, merged } from "./fake.ts";
import { createReader } from "../service/src/reader.ts";
import { watchTools } from "../service/src/tools.ts";
import { openWatches } from "../service/src/watches.ts";

const caller = { agent: "a1", roles: ["session"], task: "T1" };
const arm = { connection: "github", kind: "pull_request.closed", resource: "acme/widgets", match: { number: 1, merged: true }, note: "PR 1 merged: merge #2" };
const setup = () => {
  const kernel = fakeKernel(), watches = openWatches(":memory:");
  kernel.prs.set("acme/widgets#1", { state: "OPEN" });
  const armWatch = (a: object = arm) => watchTools({ watches, kernel }).find((t) => t.name === "watch_arm")!.run(a, caller) as Promise<{ id: string; state: string }>;
  const reader = createReader({ kernel, watches, log: () => {} });
  return { kernel, watches, armWatch, reader };
};

test("fires once on the merge event", async () => {
  const { kernel, watches, armWatch, reader } = setup();
  const { id } = await armWatch();
  await reader.tick(); // the first read starts at the log's end
  kernel.log.push(merged(1, "acme/widgets", 1), merged(2, "acme/widgets", 7));
  await reader.tick();
  assert.equal(kernel.wakes.length, 1);
  assert.equal(kernel.wakes[0]!.task, "T1");
  assert.match(kernel.wakes[0]!.text, /^PR 1 merged: merge #2\n\nhttps:\/\/github.com\/acme\/widgets\/pull\/1: acme\/widgets#1 merged at abc1234$/);
  assert.equal(watches.get(id)!.state, "fired");
  assert.equal(watches.cursor(), 2);
  await reader.tick();
  assert.equal(kernel.wakes.length, 1);
});

test("a duplicate delivery posts one notice", async () => {
  const { kernel, watches, armWatch, reader } = setup();
  const { id } = await armWatch();
  await reader.tick();
  kernel.log.push(merged(1, "acme/widgets", 1));
  await reader.tick();
  watches.setCursor(0); // the cursor commit was lost: the same event is read again
  await reader.tick();
  assert.equal(kernel.wakes.length, 1);
  assert.equal(kernel.seen.size, 1);
  assert.equal(watches.get(id)!.state, "fired");
});

test("arming after the merge fires at once", async () => {
  const { kernel, watches, armWatch } = setup();
  kernel.prs.set("acme/widgets#1", { state: "MERGED", mergedAt: "2026-11-25T10:00:00Z", sha: "abc1234" });
  const r = await armWatch();
  assert.equal(r.state, "fired");
  assert.equal(kernel.wakes.length, 1);
  assert.match(kernel.wakes[0]!.id, /^watch-[0-9a-f]+$/);
  assert.equal(watches.get(r.id)!.state, "fired");
});

test("restart reconciles", async () => {
  const { kernel, watches, armWatch, reader } = setup();
  const { id } = await armWatch();
  kernel.prs.set("acme/widgets#1", { state: "MERGED", mergedAt: "2026-11-25T10:00:00Z", sha: "abc1234" }); // merged while the service was down
  await reader.reconcileAll();
  assert.equal(watches.get(id)!.state, "fired");
  assert.equal(kernel.wakes.length, 1);
});

test("unwatched repo is refused", async () => {
  const { kernel, watches, armWatch } = setup();
  kernel.unwatched.add("acme/widgets");
  await assert.rejects(armWatch(), /acme\/widgets isn't watched: the owner adds it to the Maintainer's or Ship's list/);
  assert.deepEqual(watches.list("T1"), []);
});
