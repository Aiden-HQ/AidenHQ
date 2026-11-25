import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeKernel } from "./fake.ts";
import { watchTools } from "../service/src/tools.ts";
import { openWatches } from "../service/src/watches.ts";

const setup = () => {
  const kernel = fakeKernel(), watches = openWatches(":memory:");
  kernel.prs.set("acme/widgets#1", { state: "OPEN" });
  const tool = (name: string) => watchTools({ watches, kernel }).find((t) => t.name === name)!;
  return { kernel, watches, tool };
};
const t1 = { agent: "a1", roles: ["session"], task: "T1" }, t2 = { agent: "a1", roles: ["session"], task: "T2" };
const arm = { connection: "github", kind: "pull_request.closed", resource: "Acme/Widgets", match: { number: 1, merged: true }, note: "PR 1 merged: merge #2" };

test("arm, list, cancel are the caller task's", async () => {
  const { tool } = setup();
  const armed = (await tool("watch_arm").run(arm, t1)) as { id: string; state: string };
  assert.equal(armed.state, "armed");
  assert.deepEqual(((await tool("watch_list").run({}, t1)) as { watches: { id: string }[] }).watches.map((w) => w.id), [armed.id]);
  assert.deepEqual(((await tool("watch_list").run({}, t2)) as { watches: unknown[] }).watches, []);
  await assert.rejects(tool("watch_cancel").run({ id: armed.id }, t2), /no such watch/);
  assert.equal(((await tool("watch_cancel").run({ id: armed.id }, t1)) as { state: string }).state, "cancelled");
});
