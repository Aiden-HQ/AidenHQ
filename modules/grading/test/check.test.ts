// The new path end to end: a rubric filed through the kernel's route, its task closed, one check after close; an unmet
// criterion sends the delegator one notice; nothing is held (the module only reads tasks, asks for a token and posts a wake).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../service/src/store.ts";
import { createServer } from "../service/src/server.ts";
import { createChecker, parse } from "../service/src/check.ts";

const RUBRIC = ["The PR is merged.", "Its checks are green.", "A test covers the change."];

function world(answer: { id: string; met: string; reason: string }[]) {
  const tasks: Record<string, any> = {
    T1: { id: "T1", identifier: "WOR-1", title: "Fix it", status: "in_progress", assigneeAgentId: "eng", parentId: "P1", createdByAgentId: "lead" },
    P1: { id: "P1", identifier: "WOR-0", status: "in_progress", assigneeAgentId: "lead" },
  };
  const calls: string[] = [];
  const wakes: any[] = [];
  const kernel = async (method: string, path: string, body?: any) => {
    calls.push(`${method} ${path}`);
    const m = /^\/v1\/cp\/read\/api\/issues\/([^/]+)(\/comments)?$/.exec(path);
    if (m && m[2]) return [{ id: "c1", authorAgentId: "eng", body: "Merged #12. I skipped the test: no time." }];
    if (m) return tasks[decodeURIComponent(m[1]!)] ?? Promise.reject(Object.assign(new Error("no task"), { status: 404 }));
    if (path === "/v1/wakes") return (wakes.push(body), { posted: true });
    throw new Error(`unexpected ${method} ${path}`);
  };
  let asked = 0;
  const ask = async (_task: string, p: { system: string; user: string }) => {
    asked++;
    assert.match(p.user, /I skipped the test/);
    return { content: JSON.stringify({ criteria: answer }) };
  };
  const store = new Store(new DatabaseSync(":memory:"));
  return { tasks, calls, wakes, kernel, ask, store, asked: () => asked };
}

async function fileForModule(store: Store) {
  const server = createServer({ store, issue: async () => ({ id: "T1" }), keys: { check: "ck", board: "bk" }, jwks: { keys: [] } }).listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${port}/check/rubric`, { method: "POST", headers: { authorization: "Bearer ck" }, body: JSON.stringify({ task: { id: "T1" }, module: "maintainer", rubric: RUBRIC, deliverable: { kind: "pr", ref: "" } }) });
    assert.deepEqual(await r.json(), { verdict: "ok" });
    const b = await fetch(`http://127.0.0.1:${port}/board/grades`, { method: "POST", headers: { authorization: "Bearer bk" }, body: JSON.stringify({ ids: ["T1", "T9"] }) });
    const view = await b.json();
    assert.equal(view.grades.T1.state, "open");
    assert.equal(view.grades.T9, null);
  } finally { server.close(); }
}

test("a closed task with a rubric gets one check; an unmet criterion tells the delegator once; nothing is held", async () => {
  const w = world([{ id: "1", met: "yes", reason: "merged" }, { id: "2", met: "yes", reason: "not mentioned" }, { id: "3", met: "no", reason: "the report says the test was skipped" }]);
  await fileForModule(w.store);
  const checker = createChecker({ store: w.store, kernel: w.kernel, ask: w.ask, model: "m" });

  await checker.pass();
  assert.equal(w.asked(), 0, "an open task is not checked");
  assert.equal(w.store.get("T1")!.state, "open");

  w.tasks.T1.status = "done";
  await checker.pass();
  await checker.pass();
  assert.equal(w.asked(), 1, "one check after close");
  const row = w.store.get("T1")!;
  assert.equal(row.state, "unmet");
  assert.deepEqual(row.criteria.map((c) => c.met), ["yes", "yes", "no"]);
  assert.equal(w.wakes.length, 1);
  assert.equal(w.wakes[0].task, "P1");
  assert.match(w.wakes[0].text, /A test covers the change\.: the report says the test was skipped/);
  // The module never moves a task: it reads, asks for nothing else, and posts only the wake.
  assert.deepEqual([...new Set(w.calls.map((c) => c.split(" ")[0]))].sort(), ["GET", "POST"]);
  assert.ok(w.calls.filter((c) => c.startsWith("POST")).every((c) => c === "POST /v1/wakes"));
});

test("everything met: recorded, nobody told; a cancelled task's rubric is dropped", async () => {
  const w = world([{ id: "1", met: "yes", reason: "a" }, { id: "2", met: "yes", reason: "b" }, { id: "3", met: "yes", reason: "c" }]);
  w.store.file("T1", "agent:lead", RUBRIC, { kind: "pr", ref: "" });
  w.tasks.T1.status = "done";
  await createChecker({ store: w.store, kernel: w.kernel, ask: w.ask, model: "m" }).pass();
  assert.equal(w.store.get("T1")!.state, "met");
  assert.equal(w.wakes.length, 0);

  w.store.file("T2", "agent:lead", RUBRIC, { kind: "pr", ref: "" });
  w.tasks.T2 = { id: "T2", status: "cancelled" };
  await createChecker({ store: w.store, kernel: w.kernel, ask: w.ask, model: "m" }).pass();
  assert.equal(w.store.get("T2"), undefined);
});

test("an answer that doesn't match the rubric is not a result", () => {
  assert.throws(() => parse(JSON.stringify({ criteria: [{ id: "1", met: "yes", reason: "" }] }), 3));
  assert.throws(() => parse(JSON.stringify({ criteria: [{ id: "1", met: "maybe", reason: "" }] }), 1));
});
