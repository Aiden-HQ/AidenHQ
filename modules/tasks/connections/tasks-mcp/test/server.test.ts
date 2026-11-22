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
function issueBoard({ rows, me = "me", full = {} }) {
  return async (req, res) => {
    for await (const _ of req) void _;
    const send = (x) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(x));
    const url = new URL(req.url ?? "", "http://x");
    const p = url.pathname;
    if (p === "/api/agents/me") return send({ id: me, companyId: "co" });
    if (p.endsWith("/companies/co/issues")) {
      const status = new Set(String(url.searchParams.get("status") ?? "").split(",").filter(Boolean));
      const agent = url.searchParams.get("assigneeAgentId"), user = url.searchParams.get("assigneeUserId");
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
      return send(rows
        .filter((r) => !status.size || status.has(r.status))
        .filter((r) => !agent || r.assigneeAgentId === agent)
        .filter((r) => !user || r.assigneeUserId === user)
        .slice(offset, offset + limit));
    }
    if (p.endsWith("/companies/co/agents")) return send([]);
    if (p === "/api/companies/co") return send({ id: "co", defaultResponsibleUserId: "owner" });
    if (p.startsWith("/api/issues/")) {
      const id = p.slice("/api/issues/".length);
      return send(full[id] ?? rows.find((r) => r.id === id) ?? {});
    }
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

test("task_list(mine) merges assigned work and handed-back chats newest first before the limit", async () => {
  const old = { ...row("assigned-1", "todo"), assigneeAgentId: "me", createdAt: "2026-01-01T00:00:00Z" };
  const chat = { ...row("chat-1", "todo"), assigneeUserId: "owner", createdAt: "2026-02-01T00:00:00Z", description: `hi\n\n<!-- aidenhq-chat-agent:me -->` };
  const states = { "assigned-1": noAttention("working"), "chat-1": noAttention("waiting") };
  const { call } = bridge({ handler: issueBoard({ rows: [chat, old] }), states });
  const out = parse(await call("task_list", { mine: true, limit: 1 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["chat-1"], "the newer chat is not crowded out by older assigned work");
  const both = parse(await call("task_list", { mine: true, limit: 10 }));
  assert.deepEqual(both.out.tasks.map((t) => t.id), ["chat-1", "assigned-1"]);
  assert.equal(new Set(both.out.tasks.map((t) => t.id)).size, 2, "no task is listed twice");
});

test("task_list(mine) finds a handed-back chat whose marker was cut from the list description", async () => {
  const chat = { ...row("chat-2", "todo"), assigneeUserId: "owner", description: "a long opening with no marker", descriptionTruncated: true };
  const full = { "chat-2": { ...chat, description: `the whole message\n\n<!-- aidenhq-chat-agent:me -->`, descriptionTruncated: false } };
  const { call } = bridge({ handler: issueBoard({ rows: [chat], full }), states: { "chat-2": noAttention("waiting") } });
  const out = parse(await call("task_list", { mine: true, limit: 5 }));
  assert.deepEqual(out.out?.tasks.map((t) => t.id), ["chat-2"], JSON.stringify(out));
});

test("task_list(mine) finds a handed-back chat whose marker is followed by a trailing newline", async () => {
  const chat = { ...row("chat-4", "todo"), assigneeUserId: "owner", description: `hi\n\n<!-- aidenhq-chat-agent:me -->\n`, createdAt: "2026-02-01T00:00:00Z" };
  const { call } = bridge({ handler: issueBoard({ rows: [chat] }), states: { "chat-4": noAttention("waiting") } });
  const out = parse(await call("task_list", { mine: true, limit: 5 }));
  assert.deepEqual(out.out?.tasks.map((t) => t.id), ["chat-4"], JSON.stringify(out));
});

test("task_list pages overlap so a row pulled up by a task leaving the list is not skipped", async () => {
  // Page one (t-0..t-199) is read, then its first row leaves: every later row moves up one, and a plain offset of 200 would
  // now start at t-201, skipping t-200.
  let reads = 0;
  const rows = Array.from({ length: 300 }, (_, n) => row(`t-${n}`, "todo"));
  const board = issueBoard({ rows });
  const handler = async (req, res) => {
    if ((req.url ?? "").includes("/issues?")) {
      if (reads++ === 1) rows.shift();
    }
    return board(req, res);
  };
  // Only t-200 matches, so the scan must page; the row is the first of page two before the shift and would be skipped after it.
  const states = Object.fromEntries(rows.map((r) => [r.id, noAttention(r.id === "t-200" ? "waiting" : "working")]));
  const { call } = bridge({ handler, states });
  const out = parse(await call("task_list", { state: "waiting", limit: 5 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["t-200"]);
});

test("task_list stops when the issues endpoint ignores offset and repeats a page", async () => {
  const rows = Array.from({ length: 200 }, (_, n) => row(`open-${n}`, "todo"));
  let reads = 0;
  const board = issueBoard({ rows });
  // A pager that ignores offset and repeats its one page.
  const ignores = async (req, res) => {
    if ((req.url ?? "").includes("/issues?")) {
      reads++;
      if (reads > 6) throw new Error("kept paging a repeated page");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
      return;
    }
    return board(req, res);
  };
  const states = Object.fromEntries(rows.map((r) => [r.id, noAttention("working")]));
  const { call } = bridge({ handler: ignores, states });
  const out = parse(await call("task_list", { state: "waiting", limit: 5 }));
  assert.deepEqual(out.out.tasks, []);
  assert.match(out.out.incomplete, /stopped advancing/, "a scan that could not page past its first page says so");
});

test("task_search's state filter is applied over pages of ranked hits, not just the first", async () => {
  // 200 higher-ranked hits that do not match state, then the waiting one.
  const hits = [...Array.from({ length: 200 }, (_, n) => ({ ...row(`hit-${n}`, "todo"), description: "invoice open" })), { ...row("hit-waiting", "todo"), description: "invoice open" }];
  const states = Object.fromEntries(hits.map((r) => [r.id, noAttention(r.id === "hit-waiting" ? "waiting" : "working")]));
  const { call } = bridge({ handler: issueBoard({ rows: hits }), states });
  const out = parse(await call("task_search", { query: "invoice", state: "waiting", limit: 2 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["hit-waiting"]);
});

test("task_search does not call an exhausted short result set incomplete", async () => {
  // 450 hits, one matching state deep in the tail: the overlap pages at the end share rows, which is not a repeated page.
  const rows = Array.from({ length: 450 }, (_, n) => ({ ...row(`hit-${n}`, "todo"), description: "invoice open" }));
  const states = Object.fromEntries(rows.map((r) => [r.id, noAttention(r.id === "hit-445" ? "waiting" : "working")]));
  const { call } = bridge({ handler: issueBoard({ rows }), states });
  const out = parse(await call("task_search", { query: "invoice", state: "waiting", limit: 5 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["hit-445"]);
  assert.equal(out.out.incomplete, undefined, "the set was read to its end, not cut short");
});

test("task_list(mine) reads past pages whose candidates all fail the filter", async () => {
  // Two full pages of assigned work that is not waiting; the waiting task is on the third. No owner chats: the merge sees one
  // source, and a page without matches must not be taken for the end of it.
  const rows = [...Array.from({ length: 400 }, (_, n) => ({ ...row(`work-${n}`, "todo"), assigneeAgentId: "me" })), { ...row("waits-1", "todo"), assigneeAgentId: "me" }];
  const states = Object.fromEntries(rows.map((r) => [r.id, noAttention(r.id === "waits-1" ? "waiting" : "working")]));
  const { call } = bridge({ handler: issueBoard({ rows }), states });
  const out = parse(await call("task_list", { mine: true, state: "waiting", limit: 5 }));
  assert.deepEqual(out.out?.tasks.map((t) => t.id), ["waits-1"], JSON.stringify(out));
  assert.equal(out.out?.incomplete, undefined);
});

test("task_list(mine) caps both sources on Paperclip's own createdAt order, the order it returns", async () => {
  // The chat is newer by createdAt and only touched later on the assigned one: the list is Paperclip's newest-first, so the
  // newer chat is the one `limit: 1` keeps.
  const assigned = { ...row("assigned-2", "todo"), assigneeAgentId: "me", createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" };
  const chat = { ...row("chat-3", "todo"), assigneeUserId: "owner", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z", description: `hi\n\n<!-- aidenhq-chat-agent:me -->` };
  const states = { "assigned-2": noAttention("working"), "chat-3": noAttention("waiting") };
  const { call } = bridge({ handler: issueBoard({ rows: [assigned, chat] }), states });
  const out = parse(await call("task_list", { mine: true, limit: 1 }));
  const all = parse(await call("task_list", { mine: true, limit: 10 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["assigned-2"], "the cap keeps Paperclip's newest row");
  assert.deepEqual(all.out.tasks.map((t) => t.id), ["assigned-2", "chat-3"], "and the full list is in that same order");
});

test("task_list(mine) fills limit with distinct tasks even when a chat is in both sources", async () => {
  // chat-1 is handed back to the agent between the scans, so both sources hold it; the limit counts distinct tasks.
  const chat = { ...row("chat-1", "todo"), assigneeUserId: "owner", createdAt: "2026-05-01T00:00:00Z", description: `hi\n\n<!-- aidenhq-chat-agent:me -->` };
  const dup = { ...chat, assigneeUserId: null, assigneeAgentId: "me" };
  const older = { ...row("assigned-2", "todo"), assigneeAgentId: "me", createdAt: "2026-01-01T00:00:00Z" };
  const states = { "chat-1": noAttention("waiting"), "assigned-2": noAttention("working") };
  // The fake board serves whichever assignee filter the query asks for.
  const board = issueBoard({ rows: [chat, dup, older] });
  const handler = (req, res) => board(req, res);
  const { call } = bridge({ handler, states });
  const out = parse(await call("task_list", { mine: true, limit: 2 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["chat-1", "assigned-2"], "two distinct tasks, nothing listed twice");
});

test("task_list(mine) stops reading pages once it has limit distinct matches", async () => {
  let reads = 0;
  const rows = Array.from({ length: 900 }, (_, n) => ({ ...row(`assigned-${n}`, "todo"), assigneeAgentId: "me", createdAt: `2026-01-01T00:00:${String(59 - (n % 60)).padStart(2, "0")}Z` }));
  const board = issueBoard({ rows });
  const handler = async (req, res) => {
    if ((req.url ?? "").includes("/issues?")) reads++;
    return board(req, res);
  };
  const states = Object.fromEntries(rows.map((r) => [r.id, noAttention("working")]));
  const { call } = bridge({ handler, states });
  const out = parse(await call("task_list", { mine: true, limit: 2 }));
  assert.equal(out.out.tasks.length, 2);
  assert.ok(reads <= 4, `read ${reads} pages for two matches; it should stop early`);
});

test("task_list(mine) returns the newest match without reading the rest of the history", async () => {
  // One matching task at the top of the assigned list, then 900 non-matching older rows.
  let reads = 0;
  const rows = [{ ...row("match-1", "todo"), assigneeAgentId: "me", createdAt: "2026-06-01T00:00:00Z" },
    ...Array.from({ length: 900 }, (_, n) => ({ ...row(`old-${n}`, "todo"), assigneeAgentId: "me", createdAt: "2026-01-01T00:00:00Z" }))];
  const board = issueBoard({ rows });
  const handler = async (req, res) => {
    if ((req.url ?? "").includes("/issues?")) reads++;
    return board(req, res);
  };
  const states = Object.fromEntries(rows.map((r) => [r.id, noAttention(r.id === "match-1" ? "waiting" : "working")]));
  const { call } = bridge({ handler, states });
  const out = parse(await call("task_list", { mine: true, state: "waiting", limit: 1 }));
  assert.deepEqual(out.out.tasks.map((t) => t.id), ["match-1"]);
  assert.ok(reads <= 4, `read ${reads} pages for one match; it should stop after yielding it`);
});
