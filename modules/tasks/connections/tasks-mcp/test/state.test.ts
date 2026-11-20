// The task tools show the kernel's one state of a task, never Paperclip's status, and filter on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, parse } from "./helpers.ts";

const issues = [
  { id: "a", identifier: "WOR-1", title: "Build", status: "in_progress" },
  { id: "b", identifier: "WOR-2", title: "Ask", status: "in_review" },
];
const states = {
  a: { kind: "working", reason: "job_running", ref: "job:1", note: "checks running", since: "2026-11-20T10:00:00Z", holder: "eng", attention: [] },
  b: { kind: "waiting", reason: "owner_wait", since: "2026-11-20T09:00:00Z", holder: "eng", attention: [{ who: "owner", why: "owner_wait", ref: "wait:b" }] },
};
const handler = (req, res) => {
  const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
  if (req.url === "/api/agents/me") return send({ id: "me", name: "Eng", companyId: "c" });
  if (req.url.startsWith("/api/issues/")) return send(issues[0]);
  send(issues);
};
const call = async (name, args) => parse(await bridge({ handler, states, agents: { me: { key: "eng", roles: [] } } }).call(name, args));

test("agent-facing tasks carry the kernel state, never Paperclip's status", async () => {
  const g = (await call("task_get", { issue: "WOR-1" })).out;
  assert.equal(g.state.kind, "working");
  assert.equal(g.state.note, "checks running");
  assert.ok(!("status" in g));
  for (const t of (await call("task_list", {})).out.tasks) assert.ok(t.state && !("status" in t));
  for (const t of (await call("task_search", { query: "x" })).out.tasks) assert.ok(t.state && !("status" in t));
});

test("task_list filters on the kernel's kind and attention", async () => {
  assert.deepEqual((await call("task_list", { state: "waiting" })).out.tasks.map((t) => t.identifier), ["WOR-2"]);
  assert.deepEqual((await call("task_list", { attention: "owner" })).out.tasks.map((t) => t.identifier), ["WOR-2"]);
  assert.match((await call("task_list", { state: "napping" })).error, /state is/);
});

test("the retired status argument is an error, not silently ignored", async () => {
  assert.match((await call("task_list", { status: "done" })).error, /filter on `state`/);
  assert.match((await call("task_search", { query: "x", status: "done" })).error, /takes no `status`/);
});
