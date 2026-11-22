// The HTTP endpoint: its own key only, the caller assertion on every tools/call, and nothing of one caller in another's call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertion, bridge, parse, rpc } from "./helpers.ts";

test("POST /mcp behind the service key; a tools/call needs a valid assertion for this module", async () => {
  assert.equal((await rpc({ method: "tools/list" }, { authorization: "Bearer wrong" })).status, 401);
  const list = await rpc({ method: "tools/list" });
  assert.ok(list.json.result.tools.some((t) => t.name === "task_comment"));
  assert.equal((await rpc({ method: "notifications/initialized", id: undefined })).status, 202);
  assert.equal((await rpc({ method: "initialize", params: {} })).json.result.serverInfo.name, "paperclip-tasks");
  const call = (h) => rpc({ method: "tools/call", params: { name: "task_get", arguments: { issue: "WOR-1" } } }, h);
  for (const h of [{}, { "x-aidenhq-caller": assertion({ aud: "other" }) }, { "x-aidenhq-caller": assertion({ exp: 1 }) }, { "x-aidenhq-caller": `${assertion().slice(0, -4)}AAAA` }])
    assert.match((await call(h)).json.result.content[0].text, /^Refused: /);
});

test("two agents on one server: each its own run counts, its own task and its own company", async () => {
  const comments = [];
  const { call } = bridge({
    agents: { a: { key: "alpha", memory_inbox: "inbox-a" }, b: { key: "beta", memory_inbox: "inbox-b" } },
    agent: "a",
    handler: async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const send = (x) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(x));
      const who = req.headers.authorization; // the kernel's credential for the caller
      if (req.url === "/api/agents/me") return send({ id: callerOf(who), companyId: `co-${callerOf(who)}` });
      if (req.method === "POST" && req.url.endsWith("/comments")) return (comments.push(req.url.split("/")[3]), send({ id: "c" }));
      if (req.url.startsWith("/api/issues/")) return send({ id: req.url.split("/")[3], identifier: "WOR-1", title: "t", status: "todo" });
      if (req.url.includes("/advisor/")) return send({ choices: [{ message: { content: "ok" } }] });
      send([]);
    },
  });
  // The fake kernel forwards one credential for everyone: who is asking is in the assertion, so track the last caller.
  let last = "a";
  const callerOf = () => last;
  const A = { agent: "a", key: "alpha", roles: [], task: "task-a", run: "run-a" };
  const B = { agent: "b", key: "beta", roles: [], task: "task-b", run: "run-b" };
  const as = async (who, name, args) => ((last = who.agent), parse(await call(name, args, who)));
  for (let i = 0; i < 10; i++) assert.ok((await as(A, "memory_note", { fact: `a ${i}`, source: "WOR-1" })).out);
  assert.match((await as(A, "memory_note", { fact: "a 11", source: "WOR-1" })).error, /at most 10/);
  assert.ok((await as(B, "memory_note", { fact: "b", source: "WOR-1" })).out, "another agent's run has its own count");
  assert.deepEqual([...new Set(comments)], ["inbox-a", "inbox-b"]);
  const q = "retry the failing deploy, or roll back first? facts attached";
  for (let i = 0; i < 5; i++) assert.ok((await as(A, "advisor_ask", { question: q })).out);
  assert.match((await as(A, "advisor_ask", { question: q })).error, /advisor_limit/);
  assert.equal((await as(B, "advisor_ask", { question: q })).out.calls_left, 4);
  assert.equal((await as(B, "task_current", {})).out.task.id, "task-b");
  assert.equal((await as(A, "task_current", {})).out.task.id, "task-a");
});

