// task_comments, task_search and task_get cap their output (token cost); `comment` returns one comment in full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.ts";

const big = "x".repeat(5000);

async function call(name, args) {
  const seen = [];
  const handler = (req, res) => {
    seen.push(req.url);
    const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
    if (req.url === "/api/agents/me") return send({ id: "me", name: "UI" });
    if (req.url.includes("/comments")) return send([{ id: "c1", authorType: "user", body: big, createdAt: "t" }]);
    if (req.url.includes("/issues?")) return send([{ id: "i", identifier: "WOR-1", title: "t", status: "todo", description: big.repeat(4) }]);
    send({ id: "i", identifier: "WOR-1", title: "t", status: "todo", description: big.repeat(4) });
  };
  const r = await bridge({ handler, agents: { me: { key: "ui", roles: [] } } }).call(name, args);
  assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
  return { out: JSON.parse(r.result.content[0].text), seen };
}

test("task_comments truncates bodies and defaults to 20; `comment` returns the full text", async () => {
  const a = await call("task_comments", { issue: "WOR-1" });
  assert.match(a.seen.find((u) => u.includes("/comments")), /limit=20/);
  assert.ok(a.out.comments[0].body.length < 1700 && a.out.comments[0].body.includes("[truncated"));
  const b = await call("task_comments", { issue: "WOR-1", comment: "c1" });
  assert.equal(b.out.comments[0].body.length, 5000);
});

test("task_get caps the description and task_search returns short snippets", async () => {
  const g = await call("task_get", { issue: "WOR-1" });
  assert.ok(g.out.description.length < 8200 && g.out.description.includes("[truncated"));
  const s = await call("task_search", { query: "x" });
  assert.ok(s.out.tasks[0].snippet.length < 450 && !("description" in s.out.tasks[0]));
});
