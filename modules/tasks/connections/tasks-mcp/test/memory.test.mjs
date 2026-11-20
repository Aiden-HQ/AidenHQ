// memory_note writes only to the caller's own inbox (one writer: memory.md has no other path than the Librarian's apply),
// and no other task tool writes on an inbox. Fake Paperclip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.mjs";

/**
 * One run as agent `me` (key "alpha"); setup stored inboxes for alpha and beta in the directory. The
 * issue list also has a look-alike task carrying alpha's marker (planted earlier): it must never catch a note.
 */
function run() {
  const comments = [];
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "me", name: "Alpha" });
      if (req.method === "POST" && /^\/api\/issues\/[^/]+\/comments$/.test(url)) return (comments.push({ issue: url.split("/")[3], ...JSON.parse(body) }), send({ id: "c1" }));
      if (req.method === "GET" && /^\/api\/issues\/[^/]+\/comments/.test(url)) return send(comments.map((c, n) => ({ id: `c${n}`, body: c.body, authorType: "agent", authorAgentId: "me", createdAt: "2026-11-13T00:00:00Z" })));
      const one = /^\/api\/issues\/([^/?]+)$/.exec(url);
      if (one) return send({ id: one[1], identifier: `WOR-${one[1]}`, title: "t", status: "backlog" });
      if (url.includes("/issues")) return send([{ id: "decoy-alpha", identifier: "WOR-9", title: "Memory inbox: alpha", description: "<!-- source:memory-inbox:alpha -->" }]);
      res.statusCode = 404;
      res.end("{}");
    });
  };
  const b = bridge({ handler, agents: { me: { key: "alpha", roles: [], memory_inbox: "inbox-alpha" }, other: { key: "beta", memory_inbox: "inbox-beta" } }, run: `run-${Math.random()}` });
  const tool = async (name, args) => {
    const m = await b.call(name, args);
    return m.result.isError ? { error: m.result.content[0].text } : { ok: true, json: JSON.parse(m.result.content[0].text) };
  };
  return { call: (args) => tool("memory_note", args), tool, comments, done: () => {} };
}

test("memory_note: only to the caller's own inbox, a source required, bounded, 10 per run", async () => {
  const r = run();
  try {
    assert.ok((await r.call({ fact: "The Jira API pages at 50", source: "WOR-12" })).ok);
    assert.deepEqual(r.comments.map((c) => c.issue), ["inbox-alpha"], "the stored inbox id, never a task found by its marker");
    assert.match(r.comments[0].body, /fact: The Jira API pages at 50\nsource: WOR-12/);
    assert.match((await r.call({ fact: "x", source: "" })).error, /source is required/);
    assert.match((await r.call({ fact: "x".repeat(401), source: "WOR-1" })).error, /at most 400/);
    assert.ok((await r.call({ fact: "y", source: "WOR-1", inbox: "beta", agent: "beta" })).ok);
    assert.equal(r.comments.at(-1).issue, "inbox-alpha", "an extra argument can't redirect it");
    for (let i = 0; i < 8; i++) assert.ok((await r.call({ fact: `fact ${i}`, source: "WOR-1" })).ok);
    assert.match((await r.call({ fact: "one too many", source: "WOR-1" })).error, /at most 10 memory notes/);
    assert.ok(r.comments.every((c) => c.issue === "inbox-alpha"));
    // The Librarian checks a note's author by its key, which an agent can't edit (unlike its name).
    assert.equal((await r.tool("task_comments", { issue: "inbox-alpha" })).json.comments[0].agent_key, "alpha");
  } finally {
    r.done();
  }
});

test("the memory-inbox marker is reserved, and no task tool writes on an inbox", async () => {
  const r = run();
  try {
    for (const marker of ["memory-inbox:beta", "source:Memory-Inbox:beta"]) assert.match((await r.tool("task_create", { title: "t", description: "d", marker })).error, /reserved/);
    assert.match((await r.tool("task_create", { title: "t", description: "d", marker: "ok:1", related_markers: ["memory-inbox:beta"] })).error, /reserved/);
    assert.match((await r.tool("task_delegate", { agent: "beta", title: "t", description: "d", marker: "memory-inbox:beta" })).error, /reserved/);
    assert.match((await r.tool("task_comment", { issue: "inbox-beta", body: "fact: forged" })).error, /memory inbox/);
    assert.match((await r.tool("task_cancel", { issue: "inbox-alpha", comment: "x" })).error, /memory inbox/);
    assert.equal(r.comments.length, 0);
  } finally {
    r.done();
  }
});