// task_list filters on the kernel kind and attention while it pages: a match past the first page of candidates is found, and
// no more than `limit` come back. Paperclip serves issues newest first, paged with `offset`.
function issueBoard({ rows, me = "me" }) {
  return async (req, res) => {
    for await (const _ of req) void _;
    const send = (x) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(x));
    const url = new URL(req.url ?? "", "http://x");
    const p = url.pathname;
    if (p === "/api/agents/me") return send({ id: me, companyId: "co" });
    if (p.endsWith("/companies/co/issues")) {
      const status = new Set(String(url.searchParams.get("status") ?? "").split(",").filter(Boolean));
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
      return send(rows.filter((r) => !status.size || status.has(r.status)).slice(offset, offset + limit));
    }
    if (p.endsWith("/companies/co/agents")) return send([]);
    if (p === "/api/companies/co") return send({ id: "co", defaultResponsibleUserId: "owner" });
    return send([]);
  };
}
const row = (id, status) => ({ id, identifier: id.toUpperCase(), title: id, status, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
const state = (kind, attention = []) => ({ kind, reason: kind === "idle" ? "history_expired" : "job_running", since: "2026-01-01T00:00:00Z", holder: "me", attention });
const noAttention = (kind) => state(kind);

test("task_list(state=\"idle\") finds an idle row past the first page of non-matching candidates, and returns only it", async () => {
  // A full first page of open, working rows; the idle row (a done Paperclip status, its history pruned) is on the second.
  const rows = [...Array.from({ length: 200 }, (_, n) => row(`open-${n}`, "todo")), row("idle-1", "done")];
  const states = Object.fromEntries(rows.map((r) => [r.id, r.id === "idle-1" ? state("idle", [{ who: "agent", why: "history_expired", ref: "idle-1" }]) : noAttention("working")]));
  const { call } = bridge({ handler: issueBoard({ rows }), states });
  const out = parse(await call("task_list", { state: "idle", limit: 5 }));
  assert.equal(out.out.tasks.length, 1);
  assert.equal(out.out.tasks[0].id, "idle-1");
  assert.equal(out.out.tasks[0].state.kind, "idle");
});

test("task_list(attention=\"any\") returns the rows with an attention entry, past the first page too", async () => {
  const rows = [...Array.from({ length: 200 }, (_, n) => row(`open-${n}`, "todo")), row("needs-1", "todo"), row("calm-1", "todo")];
  const states = Object.fromEntries(rows.map((r) => [r.id, r.id === "needs-1" ? state("waiting", [{ who: "owner", why: "owner_wait", ref: "needs-1" }]) : noAttention(r.id === "calm-1" ? "working" : "idle")]));
  const { call } = bridge({ handler: issueBoard({ rows }), states });
  const out = parse(await call("task_list", { attention: "any", limit: 5 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["needs-1"]);
  const owner = parse(await call("task_list", { attention: "owner", limit: 5 }));
  assert.deepEqual(owner.out.tasks.map((t) => t.id), ["needs-1"]);
});

test("task_list(state=\"done\") returns a done row behind a first page of open rows", async () => {
  const rows = [...Array.from({ length: 200 }, (_, n) => row(`open-${n}`, "todo")), row("done-1", "done")];
  const states = Object.fromEntries(rows.map((r) => [r.id, r.id === "done-1" ? noAttention("done") : noAttention("working")]));
  const { call } = bridge({ handler: issueBoard({ rows }), states });
  const out = parse(await call("task_list", { state: "done", limit: 5 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["done-1"]);
});

test("task_list with no state still returns only the not-done kinds", async () => {
  const rows = [row("done-1", "done"), row("working-1", "todo"), row("waiting-1", "in_progress"), row("idle-1", "todo")];
  const states = { "done-1": noAttention("done"), "working-1": noAttention("working"), "waiting-1": noAttention("waiting"), "idle-1": noAttention("idle") };
  const { call } = bridge({ handler: issueBoard({ rows }), states });
  const out = parse(await call("task_list", { limit: 10 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["working-1", "waiting-1", "idle-1"]);
});

test("task_list returns no more than limit matches even when more pages hold matches", async () => {
  const rows = Array.from({ length: 450 }, (_, n) => row(`idle-${n}`, "todo"));
  const states = Object.fromEntries(rows.map((r) => [r.id, state("idle")]));
  const { call } = bridge({ handler: issueBoard({ rows }), states });
  const out = parse(await call("task_list", { state: "idle", limit: 3 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["idle-0", "idle-1", "idle-2"], "newest first, capped at limit");
});
